// lib/auth/manager.js —— 访问安全认证管理器（Lite 版，完整迁移自上游 dsh-bridge）
//
// 两层防护（与上游一致）：
//   1. 访问门禁（访客侧）：局域网设备进入 DSH 前必须过密码 / 扫码 Token / 会话 Cookie；
//   2. 后台防篡改锁（管理员侧）：改配置（模式、密码、Token、端口、网卡）必须先解锁管理员，
//      否则任何蹭进局域网的访客都能把你锁在门外。
//
// 相对上游的差异（仅两处，均为 Lite 定位所致）：
//   - 移除 `scope`（all / lan_only / public_only）：Lite 只有局域网一种入口、没有隧道，
//     「对公网生效 / 只对局域网生效」没有可区分的对象，留着会是面板上一个骗人的开关。
//   - 移除 `internalTunnelSecret`（辨别自建隧道转发流量）：同样因为没有隧道。
// 其余（PBKDF2 参数、哈希格式、adminPolicy 三态、失败封禁、会话持久化）逐字对齐，
// 因此 `config.json` 里的密码哈希在两个插件之间可以直接搬。

import { randomBytes, pbkdf2 as pbkdf2Callback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { PLUGIN_NAME } from '../constants.js'

const pbkdf2Async = promisify(pbkdf2Callback)

const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 天
const ADMIN_SESSION_MAX_AGE_MS = 30 * 60 * 1000 // 30 分钟
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_PERIOD_MS = 60 * 1000 // 连续失败封禁 60 秒

const PBKDF2_ITERATIONS = 600000
const LEGACY_PBKDF2_ITERATIONS = 10000
const PBKDF2_KEYLEN = 32
const PBKDF2_PREFIX = 'pbkdf2-sha256$'

export const AUTH_COOKIE_NAME = 'dsh_portal_auth'

/**
 * 判断一个连接是否来自真正物理回环（127.0.0.1 / ::1）。
 * 代理监听 0.0.0.0，只有直连本机端口的才被判定为回环。
 * @param {string} remoteAddress
 * @returns {boolean}
 */
export function isLoopbackAddress(remoteAddress) {
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
}

/**
 * 从 Cookie 头里取出访问会话令牌。
 * @param {string} cookieHeader
 * @returns {string|null}
 */
export function readSessionCookie(cookieHeader) {
  if (!cookieHeader) return null
  const m = /(?:^|;\s*)dsh_portal_auth=([a-f0-9]+)/i.exec(String(cookieHeader))
  return m ? m[1] : null
}

/** 登录会话落盘：宿主重启后已登录设备免重输密码。 */
const DEFAULT_SESSIONS_FILE = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  PLUGIN_NAME, 'sessions.json',
)

class PersistentSessionMap extends Map {
  /** @param {string} file 会话落盘文件路径 */
  constructor(file) {
    super()
    this._file = file
  }
  _flush() {
    try {
      mkdirSync(dirname(this._file), { recursive: true })
      writeFileSync(this._file, JSON.stringify([...this.entries()]), { mode: 0o600 })
    } catch { /* 落盘失败降级为纯内存语义，不阻断认证流程 */ }
  }
  static load(file) {
    const m = new PersistentSessionMap(file)
    try {
      const arr = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(arr)) return m
      const now = Date.now()
      for (const [k, v] of arr) {
        // 只恢复结构合法且未过期的会话
        if (typeof k === 'string' && v && Number.isFinite(v.expiresAt) && v.expiresAt > now) {
          Map.prototype.set.call(m, k, { createdAt: Number(v.createdAt) || 0, expiresAt: Number(v.expiresAt) })
        }
      }
    } catch { /* 文件缺失/损坏：降级为空 */ }
    return m
  }
  set(k, v) { super.set(k, v); this._flush(); return this }
  delete(k) { const r = super.delete(k); if (r) this._flush(); return r }
  clear() { super.clear(); this._flush() }
}

export class AuthManager {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config] 持久化认证配置
   * @param {'token_and_password'|'password_only'|'token_only'} [opts.config.mode]
   * @param {'password_unlock'|'local_only'|'open'} [opts.config.adminPolicy]
   * @param {(patch: object) => Promise<any>|any} [opts.onPersist]
   * @param {string} [opts.sessionsFile]
   * @param {object} [opts.logger]
   */
  constructor({ config = {}, onPersist, sessionsFile, logger = console } = {}) {
    this.logger = logger
    this.onPersist = onPersist

    this.enabled = Boolean(config.enabled)
    this.mode = config.mode || 'token_and_password'
    this.adminPolicy = config.adminPolicy || 'password_unlock'
    // 管理保护独立于访问认证：默认开启。关闭后管理操作免 adminToken（与访问认证解耦）
    this.adminProtection = config.adminProtection !== false
    this.passwordHash = config.passwordHash || ''
    this.passwordSalt = config.passwordSalt || ''
    this.adminPasswordHash = config.adminPasswordHash || ''
    this.adminPasswordSalt = config.adminPasswordSalt || ''
    this.secretToken = config.secretToken || this._generateToken()
    this.allowLoopback = config.allowLoopback !== false

    // 访客会话（持久化：宿主重启后已登录设备免重登）
    this.sessions = PersistentSessionMap.load(sessionsFile ?? DEFAULT_SESSIONS_FILE)
    // 管理员解锁会话（纯内存：进程重启即失效，属期望行为）
    /** @type {Map<string, {createdAt:number, expiresAt:number}>} */
    this.adminSessions = new Map()
    // 防暴力破解：ip -> { failedCount, lockUntil }
    /** @type {Map<string, {failedCount:number, lockUntil:number}>} */
    this.rateLimits = new Map()

    // 管理员解锁的全局失败计数（RPC 层拿不到真实 clientIp，只能用全局计数防爆破）
    this._adminUnlockFailures = 0
    this._adminUnlockLockUntil = 0

    this._cleanupTimer = setInterval(() => this._cleanupExpired(), 60 * 60 * 1000)
    if (this._cleanupTimer.unref) this._cleanupTimer.unref()
  }

  _generateToken() {
    // 256-bit：二维码里带的就是它，猜不中即等于免密直通
    return 'dshl_' + randomBytes(32).toString('hex')
  }

  // ---------------- 密码哈希 ----------------

  async _hashPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
    const derived = await pbkdf2Async(String(password), salt, iterations, PBKDF2_KEYLEN, 'sha256')
    return `${PBKDF2_PREFIX}${iterations}$${derived.toString('hex')}`
  }

  /**
   * 校验密码与存储哈希；兼容裸 hex 旧格式（10000 次）。
   * @returns {Promise<{ok: boolean, legacy: boolean}>} legacy 供调用方做透明升级
   */
  async _verifyHash(inputPassword, storedHash, storedSalt) {
    if (!storedHash || !storedSalt) return { ok: false, legacy: false }
    let iterations = LEGACY_PBKDF2_ITERATIONS
    let expected = storedHash
    if (storedHash.startsWith(PBKDF2_PREFIX)) {
      const rest = storedHash.slice(PBKDF2_PREFIX.length)
      const sep = rest.indexOf('$')
      if (sep === -1) return { ok: false, legacy: false }
      iterations = Number(rest.slice(0, sep))
      expected = rest.slice(sep + 1)
      if (!Number.isFinite(iterations) || iterations < 1) return { ok: false, legacy: false }
    }
    try {
      const derived = await pbkdf2Async(String(inputPassword), storedSalt, iterations, PBKDF2_KEYLEN, 'sha256')
      const expectedBuf = Buffer.from(expected, 'hex')
      const ok = derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf)
      return { ok, legacy: ok && !storedHash.startsWith(PBKDF2_PREFIX) }
    } catch {
      return { ok: false, legacy: false }
    }
  }

  /** 旧格式哈希在登录成功后透明升级（新盐 + 新迭代数）并持久化。 */
  async _upgradeHash(kind, password) {
    const salt = randomBytes(16).toString('hex')
    const hash = await this._hashPassword(password, salt)
    if (kind === 'admin') {
      this.adminPasswordHash = hash
      this.adminPasswordSalt = salt
    } else {
      this.passwordHash = hash
      this.passwordSalt = salt
    }
    await this._persist()
  }

  get hasPassword() {
    return Boolean(this.passwordHash && this.passwordSalt)
  }

  get hasAdminPassword() {
    return Boolean(this.adminPasswordHash && this.adminPasswordSalt)
  }

  // ---------------- 状态 ----------------

  /**
   * 安全认证状态（默认脱敏，防止普通接口泄露完整 Secret Token）。
   * @param {{masked?: boolean}} [opts]
   */
  getStatus({ masked = true } = {}) {
    let token = this.secretToken
    if (masked && token) {
      token = `${token.slice(0, 8)}****************`
    }
    return {
      enabled: this.enabled,
      mode: this.mode,
      adminPolicy: this.adminPolicy,
      adminProtection: this.adminProtection,
      hasPassword: this.hasPassword,
      hasAdminPassword: this.hasAdminPassword,
      secretToken: token,
      allowLoopback: this.allowLoopback,
    }
  }

  /**
   * 仅限已解锁的管理员或 `open` 策略下返回原始 Secret Token。
   * @param {string} [adminToken]
   * @returns {string|null}
   */
  getRawSecretToken(adminToken) {
    if (this.adminPolicy !== 'open') {
      const hasAnyPassword = this.hasAdminPassword || this.hasPassword
      if (hasAnyPassword && (!adminToken || !this.validateAdminSession(adminToken))) {
        return null
      }
    }
    return this.secretToken
  }

  /** 公开状态（供未认证访客 / 登录页使用，严格不含 secretToken）。 */
  getPublicStatus() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      adminPolicy: this.adminPolicy,
      adminProtection: this.adminProtection,
      hasPassword: this.hasPassword,
      hasAdminPassword: this.hasAdminPassword,
      allowLoopback: this.allowLoopback,
    }
  }

  // ---------------- 配置变更 ----------------

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled)
    this.sessions.clear()
    this.adminSessions.clear()
    await this._persist()
  }

  /** 管理保护独立开关：关闭后管理操作免 adminToken（与访问认证解耦）。 */
  async setAdminProtection(protection) {
    this.adminProtection = protection !== false
    if (!this.adminProtection) this.adminSessions.clear()
    await this._persist()
  }

  /**
   * 切换访客验证模式。切换时清空所有现有会话，确保新策略立即对所有设备生效。
   * @param {'token_and_password'|'password_only'|'token_only'} mode
   */
  async setMode(mode) {
    if (['token_and_password', 'password_only', 'token_only'].includes(mode)) {
      this.mode = mode
      this.sessions.clear()
      this.adminSessions.clear()
      await this._persist()
    }
  }

  /**
   * 远程管理防篡改策略。
   * - `password_unlock`：局域网也可用管理密码解锁（默认）
   * - `local_only`：只有电脑本机能管理，远程一律拒绝
   * - `open`：管理操作免验证（危险）
   * @param {'password_unlock'|'local_only'|'open'} policy
   */
  async setAdminPolicy(policy) {
    if (['password_unlock', 'local_only', 'open'].includes(policy)) {
      this.adminPolicy = policy
      this.adminSessions.clear()
      await this._persist()
    }
  }

  async setAllowLoopback(allow) {
    this.allowLoopback = Boolean(allow)
    await this._persist()
  }

  /**
   * 设置访客访问密码；传空串表示清除。
   * 更改密码时使所有普通访客会话失效。
   */
  async setPassword(password) {
    if (!password) {
      this.passwordHash = ''
      this.passwordSalt = ''
    } else {
      const salt = randomBytes(16).toString('hex')
      this.passwordHash = await this._hashPassword(password, salt)
      this.passwordSalt = salt
    }
    this.sessions.clear()
    await this._persist()
  }

  /**
   * 设置后台管理密码；传空串表示清除。
   * 更改管理密码时使所有远程管理员解锁会话失效。
   */
  async setAdminPassword(password) {
    if (!password) {
      this.adminPasswordHash = ''
      this.adminPasswordSalt = ''
    } else {
      const salt = randomBytes(16).toString('hex')
      this.adminPasswordHash = await this._hashPassword(password, salt)
      this.adminPasswordSalt = salt
    }
    this.adminSessions.clear()
    await this._persist()
  }

  async regenerateSecretToken() {
    this.secretToken = this._generateToken()
    this.sessions.clear()
    await this._persist()
    return this.secretToken
  }

  async _persist() {
    if (typeof this.onPersist !== 'function') return
    try {
      await this.onPersist({
        enabled: this.enabled,
        mode: this.mode,
        adminPolicy: this.adminPolicy,
        adminProtection: this.adminProtection,
        passwordHash: this.passwordHash,
        passwordSalt: this.passwordSalt,
        adminPasswordHash: this.adminPasswordHash,
        adminPasswordSalt: this.adminPasswordSalt,
        secretToken: this.secretToken,
        allowLoopback: this.allowLoopback,
      })
    } catch (err) {
      this.logger.error?.('dsh-porthole: 认证配置持久化失败: %s', err?.message ?? err)
    }
  }

  // ---------------- 管理员解锁 ----------------

  createAdminSession(maxAgeMs = ADMIN_SESSION_MAX_AGE_MS) {
    const adminToken = randomBytes(24).toString('hex')
    const now = Date.now()
    this.adminSessions.set(adminToken, { createdAt: now, expiresAt: now + maxAgeMs })
    return adminToken
  }

  validateAdminSession(adminToken) {
    if (!adminToken) return false
    const sess = this.adminSessions.get(adminToken)
    if (!sess) return false
    if (Date.now() > sess.expiresAt) {
      this.adminSessions.delete(adminToken)
      return false
    }
    return true
  }

  revokeAdminSession(adminToken) {
    if (adminToken) this.adminSessions.delete(adminToken)
  }

  /**
   * 校验管理员密码。未设管理密码时回退校验访客密码（与上游一致）。
   */
  async verifyAdminPassword(inputPassword, clientIp = '') {
    if (this.isIpBlocked(clientIp)) {
      return { success: false, error: '尝试次数过多，请稍后再试' }
    }

    const targetHash = this.adminPasswordHash || this.passwordHash
    const targetSalt = this.adminPasswordSalt || this.passwordSalt

    if (!targetHash || !targetSalt) {
      return { success: true }
    }

    const check = await this._verifyHash(inputPassword, targetHash, targetSalt)
    if (check.ok) {
      // 旧格式透明升级：管理位为空时实际校验的是访客密码，升级落在对应字段
      if (check.legacy) {
        await this._upgradeHash(this.adminPasswordHash ? 'admin' : 'password', inputPassword)
      }
      this.recordSuccess(clientIp)
      return { success: true }
    }

    this.recordFailedAttempt(clientIp)
    return { success: false, error: '管理员密码错误' }
  }

  /**
   * 解锁管理员，返回一次性 adminToken。
   * @returns {Promise<{ok: boolean, adminToken?: string, error?: string}>}
   */
  async unlockAdmin(password, clientIp = '') {
    if (this.adminPolicy === 'local_only') {
      return { ok: false, error: '当前已配置为仅限电脑本机管理设置' }
    }
    // RPC 层拿不到真实 clientIp（代理以回环转发），因此用独立的全局失败计数防爆破：
    // 攻击者 5 次失败即锁 60s，暴力破解不可行；代价是可短时干扰解锁（可接受的权衡）
    if (this._adminUnlockLockUntil && Date.now() < this._adminUnlockLockUntil) {
      return { ok: false, error: '尝试次数过多，请 60 秒后再试' }
    }
    const hasAnyPassword = this.hasAdminPassword || this.hasPassword
    if (!hasAnyPassword) {
      return { ok: true, adminToken: this.createAdminSession() }
    }
    const verify = await this.verifyAdminPassword(password, clientIp)
    if (verify.success) {
      this._adminUnlockFailures = 0
      return { ok: true, adminToken: this.createAdminSession() }
    }
    this._adminUnlockFailures += 1
    if (this._adminUnlockFailures >= MAX_FAILED_ATTEMPTS) {
      this._adminUnlockLockUntil = Date.now() + LOCKOUT_PERIOD_MS
      this._adminUnlockFailures = 0
      this.logger.warn?.('dsh-porthole: 管理员解锁连续失败，已锁定 60 秒')
    }
    return { ok: false, error: verify.error || '管理员密码错误' }
  }

  // ---------------- 访客认证校验 ----------------

  /**
   * 校验访客访问密码。
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async verifyPassword(inputPassword, clientIp = '') {
    if (this.isIpBlocked(clientIp)) {
      return { success: false, error: '尝试次数过多，请稍后再试' }
    }

    // 严禁 token_only 模式下通过密码登录接口获取 Session
    if (this.mode === 'token_only') {
      return { success: false, error: '当前仅允许专属安全 Token 扫码访问，不支持密码登录' }
    }

    if (!this.hasPassword) {
      // 未设密码 = 没有受保护秘密：先让管理员进来完成密码初始化。
      // 若在此拒绝，会形成死锁（无密码 → 401 → 进不去面板 → 永远设不了密码）。
      return { success: true }
    }

    const check = await this._verifyHash(inputPassword, this.passwordHash, this.passwordSalt)
    if (check.ok) {
      if (check.legacy) await this._upgradeHash('password', inputPassword)
      this.recordSuccess(clientIp)
      return { success: true }
    }

    this.recordFailedAttempt(clientIp)
    return { success: false, error: '访问密码错误' }
  }

  validateSecretToken(token) {
    if (!token || !this.secretToken) return false
    const bufA = Buffer.from(String(token))
    const bufB = Buffer.from(String(this.secretToken))
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
  }

  createSession(maxAgeMs = DEFAULT_SESSION_MAX_AGE_MS) {
    const sessionToken = randomBytes(24).toString('hex')
    const now = Date.now()
    this.sessions.set(sessionToken, { createdAt: now, expiresAt: now + maxAgeMs })
    return sessionToken
  }

  validateSession(sessionToken) {
    if (!sessionToken) return false
    const sess = this.sessions.get(sessionToken)
    if (!sess) return false
    if (Date.now() > sess.expiresAt) {
      this.sessions.delete(sessionToken)
      return false
    }
    return true
  }

  revokeSession(sessionToken) {
    if (sessionToken) this.sessions.delete(sessionToken)
  }

  // ---------------- 防暴力破解 ----------------

  isIpBlocked(ip) {
    if (!ip) return false
    const record = this.rateLimits.get(ip)
    if (!record) return false
    if (record.lockUntil && Date.now() < record.lockUntil) return true
    if (record.lockUntil && Date.now() >= record.lockUntil) {
      this.rateLimits.delete(ip)
      return false
    }
    return false
  }

  recordFailedAttempt(ip) {
    if (!ip) return
    const now = Date.now()
    const record = this.rateLimits.get(ip) || { failedCount: 0, lockUntil: 0 }
    record.failedCount += 1
    if (record.failedCount >= MAX_FAILED_ATTEMPTS) {
      record.lockUntil = now + LOCKOUT_PERIOD_MS
      this.logger.warn?.(`dsh-porthole: IP ${ip} 连续失败，已锁定 60 秒`)
    }
    this.rateLimits.set(ip, record)
  }

  recordSuccess(ip) {
    if (ip) this.rateLimits.delete(ip)
  }

  // ---------------- HTTP / WebSocket 请求总入口鉴权 ----------------

  /**
   * 检查请求是否已授权。
   *
   * 放行顺序：
   *   1. 访问认证未开启 → 全放行；
   *   2. 真正物理回环（127.0.0.1 + Host 也是回环）→ 放行，本机浏览器免密；
   *   3. `?auth=<secretToken>` URL Token（`password_only` 模式禁用）→ 放行；
   *   4. `dsh_portal_auth` 会话 Cookie 有效 → 放行；
   *   5. 其余 → 拒绝。
   *
   * @param {{headers?: Record<string, any>, socket?: {remoteAddress?: string}, url?: string}} req
   * @returns {{authenticated: boolean, fromToken?: boolean, sessionToken?: string, loopback?: boolean, bypass?: boolean}}
   */
  verifyRequest(req) {
    if (!this.enabled) {
      return { authenticated: true, bypass: true }
    }

    const remote = req.socket?.remoteAddress || ''
    const isLoopback = isLoopbackAddress(remote)

    // 2. 本地回环免认证：要求 Host 也是回环，防止被反代/隧道借用回环身份。
    //    注意 Host 为空**不放行**：HTTP/1.1 要求必带 Host，缺失本身就是异常信号
    //    （nginx 少写 proxy_set_header Host 就会变成空值），按误配处理更安全。
    if (this.allowLoopback && isLoopback) {
      const host = String(req.headers?.host || '')
      if (host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')) {
        return { authenticated: true, loopback: true }
      }
    }

    // 3. Query Token（扫码免密直通）
    if (this.mode !== 'password_only') {
      try {
        const urlObj = new URL(req.url || '/', 'http://localhost')
        const queryToken = urlObj.searchParams.get('auth') || urlObj.searchParams.get('token')
        if (queryToken && this.validateSecretToken(queryToken)) {
          return { authenticated: true, fromToken: true }
        }
      } catch { /* URL 非法则不认为带 token */ }
    }

    // 4. Session Cookie
    const cookieHeader = req.headers?.cookie || ''
    const sessionToken = readSessionCookie(cookieHeader)
    if (sessionToken && this.validateSession(sessionToken)) {
      return { authenticated: true, sessionToken }
    }

    return { authenticated: false }
  }

  _cleanupExpired() {
    const now = Date.now()
    for (const [t, s] of this.sessions.entries()) {
      if (now > s.expiresAt) this.sessions.delete(t)
    }
    for (const [t, s] of this.adminSessions.entries()) {
      if (now > s.expiresAt) this.adminSessions.delete(t)
    }
    for (const [ip, r] of this.rateLimits.entries()) {
      if (r.lockUntil && now > r.lockUntil) this.rateLimits.delete(ip)
    }
  }

  dispose() {
    clearInterval(this._cleanupTimer)
    // 不清空 sessions：进程退出时内存随进程自然消失；
    // 若此处 clear() 会把持久化文件一并清空，宿主重启后已登录设备仍会全部丢失
    this.rateLimits.clear()
  }
}
