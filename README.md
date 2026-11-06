# dsh-porthole

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522.19%20%7C%20%E2%89%A524-339933" alt="node" /></a>
</p>

> DeepSeek Harness 的局域网门户：手机打开一个地址，就能继续用电脑上的 DSH。

porthole 专注反向代理与内网穿透接入。外部链路交给 frps / EasyTier，这里负责统一入口、鉴权和转发。二级目录也做了专门优化：挂在 `/dsh` 等子路径时，登录入口、`Location`、`Cookie Path` 都会自动适配。

项目宗旨是**精简、克制**：只做门户该做的事，不堆功能。

---

## 它做什么

把请求转发到 DSH 的 `127.0.0.1:<dshPort>`，并自动注入 DSH 原生鉴权所需的 loopback 会话 cookie，手机浏览器不用再处理 `?token=`。

| 能力 | 说明 |
| --- | --- |
| HTTP 转发 | 页面、API、静态资源透传 |
| WebSocket 转发 | `/plugins/events` 等实时通道原样升级；未认证不放行 |
| SSE 空闲保活 | 每 25s 注入 `: keepalive`，避免链路空闲被回收 |
| 二级目录挂载 | 支持 `/dsh` 等前缀；nginx 剥前缀并上报 `X-Forwarded-Prefix`，`Location`、`Cookie Path` 自动适配 |
| 监听地址可选 | `0.0.0.0`、`127.0.0.1` 或任意本机网卡 IP |
| 固定登录入口 | 站点根或 `/dsh/` 固定登录；未登录页面导航回入口，API/SSE/POST 返回 401 JSON |
| 地址展示 | 面板地址、复制按钮、二维码统一使用真实局域网根地址 |
| 保留 DSH 压缩 | 透传 `Accept-Encoding`，主 bundle 941 KB → 320 KB |
| 会话投影剥离 | `session/list` 移除 `contextHeaders` / `contextTimeline`（每会话可达数 MB），失败时原样直通 |
| 多网卡识别 | 物理网卡优先，WSL / Docker / 虚拟网卡降权 |
| 二维码 | 扫码免密；开启门禁时内嵌 256-bit token |
| 双密码门禁 | 访客密码 + 管理密码，PBKDF2-SHA256 600k 迭代 |
| 后台防篡改锁 | 三档策略；管理员令牌 30 分钟过期，改策略即吊销 |
| 本机特权令牌 | 本机（含桌面版 `dsh-app://app`）自动获得管理权限 |
| 远程工作区管理 | 浏览本机目录并一键注册进 DSH，敏感路径自动过滤 |
| 应急复位 | `touch ~/.dsh/dsh-porthole/reset-auth` 后重启，清空密码 |
| 自检 | 检查 DSH 服务、端口、局域网地址、回环凭据、门禁状态 |

## 安装

需要 Node.js ≥22.19 和 pnpm（版本见 `packageManager`）。

```bash
pnpm install
dsh plugin --profile desktop add .
```

装好后重启 DSH，进入 **设置 → 远程访问**。`cordis.patch.yml` 和 `package.json` 的 `dsh.client` 会自动完成客户端注入。

## 配置

`cordis.yml` 全部可选：

```yaml
- name: 'dsh-porthole'
  config:
    port: 3082          # 1024–65535
    host: 0.0.0.0       # 0.0.0.0 / 127.0.0.1 / 本机网卡 IP
    sseKeepalive: true  # SSE 空闲保活
    # trustedProxies: ['192.168.0.10']  # 默认只信 127.0.0.1 / ::1
```

`host` 也能在面板 **设置 → 远程访问 → 局域网访问** 修改，面板中的值优先于 `cordis.yml`。`trustedProxies` 只在 `cordis.yml` 配置，自定义值会追加到回环基线；异机 nginx 填 nginx 机器的真实 IP。

### 挂在 nginx 后面

支持子域名和二级目录，完整配置见 [docs/nginx.md](./docs/nginx.md)。

二级目录要点：

- `proxy_pass http://<porthole地址>:3082/;`，结尾必须有 `/`，由 nginx 剥掉 `/dsh/` 前缀；
- `proxy_set_header X-Forwarded-Prefix /dsh;`；
- `proxy_set_header Host $host;`，porthole 靠它判断请求是否来自本机；
- 站点根部署时改为 `proxy_set_header X-Forwarded-Prefix "";`。

运行期状态在 `~/.dsh/dsh-porthole/`：

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `config.json` | 端口、监听地址、认证配置 | `0600` |
| `sessions.json` | 已登录设备的会话令牌 | `0600` |
| `reset-auth` | 应急复位标记 | — |

---

## 安全认证

PWA 需要匿名读取 `/manifest.webmanifest`、`/favicon.svg`、`/favicon-dark.svg`，这三个资源允许匿名 GET/HEAD；其它页面、API、资源仍需登录。

未登录时：

- 应用根 GET/HEAD：返回登录页（401）；
- 深层页面导航：302 回入口；
- API / SSE / fetch / POST：返回 401 JSON。

### 两把钥匙

| | 访客密码 | 管理密码 |
| --- | --- | --- |
| 作用 | 进入 DSH | 修改安全配置、获取免密二维码、改端口/网卡 |
| 默认 | 未设置 | 未设置（沿用访客密码） |
| 忘记怎么办 | 应急复位 | 应急复位 |

访客密码只用于进入 DSH，管理密码才能修改安全配置。两者独立后，家人或同事可以用访客密码访问，但改不了配置。

### 三种验证方式

- **密码 + 扫码令牌**（默认）：输密码或扫二维码；
- **仅密码**：禁用 URL token；
- **仅扫码令牌**：禁用密码登录。

> 切换到「仅密码」或「仅扫码」前，必须先设好对应凭证，否则会把自己锁在门外。

### 防篡改策略

| 策略 | 含义 |
| --- | --- |
| 局域网可解锁（默认） | 手机端输管理密码即可改配置 |
| 仅限电脑本机 | 任何远程来源都不能改配置 |
| 不设防 | 谁都能改（危险，仅调试用） |

### 应急复位

```bash
# 三选一
touch ~/.dsh/dsh-porthole/reset-auth
touch "$DSH_HOME/dsh-porthole/reset-auth"

# Windows PowerShell
New-Item "$env:USERPROFILE\.dsh\dsh-porthole\reset-auth" -ItemType File
```

然后重启 `dsh web`。日志会提示已重置密码和安全策略；`reset-auth` 会自动删除，`secretToken` 保留，二维码仍然有效。

## 使用

打开 **设置 → 远程访问**，复制地址或扫码；手机连同一 Wi-Fi 即可访问。首次使用时先设访客密码和管理密码，再开启访问认证。

### 远程工作区

面板的「工作区」卡片可以浏览电脑目录，并把目录注册为 DSH 工作区。之后在工作区里新建对话，会话由 DSH 创建并持久化。

- 需要管理员身份：本机用 `127.0.0.1` 打开自动解锁，局域网设备需输入管理密码；
- 从未设置密码时，目录浏览会被拒绝，需先设置密码；
- `.ssh`、`.git`、`.env`、系统目录、UNC 路径和符号链接逃逸都会被过滤；
- 手机端不提供目录抽屉，添加工作区走 DSH 原生流程。

## 端口占用

默认 `3082`。端口被占用时，在面板里改端口并点「应用」；插件会热重启代理，新端口起不来会自动回滚。

## 开发

```bash
pnpm test                                   # 核心链路 / 认证 / 附加能力
pnpm run build:client                       # client/index.js → client/client.js
node test/manual-auth.mjs 34567             # 手工验收：完整认证流程
```

改插件名时，同步修改 `lib/constants.js` 的 `PLUGIN_NAME`；包名、loader id、cordis 条目名、数据目录名共用这个值。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 手机打开一直 401 / 提示 `dsh web authentication required` | `~/.dsh/.credentials.yaml` 缺失或没有 `client-connection/browser-session` 记录。跑一次自检看「DSH 回环凭据」 |
| 手机连不上，本机能打开 | 电脑防火墙拦了 `<port>`；或手机不在同一网段 |
| 地址里是 WSL / Docker / 代理网段 | 监听地址选了虚拟网卡；改回 `0.0.0.0` 或选物理网卡地址 |
| 实时通道每隔几分钟断一次 | 链路空闲回收；确认 `sseKeepalive` 没被关 |
| 提示「需要管理员权限」 | 输管理密码解锁；或在电脑上用回环地址打开面板（自动免密） |
| 改完验证方式/策略后要重新解锁 | 设计如此：策略变更会吊销所有管理员令牌，确保新策略立即生效 |
| 设置了密码但本机不用输 | 设计如此：`127.0.0.1` 免密（面板可关） |
| 访问 `/dsh/` 一直 404 | 确认 `proxy_pass` 带尾斜杠，且设置了固定的 `X-Forwarded-Prefix /dsh`，见 [docs/nginx.md](./docs/nginx.md) |
| 出现 `/dsh/dsh/` 双前缀 | 多写了 `proxy_redirect` 或 `return` 补前缀；去掉多余的 `proxy_redirect` |
| API / SSE 拿到一页登录 HTML 或 302 | API/SSE/POST 应返回 `401 JSON`。见到 HTML 说明 nginx 没剥前缀或没正确上报 `X-Forwarded-Prefix` |
| 异机 nginx 下 `X-Forwarded-Prefix` 不生效 | `trustedProxies` 没加 nginx 机器真实 IP；注意填 socket 对端 IP，不是客户端 IP/XFF |
| 可信代理发来非法前缀被 `400` | 前缀含 `..`、`%`、`?`、`,`、`\`、`//`、超长等；改成合法 `/dsh` 形态 |
| 插件接口 404 / 请求落到站点根（如 BrowserSkill 的 `/bsk-observation/*`） | 插件把接口写成了根绝对路径；按 [docs/nginx.md](./docs/nginx.md) 第六节给它加 307 回 `/dsh` 的 location |
| 绑了具体网卡后 `127.0.0.1` 打不开 | 绑定具体 IP 时不会同时监听回环（Windows 行为）；改用该 IP 访问，或把监听地址改回 `0.0.0.0` |

## 与原版 dsh-bridge 的差异

dsh-porthole 专注「本机 DSH 门户 + 访问安全」：传输交给 frps / EasyTier，交互交给 DSH 原生流程。相比 `wenbin-wb/dsh-bridge` v2.17.8，主要增强：

- **二级目录 + 固定登录入口**：支持 `/dsh` 等前缀，`Location`、`Cookie Path` 自动适配。
- **监听地址可绑定**：`0.0.0.0`、`127.0.0.1` 或任意本机网卡 IP。
- **工作区真正注册**：添加后由 DSH 创建并持久化会话。
- **门禁更严**：本机免密要求回环地址和非空回环 `Host`。
- **保留 DSH 压缩**：主 bundle 941 KB → 320 KB。
- **macOS 临时目录可用**。

公网隧道、IM 机器人、移动端页面改写、手机端目录抽屉、运维看板等有意不内置，完整对比见 [GAP-REPORT.md](./GAP-REPORT.md)。

---

## 致谢

`dsh-porthole` 派生自 [`wenbin-wb/dsh-bridge`](https://github.com/wenbin-wb/dsh-bridge) v2.17.8，沿用其反向代理骨架、loopback cookie 注入、SSE 保活、多网卡识别与安全认证体系，部分底层模块直接沿用或改写。

感谢 **wenbin-wb** 与所有贡献者。原项目与本项目均采用 MIT 协议。

## Changelog

版本变更见 [CHANGELOG.md](./CHANGELOG.md)。

## License

MIT
