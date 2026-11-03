# Codem Mobile 目标意图审计（2026-11-03）

> 范围：本轮对话里提出的「Flutter 原生 Android 客户端 + 桌面同源设计 + 远程 Host 协议 + 零配对码」。
> 只记录**已经看到的代码/判据/读数**，不把"写了"当成"验证过了"。

## 结论

核心意图已经落地：Flutter 原生客户端、Codem「静墨 / Ink & Violet」视觉、Host 协议复用、
Tailscale Serve 零配对码、x86_64 release APK 与桌面全量回归都成立。

仍有 **3 个明确的未完成/受限项**，不应在对外说明里写成"全部完成"：

1. **本机 Host 的启动/发现未接**：手机端主路径是远程 Tailscale Host；本机模式仍是旧壳。
2. **零配对码只覆盖 Tailscale Serve**：Funnel、Cloudflare、自定义反代没有可信身份头，
   继续要求配对码；不是"所有入口都零码"。
3. **平台/发布硬化未完成**：只验证 x86_64 模拟器；arm64 未上真机；cookie 暂存
   SharedPreferences；APK 约 169 MB（未接完整 NDK strip）。

另有一项**验证边界**：没有用第二台已登录 Tailscale 的手机跑完整 tailnet 闭环；
Host 侧信任判据和客户端 cookie 捕获分别有自动化测试，但不能替代该真机闭环。

## 意图 → 实现

| 意图 | 实现 | 证据/位置 | 状态 |
|---|---|---|---|
| 用 Flutter 原生 UI 取代 WebView 手机端 | `mobile/` Flutter 工程，包名 `io.codem.codem_mobile` | `mobile/lib/`、`mobile/README.md` | 已落地；`android-shell` 保留为历史/调试壳 |
| 对标 dsh-go，但有 Codem 自己的美感 | 炭黑 + 紫、Alimama 品牌字、JetBrains Mono、细线/扁平、深浅主题 | `docs/design/MOBILE-DESIGN.md`、`mobile/lib/design/tokens.dart` | 已落地（审美为主观项，截图见 `.preview-shot/mobile-*.png`） |
| 移动端高信号、中密度、渐进披露 | 72px 会话行、16sp 正文、12sp mono 元数据、单列 + Sheet、≥44px 触控 | `docs/design/MOBILE-DESIGN.md`、`mobile/lib/design/components/` | 已落地 |
| 复用桌面 Host 协议，不建第二套库 | JSON-RPC `/rpc` + SSE `/events`；`HostClient` 对接 `host.hello`、`session.*`、`prompt.send`、`approval.*`、`workspace.*` | `mobile/lib/data/host_client.dart`、`src-tauri/src/phone/gateway/mod.rs` | 已落地（附件按 Host 能力位开关） |
| N0–N6 里程碑 | 设计、主机、聊天/工具/审批、项目/文件/改动、媒体/通知/前台、Tailscale/主机切换、测试/APK | `docs/architecture/ADR-0007-NATIVE-ANDROID-CLIENT.md` | 完成；带上方 3 项限制 |
| Tailscale Serve 零配对码 | loopback + `*.ts.net` + 非 Funnel + ASCII 登录 → 自动登记设备、下发 HttpOnly cookie；同名轮换 token；撤销进 deny-list | `src-tauri/src/phone/gateway/mod.rs`、`pairing.rs`；Rust 网关测试 46 项 | 已落地；只对 Serve 生效 |
| Funnel/公网仍安全 | Funnel 不注入身份头且带 `Tailscale-Funnel-Request`，直接拒绝自动登记 | 同上；测试覆盖 Funnel/非 ts.net/畸形登录 | 已落地 |
| 不修改桌面既有行为 | 只在网关新增一条自举路径；完整 PC 回归通过 | 见下 | 回归通过；这是**新增**行为，不是替换旧配对 |
| 不提交/不发布/不升版本 | 未 commit/push；版本仍 1.17.0；未改 `docs/releases` | `git status` | 遵守 |

## PC 端回归

本轮全面测试读数：

| 面 | 命令 | 结果 |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | 0 错误 |
| 前端全量 | `npx vitest run` | **874 文件 / 9510 passed / 17 skipped / 0 failed** |
| Rust 全量 | `cargo test --lib` | **241 passed / 2 ignored / 0 failed** |
| Flutter | `flutter analyze` / `flutter test` | 0 issue / **10 passed** |
| 文档门禁 | `npm run audit:docs` | 通过（1.17.0） |
| 静态审计 | report-sites / reachability / mutations / fail-open / silent-write / command-parity / node-syntax / token-hygiene / regex-unicode / storage-boundary / schema-parity / coverage / unrouted-db / row-builders / write-return / control-bytes / gaplist / probe-guard / color-roles / style-literals / guard-bypass / false-success | 全部通过（逐项见本轮日志） |

本轮发现并修复的 PC 侧问题：

- `cargo fmt --all` 曾把多个既有 Rust 文件整体重排，导致 5 条**源码结构判据**失败：
  `file-tree-hidden`、`shell-spawn-flags`、`free-model-plugin-host`、`mutation-artifacts`。
  处理：恢复 35 个只被格式化、原本干净的文件；在 `lib.rs` 恢复三处判据钉住的单行形态
  （`list_directory` 签名、PowerShell 参数链、`execute_command` 测试调用）；
  `ofm.rs` / `repo.rs` 回到 HEAD。再跑全量 Vitest：0 失败。
- 没有发现业务语义回归；全量测试与 Rust/Flutter 测试均通过。

## 未完成 / 下一步

1. 用第二台已登录 Tailscale 的手机验证 Serve 零码闭环（不在本环境）。
2. 本机 Host 启动/发现；否则手机主路径仍依赖远程 Host。
3. arm64 真机、Keystore、完整 NDK strip / APK 瘦身。
4. 若要让 Funnel 也零码，需要另行设计可信身份（不能信任客户端可伪造的头）。
