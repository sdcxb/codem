# ADR-0001 · Host 抽取边界与 `codem-db serve` 协议

> 状态：**已定（Spike 已验证关键路径，含 1 处未收敛缺陷）** ｜ 日期：2026-10-31 ｜ 基线：`master` @ `eff821c5`（1.16.334）
> 决策者：Codem 架构线 ｜ 相关：`ADR-0002`（Android 运行时）、`ADR-0003`（共享 UI/Transport）、`SPIKE-REPORT.md`

---

## 1. 要解决的问题

现在 Agent 循环、工具、存储调用**全部住在渲染进程**（`src/core/**` + WebView）。桌面 UI 与未来的手机 UI
若要共用同一套能力，只有两条路：

- **A. 复制一套**：手机端重写循环/工具 —— 立即产生两份行为，且"同一句话在两端结果不同"无法避免；
- **B. 抽出一个常驻 Host**：循环/工具/存储只存在一份，桌面与手机都只是**客户端**。

选 B。本 ADR 只回答一件事：**边界画在哪、哪些必须动、哪些一行都不用改**。

---

## 2. 结论（先看这个）

| 层 | 现状 | Host 里怎么办 | 改动量 |
|---|---|---|---|
| **Agent 循环** `src/core/llm/agentic-loop.ts`（6944 行） | 渲染侧类，Node 里**能直接跑**（实测） | **原样复用**，不重写 | 0 行（修 1 处 Vite 专属 API，见 §4.1） |
| **工具注册** `src/core/llm/tools.ts`（2667 行，39 个静态 import） | 模块求值阶段会触发 Vite `import.meta.glob` | 同样原样复用；Host **只注册**自己实现的那部分工具 | 1 处 try/catch |
| **存储层** `src/core/storage/rust-port.ts`（3416 行） | 已经有 `StorageTransport` 抽象（默认 Tauri IPC） | 提供 `NodeTransport`（stdio → serve） | **新增 ~90 行** |
| **文件层** `src/core/file-api.ts`（21 个 `tauriInvoke` 调用点） | 直接读 `window.__TAURI__.core` | Spike：兼容层；阶段 1：抽 `FileTransport` | 0 / 21 处收口于 1 个函数 |
| **Rust `codem-db`** | 只有一次性 CLI（`invoke`/`batch`） | **新增 `serve`**（NDJSON 长驻） | 新增 `serve.rs`（~230 行）+ 9 条判据 |
| **Rust `lib.rs`（360 KB）** | 窗口/托盘/命令/终端/更新 | **不迁移**，继续只做桌面壳 | 0 |
| **桌面 UI** | 直接 import `core` | 阶段 1 起改为经 Transport 连 Host | 见 ADR-0003 |

一句话：**Host 不是"重写一个后端"，而是"给已经分好层的渲染侧换宿主"**。这也是它能成立的全部原因。

---

## 3. 边界图

```text
┌─────────────────────────── PC ───────────────────────────┐
│  Tauri 壳（lib.rs：窗口/托盘/更新/PTY 原生桥）              │
│      │ sidecar 拉起                                        │
│      ▼                                                     │
│  codem-host（Node/TS，常驻）                                │
│   ├─ Agent 循环（复用 src/core/llm/agentic-loop.ts）        │
│   ├─ 工具（Host 侧实现，id/schema 与渲染侧一致）             │
│   ├─ 会话/运行/审批/事件（协议语义层）                       │
│   ├─ 文件层（file-api 的 Node 传输）                        │
│   ├─ JSONL 权威日志（sessions/<id>.jsonl）                  │
│   └─ codem-db serve ◀── NDJSON（一条命令一行）              │
│          │                                                 │
│          └─ SQLite/WAL（单进程单连接 = 单写者）              │
└───────────────▲───────────────────────────▲───────────────┘
                │ HTTP+SSE（loopback）       │ 同一 Transport
        ┌───────┴───────┐            ┌──────┴───────┐
        │ 桌面 WebView   │            │ 手机 WebView │
        └───────────────┘            └──────────────┘
```

**边界判据**：任何"只有某个 UI 需要"的东西（hover、右键菜单、窗口尺寸、皮肤）**不进 Host**；
任何"换个客户端也必须一样"的东西（消息落库、工具语义、压缩、审批规则）**必须在 Host 且只有一份**。

---

## 4. 实测出来的三堵墙（这是本 ADR 最有价值的部分）

### 4.1 Vite 专属 `import.meta.glob` 会拖垮整条工具链

- 位置：`src/core/knowledge/ppt-skill-registry.ts`（2 处，**模块求值阶段**）。
- 原因链：`tools.ts → generate-ppt → ppt-generator → ppt-skill-registry`，**静态 import**。
- 症状：Node 里 `TypeError: (intermediate value).glob is not a function`，**整个 agent 循环起不来**
  （看起来像"Host 不支持 PPT"，实际是"Host 根本没启动"）。
- 已修：把两处字面量调用包进 `try/catch`（Vite 构建期仍会把它替换成对象字面量，Web 行为不变）。
  判据：`src/test/ppt-skill-registry-glob.test.ts`。

### 4.2 原生依赖只能外置，不能打进 bundle

- `@huggingface/transformers` → `onnxruntime-node`（`.node` 原生二进制）。
  它是**动态 import**（`local-embedding.ts:130`），但打包器会跟着静态分析把它拉进来。
- 结论：Host 的构建把 `@huggingface/transformers` / `onnxruntime-node` / `sharp` 标成 external；
  只有真正做语义检索时才需要它们。**Host 主路径不依赖任何原生模块**（除了 Rust 的 codem-db）。

### 4.3 文件层没有可注入的传输（唯一需要改产品代码的地方）

- `file-api.ts` 的 21 个调用点全部收口在**一个函数** `tauriInvoke` 里，但它直接读全局
  `window.__TAURI__.core.invoke`。
- 连带影响面：`session-jsonl.ts`（权威日志）、`attachment-files.ts`（附件外置）、
  `data-root.ts`（数据根解析）、`snapshot.ts`（回合快照）、`sandbox-acl.ts`（工作区判定）。
- Spike 用**兼容层**（`packages/host/src/tauri-compat.ts`）在进程内提供同名全局对象，**一行产品代码没改**
  就跑通了权威日志追加；阶段 1 的正解是把它换成显式 `FileTransport`（判据：删掉兼容层后 Spike 仍通过）。

### 4.4 额外发现：Host 必须复用**同一条启动序列**

`MessageStorage.createMessage` 的第一道判断是"会话是否已删除"，读的是 `sessions` 的**域镜像**；
镜像没预热时那一读返回 `null`，写入被**静默跳过**（事件流一切正常，库里一行没有）。
Spike 第一版手搓启动序列就踩了这个坑，改成 `registerRustStoragePort` + `prefetchDomainMirrors`
（`bootstrap.ts` 的同一条路径）后恢复。**结论：Host 的启动序列不允许"差不多"，必须调 bootstrap 的公开入口。**

---

## 5. `codem-db serve` 协议（定稿）

### 5.1 为什么必须新增（不能继续用 `codem-db-cli invoke`）

1. **单写者**：`invoke` 每次一个新进程、一条新连接；WAL 下退化成多连接抢锁（`busy_timeout` 只是兜底）。
2. **事务属于连接**：没有长连接就没有"跨命令的状态"（导入/迁移/重建都必须在一个连接里）。
3. **成本**：每次调用重开库（PRAGMA + schema 幂等检查 + 装审计触发器）落在流式热路径上。

### 5.2 帧格式：NDJSON（一条命令一行）

```json
{"id":1,"command":"messages.list","params":{"session_id":"s1","limit":20,"include_hidden":true}}
{"id":1,"ok":true,"result":{"items":[…],"has_more":false},"engine":"rust"}
{"id":2,"ok":false,"engine":"rust","error":{"code":"UNSUPPORTED","message":"…","retryable":false,"hint":"…"}}
```
- `id` **原样回显**（数字/字符串都保留类型）—— 这是唯一能把应答配回请求的依据；
- 空行**不产生应答**（心跳不能把 stdout 刷满）；
- 单行上限 32 MiB（超限报错，不是 OOM）；
- `op`：`invoke`（缺省）/ `batch` / `health` / `capabilities` / `ping` / `shutdown`。
- 形状与 Tauri 的 `StorageReply` **逐字段对齐**（多一个 `id`），因此 `NodeTransport` 与
  `tauriTransport` 共用同一套解包代码（`rust-port.ts::unwrap`）。

### 5.3 为什么不是 WebSocket / 不是 HTTP

- Host 与 codem-db 是**同机、同用户、父子进程**：进程内通道最简单、没有端口、没有鉴权面；
- NDJSON 可被 `jq`/`Get-Content` 直接看，排障不需要协议工具；
- 代价：只能串行（一个 Engine 一把锁）—— 而单写者本来就是这个设计的前提。

### 5.4 判据

`src-tauri/codem-db/tests/serve_contract.rs`（9 条，已全绿）：
SERVE-1 能力清单 / SERVE-2 同进程写后读 / SERVE-3 未知命令结构化 / SERVE-4 坏 JSON 不杀会话 /
SERVE-5 batch 失败即停且只回命令名 / SERVE-6 跨行单连接 / SERVE-7 shutdown / SERVE-8 行上限 /
SERVE-9 **真进程**往返（证明每行立即 flush，纯函数测试看不见这一点）。

---

## 6. Host 的职责清单（阶段 1 施工顺序）

1. **存储与启动序列**（已完成 Spike 验证）：`NodeTransport` + `bootstrap` 同路径。
2. **文件传输** `FileTransport`：`file-api.tauriInvoke` 已换成可注入（21 处收口于 1 个函数）。
   - **已完成**：`setFileInvoker` + Host 的 `createNodeFileInvoker`；判据 `src/test/host-file-transport.test.ts`（FT-1..3）。
   - 剩余（阶段 2）：`data-root`/`maintenance` 里仍直读 `__TAURI__` 的少数点，逐条改走同一个注入点。
3. **工具迁移**：`read`/`glob`/`grep`/`write`/`edit`/`bash` 逐个搬到 Host（**同一 id、同一 schema**），
   `bash` 需要审批/超时/进程树，放在工具迁移的最后。
   - **部分完成（2026-11）**：`bash` 已落地（`bash-run.ts` + `approval.requested` 门 + 超时/进程树/输出上限/工作区边界，
     判据 BASH-1..5）；写工具（write/edit/grep）仍待迁移；共享 UI 的审批卡片是下一步。
4. **回合落库契约（TurnWriter）**：把 `App.tsx` 的回合落库序列提取成 Host 可调用的
   `TurnWriter`（进入会话 hydrate → 建 user 行 → 建 assistant 壳 → 工具调用/结果 → 定稿正文）。
   - **已落地的三块**（Spike A 6/6、Spike C 8/8 的证据）：
     1. `message.ts` 日志镜像**写穿**（create/update 同步镜像）+ Host 进入会话先 `hydrateSessionLog`；
     2. `LoopConfig.onToolResult` 钩子：在把 `tool_complete` 交给调用方**之前**同步落库，
        解决"调用方落库永远晚于下一轮请求定稿"；
     3. 裁剪语义定稿：默认列表不显示被裁行，`listTimelineMessages` 显式展示（`SLOG-8`/`FIXB-4a` 同一条规则）。
   - **已完成**：三步封装成 `packages/agent/src/turn-writer.ts`（TW-1..3 判据），Host 改用它；
     FileTransport 也已显式化（`setFileInvoker` + FT-1..3）。
5. **事件序号**：把 Spike 的"单调时钟 seq"换成 `session_events.seq`（表与 `events.list` 命令都已存在）。
   - **已完成（2026-11）**：`emit` 先 `events.append` 落库再通知订阅者；`subscribe` 从 `events.list` 补发；
     `prompt.send` 等 `run.started` 落库后才返回 `eventSeq`；诊断暴露 `persistFailures`。
     判据 `packages/host/scripts/spike-seq.mjs`（SEQ-1..5，跨重启补发 21 条、seq 21→42 连续）。
6. **打包**：`packages/host/dist/host.mjs` 单文件 + `codem-db-cli` sidecar；桌面用 Tauri sidecar 拉起。
   - **已完成（2026-11）**：`tools/build/stage-host-sidecar.mjs` 把 host.mjs/web/codem-db 放进
     `src-tauri/resources/host/`（Node 复用安装包已有的 `resources/node/node.exe`）；Rust 新增
     `host_start/host_stop/host_status`（`host_cmd.rs`，`--port 0` + READY 行读 URL）；桌面启动时自启
     （`bootstrapRemoteHost`，默认开启、可一键关闭），设置页「远程 Host（新协议）」显示地址/状态。
     判据：Rust `host_cmd` 单测（READY 解析）、`RB-1..3`（默认开启/关闭生效/非 Tauri 静默）、
     以及用**安装包同款路径**跑起 staged Host 并用 `host.hello`/`session.list` 验证。
   - **安装包实测（2026-11）**：`tauri build` 出 NSIS 69.9MB / MSI 87.5MB；静默安装后
     启动应用 → `resources/node/node.exe` 自动拉起 `resources/host/host.mjs`（端口随机）→
     `host.hello` 返回 `hostId`；`host_stop` 后进程归零。
   - **踩坑**：Tauri 在 Windows 返回 `\\?\` 逐字前缀，直接传给 node 会 `lstat 'C:'` 报 EISDIR；
     必须在交给子进程前 strip（`host_cmd::strip_verbatim`，与 ofm 同处理）。

---

## 7. 明确不做

- **不重写 Agent 循环**（一次重写 = 两份行为，且现有压缩/守卫/审批语义极难复刻）。
- **不迁移 `lib.rs`**：窗口/托盘/更新/Job Object 是**壳**的职责，不是 Host 的。
- **不让 Host 直接对 SQLite 写 SQL**：只走仓储命令（authorizer 与白名单继续生效）。
- **不做"Host 内嵌在 WebView 里"的伪常驻**：关窗后仍要远程服务，进程必须独立。

---

## 8. 验收（本 ADR 生效的条件）

- [x] `AgenticLoop` 在 Node 可加载（`IMPORT_OK`）。
- [x] `codem-db serve` 契约测试 9/9（Windows）。
- [x] 线协议 parity：CLI 与 serve 对同一输入给出**同一结果**（12/12，含失败面）。
- [x] Host 读取**真实会话**（用户数据副本）并跑完一轮（工具执行、索引 6→9）。
- [x] 失败**不伪装成成功**：正文为空时 `run.failed`（含原因），不是 `succeeded`。
- [x] 模型在下一轮**看见工具结果**，并据此收尾（SA-2b/SA-4 通过）。
- [x] 移动端 390×844 一轮完整回合（SC-3 通过，8/8）。
- [ ] `FileTransport` 显式化（阶段 1）。
