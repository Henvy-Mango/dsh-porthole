// client/index.js —— Lite 版控制台面板
//
// 四块内容：
//   1. 局域网访问（地址 + 二维码 + 网卡切换 + 端口）
//   2. 安全认证（开关 / 验证模式 / 访客密码 / 管理密码 / 防篡改策略 / 管理保护 / 令牌）
//   3. 自检
//   4. 应急复位说明
//
// 管理员权限模型（与上游一致）：
//   - 本机浏览器（127.0.0.1）进面板时自动向 /__dsh_porthole__/loopback-token 领取
//     adminToken，无需输密码；
//   - 局域网访客进面板时拿不到令牌，改动安全配置会被服务端拒绝，
//     面板据此弹出"输入管理密码解锁"。
//
// 构建方式：esbuild 打成 CJS，包在 `window.__ModuleLoader__.load` 里，由打包外壳
// 注入模块级变量 `React`（见 client/build.mjs），所以这里直接 `React.createElement`。

/* global React */

const name = 'dsh-porthole';
// locale 服务不能写进 inject（动态插件激活时服务不在上下文里，会导致 entry did not activate）
const inject = ['slots', 'connection'];

const BRIDGE_RPC_CHANNEL = '/dsh-porthole';
const ENDPOINT_PREFIX = '/__dsh_porthole__';

// 与 lib/rpc.js 的端点表保持一致，由 test/unit.test.mjs 的契约用例防漂移
const EP = {
  getStatus: 'getStatus',
  setPort: 'setPort',
  restartProxy: 'restartProxy',
  setProxyConfig: 'setProxyConfig',
  getQr: 'getQr',
  diagnose: 'diagnose',
  authGetStatus: 'authGetStatus',
  authUpdateConfig: 'authUpdateConfig',
  authRegenerateToken: 'authRegenerateToken',
  authAdminUnlock: 'authAdminUnlock',
  authAdminLock: 'authAdminLock',
  // 远程工作区管理
  listWorkspaces: 'listWorkspaces',
  listRemoteDirectories: 'listRemoteDirectories',
  addRemoteWorkspace: 'addRemoteWorkspace',
};

const h = (type, props, ...children) => React.createElement(type, props, ...children);


const S = {
  card: {
    background: 'var(--dsw-alias-bg-layer-2,#f9fafb)',
    border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
    borderRadius: 12,
    padding: '16px 18px',
    marginBottom: 16,
    boxSizing: 'border-box',
  },
  title: { fontSize: 14, fontWeight: 600, margin: '0 0 12px 0' },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 },
  label: { fontSize: 13, color: 'var(--dsw-alias-fg-l3,#6b7280)', minWidth: 84 },
  mono: { fontSize: 13, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', wordBreak: 'break-all' },
  input: {
    flex: 1,
    minWidth: 120,
    padding: '7px 10px',
    fontSize: 13,
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
    background: 'var(--dsw-alias-bg-layer-1,#fff)',
    color: 'inherit',
    boxSizing: 'border-box',
  },
  btn: {
    padding: '7px 14px',
    fontSize: 13,
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
    background: 'var(--dsw-alias-bg-layer-1,#fff)',
    color: 'inherit',
    cursor: 'pointer',
  },
  btnPrimary: {
    padding: '7px 14px',
    fontSize: 13,
    borderRadius: 8,
    border: '1px solid #4f6ef7',
    background: '#4f6ef7',
    color: '#fff',
    cursor: 'pointer',
  },
  btnDanger: {
    padding: '7px 14px',
    fontSize: 13,
    borderRadius: 8,
    border: '1px solid #dc2626',
    background: 'transparent',
    color: '#dc2626',
    cursor: 'pointer',
  },
  hint: { fontSize: 12, color: 'var(--dsw-alias-fg-l3,#6b7280)', lineHeight: 1.6, margin: '8px 0 0' },
  ok: { color: '#16a34a', fontSize: 12 },
  bad: { color: '#dc2626', fontSize: 12 },
  warn: { color: '#d97706', fontSize: 12 },
  qr: { width: 168, height: 168, borderRadius: 8, background: '#fff', padding: 6 },
  locked: {
    background: 'rgba(217,119,6,.1)',
    border: '1px solid rgba(217,119,6,.4)',
    borderRadius: 10,
    padding: '12px 14px',
    marginBottom: 16,
  },
};

function Row({ label, children }) {
  return h('div', { style: S.row }, h('span', { style: S.label }, label), children);
}

function Card({ title, children }) {
  return h('div', { style: S.card }, h('h3', { style: S.title }, title), children);
}

const MODE_LABELS = {
  token_and_password: '密码 + 扫码令牌',
  password_only: '仅密码',
  token_only: '仅扫码令牌',
};

const POLICY_LABELS = {
  password_unlock: '局域网可解锁（推荐）',
  local_only: '仅限电脑本机',
  open: '不设防（危险）',
};

/**
 * 面板主体。
 * @param {object} props
 * @param {(endpoint: string, payload?: object, signal?: AbortSignal) => Promise<any>} props.rpcCall
 * @param {object} [props.initialStatus] 仅测试注入：跳过首次拉取直接渲染给定状态
 * @param {string} [props.initialAdminToken] 仅测试注入：预置管理员令牌
 */
function BridgePanel({ rpcCall, initialStatus, initialAdminToken }) {
  const [status, setStatus] = React.useState(initialStatus ?? null);
  const [qr, setQr] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const [diag, setDiag] = React.useState(null);

  // 管理员解锁态
  const [adminToken, setAdminToken] = React.useState(initialAdminToken ?? null);
  const [adminPassword, setAdminPassword] = React.useState('');
  const [unlockErr, setUnlockErr] = React.useState(null);
  // 自动领取本机令牌失败的原因（null = 正常或尚未尝试）
  const [adminAutoFetchError, setAdminAutoFetchError] = React.useState(null);

  // 各输入框
  const [guestPassword, setGuestPassword] = React.useState('');
  const [adminPasswordNew, setAdminPasswordNew] = React.useState('');
  const [portVal, setPortVal] = React.useState('');
  const [basePathVal, setBasePathVal] = React.useState('');
  // 卡片内联反馈：面板顶部的全局提示离这张卡片太远，滚动后看不见
  const [proxyMsg, setProxyMsg] = React.useState(null);
  const [hostVal, setHostVal] = React.useState('0.0.0.0');

  // 工作区：已注册列表 + 目录浏览状态
  const [wsList, setWsList] = React.useState(null);
  const [browse, setBrowse] = React.useState(null);
  const [browseErr, setBrowseErr] = React.useState(null);
  const [adding, setAdding] = React.useState(false);

  const auth = status?.auth;
  const needUnlock = Boolean(auth && (auth.hasPassword || auth.hasAdminPassword)
    && auth.adminProtection !== false && auth.adminPolicy !== 'open' && !adminToken);

  const refresh = React.useCallback(async (withToken) => {
    try {
      const res = await rpcCall(EP.getStatus, { adminToken: withToken ?? undefined });
      if (res?.ok) {
        setStatus(res.value);
        setPortVal(String(res.value.proxy.port));
        setBasePathVal(res.value.basePath || '');
        setHostVal(res.value.host || '0.0.0.0');
        return res.value;
      }
      setMsg({ kind: 'bad', text: res?.error?.message ?? '读取状态失败' });
      return null;
    } catch (err) {
      setMsg({ kind: 'bad', text: `读取状态失败：${err?.message ?? err}` });
      return null;
    }
  }, [rpcCall]);

  const loadQr = React.useCallback(async (withToken) => {
    try {
      const res = await rpcCall(EP.getQr, { adminToken: withToken ?? undefined });
      if (res?.ok) setQr(res.value);
    } catch { /* 二维码拿不到不影响主流程 */ }
  }, [rpcCall]);

  // 首次挂载：拉状态 → 若是本机则自动领令牌
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await refresh();
      if (cancelled || !s) return;
      void loadQr();
      // 本机浏览器自动领 adminToken，免去反复输管理密码。
      //
      // 三种「本机」形态都要认：
      //   1. http://127.0.0.1 / localhost / [::1]
      //   2. dsh-app:// 官方桌面版（窗口来源是自定义协议，hostname 为 'app'，
      //      不是 127.0.0.1 —— 之前只判 http 形态，导致桌面版永远拿不到令牌，
      //      表现为「面板控件点了没反应」）
      //   3. 空 hostname（file: 之类）
      const host = window.location?.hostname || '';
      const protocol = window.location?.protocol || '';
      const isDesktopShell = protocol === 'dsh-app:';
      const isLocalHost = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '';
      if ((!isLocalHost && !isDesktopShell) || !s.proxy?.port) return;
      // 领令牌要打到「门户实际监听的地址」：
      //   - 绑到具体网卡（如 192.168.1.103）时，回环 127.0.0.1 根本没人监听，
      //     此时只能打该网卡地址（Windows 上绑定具体 IP 不会同时监听回环）；
      //   - 桌面壳的 hostname 是 'app'，不能拿来拼 URL。
      const boundHost = s.host && s.host !== '0.0.0.0' ? s.host : null;
      const targetHost = boundHost || (isDesktopShell ? '127.0.0.1' : host);
      try {
        const resp = await fetch(`http://${targetHost}:${s.proxy.port}${ENDPOINT_PREFIX}/loopback-token`, {
          credentials: 'omit',
        });
        if (!resp.ok) {
          // 403/network 都不该静默：管理类控件会一直是禁用态，用户只会觉得"点了没反应"
          setAdminAutoFetchError(
            resp.status === 403
              ? '本机令牌被拒绝（来源不在白名单）。可在「安全认证」里输管理密码解锁。'
              : `本机令牌获取失败（HTTP ${resp.status}），请用管理密码解锁。`,
          );
          return;
        }
        const data = await resp.json();
        if (data?.ok && data.adminToken && !cancelled) {
          setAdminToken(data.adminToken);
          setAdminAutoFetchError(null);
          await refresh(data.adminToken);
          await loadQr(data.adminToken);
        }
      } catch (err) {
        if (!cancelled) {
          setAdminAutoFetchError(`无法连接门户端口 ${s.proxy?.port}（${err?.message ?? err}），请用管理密码解锁。`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [refresh, loadQr]);

  /** 带管理员令牌的 RPC 调用。 */
  const call = async (endpoint, payload) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await rpcCall(endpoint, { ...(payload ?? {}), adminToken: adminToken ?? undefined });
      if (res?.ok) {
        // 切换验证方式 / 防篡改策略会在服务端清空所有管理员解锁态（安全语义要求），
        // 手上的令牌当场失效。这里主动降级为未解锁，避免用户下一次点按钮才莫名被拒。
        const invalidatesAdmin = endpoint === EP.authUpdateConfig
          && (payload?.mode !== undefined || payload?.adminPolicy !== undefined
            || payload?.password !== undefined);
        if (invalidatesAdmin) {
          setAdminToken(null);
          await refresh();
          await loadQr();
          setMsg({ kind: 'ok', text: '已保存。安全策略变更会重置登录态，请重新解锁管理员以继续修改。' });
        } else {
          await refresh(adminToken);
        }
        return res.value;
      }
      const text = res?.error?.message ?? '操作失败';
      setMsg({ kind: 'bad', text });
      // 服务端说需要管理员 → 收起令牌，让锁定条出现
      if (/管理员|解锁|仅限电脑本机/.test(text)) setAdminToken(null);
      return null;
    } catch (err) {
      setMsg({ kind: 'bad', text: `操作失败：${err?.message ?? err}` });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const doUnlock = async () => {
    setBusy(true);
    setUnlockErr(null);
    try {
      const res = await rpcCall(EP.authAdminUnlock, { password: adminPassword });
      if (res?.ok && res.value?.adminToken) {
        setAdminToken(res.value.adminToken);
        setAdminPassword('');
        setMsg({ kind: 'ok', text: '已解锁管理员，现在可以修改安全配置' });
        await refresh(res.value.adminToken);
        await loadQr(res.value.adminToken);
      } else {
        setUnlockErr(res?.error?.message ?? '管理员密码错误');
      }
    } catch (err) {
      setUnlockErr(err?.message ?? '管理员密码错误');
    } finally {
      setBusy(false);
    }
  };

  const doLock = async () => {
    try {
      await rpcCall(EP.authAdminLock, { adminToken });
    } catch { /* 忽略 */ }
    setAdminToken(null);
    setMsg({ kind: 'ok', text: '已锁定管理员' });
    await refresh();
    await loadQr();
  };

  // ---- 工作区：解锁后加载已注册列表 + 主目录浏览 ----
  React.useEffect(() => {
    if (!adminToken) { setWsList(null); setBrowse(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await rpcCall(EP.listWorkspaces, { adminToken });
        if (!cancelled && res?.ok) setWsList(res.value ?? []);
      } catch { /* 列表拿不到不阻塞浏览 */ }
      try {
        const res = await rpcCall(EP.listRemoteDirectories, { adminToken });
        if (!cancelled) {
          if (res?.ok) setBrowse(res.value);
          else setBrowseErr(res?.error?.message ?? '目录浏览失败');
        }
      } catch (err) {
        if (!cancelled) setBrowseErr(err?.message ?? '目录浏览失败');
      }
    })();
    return () => { cancelled = true; };
  }, [adminToken, rpcCall]);

  const browseTo = async (path) => {
    setBrowseErr(null);
    try {
      const res = await rpcCall(EP.listRemoteDirectories, { path, adminToken: adminToken ?? undefined });
      if (res?.ok) {
        setBrowse(res.value);
        if (res.value?.workspaces) setWsList(res.value.workspaces);
      } else {
        setBrowseErr(res?.error?.message ?? '目录浏览失败');
        if (/管理员|解锁/.test(res?.error?.message ?? '')) setAdminToken(null);
      }
    } catch (err) {
      setBrowseErr(err?.message ?? '目录浏览失败');
    }
  };

  const addToWorkspace = async (path) => {
    setAdding(true);
    setBrowseErr(null);
    try {
      const res = await rpcCall(EP.addRemoteWorkspace, { path, adminToken: adminToken ?? undefined });
      if (res?.ok && res.value?.ok) {
        setWsList(res.value.workspaces ?? []);
        setMsg({ kind: 'ok', text: `已添加工作区：${res.value.title}` });
      } else {
        const text = res?.error?.message ?? res?.value?.error ?? '添加失败';
        setBrowseErr(text);
        if (/管理员|解锁/.test(text)) setAdminToken(null);
      }
    } catch (err) {
      setBrowseErr(err?.message ?? '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const runDiagnose = async () => {
    try {
      const res = await rpcCall(EP.diagnose, {});
      if (res?.ok) setDiag(res.value?.checks ?? []);
      else setMsg({ kind: 'bad', text: res?.error?.message ?? '自检失败' });
    } catch (err) {
      setMsg({ kind: 'bad', text: `自检失败：${err?.message ?? err}` });
    }
  };

  if (!status) {
    // 读不到状态时必须给出可操作的失败态，不能永远停在"正在读取…"
    return h('div', { style: S.card },
      h('h3', { style: S.title }, '局域网访问'),
      msg?.kind === 'bad'
        ? h('div', null,
            h('div', { style: { ...S.bad, marginBottom: 10 } }, msg.text),
            h('button', { style: S.btn, onClick: () => void refresh() }, '重试'),
            h('p', { style: S.hint }, '若持续失败，请确认 DSH 主进程仍在运行，然后重启插件。'))
        : h('div', { style: { fontSize: 13 } }, '正在读取局域网访问状态…'));
  }

  const { proxy, lan } = status;

  /**
   * 把用户填的 basePath 翻译成「实际要访问的地址」，让填写结果一眼可验。
   * 与后端 validateBasePath 的归一化规则保持一致（补前导斜杠、去尾斜杠）。
   */
  const previewUrl = (() => {
    // 基线必须用「主机:端口」而不是 lan.url —— lan.url 现在已经带上生效中的 basePath，
    // 拿它再拼输入框里的前缀会得到 /dsh/dsh/。
    const base = `http://${lan.ip || '127.0.0.1'}:${proxy.port}`;
    let p = String(basePathVal || '').trim();
    if (!p || p === '/') return `${base}/`;
    if (!p.startsWith('/')) p = `/${p}`;
    p = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return `${base}${p}/`;
  })();
  const lanUrl = lan.url;

  return h('div', null,

    // ---- 管理员锁定条 ----
    needUnlock
      ? h('div', { style: S.locked },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } },
            '🔒 安全配置已锁定'),
          h('div', { style: { ...S.hint, margin: '0 0 10px' } },
            '修改认证模式、密码、防篡改策略需要管理员权限。'
            + (auth.adminPolicy === 'local_only'
              ? '当前策略为「仅限电脑本机」，请在电脑上用 127.0.0.1 打开本页面。'
              : '请输入管理密码解锁（未单独设置管理密码时，输入访问密码即可）。')),
          // 本机自动领取令牌失败时说明原因，否则用户只会看到"要输密码"却不知为何
          adminAutoFetchError
            ? h('div', { style: { ...S.warn, fontSize: 12, marginBottom: 8 } },
                `本机自动解锁失败：${adminAutoFetchError}`)
            : null,
          auth.adminPolicy === 'local_only'
            ? null
            : h('div', { style: S.row },
                h('input', {
                  style: S.input,
                  type: 'password',
                  placeholder: '管理密码',
                  value: adminPassword,
                  onChange: (e) => setAdminPassword(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') void doUnlock(); },
                }),
                h('button', {
                  style: S.btnPrimary,
                  disabled: busy || !adminPassword,
                  onClick: () => void doUnlock(),
                }, '解锁')),
          unlockErr ? h('div', { style: S.bad }, unlockErr) : null)
      : null,

    msg ? h('div', { style: msg.kind === 'bad' ? { ...S.bad, marginBottom: 12 } : { ...S.ok, marginBottom: 12 }, role: 'alert' }, msg.text) : null,

    // ---------------- 1. 局域网访问 ----------------
    h(Card, { title: '局域网访问' },
      h(Row, { label: '访问地址' },
        h('span', { style: S.mono }, lanUrl ?? '未找到可用网卡'),
        lanUrl ? h('button', {
          style: S.btn,
          onClick: () => navigator.clipboard?.writeText(lanUrl),
        }, '复制') : null),
      h(Row, { label: '状态' },
        h('span', { style: proxy.running ? S.ok : S.bad },
          proxy.running
            ? `运行中 · ${status.host || '0.0.0.0'}:${proxy.port} · ${proxy.activeConnections} 个连接`
            : (proxy.error || '未运行')),
        h('button', {
          style: S.btn,
          disabled: busy,
          onClick: () => void call(EP.restartProxy, {}),
        }, '重启代理')),
      qr?.dataUrl
        ? h(Row, { label: '扫码' },
            h('img', { src: qr.dataUrl, alt: '局域网访问二维码', style: S.qr }))
        : qr?.url
          ? h(Row, { label: '扫码' },
              h('span', { style: S.hint }, '解锁管理员后可生成免密二维码（当前只显示地址）'))
          : null,
      // 「网卡」行已移除：它与「监听地址」职责重叠。对外展示的 IP 现在直接跟随监听地址
      // （绑具体地址就用它；绑 0.0.0.0 时自动挑最佳局域网 IP）。
      h(Row, { label: '端口' },
        h('input', {
          style: S.input,
          value: portVal,
          inputMode: 'numeric',
          onChange: (e) => setPortVal(e.target.value.replace(/[^\d]/g, '')),
        }),
        h('button', {
          style: S.btn,
          disabled: busy,
          onClick: () => void call(EP.setPort, { port: Number(portVal) }),
        }, '应用')),

      // ---- 二级目录（挂载前缀）----
      // 设了前缀即强制生效：只放行该前缀下的路径，未挂载路径一律拒绝（无开关）。
      h(Row, { label: '二级目录' },
        h('input', {
          style: S.input,
          placeholder: '留空 = 站点根；填 /dsh 表示 http://IP:端口/dsh/',
          value: basePathVal,
          disabled: busy,
          onChange: (e) => setBasePathVal(e.target.value),
        })),
      h(Row, { label: '监听地址' },
        h('select', {
          style: S.input,
          value: hostVal,
          disabled: busy,
          onChange: (e) => setHostVal(e.target.value),
        },
          h('option', { value: '0.0.0.0' }, '0.0.0.0（全部网卡，默认）'),
          h('option', { value: '127.0.0.1' }, '127.0.0.1（仅本机）'),
          // 只显示 IP，不堆网卡名：选哪张网卡对用户是噪音，
          // 真正要回答的问题只有一个——「绑到哪个地址」。
          ...(lan.interfaces ?? []).map((i) => h('option', { key: i.address, value: i.address }, i.address)),
          // 已保存但该地址已不存在（换了网络/拔了网线）：保留选项，避免下拉显示空白
          ...(hostVal && hostVal !== '0.0.0.0' && hostVal !== '127.0.0.1'
            && !(lan.interfaces ?? []).some((i) => i.address === hostVal)
            ? [h('option', { key: '__missing__', value: hostVal }, `${hostVal}（当前不可用）`)]
            : []))),
      h(Row, { label: '' },
        h('button', {
          style: S.btnPrimary,
          disabled: busy,
          onClick: async () => {
            setProxyMsg(null);
            const v = await call(EP.setProxyConfig, {
              basePath: basePathVal,
              host: hostVal,
            });
            if (v) {
              setProxyMsg({
                kind: 'ok',
                text: `已保存：挂在 ${v.basePath || '站点根'}，监听 ${v.host}。请用 ${previewUrl} 访问。`,
              });
            } else {
              // call() 把原因写进面板顶部提示；这里复制一份到操作点旁边，
              // 否则滚动到这一段时看不到任何反馈，只会觉得"点了没反应"。
              setProxyMsg({ kind: 'bad', text: msg?.text || '保存失败，原因见面板顶部提示' });
            }
          },
        }, '保存挂载设置')),
      proxyMsg
        ? h('div', { style: { ...(proxyMsg.kind === 'ok' ? S.ok : S.bad), margin: '0 0 8px', lineHeight: 1.6 } },
            proxyMsg.text)
        : null,
      h('p', { style: { ...S.hint, margin: '0 0 6px' } },
        '将从此地址访问：', h('span', { style: S.mono }, previewUrl)),
      h('p', { style: { ...S.warn, margin: '0 0 6px' } },
        '⚠️ 二级目录是 URL 路径前缀，不是域名：要写 /dsh，不要写 -DSH 或 dsh.example.com。'),
      h('p', { style: { ...S.hint, margin: '0 0 6px' } },
        '选 0.0.0.0 时所有地址都能访问；选具体 IP 时只有该地址能访问，访问地址也会跟着变。'),
      basePathVal.trim()
        ? h('p', { style: { ...S.warn, margin: '0 0 6px' } },
            '设定后只允许从该目录访问：根路径会自动跳转到它，其它未挂载路径返回 404。'
            + '若前面有 nginx，请不要让它再剥前缀（proxy_pass http://127.0.0.1:<端口>; 不带尾斜杠）。')
        : null,
      h('p', { style: S.hint },
        '同一 Wi-Fi / 局域网下的手机、平板、其它电脑，打开上面的地址即可继续使用这台电脑上的 DSH。'
        + '扫码只在局域网内有效：路由器不做端口映射，这套地址出不了内网。'
        + '填错二级目录后当前路径会失效，可用本机 127.0.0.1 打开面板改回。')),

    // ---------------- 2. 安全认证 ----------------
    h(Card, { title: '安全认证' },
      // 2.1 总开关
      h(Row, { label: '访问认证' },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
          h('input', {
            type: 'checkbox',
            checked: Boolean(auth.enabled),
            disabled: busy,
            onChange: (e) => void call(EP.authUpdateConfig, { enabled: e.target.checked }),
          }),
          '开启'),
        auth.enabled
          ? h('span', { style: S.ok }, '已开启')
          : h('span', { style: S.warn }, '未开启 · 同网段设备可直接进入')),
      h('p', { style: { ...S.hint, margin: '0 0 12px' } },
        '关闭访问认证不会关闭管理保护：局域网访客可以进来看，但仍然改不了安全配置。'),

      // 2.2 验证模式
      h(Row, { label: '验证方式' },
        h('select', {
          style: S.input,
          value: auth.mode || 'token_and_password',
          disabled: busy,
          onChange: (e) => void call(EP.authUpdateConfig, { mode: e.target.value }),
        },
          ...Object.entries(MODE_LABELS).map(([k, v]) => h('option', { key: k, value: k }, v)))),

      // 2.3 访客密码
      h(Row, { label: '访客密码' },
        h('span', { style: { fontSize: 12, minWidth: 64 } },
          auth.hasPassword ? '已设置' : '未设置'),
        h('input', {
          style: S.input,
          type: 'password',
          placeholder: auth.hasPassword ? '输入新密码以更换（至少 4 位）' : '设置访客访问密码（至少 4 位）',
          value: guestPassword,
          onChange: (e) => setGuestPassword(e.target.value),
        }),
        h('button', {
          style: S.btnPrimary,
          disabled: busy || guestPassword.length < 4,
          onClick: async () => {
            const v = await call(EP.authUpdateConfig, { password: guestPassword });
            if (v) {
              setGuestPassword('');
              setMsg({ kind: 'ok', text: '访客密码已更新，所有访客会话已失效' });
            }
          },
        }, '保存'),
        auth.hasPassword ? h('button', {
          style: S.btnDanger,
          disabled: busy,
          onClick: async () => {
            const v = await call(EP.authUpdateConfig, { password: '' });
            if (v) setMsg({ kind: 'ok', text: '已清除访客密码' });
          },
        }, '清除') : null),

      // 2.4 管理密码
      h(Row, { label: '管理密码' },
        h('span', { style: { fontSize: 12, minWidth: 64 } },
          auth.hasAdminPassword ? '已设置' : '未设置'),
        h('input', {
          style: S.input,
          type: 'password',
          placeholder: auth.hasAdminPassword ? '输入新密码以更换（至少 4 位）' : '设置管理密码（可留空：沿用访客密码）',
          value: adminPasswordNew,
          onChange: (e) => setAdminPasswordNew(e.target.value),
        }),
        h('button', {
          style: S.btnPrimary,
          disabled: busy || adminPasswordNew.length < 4,
          onClick: async () => {
            const v = await call(EP.authUpdateConfig, { adminPassword: adminPasswordNew });
            if (v) {
              setAdminPasswordNew('');
              setMsg({ kind: 'ok', text: '管理密码已更新，所有管理员解锁态已重置' });
            }
          },
        }, '保存'),
        auth.hasAdminPassword ? h('button', {
          style: S.btnDanger,
          disabled: busy,
          onClick: async () => {
            const v = await call(EP.authUpdateConfig, { adminPassword: '' });
            if (v) setMsg({ kind: 'ok', text: '已清除管理密码（后续沿用访客密码）' });
          },
        }, '清除') : null),
      h('p', { style: S.hint },
        '访客密码用于「进入 DSH」；管理密码用于「修改安全配置」和「查看免密二维码」。'
        + '未单独设置管理密码时，两件事共用访客密码。'),

      // 2.5 防篡改策略
      h(Row, { label: '防篡改' },
        h('select', {
          style: S.input,
          value: auth.adminPolicy || 'password_unlock',
          disabled: busy,
          onChange: (e) => void call(EP.authUpdateConfig, { adminPolicy: e.target.value }),
        },
          ...Object.entries(POLICY_LABELS).map(([k, v]) => h('option', { key: k, value: k }, v)))),

      // 2.6 管理保护开关
      h(Row, { label: '管理保护' },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
          h('input', {
            type: 'checkbox',
            checked: auth.adminProtection !== false,
            disabled: busy,
            onChange: (e) => void call(EP.authUpdateConfig, { adminProtection: e.target.checked }),
          }),
          '修改配置需要管理权限'),
        auth.adminProtection === false
          ? h('span', { style: S.warn }, '已关闭 · 局域网内任何人都能改配置')
          : null),

      // 2.7 本机免密
      h(Row, { label: '本机免密' },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
          h('input', {
            type: 'checkbox',
            checked: auth.allowLoopback !== false,
            disabled: busy,
            onChange: (e) => void call(EP.authUpdateConfig, { allowLoopback: e.target.checked }),
          }),
          '127.0.0.1 直连不用密码')),

      // 2.8 令牌
      h(Row, { label: '扫码令牌' },
        h('span', { style: S.mono }, auth.secretToken || '—'),
        h('button', {
          style: S.btn,
          disabled: busy,
          onClick: async () => {
            const v = await call(EP.authRegenerateToken, {});
            if (v) {
              setQr(null);
              await loadQr(adminToken);
              setMsg({ kind: 'ok', text: '令牌已重置，旧二维码全部失效' });
            }
          },
        }, '重置'),
        adminToken
          ? h('button', { style: S.btn, onClick: () => void doLock() }, '锁定管理')
          : null),
      h('p', { style: S.hint },
        '令牌内嵌在二维码里，是本机签发的 256 位随机串；重置后所有旧二维码立即失效。'
        + '「密码 + 扫码」模式下它是免密直通的钥匙，请当作密码保管。')),

    // 3. 工作区（本机目录浏览 + 注册，手机端不提供）
    h(Card, { title: '工作区' },
      !adminToken
        ? h('p', { style: S.hint },
            '解锁管理员后可在这里浏览这台电脑的目录，把文件夹一键注册为 DSH 工作区。'
            + '本机用 127.0.0.1 打开面板会自动解锁。')
        : h('div', null,
            h(Row, { label: '已注册' },
              wsList === null
                ? h('span', { style: { fontSize: 12 } }, '读取中…')
                : wsList.length === 0
                  ? h('span', { style: { fontSize: 12 } }, '还没有工作区')
                  : h('div', { style: { flex: 1, minWidth: 220 } },
                      ...wsList.map((w) => h('div', { key: w.id ?? w.path, style: { fontSize: 12, padding: '2px 0' } },
                        h('span', { style: { fontWeight: 500 } }, w.title),
                        ' ',
                        h('span', { style: S.hint }, w.path))))),
            browse?.roots?.length
              ? h(Row, { label: '快捷' },
                  ...browse.roots.map((r) => h('button', {
                    key: r.path, style: S.btn, onClick: () => void browseTo(r.path),
                  }, r.name)),
                  ...browse.drives.map((d) => h('button', {
                    key: d.path, style: S.btn, onClick: () => void browseTo(d.path),
                  }, d.name)))
              : null,
            browse
              ? h(Row, { label: '位置' },
                  ...browse.breadcrumbs.map((b) => h('button', {
                    key: b.path, style: { ...S.btn, padding: '4px 8px' }, onClick: () => void browseTo(b.path),
                  }, b.name)))
              : null,
            browse
              ? h('div', {
                  style: {
                    maxHeight: 200, overflowY: 'auto', marginBottom: 8,
                    border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 8, padding: '6px 10px',
                  },
                },
                browse.entries.length === 0
                  ? h('div', { style: S.hint }, '（没有可显示的子目录）')
                  : browse.entries.map((e) => h('div', {
                      key: e.path, onClick: () => void browseTo(e.path),
                      style: { fontSize: 12, padding: '3px 4px', cursor: 'pointer', borderRadius: 4 },
                    }, '📁 ', e.name)))
              : null,
            browseErr ? h('div', { style: { ...S.bad, marginBottom: 8 } }, browseErr) : null,
            browse
              ? h(Row, { label: '当前目录' },
                  h('span', { style: S.mono }, browse.currentPath),
                  h('button', {
                    style: S.btnPrimary,
                    disabled: busy || adding,
                    onClick: () => void addToWorkspace(browse.currentPath),
                  }, adding ? '添加中…' : '添加为工作区'))
              : null),
      h('p', { style: S.hint },
        '添加后可在工作区中新建对话，对话将以该目录为工作目录。'
        + '.ssh / .git 等敏感目录与系统目录已默认屏蔽。')),

    // 4. 自检
    h(Card, { title: '自检' },
      h(Row, { label: '检查' },
        h('button', {
          style: S.btn,
          disabled: busy,
          onClick: () => void runDiagnose(),
        }, '运行自检')),
      diag
        ? h('div', null, ...diag.map((c) => h('div', {
            key: c.id,
            style: { display: 'flex', gap: 8, fontSize: 12, padding: '4px 0' },
          },
            h('span', { style: { width: 14, textAlign: 'center' } }, c.ok ? '✓' : (c.warnOnly ? '!' : '✗')),
            h('span', { style: { minWidth: 92, fontWeight: 500 } }, c.label),
            h('span', { style: c.ok ? S.ok : (c.warnOnly ? S.warn : S.bad) }, c.detail))))
        : h('p', { style: S.hint }, '点「运行自检」检查上游服务、代理端口、网卡、回环凭据与门禁状态。')),

    // 版本页脚：排障第一眼要看的东西（升级后是否真的生效、面板与包是否同版本）
    h('p', { style: { ...S.hint, textAlign: 'center', marginTop: 4 } },
      `dsh-porthole v${status.version || '(未知)'}`
      + (status.basePath ? ` · 挂在 ${status.basePath}` : '')
      + (status.host && status.host !== '0.0.0.0' ? ` · 仅监听 ${status.host}` : '')));
}

function apply(ctx) {
  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(BRIDGE_RPC_CHANNEL, endpoint, payload, signal);

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'dsh-porthole',
      order: 10,
      label: () => '远程访问',
    },
    (props) => h(BridgePanel, { ...props, rpcCall }),
  ));
}

export { name, inject, apply, BridgePanel, EP };
