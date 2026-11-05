# dsh-porthole

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522.19%20%7C%20%E2%89%A524-339933" alt="node" /></a>
</p>

> DeepSeek Harness 的**局域网门户**：在手机上打开一个地址，继续用你电脑上的 DSH。
> 舷窗（porthole）——船身开的一扇小窗，只在舱内看得见。窗外是 frps / EasyTier，
> 窗内永远是这台电脑。

配合 **frps 反向代理**与 **EasyTier 组网**打通外部访问：外面的链路怎么变，
打进来的流量都落在这同一个门户上——它不绑定任何具体的打洞方式。
完整的能力差异见 [GAP-REPORT.md](./GAP-REPORT.md)。

---

## 它做什么

一台反向代理，把请求转发到 DSH 自己的 `127.0.0.1:<dshPort>`，并自动注入 DSH 原生鉴权所需的
loopback 会话 cookie —— 所以手机浏览器不用碰 `?token=`。

| 能力 | 说明 |
| --- | --- |
| HTTP 转发 | 页面、API、静态资源全量透传（仅 `session/list` 做投影剥离，见下） |
| WebSocket 转发 | `/plugins/events` 等实时通道原样升级；未认证不放行 |
| SSE 空闲保活 | 静默 25s 注入 `: keepalive` 注释帧，防链路按空闲回收掐断实时通道 |
| **二级目录挂载** | 可挂在 `/dsh` 这类前缀下（nginx 子路径）：nginx 剥前缀并固定上报 `X-Forwarded-Prefix`，porthole 始终原样转发内部 `req.url`，只用该头生成对外 `Location` 与 `Cookie Path` |
| **监听地址可选** | `0.0.0.0`（全部网卡）/ `127.0.0.1`（仅本机）/ 任意本机网卡 IP；展示的 IP 跟随绑定值 |
| **固定登录入口** | 外部应用根即入口（站点根 `/`、挂载时 `/dsh/`）；仅根 GET/HEAD 未登录返回 401 登录页；深层 HTML 导航 302 回入口；API/SSE/fetch/POST 一律 401 JSON |
| **访问地址自洽** | 面板顶部地址、复制按钮、二维码统一使用真实局域网**根地址**并以 `/` 结尾（如 `http://192.168.1.103:3082/`）；外部子目录前缀只由 nginx 声明，不混入直连地址，也不从代理头猜公开域名 |
| **保留 DSH 压缩** | 转发客户端的 `Accept-Encoding`，让 DSH 自己的 gzip 生效（实测主 bundle 941 KB → 320 KB）；上游为注入 HTML 会删掉该头，等于关掉压缩 |
| 会话投影剥离 | `session/list` 移除 `contextHeaders` / `contextTimeline`（每会话可达数 MB、无 UI 读取）；支持 gzip，剥离失败一律原样直通 |
| 多网卡识别 | 物理 Wi-Fi / 有线网卡优先，WSL / VMware / Docker / Hyper-V / Mihomo / Clash 大幅降权 |
| 二维码 | 扫码免密直通；开启门禁时内嵌 256-bit token |
| **双密码门禁** | 访客密码（进入 DSH）+ 管理密码（改配置、看免密二维码），PBKDF2-SHA256 600k 迭代 |
| **后台防篡改锁** | 三点策略：局域网可解锁 / 仅限电脑本机 / 不设防；管理员令牌 30 分钟过期，改策略即吊销 |
| **本机特权令牌** | 电脑自己打开面板自动免密拿管理权限（含桌面版 `dsh-app://app` 来源） |
| **远程工作区管理** | 面板浏览本机目录（敏感目录 / 系统目录 / 符号链接逃逸全过滤），一键注册进 DSH，随后可在工作区中新建对话 |
| **应急复位** | 忘记密码时 `touch ~/.dsh/dsh-porthole/reset-auth` 后重启，全量清空 |
| 自检 | 一键检查上游服务、代理端口、局域网地址、回环凭据、门禁状态 |

## 与原版 dsh-bridge 的差异

对比基准：`wenbin-wb/dsh-bridge` **v2.17.8**（`main` @ `615286b`，2026-11-03）。完整清单见 [GAP-REPORT.md](./GAP-REPORT.md)。

**原版有、这里没有**（有意不做）

| 能力 | 说明 |
| --- | --- |
| 公网隧道 | Cloudflare 临时/固定域名、自建 WS 隧道、外部隧道登记 —— 改用 frps / EasyTier 等外部工具，门户本身与传输方式无关 |
| IM 机器人 | 微信 / QQ / 飞书 / Telegram，含卡片审批、文件传输、多账号矩阵 |
| 移动端页面改写 | 顶栏、抽屉、输入框折叠、iOS 键盘适配、PWA 全屏 |
| 手机端目录抽屉 | 不接管 DSH 的 `directoryFlow` Slot；目录浏览在设置页 |
| 运维看板 | CPU/内存、多目标网络诊断、插件与宿主升级、一键重启、配置备份恢复 |

**这里更强的地方**（原版没有或有问题）

| 能力 | 说明 |
| --- | --- |
| 二级目录 + 固定入口 | 原版只有「局域网/隧道地址」，没有挂载前缀概念；这里由 nginx 剥前缀 + `X-Forwarded-Prefix` 声明外部前缀，登录入口固定在对外应用根 |
| 监听地址可绑定 | 原版固定 `0.0.0.0`，无法只监听某张网卡 |
| 工作区真正注册 | 原版 `BridgeService.this.ctx` 从未赋值，`addWorkspace` 只做安全校验便返回，**从不真正注册**；这里显式接线并实机验证 |
| macOS 临时目录可用 | 原版 POSIX 黑名单里笼统的 `/private` 会把 `/private/var/folders/...`（macOS 所有临时目录）误判为系统目录 |
| 反代不漏门禁 | 原版回环免密允许空 `Host`，nginx 漏配 `proxy_set_header Host` 时等于全站免密；这里要求 Host 必须是回环名 |
| **保留响应压缩** | 原版为注入 HTML 会删掉 `accept-encoding`，等于把 DSH 自带的 gzip 关掉（主 bundle 941 KB 全量传输）；这里原样转发，实测降到 320 KB |
| 宿主兼容 | 两个版本都需要 `connection-compat` 绕过 DSH 的 RPC 注册回归；这里同样内置，并在上游修复后自动空转 |

> 取舍一句话：**原版是「一个插件解决全部远程访问」，这里是「只做门户，传输交给外部工具」。**

---

## 安装

```bash
cd dsh-porthole
npm install
npm run build:client

# 装进宿主（web / desktop profile 按需）
dsh plugin --profile desktop add ./dsh-porthole
```

`cordis.patch.yml` 已声明 bundle 注入，`package.json` 的 `dsh.client` 声明了客户端注入，
DSH 会自动加载 `client/client.js`。装好后**重启宿主**，进 **设置 → 远程访问**。

> 注意：插件名 `dsh-porthole` 同时是 loader id、cordis 条目名与数据目录名，改包名时必须四者同步改
> （已收敛到 `lib/constants.js` 的 `PLUGIN_NAME`）。

## 配置

`cordis.yml`（全部可选，默认值即可用）：

```yaml
- name: 'dsh-porthole'
  config:
    port: 3082          # 门户监听端口，1024–65535；外部链路（frps / EasyTier）指向它
    host: 0.0.0.0       # 监听地址：0.0.0.0 / 127.0.0.1 / 任一网卡 IP
    sseKeepalive: true  # SSE 空闲保活，默认开
    # trustedProxies 默认 ['127.0.0.1','::1']（只信回环，且只精确比对 socket.remoteAddress）。
    # 异机 nginx 时把它所在机器的真实 IP 加进来；数组会整体替换默认值。
    # trustedProxies: ['127.0.0.1', '::1', '192.168.0.10']
```

`host` 也可直接在面板 **设置 → 远程访问 → 局域网访问** 里改（保存即生效，
并写入 `config.json`；**面板里的值优先于 `cordis.yml`**，避免重启后被配置文件覆盖回去）。
二级目录由 nginx 剥前缀并用固定的 `X-Forwarded-Prefix` 声明外部前缀（见下），
porthole 侧无需任何前缀配置。`trustedProxies` 目前只在 `cordis.yml` 里配。

### 挂在 nginx 后面

支持**子域名**与**二级目录**两种挂法，完整配置（含 WebSocket、SSE、Cookie Path、
`X-Forwarded-Prefix` 与排错表）见 **[docs/nginx.md](./docs/nginx.md)**。

二级目录的唯一做法（nginx 剥前缀并固定上报外部前缀）：

- nginx 用 **带尾斜杠** 的 `proxy_pass http://192.168.0.66:3082/;`，由 nginx 替 porthole 剥掉 `/dsh/`；
  porthole 收到的内部 `req.url` 已是 `/…`，**始终原样转发**，不会重复 strip；
- 用 `proxy_set_header X-Forwarded-Prefix /dsh;` **固定为 `/dsh`**（覆盖客户端自带值）——
  它只代表外部路径，porthole 只用它生成对外 `Location` 与 `Cookie Path`；
- 同机 nginx：默认信任回环即可；**异机 nginx**：把 nginx 机器真实 IP 写进 `trustedProxies`
  （精确 socket 对端，不是客户端 IP，也不是 `X-Forwarded-For`）；
- 入口 `location = /dsh` 用 `absolute_redirect off; return 301 /dsh/;`，**不要**再额外
  `proxy_redirect` 去补前缀（会变成 `/dsh/dsh/…` 双前缀）；
- **root（站点根）部署**时清除客户端自带的声明：`proxy_set_header X-Forwarded-Prefix "";`。

两个容易踩的点先提醒：

- nginx 必须转发**真实 Host**（`proxy_set_header Host $host;`）——
  porthole 靠 Host 判断「是否本机回环」以决定是否签发本机特权令牌；固定成 `127.0.0.1` 会让
  远程请求被误判为本机；
- 保留 `absolute_redirect off`、BrowserSkill 的 `307` 兜底与局域网二维码的根地址（详见 docs/nginx.md）。

运行期状态落在 `~/.dsh/dsh-porthole/`：

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `config.json` | 端口、监听地址、认证配置（双密码哈希 / token / 策略） | `0600` |
| `sessions.json` | 已登录设备的会话令牌 | `0600` |
| `reset-auth` | **应急复位标记**（放这里 = 下次启动清空所有密码） | — |

---

## 安全认证说明

浏览器读取 PWA manifest 时默认不携带凭据，因此 DSH 自带的 `/manifest.webmanifest`、
`/favicon.svg`、`/favicon-dark.svg` 允许匿名 GET/HEAD，避免登录后仍出现 manifest 401。
挂在二级目录时，这些资源同样必须带挂载前缀（例如 `/dsh/manifest.webmanifest`）。
页面、API、其它资源以及写请求仍按原有门禁校验；此例外不会签发访问会话。

固定登录入口的判定：

- 仅**外部应用根的 GET/HEAD 且未登录**返回 `401` 登录 HTML（`HEAD` 不带 body）；
- 未登录的**深层页面导航**（明确 `Accept: text/html`）`302` 回入口；
- **API（`/api`、`/bsk-observation` 等）、非 HTML fetch、SSE、`POST`** 一律 `401 JSON`，
  不会被喂成登录 HTML、也不会被重定向；
- 所有 `Location` 都是站内绝对路径，不从 `Host`/`Origin` 拼出内部地址、也不生成协议相对跳转。

### 两把钥匙

| | 访客密码 | 管理密码 |
| --- | --- | --- |
| 作用 | 进入 DSH | 修改安全配置、取免密二维码、改端口/网卡 |
| 默认 | 未设置 | 未设置（沿用访客密码） |
| 忘记怎么办 | 应急复位 | 应急复位 |

管理密码独立后，你可以给家人/同事访客密码让他们用 DSH，
但**他们改不了你的安全配置** —— 这是两层防护的意义。

### 三种验证方式

- **密码 + 扫码令牌**（默认）：局域网设备输密码，或扫二维码免密直连；
- **仅密码**：禁用 URL token，只认密码；
- **仅扫码令牌**：禁用密码登录，只认二维码（适合"只给自己用"）。

> 切到「仅密码」或「仅扫码」前必须先设好对应凭证，否则服务端会拒绝 ——
> 这是防止把自己锁在门外的守卫。

### 防篡改策略

| 策略 | 含义 |
| --- | --- |
| 局域网可解锁（默认） | 手机端输管理密码即可改配置 |
| 仅限电脑本机 | 任何远程来源都不能改配置，必须坐在电脑前 |
| 不设防 | 谁都能改（危险，仅调试用） |

### 应急复位（忘记密码）

```bash
# 三选一，取决于你的 DSH_HOME
touch ~/.dsh/dsh-porthole/reset-auth
touch "$DSH_HOME/dsh-porthole/reset-auth"

# Windows PowerShell
New-Item "$env:USERPROFILE\.dsh\dsh-porthole\reset-auth" -ItemType File
```

然后重启 `dsh web`。日志里会出现：

```
dsh-porthole: [保命救急] 检测到 reset-auth 标记文件，已重置所有访问密码、管理密码与安全策略
```

标记文件会被自动删除（一次性）。**secretToken 保留**，二维码仍然有效。

---

## 使用

1. 装好插件，重启 `dsh web`；
2. 电脑上进 **设置 → 远程访问**，复制地址或直接扫码；
3. 手机连同一个 Wi-Fi，打开地址 / 扫码，即可继续用这台电脑上的 DSH。

> **首次配置建议**：先在面板里设好访客密码和管理密码，再开启访问认证。
> 面板对「首次设置」有豁免，不会因为你刚设了访客密码就把你锁在管理密码输入框外面。

### 远程工作区

面板的「工作区」卡片可以浏览这台电脑的目录并一键注册为 DSH 工作区。添加后，在工作区中点击「新建对话」，由 DSH 创建并持久化会话：

- 需要**管理员身份**：本机用 `127.0.0.1` 打开面板会自动解锁；局域网设备需先输管理密码；
- **从未设置过任何密码时**，目录浏览会被拒绝并提示先设密码——
  这是防止「局域网内任何人都能枚举全盘目录」的守卫（与上游一致）；
- `.ssh` / `.git` / `.env` 等敏感目录、Windows/POSIX 系统目录、UNC 路径、
  符号链接逃逸目标全部默认屏蔽；
- 按需求**不提供手机端目录抽屉**：手机上「添加工作区」继续走 DSH 原生流程。

## 端口占用

默认 `3082`。被占用时面板会显示「端口已被占用」，改一个端口点「应用」即可
（插件会热重启代理；新端口起不来会自动回滚，不会把你锁在门外）。

## 开发

```bash
npm test                                    # 核心链路 / 认证 / 附加能力（node --test）
npm run build:client                        # client/index.js → client/client.js
node test/manual-auth.mjs 34567             # 手工验收：跑一遍完整认证流程
```

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 设置面板添加工作区后，新建对话提示 `SessionPersistenceNotFoundError: session "session-1" not found` | 旧逻辑提前创建了未持久化的内存会话；更新插件后完整重启 DSH 并刷新页面，再新建对话 |
| 手机打开一直 401 / 提示 `dsh web authentication required` | `~/.dsh/.credentials.yaml` 缺失或没有 `client-connection/browser-session` 记录。跑一次自检看「DSH 回环凭据」 |
| 手机连不上，本机能打开 | 电脑防火墙拦了 `<port>`；或手机不在同一网段 |
| 地址里是 WSL / Docker / 代理网段 | 监听地址选了虚拟网卡；改回 `0.0.0.0` 或选物理网卡地址 |
| 实时通道每隔几分钟断一次 | 链路空闲回收；确认 `sseKeepalive` 没被关 |
| 提示「需要管理员权限」 | 输管理密码解锁；或在电脑上用回环地址打开面板（自动免密） |
| 改完验证方式/策略后要重新解锁 | 设计如此：策略变更会吊销所有管理员令牌，确保新策略立即生效 |
| 设置了密码但本机不用输 | 设计如此：`127.0.0.1` 免密（面板可关） |
| 访问 `/dsh/` 一直 404 | 确认 `proxy_pass` **带**尾斜杠（nginx 剥掉 `/dsh/` 前缀）且设了固定的 `X-Forwarded-Prefix /dsh`，见 [docs/nginx.md](./docs/nginx.md) |
| 出现 `/dsh/dsh/` 双前缀 | 又额外写了 `proxy_redirect`/`return` 去补前缀；去掉多余的 `proxy_redirect` 即可 |
| API / SSE 拿到一页登录 HTML 或 302 | 不该发生：API/SSE/POST 应得 `401 JSON`。见到 HTML 说明 nginx 没剥前缀或没正确上报 `X-Forwarded-Prefix` |
| 异机 nginx 下 `X-Forwarded-Prefix` 不生效 | `trustedProxies` 没加 nginx 机器真实 IP（默认只信回环）；注意填 socket 对端 IP，不是客户端 IP/XFF |
| 可信代理发来非法前缀被 `400` | 前缀含 `..`、`%`、`?`、`,`、`\`、`//`、超长等；改成合法 `/dsh` 形态 |
| BrowserSkill 观察面板 `/bsk-observation/*` 404 | 临时在 nginx 加 `location /bsk-observation/ { absolute_redirect off; return 307 /dsh$request_uri; }`，见 [docs/nginx.md](./docs/nginx.md) |
| 绑了具体网卡后 `127.0.0.1` 打不开 | 绑定具体 IP 时不会同时监听回环（Windows 行为）；改用该 IP 访问，或把监听地址改回 `0.0.0.0` |
| 面板控件点了没反应 | 早期版本在桌面版（`dsh-app://app`）下拿不到管理员令牌；1.3.1 起已修。当前版本会在卡片内直接显示失败原因 |

## 致谢

本项目站在 [`wenbin-wb/dsh-bridge`](https://github.com/wenbin-wb/dsh-bridge) 的肩膀上。

`dsh-porthole` 是从 **dsh-bridge v2.17.8** 派生出的能力子集重写：保留了它的反向代理骨架、
loopback 会话 cookie 注入、SSE 空闲保活、多网卡识别与安全认证体系，并直接沿用了其中若干模块：

| 模块 | 与上游的关系 |
| --- | --- |
| `lib/sse-keepalive.js` | **逐字沿用**（issue #71 的空闲回收实测数据尤其宝贵） |
| `lib/auth/dsh-native-cookie.js` | **逐字沿用**（DSH 原生 cookie 格式与双名称口径的逆向成果） |
| `lib/session-strip.js` | **逐字沿用**（会话投影剥离） |
| `lib/security/path-validator.js` | **逐字沿用**（跨平台路径安全校验） |
| `lib/compat.js` | **逐字沿用**（低版本 Node 的 AbortSignal 垫片） |
| `lib/connection-compat.js` | 移植（宿主 connection RPC 注册回归兜底，注释与日志按本项目重写） |
| `lib/security/rate-limiter.js` | 参考实现后重写（本项目的 `allow()` 接口 + 按用途分实例） |

此外，原版在处理 **DSH 原生鉴权的 cookie 口径漂移**、**Cloudflare 空闲回收掐断 SSE**、
**上游 socket RST 打崩进程** 等问题上踩过的坑，以及 issue 里留下的现场记录，
让这个分支少走了大量弯路。

感谢作者 **wenbin-wb** 与 [所有贡献者](https://github.com/wenbin-wb/dsh-bridge/graphs/contributors)。
原项目以 MIT 协议发布，本项目的派生与再分发同样遵循 MIT。

> 若你只想要「一个插件解决全部远程访问（公网隧道 + IM 机器人 + PWA）」，
> 请直接使用原版 [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge)——
> `dsh-porthole` 的取舍是缩小范围，不是替代它。

## License

MIT

