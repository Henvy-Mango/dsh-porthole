# dsh-porthole 能力差异报告

**定位**：本机 DSH 的**统一入口门户**——局域网直连，或经 frps / EasyTier 等外部打洞链路打进来，
都落在同一个反代 + 门禁上。不绑定具体传输方式。
**对比基准**：[wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) `main` @ `v2.17.8`（下文称「原版」）
**本插件版本**：`dsh-porthole@1.2.0`
**范围约定**：只保留「网页转发 + 局域网 + 访问安全认证 + 会话投影剥离 + 远程工作区管理（无手机端 UI）」，
其余能力一律不实现。本报告逐项列出被移除的能力、移除理由、以及**用户实际会感知到的后果**与**替代办法**。

> **v1.1.1 变更**：修复 DSH ≥0.1.5 上插件不激活的宿主回归（§4.2）；网卡识别加固。
> **v1.2.0 变更**（本版）：① 按需求迁移 **1.6 会话投影剥离**；② 按需求迁移 **1.4 远程工作区管理**
> （仅面板 UI，不做手机端 Slot 接管），并顺带修掉上游「`this.ctx` 从未赋值导致工作区从不真正注册」的 bug；
> ③ **§4.1 polyfill 实测关闭**（当前宿主前端不含 `randomUUID` 调用）；④ 插件更名为 `dsh-porthole`，
> 以全新插件形态发布（不迁移旧版 `dsh-bridge-lite` 数据）。

---

## 0. 一句话结论

本插件砍掉了原版 **47 个 RPC 端点中的 33 个**、`lib/` 下 **21 627 行源码中的 18 233 行**、
以及 `ws` / `@larksuite/*` / `@tencent-connect/*` / `cloudflared` 二进制等全部外部依赖。
省下的是**内置的隧道实现**、**IM 直达通道**、**手机端交互优化**与**运维面板**；
留下的是「给本机 DSH 开一扇门户」这一条主链路——局域网直连，或由 frps / EasyTier 等外部链路打进来，
**转发正确性、鉴权强度（双密码 + 防篡改锁）、会话投影剥离、远程工作区管理、断线抵抗力**与原版一致。

> **与「省下公网可达性」的区别**：porthole 自身不实现隧道，但门户是**传输无关**的——
> 外部链路（frps 端口映射、EasyTier 组网、自建反代）只要打到它的监听端口，同样受完整门禁保护。
> 原版把隧道做进插件（cloudflared 生命周期 + 二进制管理）；porthole 选择让外部工具干这件事。

| 维度 | 原版 dsh-bridge | dsh-porthole（v1.2.0） | 变化 |
| --- | --- | --- | --- |
| 服务端源码（不含 vendor bundle） | 21 627 行 | 3 394 行 | **−84.3%** |
| 客户端源码 | 9 979 行 | 693 行 | **−93.1%** |
| 客户端产物 `client.js` | 512 KB | 30 KB | **−94.0%** |
| npm 运行时依赖 | `qrcode`, `ws` + 3 个 peer/optional | `qrcode` + 1 个 peer | **−2** |
| RPC 端点 | 47 | 14 | **−33** |
| 宿主 inject 服务 | 7 个 | 4 个 | **−3** |
| 对外入口 | 局域网 + Cloudflare + 自建隧道 | 仅局域网 | **−2 类** |

> 行数口径：`find lib -name '*.js' -o -name '*.mjs' | xargs wc -l`，已剔除
> `lib/feishu/lark-bundled.mjs`（131 929 行）与 `lib/qq/qqbot-bundled.mjs`（8 255 行）两个第三方 vendored 产物。
> porthole 侧含沿用上游的 `sse-keepalive.js` / `dsh-native-cookie.js` / `compat.js` / `rate-limiter.js` /
> `session-strip.js` / `connection-compat.js`。

---

## 1. 完全移除的能力（按影响面排序）

### 1.1 公网访问：全部三种隧道 —— **最高影响**

| 能力 | 原版实现 | porthole |
| --- | --- | --- |
| Cloudflare 临时隧道（免登录随机域名） | `lib/cloudflared-manager.mjs`（1266 行）+ 下载/校验/拉起 cloudflared 二进制 | ❌ 无 |
| Cloudflare Token 固定域名 + 随 DSH 自启 | 同上 + `cloudflared-network-args.js`（协议/边缘 IP/区域白名单） | ❌ 无 |
| 自建 WebSocket 反向隧道 | `lib/tunnel-client.mjs`（537 行）+ `scripts/install-tunnel-server.sh` | ❌ 无 |
| 外部隧道登记（用户自己 Docker 部署） | `saveExternalTunnel` + 地址归一化 + 二维码 | ❌ 无 |
| 隧道可观测性（DNS/TLS/边缘/回源端到端探测、疑似 DNS 污染标注、二进制画像、同 Token 冲突检测） | `getStatus().cloudflared.dataPlane/binary/foreignRunner` | ❌ 无 |
| 隧道鉴权来源判定（`cf-ray` / `x-dsh-internal-tunnel` 识别） | `loopback-token` 里区分 `isCloudflare` / `isCustomTunnel` | ❌ 无 |

**你会感知到什么**

- 出门在外（4G/5G、公司网络、异地）**打不开**家里的 DSH。porthole 的地址是 `192.168.x.x`，离开这个网段就不存在。
- 原版的「扫个码，人在外面也能接着干」在 porthole 里退化为「必须在同一个 Wi-Fi 里」。
- 没有公网入口，也就没有「云端 vs 本地」的链路诊断，断线只能靠客户端表现判断。

**替代办法**（都要你自己动手，porthole 不提供）

1. 家用路由器做端口映射 + 自己签 HTTPS 证书 —— 但 DSH 自身的浏览器鉴权 cookie 绑定 `127.0.0.1`，
   外部直连 DSH 端口会遇到 origin 校验问题；**porthole 的代理层会做 Host/Origin/Referer 改写**，
   所以更现实的姿势是：端口映射到 **porthole 的 3082**，再配一层反代终止 TLS。
2. 用 Tailscale / ZeroTier 组虚拟局域网 —— 但这两类网卡在 porthole 的网卡排序里被判为虚拟网卡**降权 200 分**，
   面板默认不会选它；需要在「网卡」下拉里**手动选中** Tailscale 的 `100.x` 地址。
   （原版也有同样的降权逻辑，但原版可以直接开隧道绕开这个问题。）
3. 自建 frp / nps 等通用隧道指向 porthole 端口 —— 可以工作，但没有原版那种「一键 + 自启 + 状态可视化」。

---

### 1.2 IM 机器人矩阵：微信 / QQ / 飞书 / Telegram —— **影响面第二大**

| 能力 | 原版实现规模 | porthole |
| --- | --- | --- |
| 微信 Bot（ClawBot / iLink，扫码登录、媒体收发、消息分片） | `lib/wechat/*` ≈ 1950 行 | ❌ 无 |
| QQ Bot（官方 `@tencent-connect/qqbot-nodejs` SDK，长连接/RESUME/富媒体/C2C 流式） | `lib/qq/*` ≈ 2900 行 + 8255 行 vendored bundle | ❌ 无 |
| 飞书 Bot（官方 Channel SDK，扫码一键建应用、12 条斜杠指令、云文档评论 @、卡片审批原地更新） | `lib/feishu/*` ≈ 2500 行 + 131 929 行 vendored bundle | ❌ 无 |
| Telegram Bot（Long Polling + 代理） | `lib/telegram/*` ≈ 1300 行 | ❌ 无 |
| 统一平台编排（多工作区调度、会话持久化、流式输出、审批/问答卡片、文件双向传输、本轮改动摘要 `/diff`） | `lib/platform/*` ≈ 4900 行 | ❌ 无 |
| 多账号矩阵（同平台多实例、运行时增删、`instanceId` 契约） | `lib/platform/instances.js` + `account-ops.js` ≈ 700 行 | ❌ 无 |
| 白名单 `allowFrom`、群聊 @ 触发、机器人指令面板 | 各平台 gateway | ❌ 无 |

**你会感知到什么**

- **不能**在微信里给 DSH 发一句话让它干活；**不能**在飞书卡片上点「通过」来批准一次文件写入。
- **不能**让 Agent 主动把结果推送到 IM —— porthole 是纯拉取模型，你必须主动打开网页看。
- Agent 跑到一半要你审批时，porthole 用户只能守着浏览器；原版可以在手机上点一下卡片。
- 没有 `/diff` 导出补丁、没有「本轮改了哪些文件」的播报。

**替代办法**：保留原版 dsh-bridge 只开 IM、关掉隧道；或两者共存（注意：两者都注册
`settings.section`，会各出现一个「远程访问」条目，且都要占一个监听端口）。

> ⚠️ **共存注意**：porthole 与原版使用**不同的数据目录**（`~/.dsh/dsh-porthole/` vs `~/.dsh/dsh-bridge/`）
> 与**不同的 RPC 通道**（`/dsh-porthole` vs `/dsh-bridge`），不会互相覆盖配置；
> 但两者**默认端口都是 3082**，同时启用必须改其中一个。

---

### 1.3 移动端页面改写与 PWA —— 体验层整体移除

| 能力 | 原版实现 | porthole |
| --- | --- | --- |
| 移动端样式层（顶栏、抽屉、输入框折叠、iOS 键盘适配、防重叠工具栏） | `client/mobile-styles.js` 1299 行 + `client/mobile-yield.js` 219 行 | ❌ 无 |
| 宿主 CSS-module 类名运行时解析 + 变化监听（跨 DSH 版本兼容） | `client/host-families.js` 442 行 | ❌ 无 |
| 设置页窄屏两级钻取（≤480px 列表/详情切换） | `client/index.js` CSS 6.2 块 | ❌ 无 |
| 设置页导航图标替换 | `client/settings-nav-icon.js` 105 行 | ❌ 无 |
| PWA Manifest / 图标 / `apple-mobile-web-app-*` / 独立全屏 App | 服务端 HTML 注入 `manifest.webmanifest` + `pwa-icon.svg` | ❌ 无 |
| 浏览器 polyfill 注入（`crypto.randomUUID`、`AbortSignal.any`、`Promise.iterator`） | HTML `<head>` 注入 3 段脚本 | ❌ 无 |
| viewport / overscroll / theme-color 注入 | `HTML_HEAD_ASSETS` | ❌ 无 |
| 主题令牌注入（深色模式告警面/边框） | `client/theme-tokens.js` | ❌ 无 |
| 页面改写层总开关（`mobileUi` / `DSH_BRIDGE_MOBILE_UI` / 面板开关三层） | `resolveMobileUiEnabled` + `uiGetFlags/uiUpdateConfig` | ❌ 无 |

**你会感知到什么**

这是**最容易踩坑的一项**，因为它不是「少了个功能」，而是「页面变回 DSH 桌面版原样」。

- 手机上打开会是**桌面布局**：右侧栏不会自动全屏、工具栏可能重叠、输入框不会随键盘收起。
  原版把这些都改写了，porthole 完全不做 —— 这是**有意为之**：页面 HTML 一律原样透传，
  代理层只在 `session/list` 这一个 JSON 端点上做投影剥离（§1.6），从不改写页面结构与样式。
- **不能「添加到主屏幕」当独立 App 用**：没有 manifest，加进去就是个普通网页书签。
- 老旧 iOS Safari / 微信内置 WebView 里，如果 DSH 依赖 `crypto.randomUUID`，
  在 **HTTP（非 HTTPS）局域网地址**下会缺失 —— 原版注入 polyfill 兜住了，porthole 没有。
  **这是 porthole 已知的功能性缺陷**，见 §4.1。

**替代办法**：用桌面浏览器开（porthole 本来就是为「同网段的第二块屏幕」设计的）；
或者保留原版并设 `mobileUi: true`。

---

### 1.4 远程工作区管理 —— **已迁移（v1.2.0，按需求去掉手机端 UI）**

| 能力 | 原版 | porthole | 说明 |
| --- | --- | --- | --- |
| 目录浏览（`listRemoteDirectories`：根目录 / 盘符 / 面包屑 / 子目录） | ✅ | ✅ **已迁移** | 敏感目录与不安全符号链接过滤逐字对齐 |
| 路径安全校验（`path-validator.js`：系统目录、`.ssh` 等黑名单、符号链接逃逸、UNC） | ✅ 195 行 | ✅ **已迁移** | 同一份代码 |
| 远程添加工作区（`addRemoteWorkspace` → DSH `workspaceRegistry` + 挂会话） | ⚠️ 有 bug | ✅ **已迁移并修好** | 见下方说明 |
| 工作区列表（`listWorkspaces`） | ⚠️ 有 bug | ✅ **已迁移并修好** | 同上 |
| 面板 UI | 手机抽屉 + 目录 Slot 接管 | ✅ **设置页「工作区」卡片**（本机浏览 / 一键添加） | 按需求**不做手机端**：不接管 `directoryFlow` Slot，手机上「添加工作区」继续走 DSH 原生流程 |
| 鉴权 | `checkAdminAuth` + `requireConfigured`（浏览 30/min、添加 20/min 限流） | ✅ 同策略 | 未设密码时浏览/添加会被拒并提示先设密码 |

**修复的上游 bug**：原版 `BridgeService` 里 `this.ctx` **从未被赋值**——`getWorkspaces()` / `addWorkspace()`
写的是 `this.ctx?.workspaceRegistry`，实际永远是 `undefined`。也就是说原版的「远程添加工作区」
只做了路径安全校验就返回 `{ok:true, registered:false}`，**从不真正注册**。porthole 把宿主 ctx 显式
传入服务（`hostCtx`），实机验证：注册返回 DSH 真实 `workspaceId`（UUID）、创建并挂接了会话、
`listWorkspaces` 能回读。

---

### 1.5 运维看板与宿主生命周期

| 能力 | 原版 | porthole |
| --- | --- | --- |
| 系统指标（CPU / 内存 / Uptime / loadavg） | `getSystemMetrics` 42 行 + `os` 全量导入 | ❌ 无 |
| 网络连通性一键诊断（多目标探测） | `diagnoseNetwork` 140 行 | ⚠️ **降级保留**（见 §2） |
| 版本检查（npmmirror，10 分钟 TTL 缓存） | `checkVersion` | ❌ 无 |
| 插件自升级（`upgradePlugin`，增强 PATH 的 spawn） | 72 行 | ❌ 无 |
| 宿主 DSH 升级（`upgradeDsh`） | 125 行 | ❌ 无 |
| 一键平滑重启（systemd / 守护进程 / 重启助手三分支） | `restartDsh` 108 行 + `restart-helper.mjs` 133 行 + `restart-active-work-guard` | ❌ 无 |
| 运行中任务探测（重启前拦住「有 turn 在跑」） | `getActiveWork` + `describeOpenTurn`（1658 行 conversation-bridge 的一部分） | ❌ 无 |
| 配置备份导出 / 导入恢复 | `exportBackup` / `importBackup` | ❌ 无 |
| 桌面宿主识别（Electron / desktop-host，避免重启拉出孤儿进程） | `isDesktopHost` / `currentProfileName` | ❌ 无（因为不再重启宿主） |
| 首次启用引导（门禁未开时的提示卡） | `firstRunGuide` + `dismissFirstRunGuide` | ⚠️ **降级保留**（面板常驻风险提示，无一次性引导） |

**你会感知到什么**：装了 porthole 之后，**每次改插件配置都得手动重启 `dsh web`** ——
porthole 面板里只有「重启代理」（重启自己的 3082 监听），不会重启 DSH 宿主。
升级插件也得手动跑 `dsh plugin add`。

---

### 1.6 会话与响应体加工 —— **已迁移（v1.2.0）**

| 能力 | 原版 | porthole | 说明 |
| --- | --- | --- | --- |
| 会话投影剥离（`session/list` 等端点移除 `contextHeaders` / `contextTimeline`） | `lib/session-strip.js` 100 行 | ✅ **已迁移**（同一份代码） | 剥离后实测传输体积降一个量级 |
| gzip 响应解压后剥离再回写 | ✅ | ✅ **已迁移** | DSH 默认开 gzip，不解压就会静默跳过剥离 |
| 命中失败时原样返回（绝不破坏响应） | ✅ | ✅ **已迁移** | 非 200 / 解析失败 / 结构不符一律直通 |

**实机验证（DSH 0.2.1-rc.5）**：经代理 POST `/api/session/list`（envelope 形如
`{args:{_request:{}}}`），返回的 9 个真实会话**全部已剥离** `contextHeaders` /
`contextTimeline`，响应头正确去掉了 `content-encoding` 并重算 `content-length`。
注意 `session/history` 在当前 DSH 版本已不存在（历史读取走 `session/page`），
该分支仅作为兼容面保留。

**取舍说明**：这解除了 porthole 早期「不碰响应体一个字节」的承诺——但仅限命中
`session/list` 的 200 响应，其余流量仍逐字节直通。

---

### 1.7 安全体系 —— **已完整迁移（v1.1.0）**

原先这一节整节都是「无」，按用户要求已把认证体系整套搬过来。现在只剩三项因定位原因不适用：

| 能力 | 原版 | porthole | 说明 |
| --- | --- | --- | --- |
| 访问密码（访客） | ✅ PBKDF2 600k + 失败封禁 | ✅ **一致** | 哈希格式完全相同 |
| 独立**管理员密码** | ✅ | ✅ **已迁移** | 未设时回退校验访客密码 |
| 后台防篡改锁 `adminPolicy`（`password_unlock` / `local_only` / `open`） | ✅ | ✅ **已迁移** | 三态语义逐字对齐 |
| 管理保护独立开关 `adminProtection` | ✅ | ✅ **已迁移** | 与访问认证解耦 |
| 管理员会话（30 分钟过期、改密码/改策略即吊销） | ✅ | ✅ **已迁移** | |
| 验证模式 `mode`（`token_and_password` / `password_only` / `token_only`） | ✅ | ✅ **已迁移** | 三种模式全部生效 |
| `loopback-token` 端点（本机免密领 adminToken） | ✅ CORS 收敛到来源白名单 | ✅ **已迁移** | 额外加了「Host 必须是回环」一道闸 |
| `reset-auth` 应急复位文件 | ✅ | ✅ **已迁移** | 一次性，复位后自动删除标记 |
| 令牌脱敏（`getStatus({masked})` / `getRawSecretToken`） | ✅ | ✅ **已迁移** | 非管理员只看到前缀 + `***` |
| 高危操作 `requireConfigured` 拒绝 | ✅ | ✅ 机制已实现 | 但 porthole 没有隧道/备份这类极高危操作，实际未触发 |
| 访问范围 `scope`（`all` / `lan_only` / `public_only`） | ✅ | ❌ **不适用** | porthole 只有局域网一种入口，没有可区分的对象 |
| 内部隧道密钥 `internalTunnelSecret` | ✅ | ❌ **不适用** | 没有隧道，无需辨别隧道转发流量 |
| 日志注入净化 / 敏感路径校验 | ✅ | ❌ 无 | `log-sanitize.js` 50 行、`path-validator.js` 195 行；porthole 不做目录浏览、不拼用户输入进日志 |

**比原版更强的一点**：`loopback-token` 除了原有的「remoteAddress 必须是回环」+「Origin 白名单」，
porthole 还要求 `Host` 头是 `127.0.0.1` / `localhost`。原因是 porthole 明确只有局域网一种入口，
任何反向代理转发进来时 `remoteAddress` 同样是回环 —— 但 `Host` 会是外部域名。
不加这道闸，一个挂在同机上的反向代理就能替外部请求领走 adminToken。

**迁移时修掉的一个死锁**（上游也有，porthole 必须处理得更稳）：
用户先设访客密码，`hasAnyPassword` 立刻为真 → 再设管理密码就被「需要管理员」拦下 →
而解锁又要用管理密码 → 死锁。porthole 引入「**首次初始化豁免**」：
某类密码从「未设置」变「已设置」不需要管理员权限，但**修改或清除已存在的密码仍然需要**。
这样既解开死锁，又挡住"把别人设好的密码换成自己的"这种接管。

---

### 1.8 兼容垫片与版本适配

| 能力 | 原版 | porthole |
| --- | --- | --- |
| connection RPC 注册回归兜底（DSH ≥ 0.1.5-alpha.1 的 `without inject` 报错） | `connection-compat.js` 115 行，`internal/get` 瀑布事件临时挂兜底 | ❌ **无 —— 已知风险，见 §4.2** |
| 宿主类名运行时解析（跨 DSH CSS-module 版本） | `host-families.js` | ❌ 无（不注入样式，自然不需要） |
| `AbortSignal.any` / `Promise.iterator` 服务端垫片 | `compat.js` 172 行 | ✅ **保留**（DSH 核心链每次 agent 请求都调用，缺了会 `(internal)`） |
| 浏览器侧 `crypto.randomUUID` 等 polyfill | HTML 注入 | ❌ **无 —— 见 §4.1** |
| 资源 URL 兼容（`resource-url-compat.js`） | 90 行 | ❌ 无 |

---

### 1.9 工程配套

| 项目 | 原版 | porthole |
| --- | --- | --- |
| 单元/集成测试 | `test/` 下 100 个 `.test.mjs` | 71 个用例（5 个文件） |
| 浏览器端 UI 验收（puppeteer-core） | `test/browser/` 12 个脚本 + `run-all.mjs` | ❌ 无 |
| ESLint 配置 + CodeQL / dependabot / release workflow | 有 | ❌ 无 |
| 中英文完整文档（README 双语 66 KB + `docs/` 20 篇） | 有 | 单页 README + 本报告 |
| i18n（`locale/zh.json` / `locale/en.json` + 面板逐条翻译 + 运行时按 `<html lang>` 切换） | `client/locales.mjs` 241 行 + `panel-locales.mjs` 719 行 + 校验测试 | ❌ 中文硬编码（登录页仍按 `Accept-Language` 双语） |
| 发布流水线（GitHub Release / npm 打包 / banner 生成） | `scripts/` + `.github/workflows` | ❌ 无 |
| `llms.txt`（给 AI 的摘要） | 有 | ❌ 无 |

---

## 2. 降级保留（有，但能力缩水）

| 能力 | 原版 | porthole | 差异说明 |
| --- | --- | --- | --- |
| **网络诊断** | `diagnoseNetwork`：多目标连通性探测 | `diagnose`：5 项自检（上游 DSH / 代理端口 / 局域网地址 / 回环凭据 / 门禁） | porthole 只查「自己这条链路通不通」，不查外网、不查 DNS、不查隧道 |
| **局域网网卡选择** | 多网卡枚举 + 手动切换 + 持久化 | ✅ **完整保留**，且**更严**：额外识别代理 TUN 适配器（Mihomo / Clash / sing-box / wintun）与 RFC 2544 基准段 `198.18.0.0/15` | 原版会把 `Mihomo 198.18.0.1` 当成物理网卡（实测本机） |
| **二维码** | 局域网 / Cloudflare / 自建隧道 / 外部隧道四套二维码 + LRU 缓存 | 仅局域网二维码；无缓存（每次现算，320px dataURL） | 少三套；性能可忽略 |
| **SSE 保活** | `sse-keepalive.js`，25 s 阈值，3 条护栏 | ✅ **完整保留**（同一份代码） | 无差异。虽然局域网极少空闲回收，但成本只有每 25 s 12 字节 |
| **访问密码** | PBKDF2 600k + 旧哈希透明升级 | ✅ **完整保留** | 无差异 |
| **登录会话持久化** | `sessions.json` 0600，跨宿主重启恢复 | ✅ **保留**（同机制，独立文件） | 无差异 |
| **失败封禁** | 5 次失败锁 60 s | ✅ **保留** | 无差异 |
| **首次启用引导** | 一次性弹窗 + `wizard.guideShown` 持久化 | 面板内**常驻**一行风险提示，无一次性引导 | porthole 更简单也更聒噪；不会「确认过就不再提醒」 |
| **配置持久化** | `config.json` 0600 + 互斥队列 | ✅ **保留**（同机制，`~/.dsh/dsh-porthole/config.json`） | 目录不同，不冲突 |

---

## 3. 完全保留（porthole 的核心资产）

| 能力 | 说明 |
| --- | --- |
| **HTTP 反向代理** | 页面 / API / 静态资源全量透传，不缓冲、不改写响应体 |
| **WebSocket 转发** | `/plugins/events` 等实时通道；101 响应只放行 5 个白名单头，防止上游注入 `set-cookie` |
| **loopback cookie 注入** | 按 DSH 格式现签 HMAC 会话 cookie；同时注入「含端口」与「忽略端口」两种名称口径（兼容被本地补丁改过的宿主）；注入前按名剔除浏览器残留同名旧值（宿主「同名取第一个」会读到旧值 → 永久 401） |
| **Host / Origin / Referer 改写** | 让 DSH 的回环来源校验放行；Referer 只替换 origin，保留路径与查询 |
| **hop-by-hop 头净化** | `connection` / `transfer-encoding` / `upgrade` 等 8 个不透传 |
| **上游 socket error 监听** | 缺了会让一次 RST 变成未捕获异常直接打死 dsh 进程（原版 issue #81 的教训，已继承） |
| **多网卡智能排序** | 私有网段加分、物理网卡 +100、无线再 +50、虚拟网卡 −200 |
| **HTTP + WS 双通道鉴权** | 同一个 `verifyRequest` 覆盖两种协议；URL token 直通后 302 到干净 URL |
| **登录页** | 纯内联、零外链、< 8 KB、中英双语（`Accept-Language`） |

---

## 4. 已知风险与缺陷

### 4.1 【低·当前宿主非必需】HTTP 局域网地址下缺少浏览器 polyfill

原版通过服务端 HTML 注入补齐 `crypto.randomUUID` / `AbortSignal.any` / `Promise.iterator`，
用来兜住「不安全上下文（HTTP 非 localhost）」下这些 API 缺失的浏览器。
porthole 明确不注入响应体，**因此这条兜底没有了**。

**实测结论（2026-11-03，定级【中】→【低·当前宿主非必需】）**：在本机 DSH **0.2.1-rc.5** 的
`dsh-web-frontend` 全量产物里检索 `randomUUID`，**出现 0 次**——当前宿主的核心前端
不依赖这个 API；`AbortSignal.any` 在 Chrome 97+ / Safari 15.4+ 原生支持，
`Promise.iterator` 同样只在旧 WebView 缺失。也就是说：

- 用现代浏览器（近三年的 Chrome / Edge / Safari）经 HTTP 局域网地址访问：**无影响**；
- 只有当手机用很老的 WebView（如旧版微信内置浏览器），或安装了**依赖这些 API 的
  第三方客户端插件**时才会实际触发。

**结论**：不做。若未来手机端出现 `crypto.randomUUID is not a function`，再按原版方式
加回那 3 段 `<head>` 注入（约 20 行，只改 head、不动业务），届时升级本报告即可。

### 4.2 【已解决 v1.1.1】connection RPC 注册回归 —— 曾导致插件完全不激活

DSH ≥ `0.1.5-alpha.1` 的 `@deepseek-ai/dsh-client-connection` 存在宿主侧回归：
`HostConnectionService.register()` 里写的是 `owner.effect(() => owner.webServer.register(route))`，
而 `owner` 是 **connection 插件自己的 ctx**（`get rpc() { const owner = this.ctx }`），
它的 fiber 不把 `webServer` 记入 inject，于是 cordis 4 的服务守卫直接抛
`cannot get property "webServer" without inject`。

**实测命中**：本机 DeepSeek Harness 桌面版 **0.2.1-rc.5**（`dsh-client-connection` 同行）。

**真实表现**（不是"起不来"，而是"静默不工作"）：

```
dsh: warning: 1 entry did not activate
dsh-porthole (dsh-porthole): Error: cannot get property "webServer" without inject
    at .../@deepseek-ai/dsh-client-connection/lib/index.js:871
    at installRpc (.../dsh-porthole/lib/rpc.js:265)
    at new apply (.../dsh-porthole/lib/index.js:242)
```

宿主本身照常启动（0.2.1-rc.5 把未激活条目降级为 warning），但**插件条目压根没激活**：
代理不监听、设置页没有入口、二维码拿不到。v1.1.1 已移植 `connection-compat.js`，
把注册改走 `registerRpcChannel()`：命中回归时在 root 的 `internal/get` 瀑布事件上临时挂兜底，
默认解析失败才补上本插件已 inject 的单例 `webServer`，注册完成后立即摘除，对宿主零副作用；
上游修好后垫片自动空转。

**回归验证**：修前 `--dump-config` 正常但启动报上面那段错；修后同一 profile 启动无任何告警，
代理 3895 正常监听，直连 DSH 401 / 经 porthole 200，自检五项全绿。

### 4.3 【低】没有端口冲突自动避让

端口被占用时只会在面板显示「端口已被占用」，不会自动换下一个可用端口。
好处是行为可预测（用户配置的端口就是用户配置的端口），代价是需要手动改。

### 4.4 【已解决】密码遗忘救急通道

v1.1.0 起已迁移 `reset-auth` 机制：`touch ~/.dsh/dsh-porthole/reset-auth` 后重启 DSH，
全量清空双密码与安全策略，标记文件一次性自动删除。`secretToken` 保留（二维码仍有效）。

### 4.5 【低】与 DSH 无关的第三方依赖收敛

porthole 只依赖 `qrcode`。原版的 `ws`（隧道客户端必需）、`@larksuite/*`、`@tencent-connect/*`、
`puppeteer-core`（UI 验收）全部移除。这是收益，不是风险 —— 列在此处仅为完整。

---

## 5. 建议的补齐优先级

如果后续要按「性价比」逐步往回加，推荐顺序（P2 / P5 已于 v1.1.0 完成）：

| 优先级 | 补什么 | 理由 | 预估成本 |
| --- | --- | --- | --- |
| ~~P0~~ | ~~`connection-compat.js` 兜底~~ | ✅ **v1.1.1 已完成**（实机命中并修复） | — |
| ~~P1~~ | ~~浏览器 polyfill 注入~~ | ✅ **v1.2.0 实测关闭**：DSH 0.2.1-rc.5 前端 `randomUUID` 出现 0 次，当前宿主非必需（§4.1） | — |
| ~~P2~~ | ~~`reset-auth` 救急文件~~ | ✅ **v1.1.0 已完成** | — |
| **P3** | 移动端最小样式让位（不接管宿主类名，只加 `viewport` + `overscroll-behavior`） | 显著改善手机可用性，且不碰 DSH 布局 | ~40 行 CSS 注入 |
| ~~P4~~ | ~~会话投影剥离~~ | ✅ **v1.2.0 已完成**（实机验证 9/9 会话剥离） | — |
| ~~P5~~ | ~~管理员密码 / 两级权限~~ | ✅ **v1.1.0 已完成**（含防篡改锁、验证模式、本机特权令牌） | — |
| **P6** | 公网隧道 | 这是原版最大的差异化能力，但也是最大的复杂度来源（cloudflared 生命周期 + 二进制管理 + 网络参数） | ≥ 1300 行，不建议在 porthole 里做 |
| **P7** | IM 机器人 | 与 porthole 的定位（网页转发）正交，应该继续留在原版 | ≥ 8000 行，不建议 |

---

## 6. 选型建议

| 你的情况 | 选哪个 |
| --- | --- |
| 只想在沙发上用手机看 DSH 跑任务，不出门 | **porthole** |
| 需要出门在外访问（4G / 异地 / 公司网络） | 原版（开 Cloudflare 或自建隧道） |
| 需要在微信 / 飞书里给 Agent 发指令、点审批卡片 | 原版 |
| 手机是主要操作界面，要求原生 App 级体验 | 原版（PWA + 移动端改写） |
| 在意代码可审计性（41 个文件 vs 3 万行 + 14 万行 vendored bundle） | **porthole** |
| 在意依赖数量 / 供应链风险 | **porthole**（1 个运行时依赖 vs 5 个 + 外部二进制） |
| 两者都要 | 改掉其中一个的端口，分别配置 |

---

**报告基准时间**：2026-11-03
**最近一次实测**：v1.2.0 在 DSH 0.2.1-rc.5（桌面版）实机验证通过：代理监听、转发 200、RPC 通道、
session/list 9/9 会话投影剥离、工作区真实注册（DSH UUID + 会话挂接）与敏感路径拦截、自检五项全绿
**核对方式**：源码逐文件比对 + `wc -l` 统计 + RPC 端点表 diff（47 → 14）+ 依赖清单 diff
**porthole 测试状态**：`npm test` → 96/96 通过（代理转发 / WS 升级与鉴权 / 双密码与防篡改锁 / 验证模式 / 应急复位 / loopback-token 三道闸 / connection RPC 兼容垫片 / 会话投影剥离含 gzip 与代理集成 / 工作区注册·浏览·门禁 / 网卡排序 / 登录页 / 客户端真实 React 渲染 / RPC 常量契约）
