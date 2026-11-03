# 桌面网关的跨网访问（隧道 / 反向代理）

> 适用：`docs/architecture/ADR-0005-PC-REMOTE-GATEWAY.md` 的 PC 远程网关。
> 目标：手机在**外网**也能连到家里/公司这台桌面，而且不把回环端口裸奔到公网。

## 0. 为什么必须有外部入口（不能假装 NAT 穿透）

网关只绑 `127.0.0.1`（`PREFERRED_PORT = 41873`，被占才回退随机端口）。这是**有意**的：
回环地址在别的网络里根本不可路由。所以跨网访问**必然**需要一个外部入口：

1. 用户自建/加入的**覆盖网络**（Tailscale）——推荐；
2. **隧道服务**（Cloudflare Tunnel）——无需公网 IP；
3. 用户自己的**反向代理 + 域名**（nginx/Caddy + 证书）。

本项目**不做**自建中继、不做自签 CA、不做扫码登录服务器：那会把"一个 exe / 一个 APK"
变成"还要维护一套服务端"。没有外部入口时，手机只能在同机（模拟器 `adb reverse`）或
同一 Tailscale 网络内访问 —— 这是物理事实，不是配置缺失。

## 1. Tailscale（首选：稳定域名 + HTTPS + 设备身份）

```powershell
# 桌面与手机都安装 Tailscale 并登录同一 tailnet
tailscale serve --bg 41873
# 手机打开（域名固定，重启不变）
#   https://<machine>.<tailnet>.ts.net/
# 只给 tailnet 内设备用就到此为止；要开放公网再加 funnel（会要求账号具备 Funnel 权限）
tailscale funnel --bg 41873
```

- 网关侧：Host 白名单接受 `*.ts.net`；`X-Forwarded-Proto: https` ⇒ 设备 cookie 带 `Secure`。
- 稳定性：域名不随桌面重启变化，手机保存的地址长期有效；配对 cookie 30 天。
- **零配对码（仅 Serve）**：Tailscale 从 1.44 起由 Serve 注入
  `Tailscale-User-Login` / `Tailscale-User-Name`，并清掉客户端伪造的同名头；
  Funnel 不注入身份且会带 `Tailscale-Funnel-Request`。网关只在
  **loopback + `*.ts.net` + 非 Funnel + ASCII 邮箱登录** 同时满足时自动登记设备并下发 cookie。
  因此 Tailscale 网络内直接打开地址即可，无需 6 位码；Funnel/公网仍必须配对码。
  同一登录 + 同一设备名只保留一台；撤销后进 deny-list，需用配对码重新认领。
  本机进程被视为可信边界（Tailscale 官方模型：后端只监听 localhost）。
- 依赖/成本：需要 Tailscale 账号（免费档足够个人用）；funnel 需要额外开启且受服务条款限制。

## 2. Cloudflare Tunnel（无需公网 IP；临时/固定两种）

```powershell
# 临时隧道（不需要 Cloudflare 账号；URL 每次启动都会变）
cloudflared tunnel --url http://127.0.0.1:41873

# 固定隧道（需要账号 + 自己的域名 + 一次性配置）
cloudflared tunnel create codem
cloudflared tunnel route dns codem codem.example.com
cloudflared tunnel run --url http://127.0.0.1:41873 codem
```

- 网关侧：Host 白名单接受 `*.trycloudflare.com`；固定隧道用自己的域名时，启动桌面**之前**设置：
  `set CODEM_GATEWAY_ALLOWED_HOSTS=codem.example.com`（多个用逗号分隔）。
- 稳定性：临时隧道 URL 会变（手机要重新保存地址，配对仍有效）；固定隧道才满足"重启不重配"。
- 依赖/成本：cloudflared 可执行文件；固定隧道需要 Cloudflare 账号与域名。

## 3. 自有反向代理 / 自定义域名

要求：

1. 反代终止 TLS，**保留 Host**（`proxy_set_header Host $host;`）；
2. 带上 `X-Forwarded-Proto: https`；
3. 桌面启动前设置 `CODEM_GATEWAY_ALLOWED_HOSTS=<你的域名>`；
4. 只反代 `/`（静态 UI）、`/health`、`/rpc`、`/events` 四条路径，不要额外开管理面；
5. 不要把 `127.0.0.1:41873` 直接 DNAT 到公网（没有 TLS，cookie 会被明文发送）。

## 4. 安全模型（与代码一一对应）

| 机制 | 落点 | 判据 |
|---|---|---|
| HTTPS 下 `Secure` cookie | `device_cookie(token, secure)`；`RequestHeaders::is_https()` 读 `X-Forwarded-Proto`/Origin | Rust `host_allowlist_and_secure_cookie` |
| Origin 必须等于 Host | `origin_allowed()`（已有） | Rust `origin_check_is_exact` |
| Host 白名单（回环/隧道/显式域名） | `host_allowed()` | Rust `host_allowlist_and_secure_cookie` |
| 配对/撤销 | `pairing.claim`、`gateway_device_revoke`；设备表落盘（只存 sha256） | Rust `devices_export_import_round_trip_without_plaintext` |
| 停止网关 = 撤销全部设备 | `stop()` 清内存并写空设备表 | Rust 网关用例 |
| 只暴露必要路径 | 路由只有 `/`、`/health`、`/rpc`、`/events` | `remote-gateway-skeleton` |

## 5. 已验证 / 未验证（2026-11-03 实测，如实写）

| 通道 | 状态 | 证据 |
|---|---|---|
| Cloudflare quick tunnel | ✅ 通过 | 公网 HTTPS URL 下：配对、`Secure; HttpOnly` cookie、`project.list`、`session.create`、错误 Origin 403、撤销后 401（`.preview-shot/b4-tunnel-report.json`） |
| TLS 反向代理（**Tailscale 域名分支**） | ✅ 通过 | 本地 HTTPS 反代保留 `Host: desktop.tailnet-abc.ts.net` + `X-Forwarded-Proto: https`：配对、Secure cookie、列项目、建会话、未登记 Host 403、撤销 401（`.preview-shot/b4-proxy-tailnet.log`） |
| TLS 反向代理（**自有域名分支**） | ✅ 通过 | 桌面带 `CODEM_GATEWAY_ALLOWED_HOSTS=codem.example.test` 启动，同上全套（`.preview-shot/b4-proxy-custom.log`） |
| **真实 Tailscale tailnet** | ✅ 通过 | Tailscale 1.104.5 已登录（`bonder.cxb@`），节点 `win-6rsgb5ac85l.taile10bc6.ts.net`（100.117.238.0）；反代监听 tailnet IP `100.117.238.0:9943`，客户端用 **MagicDNS 真名**连接：配对、`Secure; HttpOnly` cookie、`project.list`、`session.create`（桌面库里查到该会话）、错误 Origin 403、撤销 401（`.preview-shot/b4-tailscale.log`） |
| **Tailscale 内置 `serve` + `funnel`** | ✅ 通过 | 控制台已开启 HTTPS 证书 + Serve + Funnel（`bonder.cxb@gmail.com`）；`tailscale serve --bg 41873` → `https://win-6rsgb5ac85l.taile10bc6.ts.net/`，`tailscale funnel --bg 41873` → Funnel on。直接访问该 HTTPS URL：配对、`Secure; HttpOnly` cookie、`project.list`、`session.create`、错误 Origin 403、撤销 401 全过（`.preview-shot/tailscale-live-report.json`） |

- 结论：**Tailscale 官方 `serve`/`funnel` 路径已实测通过**（不再依赖本地反代）；Cloudflare 与自有反代也全过。
  Funnel 会把网关暴露到公网（有配对鉴权，但攻击面变大）；不需要公网时执行 `tailscale funnel --https=443 off`，
  只保留 tailnet 内 `serve`。
