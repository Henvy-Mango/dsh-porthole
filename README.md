# dsh-porthole

<p align="center">
  <a href="https://github.com/Henvy-Mango/dsh-porthole/actions/workflows/test.yml"><img src="https://github.com/Henvy-Mango/dsh-porthole/actions/workflows/test.yml/badge.svg" alt="test" /></a>
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

一台监听 `0.0.0.0:<port>` 的反向代理，把请求转发到 DSH 自己的 `127.0.0.1:<dshPort>`，
并自动注入 DSH 原生鉴权所需的 loopback 会话 cookie —— 所以手机浏览器不用碰 `?token=`。

| 能力 | 说明 |
| --- | --- |
| HTTP 转发 | 页面、API、静态资源全量透传（仅 `session/list` 做投影剥离，见下） |
| WebSocket 转发 | `/plugins/events` 等实时通道原样升级 |
| SSE 空闲保活 | 静默 25s 注入 `: keepalive` 注释帧，防止链路按空闲回收掐断实时通道 |
| 会话投影剥离 | `session/list` 响应移除 `contextHeaders` / `contextTimeline`（每会话可达数 MB、无 UI 读取），手机端首次加载列表流量降一个量级；支持 gzip，剥离失败一律原样直通 |
| 多网卡识别 | 物理 Wi-Fi / 有线网卡优先，WSL / VMware / Docker / Hyper-V / Mihomo / Clash 大幅降权，可在面板手动切换 |
| 局域网二维码 | 扫码即用；开启门禁时二维码内嵌 256-bit token 免密直通 |
| **双密码门禁** | 访客密码（进入 DSH）+ 管理密码（修改配置、查看免密二维码），PBKDF2-SHA256 600k 迭代 |
| **后台防篡改锁** | 三点策略：局域网可解锁 / 仅限电脑本机 / 不设防；管理员令牌 30 分钟过期 |
| **本机特权令牌** | 电脑自己浏览器打开面板自动免密拿管理权限，无需反复输密码 |
| **远程工作区管理** | 面板里浏览电脑目录（敏感目录/系统目录/符号链接逃逸全过滤），一键注册进 DSH 并自动挂接会话；未设密码时强制先设密码 |
| **应急复位** | 忘记密码时 `touch ~/.dsh/dsh-porthole/reset-auth` 后重启，全量清空 |
| 自检 | 一键检查上游服务、代理端口、网卡、回环凭据、门禁状态 |

## 它不做什么

公网隧道（Cloudflare / 自建 WS）、微信 / QQ / 飞书 / Telegram 机器人、
移动端页面改写与 PWA、手机端目录抽屉（面板浏览走本机设置页）、运维看板、
插件/宿主升级与重启、多账号矩阵。
详见 [GAP-REPORT.md](./GAP-REPORT.md)。

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
    host: 0.0.0.0       # 监听地址；挂 nginx 做唯一入口时改 127.0.0.1
    basePath: ''        # 挂在二级目录（如 /dsh）时填前缀；'' = 站点根
    sseKeepalive: true  # SSE 空闲保活，默认开
    lan:
      selectedIp: 192.168.1.20   # 固定网卡；留空 = 自动挑最佳
```

### 挂在 nginx 后面

支持**子域名**与**二级目录**两种挂法，完整配置（含 WebSocket、SSE、Cookie Path、
回环身份防伪与排错表）见 **[docs/nginx.md](./docs/nginx.md)**。

两个容易踩的点先提醒：

- nginx 必须转发**真实 Host**（`proxy_set_header Host $host;`）——
  porthole 靠 Host 判断请求是否来自本机回环，固定成 `127.0.0.1` 会让远程请求被误判；
- 二级目录必须在 nginx 的 `proxy_pass` 里带尾斜杠（剥掉前缀），
  并在插件侧配 `basePath: /dsh`，否则扫码登录后会跳回站点根 404。

运行期状态落在 `~/.dsh/dsh-porthole/`：

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `config.json` | 端口、选中网卡、认证配置（双密码哈希 / token / 策略） | `0600` |
| `sessions.json` | 已登录设备的会话令牌 | `0600` |
| `reset-auth` | **应急复位标记**（放这里 = 下次启动清空所有密码） | — |

---

## 安全认证说明

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

面板的「工作区」卡片可以浏览这台电脑的目录并一键注册为 DSH 工作区（自动创建并挂接会话）：

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
npm test                                    # 96 个用例
npm run build:client                        # client/index.js → client/client.js
node test/manual-auth.mjs 34567             # 手工验收：跑一遍完整认证流程
```

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 手机打开一直 401 / 提示 `dsh web authentication required` | `~/.dsh/.credentials.yaml` 缺失或没有 `client-connection/browser-session` 记录。跑一次自检看「DSH 回环凭据」 |
| 手机连不上，本机能打开 | 电脑防火墙拦了 `<port>`；或手机不在同一网段。先在面板换网卡试试 |
| 地址里是 WSL / Docker 网段 | 面板「网卡」下拉手动选物理网卡 |
| 实时通道每隔几分钟断一次 | 链路空闲回收；确认 `sseKeepalive` 没被关 |
| 提示「需要管理员权限」 | 输管理密码解锁；或在电脑上用 127.0.0.1 打开面板（自动免密） |
| 改完验证方式/策略后要重新解锁 | 设计如此：策略变更会吊销所有管理员令牌，确保新策略立即生效 |
| 设置了密码但本机不用输 | 设计如此：`127.0.0.1` 免密（面板可关） |

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

