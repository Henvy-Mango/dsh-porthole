# Changelog

本文件记录 dsh-porthole 的版本变更。

## v1.5.3 - 2026-11-06

- 包管理器从 npm 迁移到 pnpm：新增 `pnpm-lock.yaml` / `pnpm-workspace.yaml`，移除 `package-lock.json`，`prepack` 改用 pnpm。
- README 精简并补充项目定位、二级目录优化说明。
- nginx 文档新增「插件根路径与挂载前缀不一致」的通用兼容方案。
- 变更日志独立为根目录 `CHANGELOG.md`。

## v1.5.2 - 2026-11-05

- 自检「局域网代理端口」显示实际监听地址，不再写死 `0.0.0.0`。
- 修复桌面壳（Electron）绑定具体网卡时无法自动领取本机令牌的问题。

## v1.5.1 - 2026-11-05

- `trustedProxies` 中的回环地址（`127.0.0.1` / `::1`）改为不可移除的可信基线；自定义数组在其上追加，空数组仍信任回环。
- 修复自定义 `trustedProxies` 会导致同机 nginx 的 `X-Forwarded-Prefix` 被忽略的问题。

## v1.5.0 - 2026-11-05

**不兼容变更**：二级目录改为唯一模式，由 nginx 剥前缀并固定上报 `X-Forwarded-Prefix`，移除 `basePath` / `publicPath` 手动挂载。

- 新增固定登录入口：未登录页面导航回应用根，API/SSE/写请求返回 JSON 401。
- 新增 `trustedProxies` 精确 socket 对端白名单。
- 新增 WebSocket Origin 白名单（CSWSH 纵深防御）与 `loopback-token` 来源补全。
- 设置页导航图标改为内联 SVG。
- 安全：本机免密要求非空回环 `Host`。

## v1.4.3 - 2026-11-04

- 修复添加工作区后新建对话报 `SessionPersistenceNotFoundError`：工作区只注册目录，会话交给 DSH 原生流程创建并持久化。
- 修复开启门禁后 manifest / favicon 因浏览器未携带 Cookie 返回 401：指定资源允许匿名 GET/HEAD，并遵守挂载前缀。

## v1.4.2 - 2026-11-04

- 保留 `Accept-Encoding`，让 DSH 自带 gzip 生效：主 bundle 941 KB → 320 KB，`session/list` 56 KB → 16 KB。
- 移除 GitHub Actions workflow。
- 补充「压缩 × 投影剥离」测试。

## v1.4.1 - 2026-11-04

- 修复二级目录下登录后跳回站点根的问题：登录接口与成功落点按挂载前缀注入。
- 补上 `/dsh` 缺尾斜杠时 302 到 `/dsh/`，避免静态资源以站点根为基准解析。

## v1.4.0 - 2026-11-04

- 二级目录改为强制严格模式：设了前缀即只允许该前缀访问，移除开关。
- 新增监听地址可绑定任意本机网卡 IP，面板展示地址随之变化。
- 面板访问地址与二维码带挂载前缀并以 `/` 结尾。
- 删除冗余的「网卡」行与 `setLanIp` 接口，配置面收敛为单个 `host`。
- 统一 cookie 名常量，状态行显示实际绑定地址。
- 测试精简为 3 个文件 27 个核心用例。

## v1.3.1 - 2026-11-03

- 修复桌面版（Electron，`dsh-app://app`）管理控件点击无反应：识别自定义协议、加入服务端白名单，并在未解锁时给出明确原因。

## v1.3.0 - 2026-11-03

- 新增「反向代理接入」面板，可视化配置 `basePath` 与监听地址 `host`。
- 面板页脚恢复版本号显示。
- 支持 nginx 二级目录反代，修正扫码跳转的 `Location` 与会话 `Cookie Path`。
- 安全修复：回环免密不允许空 `Host`。
- 修复 `port=0` 时未回填实际监听端口。
- 端点前缀与 Cookie 名统一为 `porthole` / `dsh_portal_auth`。

## v1.2.0 - 2026-11-03

- 迁移会话投影剥离：`session/list` 移除 `contextHeaders` / `contextTimeline`，支持 gzip。
- 迁移远程工作区管理：目录浏览、一键注册进 DSH、敏感目录过滤。
- 修复上游同款 bug：原版 `service.ctx` 从未赋值导致工作区从不真正注册；porthole 显式接线并实机验证。
- §4.1 polyfill 实测关闭：DSH 0.2.1-rc.5 前端不含 `randomUUID` 调用。

## v1.1.1

- 修复 DSH ≥0.1.5 上插件不激活的宿主回归（§5.2）；网卡识别加固。
