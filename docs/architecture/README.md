# 架构决策记录（Host / Android / 共享 UI）

> 基线：`master` @ `eff821c5`（1.16.334）｜ 2026-10-31
> 这一组文档回答"终态怎么落"，**不是**"这一版做了什么"。每份 ADR 都带判据与验收条件。

---

## 文档

- `ADR-0006-LONG-HORIZON-GOAL.md`：**长程里程碑目标模式**——稳定契约 + 一次只读深规划 + 阶段证据验收 + 受控重规划；把「禁止一切目标模式」收窄为「禁止短步/无约束目标」

- `ADR-0007-NATIVE-ANDROID-CLIENT.md`：**Flutter 原生 Android 客户端**——桌面同源设计系统、复用 Host 协议、Tailscale Serve 零配对码；`android-shell` 退为历史/调试壳

- `MOBILE-INTENT-AUDIT.md`：**目标意图审计**——原生客户端/设计/协议/零配对码逐项对照，PC 全量回归读数与未完成边界

- `BENCHMARK-1.18.0.md`：**跨实现评测**——12 个真实仓库修复任务、同一 DeepSeek Flash 模型下的通过数/token/耗时与口径限制

- `ADR-0005-PC-REMOTE-GATEWAY.md`：**当前目标架构**——PC 桌面数据由桌面拥有，手机远程经桌面网关访问；ADR-0004 Phase 3 已取消

- `ADR-0004-DATA-PLANE.md`：桌面与 Host 数据面统一决策（Phase 1 工作区 → Phase 3 Host 单写）

- `UI-UNIFY-PLAN.md`：A 方案（共享组件 + 手机/平板布局）分阶段计划

- `ANDROID-UI-REVIEW.md`：真机 UI 截图与“是否沿用 Codem UI”的对标评审

- `COMPLIANCE-AUDIT.md`：**设计对标审计**（ADR-0001/2/3 逐条状态、偏差方向、补齐优先级）

- `ANDROID-DEVICE-TEST-CASES.md`：真机操作用例（DC-1..9：新建/输入/发送/审批/继续/深链/重启/崩溃）
- `ANDROID-VERIFICATION.md`：Android 本机验证报告（API35 x86_64：SC/LT/RST 读数与限制）

- `ANALYSIS-CONTINUATION-AND-COMPACTION.md`：**任务续跑与分段滚动压缩**的分析与方案（DSH 对照）

| 文档 | 回答什么 | 状态 |
|---|---|---|
| `ADR-0001-host-extraction.md` | Host 抽到哪、哪些不用改、`codem-db serve` 协议 | 已定（D-1 已修，Spike A 6/6） |
| `ADR-0002-android-runtime.md` | Android 本机：Kotlin + PRoot + Node + codem-db 可行性 | 有条件通过（端上未验证） |
| `ADR-0003-shared-ui-transport.md` | Transport 抽象、SSE/WSS 取舍、移动端功能矩阵、安全 | 已定（1 处待拍板） |
| `SPIKE-REPORT.md` | 三个 spike 的实测读数与根因（A 6/6、B 12/12、C 8/8） | — |
| `OPEN-DECISIONS.md` | **已定决策**（按「用户零负担 + 稳健优先」）、淘汰方案、工程红线、阻塞点 | 已定 |
| `evidence/` | Spike C 的移动视口截图 | — |

---

## 三个不可协商的非目标

1. **不使用 WSL / 虚拟机作为产品运行时前置**（用户 2026-10-31 明确要求）：
   Windows 交付仍是"一个 exe，双击即用"；Android 交付是"一个 APK，安装即用"。
   PRoot 是**随 APK 打包的用户态运行时**，不是让用户去开系统功能。
2. **不做 PC↔手机项目文件双向同步**：PC 是唯一真源；需要同仓库用 Git。
3. **不维护第二套聊天 UI**：手机与桌面共用 `packages/ui`，差异只由**能力位 + 断点**表达。

---

## 代码落点（本轮新增）

```text
packages/protocol/src/index.ts      # 线上契约（JSON-RPC 方法/事件/错误码/校验）
packages/agent/src/turn-writer.ts   # 回合落库契约（hydrate → 建行 → 工具落库 → 收尾）
packages/ui/src/host-client.ts      # 共享传输客户端（rpc + SSE；浏览器/Node 通用）
packages/ui/src/browser.ts          # 浏览器入口（打包成 web/ui.js，全局 CodemUI）
packages/host/src/
├─ config.ts                         # 数据根/库/端口/token 解析（纯函数）
├─ errors.ts                         # HostError → JSON-RPC 错误
├─ db/serve-client.ts                # codem-db serve 的 NDJSON 客户端（超时/退出/诊断）
├─ db/node-transport.ts              # StorageTransport 的 Node 实现（复用整个存储层）
├─ tauri-compat.ts                   # Node 文件层实现（注册为 FileTransport）
├─ provider.ts                       # OpenAI 兼容流式 provider（fetch）
├─ tools.ts                          # Host 工具（read/glob，根限制）
├─ runtime.ts                        # 会话/运行/审批/事件 + 真实 AgenticLoop（用 TurnWriter）
├─ server.ts                         # HTTP + SSE（loopback、Origin 校验、token）
└─ cli.ts                            # 入口（stdout 只留 READY，日志全走 stderr）
packages/host/web/index.html         # 协议壳（移动视口验证用；阶段 2 换 packages/ui）
packages/host/scripts/*.mjs          # build / build-ui / mock-provider / spike-a / parity-db / spike-c
src/core/file-api.ts                 # FileTransport 注入点（setFileInvoker；桌面默认仍走 Tauri）
src-tauri/codem-db/src/serve.rs      # `codem-db serve`（NDJSON 长驻）
src-tauri/codem-db/tests/serve_contract.rs  # SERVE-1..9
```

## 怎么验（判据）

```powershell
npx tsc --noEmit                          # 桌面（必须 0）
npx tsc -p packages/host/tsconfig.json    # Host（必须 0）
npx vitest run src/test/host-*.test.ts src/test/agent-turn-writer.test.ts src/test/ui-host-client.test.ts src/test/ppt-skill-registry-glob.test.ts
cargo test --manifest-path src-tauri/codem-db/Cargo.toml      # 含 SERVE-*
node packages\host\scripts\build.mjs
node packages\host\scripts\parity-db.mjs                      # 12/12
node packages\host\scripts\spike-a.mjs                        # 见 SPIKE-REPORT
node packages\host\scripts\spike-c.mjs                        # 8/8
```
