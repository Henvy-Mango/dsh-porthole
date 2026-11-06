# Nginx 反向代理配置

dsh-porthole 可以挂在**子域名**下，也可以挂在**二级目录**（如 `https://example.com/dsh/`）下。
二级目录只有一种做法：由 **nginx 剥前缀**（`proxy_pass` 带尾斜杠）并**固定上报**
`X-Forwarded-Prefix /dsh`。porthole 始终**原样转发内部 `req.url`**，只用该头生成对外 `Location`
与 `Cookie Path`；它不会自己剥前缀。

先说结论：

| 方式 | 可行性 | 插件侧配置 | nginx 侧 |
| --- | --- | --- | --- |
| 子域名 `dsh.example.com` | ✅ 开箱可用 | 无 | 普通反代，头清空 |
| 二级目录 `example.com/dsh/` | ✅ 唯一做法 | 异机时配 `trustedProxies` | `proxy_pass http://…:3082/;`（**带**尾斜杠剥前缀）+ 固定 `X-Forwarded-Prefix /dsh` |

---

## 一、先决条件

监听地址取决于 **nginx 是否与 porthole 在同一台机器**：

**同机 nginx（推荐）**：让 porthole 只监听回环，nginx 成为唯一入口：

```yaml
- name: 'dsh-porthole'
  config:
    host: 127.0.0.1   # 只有本机 nginx 能连；局域网直连同时失效
    port: 3082
```

> 权衡：`host: 127.0.0.1` 后，手机在局域网内**也**必须走 nginx 域名，
> 「扫二维码直连局域网 IP」会失效。如果你既想要局域网直连、又想要 nginx 对外，
> 就保持 `0.0.0.0`，并用防火墙限制 3082 只对可信网段开放。

**异机 nginx**（nginx 与 porthole 不在同一台机器）：必须让 porthole 监听 `0.0.0.0`
（或至少监听 nginx 能访问到的网卡 IP），并同时做两件事：

1. **防火墙**：3082 只允许 nginx 服务器的 IP 访问，禁止其它来源直连；
2. **trustedProxies**：把 nginx 服务器的真实出口 IP 写进白名单（见下节），
   否则它上报的 `X-Forwarded-Prefix` 会被当作不可信而忽略。

```yaml
- name: 'dsh-porthole'
  config:
    host: 0.0.0.0          # 异机 nginx 必须能连进来
    port: 3082
    trustedProxies:
      - '192.168.0.10'     # nginx 服务器的真实 IP（socket 对端），不是客户端 IP、不是 XFF
```

**必须开启访问认证**。经 nginx 暴露到公网后，未设密码的门户等于把 DSH 交出去：

```yaml
# 面板 → 安全认证 → 开启访问认证，并设置访客密码
```

### 信任来源只看 socket 对端，不看 X-Forwarded-For

porthole 判断「请求是否来自可信代理」时，**只看 TCP 连接的 `socket.remoteAddress`**（精确匹配
白名单），**绝不信任 `X-Forwarded-For` / `X-Real-IP` 这类客户端可伪造的头**来判断来源。

- 默认白名单是 `trustedProxies: ['127.0.0.1', '::1']`（回环，覆盖 IPv4 mapped IPv6 形式），
  且**本地回环始终是基线、无法被移除**——即使自定义数组或写空数组，回环仍被信任；
- 同机 nginx（经回环连到 3082）默认即命中，**无需额外配置**；
- **异机 nginx**（nginx 与 porthole 不在同一台机器）时，必须把 nginx 所在机器的**真实出口 IP**
  写进 `trustedProxies`，让它成为被信任的 socket 对端：

  ```yaml
  - name: 'dsh-porthole'
    config:
      port: 3082
      host: 0.0.0.0                  # 异机 nginx 需要能连进来，不能再只听回环
      trustedProxies:
        - '192.168.0.10'             # nginx 服务器的真实 IP，不是客户端 IP，也不是 XFF
  ```

> 自定义 `trustedProxies` 数组是在**回环基线之上追加**，不再整体替换；同机 nginx 无需
> 额外列入 `127.0.0.1` / `::1`。空数组 `[]` 仍信任本地回环（等价于默认）；
> 配置不是合法的精确 IP 数组时，门户会报错并停止启动。
>
> ⚠️ 不要把客户端网段、也不要把 `X-Forwarded-For` 里出现的地址写进 `trustedProxies`——
> 这个名单唯一回答的问题是「哪些 socket 对端才允许替客户端声明外部前缀」。

---

## 二、固定登录入口的行为（所有方式通用）

porthole 有一个**固定登录入口**，它的位置是「**外部应用根**」：

- 站点根部署时入口就是 `/`；
- 挂在 `/dsh/` 时入口就是 `/dsh/`（内部对应 `/`）。

行为约定：

1. **仅根 `GET`/`HEAD` 且未登录**时返回 `401` + 登录 HTML；`HEAD` 不返回 body。
2. **未登录的深层页面**（明确 `Accept: text/html` 或导航请求）跳 `302` 回到入口。
3. **API（`/api`、插件自定义端点等）、非 HTML 的 fetch、SSE、`POST`** 一律返回 `401 JSON`，
   不返回 HTML、也不重定向——避免把脚本/事件流喂成一页登录 HTML。
4. 根请求即便**缺少 `Accept` 头**也仍视为可登录，返回登录 HTML。
5. 登录页固定从根位置 `fetch('./__dsh_porthole__/login')`，成功后 `location.replace('./')`，
   始终留在同一挂载子树内。
6. 所有 `Location` 都是**站内绝对路径**（例如 `/dsh/…`），不会从 `Host` / `Origin` 拼出
   `http://内部:端口` 之类的地址，也不会生成协议相对跳转（`//host/…`）。

> 因此 nginx **不需要**额外 `proxy_redirect` 去纠正前缀；porthole 自己产出的 `Location`
> 已经带对外前缀（来自 `X-Forwarded-Prefix`）。多写 `proxy_redirect` 反而会造成双前缀（`/dsh/dsh/…`）。

---

## 三、子域名方式（推荐用于公网）

`dsh.example.com` → `http://127.0.0.1:3082`

```nginx
# /etc/nginx/conf.d/dsh.conf
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3082;
        # 此模式不使用代理前缀，清除客户端自带的声明。
        proxy_set_header X-Forwarded-Prefix "";

        proxy_http_version 1.1;
        # WebSocket（DSH 的实时通道全靠它）
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 必须转发真实 Host：
        # porthole 的「本机特权令牌」判断会看 Host 是否为回环名，
        # 固定成 127.0.0.1 会让远程请求被误判为本机。
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE：关掉缓冲，否则 /events 之类会被攒着不发
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    listen 80;
    server_name dsh.example.com;
    return 301 https://$host$request_uri;
}
```

插件侧：无需任何与前缀相关的配置（root 部署时 nginx 侧提交空 `X-Forwarded-Prefix` 即可）。

---

## 四、二级目录方式（nginx 剥前缀 + 固定 `X-Forwarded-Prefix`）

`https://example.com/dsh/` → `http://192.168.0.66:3082/`

这个模式下 **nginx 负责剥前缀**（`proxy_pass` 带尾斜杠），并把**外部前缀**通过
`X-Forwarded-Prefix` 告诉 porthole。porthole 内部收到的 `req.url` 已经是剥好前缀的 `/…`，
它**始终原样转发**，不会重复 strip；`X-Forwarded-Prefix` 只用来表示「这个请求在外部是从
`/dsh/` 那棵子树进来的」，用于生成正确的 `Location`、`Cookie Path` 及固定登录入口的落点。
porthole 只信任该头来生成对外 cookie/redirect。

### 4.1 nginx 配置

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    client_max_body_size 100m;

    # 入口补斜杠：访问 /dsh 时跳到 /dsh/。
    # absolute_redirect off 保留 Location 中的站内路径，不补成内部 HTTP 地址。
    location = /dsh {
        absolute_redirect off;
        return 301 /dsh/;
    }

    location /dsh/ {
        # ⚠️ 关键：**带尾斜杠**。nginx 会把 /dsh/ 前缀剥掉再转给 porthole，
        # porthole 收到的就是 /…（内部路径），它不会再剥一次。
        proxy_pass http://192.168.0.66:3082/;

        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 保留真实 Host（用于回环/桌面判断，不要写成固定 127.0.0.1）
        proxy_set_header Host              $host;

        # 上报外部前缀。用固定值覆盖客户端可能自带的同名头，
        # 防止伪造；它只代表「外部路径」，不改变 porthole 看到的内部 req.url。
        proxy_set_header X-Forwarded-Prefix /dsh;

        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / WebSocket 长连接
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # 不要额外写 proxy_redirect / return 去纠正前缀：
        # porthole 产出的 Location 已带 /dsh/，重复改写会变成 /dsh/dsh/…
    }
}
```

> 上面用 `192.168.0.66:3082` 表示 porthole 所在机器的地址（异机 nginx 场景）。
> 若 nginx 与 porthole 同机，把 `proxy_pass` 换成 `http://127.0.0.1:3082/` 即可，
> 且无需配置 `trustedProxies`（默认信任回环）。

### 4.2 插件侧配置

**同机 nginx**：不用动 `trustedProxies`，默认信任回环即可。

**异机 nginx**：把 nginx 机器的真实 IP 加进 `trustedProxies`（精确 socket 对端，不是客户端 IP、不是 `X-Forwarded-For`）：

```yaml
- name: 'dsh-porthole'
  config:
    port: 3082
    host: 0.0.0.0                 # 异机 nginx 必须能连进来
    trustedProxies:
      - '192.168.0.10'            # nginx 服务器真实 IP（socket 对端），不是客户端、不是 XFF
```

> 异机部署时请在防火墙上把 3082 限制为**只允许 nginx 的 IP**访问；否则局域网内其它设备
> 可以绕过 nginx 直连门户。若 porthole 主机本身还有别的网卡，`0.0.0.0` 会监听全部网卡，
> 防火墙规则要覆盖所有入口。

访问 `https://example.com/dsh/` 即可。

### 4.3 前缀合法性（porthole 会校验）

`X-Forwarded-Prefix` 接受以下前缀：

- 接受：空串 `''` 或 `/` 表示「根」；合法的 `/dsh`、`/tools/dsh/`（会归一化为不带尾斜杠的规范值）；
- 拒绝：协议相对 `//host`、缺前导 `/`、含 `..`、含反斜杠 `\`、含百分号编码 `%`、
  含 query `?` 或 `#`、逗号多值、重复头、危险字符、以及超长值。

处理策略：

- **来自不可信来源**的头：直接**忽略**（当作没有该前缀，按根处理）；
- **来自可信代理但值非法**的：`HTTP` / `WS` 一律返回 `400`（不静默放行）。

> 有效外部前缀是**请求级**的：只作用于当前这一次请求，不会改写共享实例，
> 也不会串味到下一个直连请求。

---

## 五、局域网展示、二维码与对外域名

- 面板顶部的「访问地址」、复制按钮、二维码始终使用真实局域网根地址，
  例如 `http://192.168.1.103:3082/`；nginx 的外部挂载前缀不会加入这些直连地址。
- 这些地址**不会**从 `Host` / `Origin` / 单次代理头里去「猜」你的公开域名——一次代理头不足以
  安全推断对外域名，猜错会把二维码指到不存在的地址。porthole 也不引入 `publicUrl` 这类新配置。
- 经 nginx 对外访问时，请直接用你的外部域名 + 前缀（如 `https://example.com/dsh/`）；
  二维码里的局域网地址只适合同一局域网内扫码。

---

## 六、插件请求路径与挂载前缀不一致时的兼容

有些插件会把接口写成**站点根绝对路径**（例如 BrowserSkill 的 `/bsk-observation/…`），
而不是相对于当前页面的路径。porthole 挂在 `/dsh/` 这类子目录时，这些请求会绕过前缀直打站点根，
表现为 404，或者落到根上的其他应用。

### 怎么判断

打开浏览器 DevTools → Network，检查失败请求的 URL：

- 正常（带前缀）：`/dsh/api/…`、`/dsh/plugins/…`
- 异常（绕过前缀）：`/bsk-observation/…`、`/some-plugin/…`

如果请求路径属于某个插件的接口、但没有 `/dsh` 前缀，就属于这一类问题。

### 通用 nginx 配置

在 `server {}` 内、挂载用的 `location /dsh/` 之外，为每个被写死的根路径加一段 307 兜底：

```nginx
# 模板：/dsh 换成实际挂载前缀，/plugin-api/ 换成插件实际请求的根路径
location /plugin-api/ {
    absolute_redirect off;           # 生成站内路径，避免用 server_name 拼绝对 URL
    return 307 /dsh$request_uri;     # /plugin-api/x?y → /dsh/plugin-api/x?y
}
```

多个插件或多个根路径时重复多段即可；也可以用一个正则 location 合并：

```nginx
# 例：BrowserSkill 和另一个插件都写死了根路径
location ~ ^/(bsk-observation|another-plugin)/ {
    absolute_redirect off;
    return 307 /dsh$request_uri;
}
```

### 处理要点

- 用 `307`，不要用 `301/302`：307 保留请求方法与 body，插件的 POST/PUT 不会变成 GET；
- `$request_uri` 保留原始路径和 query string；用 `$uri` 会丢掉 query；
- `absolute_redirect off` 让 `Location` 生成站内绝对路径，避免带内部端口或协议相对地址；
- 307 只做路径接回，不绕过门禁：跳到 `/dsh/...` 后仍是同一站点，Cookie（`Path=/dsh`）会正常携带；
- 若插件写死的是 **WebSocket** 根路径，不要依赖 307（部分客户端不跟随升级重定向），应单独
  `proxy_pass` 并转发 `Upgrade` / `Connection` 头。

### 根治方式

nginx 兜底只是兼容层。正解是让插件客户端使用 document-relative 路径，例如：

```js
// 不要写死 /bsk-observation
const eventsUrl = new URL('./bsk-observation/events', document.baseURI);
```

这样无论挂在 `/`、`/dsh/` 还是其他前缀下都能正常工作。porthole 不会为了兼容写死根路径的插件
而放宽门禁或路径校验。

---

## 七、排错

| 现象 | 原因 |
| --- | --- |
| 打开 `/dsh/` 是空白页，控制台大量 404 | `proxy_pass` 少了尾斜杠（nginx 没剥前缀），或 `location` 少了尾斜杠 |
| 出现 `/dsh/dsh/…` 双前缀 | 又额外写了 `proxy_redirect`/`return` 去补前缀；去掉多余的 `proxy_redirect` 即可 |
| 页面能开但一直转圈 / 实时不更新 | 少了 `Upgrade` / `Connection` 头，WebSocket 没连上 |
| 深层链接跳回了 `/dsh/` 登录页 | 未登录导航请求按设计 302 回入口；登录后即可直达 |
| API / SSE 拿到一页 HTML 或 302 | 不该发生：API/SSE/POST 应得 `401 JSON`。若见到 HTML，说明前缀/挂载配错，请求被当成页面导航 |
| 设了密码却不用输就能进 | nginx 把 `Host` 改成 `127.0.0.1`（或没转发 Host）。务必 `proxy_set_header Host $host;` |
| 登录后立刻又退回登录页 | Cookie `Path` 与访问路径不匹配；确认 nginx 已用固定值上报 `X-Forwarded-Prefix /dsh` |
| 异机 nginx 下前缀不生效 / 被当成不可信 | `trustedProxies` 没加 nginx 真实 IP；默认只信回环 |
| 可信代理发来非法前缀后 `400` | 前缀含 `..`、`%`、`?`、`,`、`\`、`//`、超长等；改成合法 `/dsh` 形态 |
| 插件接口 404 / 请求落到站点根（如 BrowserSkill 的 `/bsk-observation/*`） | 插件写死了根绝对路径；按第六节加 307 location 把请求接回 `/dsh` 前缀 |
| 上传附件 413 | 调大 `client_max_body_size` |
| 长时间无操作后页面断连 | 调大 `proxy_read_timeout`；porthole 自身每 25s 发 SSE 保活帧，通常不会触发 |

---

## 八、安全清单

- [ ] 已开启访问认证，并设置了**足够强**的访客密码
- [ ] 已单独设置管理密码（否则访客密码即可改配置）
- [ ] 防篡改策略设为「仅限电脑本机」或「局域网可解锁」，不是「不设防」
- [ ] nginx 转发了真实 `Host`（否则回环免密/桌面令牌可能误判）
- [ ] 异机 nginx 时把 **nginx 真实 IP** 写进 `trustedProxies`（不是客户端 IP、不是 XFF）
- [ ] 由 nginx 剥前缀并用固定值上报 `X-Forwarded-Prefix /dsh`（root 部署时头清空）
- [ ] 3082 端口未直接暴露到公网
- [ ] 开启 HTTPS（局域网外的明文密码等于公开）
- [ ] 定期检查面板「安全认证」里的已登录设备数
- [ ] 若「监听地址」绑定了具体网卡，请用该地址访问面板（此时 127.0.0.1 不监听）
