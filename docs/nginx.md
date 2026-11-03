# Nginx 反向代理配置

dsh-porthole 可以挂在**子域名**下，也可以挂在**二级目录**（如 `https://example.com/dsh/`）下。
两种都支持，但所需配置不同，子目录还多一个前提。

先说结论：

| 方式 | 可行性 | 需要的配置 |
| --- | --- | --- |
| 子域名 `dsh.example.com` | ✅ 开箱可用 | 只用 nginx 配置，插件零改动 |
| 二级目录 `example.com/dsh/` | ✅ 支持 | nginx 配置 + 插件 `basePath` 一项配置 |

---

## 一、先决条件

无论哪种方式，都建议 **porthole 只监听回环**，让 nginx 成为唯一入口：

- 默认监听 `0.0.0.0:3082`（这样局域网设备可以直连，不依赖 nginx）；
- 一旦前面挂了 nginx 对外暴露，把监听地址收紧：
  ```yaml
  - name: 'dsh-porthole'
    config:
      host: 127.0.0.1   # 只有 nginx 能连；局域网直连同时失效
      port: 3082
  ```

> 权衡：`host: 127.0.0.1` 后，手机在局域网内**也**必须走 nginx 域名，
> 「扫二维码直连局域网 IP」会失效。如果你既想要局域网直连、又想要 nginx 对外，
> 就保持 `0.0.0.0`，并用防火墙限制 3082 只对可信网段开放。

**必须开启访问认证**。经 nginx 暴露到公网后，未设密码的门户等于把 DSH 交出去：

```yaml
# 面板 → 安全认证 → 开启访问认证，并设置访客密码
```

---

## 二、子域名方式（推荐）

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

    # 附件/文件上传
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3082;

        proxy_http_version 1.1;
        # WebSocket（DSH 的实时通道全靠它）
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # ⚠️ 必须转发真实 Host：
        # porthole 判断「是否本机回环免密」时会看 Host，
        # 若这里写成固定值或漏写，可能让远程请求被误判为本机（或反之全部 401）。
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

插件侧无需任何配置。

---

## 三、二级目录方式

`https://example.com/dsh/` → `http://127.0.0.1:3082/`

### 3.1 为什么需要插件侧配置

DSH 前端本身是**相对路径**的（`<base href="./">`、RPC 用 `${channel}/${endpoint}` 去掉前导斜杠），
所以把前缀剥掉后，页面、API、WebSocket 都能正常工作。

需要插件配合的只有它**自己生成的两个站内绝对路径**：

1. 扫码免密登录后返回的 `302 Location`（否则浏览器被甩回站点根，离开 `/dsh/`）；
2. 会话 Cookie 的 `Path`（否则同一域名下的其它应用也会收到这枚令牌）。

把 `basePath` 告诉插件即可，它会据此拼出 `/dsh/...` 与 `Path=/dsh`。

### 3.2 nginx 配置

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

    # 少了尾斜杠会让所有相对路径解析错位（经典坑），这里强制补上
    location = /dsh {
        return 301 /dsh/;
    }

    location /dsh/ {
        # 尾斜杠是关键：它把 /dsh 前缀剥掉再转发给上游
        # 写成 proxy_pass http://127.0.0.1:3082; （无尾斜杠）会把 /dsh/ 原样带上，上游 404
        proxy_pass http://127.0.0.1:3082/;

        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # 上游若返回站内绝对路径（插件已带前缀，这里是兜底）
        proxy_redirect / /dsh/;
    }
}
```

### 3.3 插件侧配置

**方式一：设置面板（推荐，改完立即生效，无需重启）**

进 **设置 → 远程访问 → 反向代理接入**：

- 「二级目录」填 `/dsh`（与 nginx 的 `location` 前缀逐字一致，不要带尾斜杠）；
- 「监听地址」按需选择；
- 点「应用并保存」。

`basePath` 只影响插件未来产出的 `Location` 与 `Cookie Path`，保存后**立刻生效**；
`host` 会触发一次代理重启（需要重新 bind 网卡）。改动都会写入
`~/.dsh/dsh-porthole/config.json`，重启宿主后依然保持。

> ⚠️ 填错会怎样：登录跳转会落到 nginx 未配置的路径上，表现为扫码后 404。
> **救援方式**：在电脑上用 `http://127.0.0.1:3082` 打开面板（本机免密，不受 basePath 影响），
> 或编辑 `config.json` 里的 `basePath` 后重启宿主。

**方式二：配置文件**

```yaml
- name: 'dsh-porthole'
  config:
    port: 3082
    basePath: /dsh        # 与 nginx 的 location 前缀一致；不要带尾斜杠
    host: 0.0.0.0         # 只让 nginx 访问时改 127.0.0.1
```

等价写法：`publicPath: /dsh`。改完需重启宿主生效。

> 优先级：**面板保存的值优先于 `cordis.yml`**。两者都有时以 `config.json` 为准，
> 这样面板里的改动不会被下次重启覆盖回去。

访问 `https://example.com/dsh/` 即可。

### 3.4 二级目录的已知限制

| 限制 | 说明 |
| --- | --- |
| 必须用带尾斜杠的 URL | `https://example.com/dsh` 会被 301 到 `/dsh/`；若你的客户端不跟随跳转，请直接收藏带斜杠的地址 |
| 局域网扫码地址与对外地址不同 | 二维码里是 `http://<局域网IP>:3082/`（不带 `/dsh`）。经 nginx 访问时请手动打开 `/dsh/` |
| 子目录下 `basePath` 必须与 nginx 前缀逐字一致 | 写成 `/dsh/` 或 `/DSH` 都不会生效（插件会归一化并拒绝非法值，日志里会有提示） |

---

## 四、排错

| 现象 | 原因 |
| --- | --- |
| 打开 `/dsh/` 是空白页，控制台大量 404 | `proxy_pass` 少了尾斜杠，或 `location` 少了尾斜杠 |
| 页面能开但一直转圈 / 实时不更新 | 少了 `Upgrade` / `Connection` 头，WebSocket 没连上 |
| 扫码登录后跳到站点根 404 | 插件 `basePath` 没配或与 nginx 前缀不一致 |
| 设了密码却不用输就能进 | nginx 把 `Host` 改成了 `127.0.0.1`（或没转发 Host）。porthole 以 Host 判定回环身份，务必 `proxy_set_header Host $host;` |
| 登录后立刻又退回登录页 | Cookie `Path` 与访问路径不匹配；确认 `basePath` 与 location 一致 |
| 上传附件 413 | 调大 `client_max_body_size` |
| 长时间无操作后页面断连 | 调大 `proxy_read_timeout`；porthole 自身每 25s 发 SSE 保活帧，通常不会触发 |

---

## 五、安全清单

- [ ] 已开启访问认证，并设置了**足够强**的访客密码
- [ ] 已单独设置管理密码（否则访客密码即可改配置）
- [ ] 防篡改策略设为「仅限电脑本机」或「局域网可解锁」，不是「不设防」
- [ ] nginx 转发了真实 `Host`（否则回环免密可能误判）
- [ ] 3082 端口未直接暴露到公网
- [ ] 开启 HTTPS（局域网外的明文密码等于公开）
- [ ] 定期检查面板「安全认证」里的已登录设备数
