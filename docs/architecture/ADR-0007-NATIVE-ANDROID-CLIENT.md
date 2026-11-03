# ADR-0007：Codem 原生 Android 客户端（Flutter）

- 状态：已接受（2026-11-03）
- 决策人：项目作者
- 关联：ADR-0006（长程目标模式）、`docs/design/MOBILE-DESIGN.md`、`docs/architecture/REMOTE-ACCESS-TUNNELS.md`

## 背景

现有 Android 交付物是 `android-shell`：Java WebView 壳 + 本机 Node Host，UI 复用
`packages/ui` 的 Web 页面。它能跑通“手机看 PC 会话”，但存在结构性缺口：

- UI 不是原生：手势、列表性能、键盘/Insets、深色/浅色切换都受 WebView 限制；
- 后台/通知/媒体能力弱：连接保活、审批提醒、图片选择都要桥接；
- 无“主机”产品感：仍是浏览器配对页，不是原生主机列表/一键切换；
- 与 Flutter 参考实现（dsh-go）相比，交互密度和移动端细节明显不足。

产品方向已经明确：**不继续把 Web UI 塞进 WebView，改为 Flutter 原生客户端**；
桌面端（Tauri/Rust/React）、Host、Gateway、Agent Loop、SQLite 存储与协议全部保留。

## 决策

1. 新增 `mobile/` Flutter 工程（Android 优先，包名 `io.codem.codem_mobile`），
   作为 Codem 的**原生手机客户端**。
2. 核心界面全部原生：会话、聊天、工具卡、审批、主机、项目、设置、改动 Sheet。
3. 继续复用既有协议：
   - `POST /rpc`（JSON-RPC 2.0）
   - `GET /events`（SSE）
   - `host.hello` / `session.*` / `prompt.send` / `run.cancel` / `approval.respond` /
     `attachment.put` / `session.changes` / `session.change.diff`
4. 保留 `android-shell` 作为历史/调试壳，不作为主产品；第三方 HTML 插件页
   可以继续用 WebView，核心壳不退回 WebView。
5. 设计语言与桌面同源：炭黑 `#0F1217` + 紫 `#7C6CF0`、Alimama 品牌字、
   mono 元数据、扁平细线；移动端采用“信息高密度、操作低密度”的三层密度模型。

## 架构

```
Flutter UI (mobile/)
  ├─ CodemAppState（会话/消息/审批/运行状态）
  ├─ HostClient（Dart：JSON-RPC + SSE + cookie/Bearer）
  ├─ HostStore（主机列表；N0 暂用 SharedPreferences）
  ├─ NativeBridge（MethodChannel：前台服务/通知/系统分享）
  └─ Design System（CodemTheme/CodemPalette/组件）
        │ HTTP(S) / SSE
        ▼
PC 上的 Codem Host（127.0.0.1:41873 或 Tailscale HTTPS）
        │
        ▼
桌面 Agent Loop / SQLite / 工具执行
```

- 手机不直接执行工具、不直接读文件；所有工具/审批仍在 PC。
- 远程凭据是 `pair.claim` 下发的 HttpOnly cookie；Dart 侧以 `Cookie` 头携带。
- 本机模式后续复用同一协议，由 Flutter 侧启动/发现本机 Host（N1 未完成）。

## 移动端设计要点

- 一层主任务：看会话、发消息、审批、切主机；不把桌面三栏缩成手机三栏。
- 会话行 72、正文 16sp、元数据 12sp mono、点击区 ≥44。
- 详情（改动/文件/上下文）放 Sheet，允许高密度；主屏保持中密度。
- 低装饰但高反馈：按下态、触觉、紫线焦点、状态点 + 文字。
- 深色为默认，浅色同源；不引入 Material 默认紫。

## 安全

- 传输：Tailscale HTTPS / 本机 loopback；不经过 Codem 服务器。
- 凭据：配对 cookie 只存本地；N0 为快速验证暂存 SharedPreferences，
  **正式发布前必须迁移到 Android Keystore/EncryptedSharedPreferences**。
- 日志：不打印 cookie、token、文件正文；审批只展示摘要与路径。
- 零配对码（Tailscale Serve）：只信任同时满足四条的请求——
  TCP 对端 loopback、Host 是 `*.ts.net`、不是 Funnel（拒绝
  `Tailscale-Funnel-Request`）、`Tailscale-User-Login` 是 ASCII 邮箱。
  身份由 tailscaled 注入并清掉客户端伪造值；本机进程属于可信边界。
  Funnel/公网入口不注入身份，仍走 6 位配对码。
  同一登录 + 同一设备名只保留一台（同名重连轮换 token）；撤销写入 deny-list，
  必须重新用配对码认领；停止网关会清空 deny-list（重新启用远程）。
- 网络：`network_security_config` 仅允许 `127.0.0.1`/`localhost`/`10.0.2.2`
  明文，远程必须 HTTPS。

## 后果

正面：

- 原生手势、键盘、深色模式、通知/前台服务、图片选择；
- 主机列表与一键切换成为一等公民；
- 与桌面共用协议，不需要重写 Agent/存储。

代价/风险：

- Flutter 插件原生依赖（NDK/CMake）会拖慢首建；已通过固定插件版本与
  跳过 native 符号裁剪规避，后续引入 native 插件时要补真实 NDK；
- 免配对需要 Host 侧配合（认领链接/短码），客户端只能做到解析链接；
- 当前没有自建 relay，跨网络仍依赖 Tailscale；账号/中继是后续独立决策；
- 安装包仍偏大（release x64 约 169MB，主要来自 Flutter 引擎/调试符号策略）。

## 里程碑与状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| N0 | 设计基线、Flutter 工程、主题/组件、三屏 golden | 完成 |
| N1 | 主机管理、HostClient、会话列表、真实连接 | 完成（本机 Host 启动待补） |
| N2 | 聊天流式、工具卡、审批、停止 | 完成（用 mock Host 真实验证流式/工具/审批通知） |
| N3 | 项目、文件树、改动/diff、设置、分享 | 完成（文件树/文件预览已接 `workspace.*`） |
| N4 | 图片、通知、前台服务、分享 | 完成基线（图片上传、审批通知、前台服务、系统分享） |
| N5 | Tailscale、零配对码、主机切换 | 完成（Serve 身份自动登记；Funnel/公网仍走配对码） |
| N6 | 测试、真机验收、APK | 完成（analyze/test/模拟器 release 安装） |

## 非目标

- 不在手机端执行工具或改文件；
- 不重写桌面 UI；
- 不实现自建账号/中继服务（当前用 Tailscale）；
- 不删除 `android-shell`，只停止把它当主客户端。
