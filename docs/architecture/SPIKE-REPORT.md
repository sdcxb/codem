# Spike 报告（2026-10-31）

> 目的：用**可复跑**的三条证据回答三件事 —— Host 能不能真跑起来、存储能不能换通道、
> 手机形态的 UI 能不能连上 Host。全部脚本在 `packages/host/scripts/`，产物不进 git（除一张截图）。

---

## 0. 怎么复跑

```powershell
# 1) 构建（Host 单文件 bundle）
node packages\host\scripts\build.mjs

# 2) 存储二进制（带 serve）
cargo build --release --manifest-path src-tauri/codem-db/Cargo.toml

# 3) 三个 spike
$env:CODEM_DB_BIN="C:\mimo-gui\src-tauri\codem-db\target\release\codem-db-cli.exe"
node packages\host\scripts\spike-a.mjs      # 真实会话 + 一轮 Agent
node packages\host\scripts\parity-db.mjs    # CLI vs serve 线协议 parity
node packages\host\scripts\spike-c.mjs      # 390×844 Chromium 连 Host
```

`spike-a` / `spike-c` 会用**临时数据根**（用户数据的副本 / 全新库），**不触碰真实库**。

---

## 1. Spike A · Host 读取真实会话并跑一轮 Agent

**输入**：用户数据根副本（`%APPDATA%\com.codem.app` 的库三件套 + 目标会话 JSONL）。

```text
会话：对话 54（id 1793198426444-33nqat271）｜索引 6 条消息｜权威日志 94 行
模型：本地确定性假模型（scripts/mock-provider.mjs，OpenAI 兼容 SSE）
工作区：packages/host/web（只读工具只能读到 index.html）
```

| 判据 | 结果 | 读数 |
|---|---|---|
| SA-1 真实会话被读出 | ✅ | `session.get` 返回同一 id/标题，6 条消息 |
| SA-2 收到终态 | ✅ | `run.finished`（state=`succeeded`） |
| SA-2b 成功且**有正文** | ✅ | 正文是模型对文件首行的真实回答 |
| SA-3 工具真的执行 | ✅ | `tool.end`（`read index.html`，输出 12,091 字符） |
| SA-4 模型第二轮看见工具结果 | ✅ | 后续请求出现 `role:"tool"`，且模型据此收尾 |
| SA-5 索引真的写入 | ✅ | `messages.count` 6 → 9（user + assistant + tool 行） |

**事件序列**（真实抓取）：

```text
run.started → tool.start → usage → tool.end → … → run.finished
```

### 根因与修法（三处，缺一不可）

1. **读路径短路**：`listMessagesMerged` 在日志镜像为空时只返回索引镜像 ⇒ Host 冷启动读不到本回合写入的行。
   修法：`createMessage`/`updateMessage` **写穿日志镜像** + Host 进入会话先 `hydrateSessionLog`。
2. **落库时序**：循环在把 `tool_complete` 交给调用方之前就已开始下一轮请求的消息定稿 ⇒ 调用方在事件处理里
   落库永远晚一步。修法：新增 `LoopConfig.onToolResult` 钩子，在 `yield` **之前**同步落库
   （Host 用它写 `role:"tool"` 行并回填工具调用状态）。
3. **语义冲突**（顺手定稿，避免两套行为）：被索引裁剪的历史在**默认列表**里不显示，
   「完整历史」走 `listTimelineMessages` 显式展示。`SLOG-8` 与 `FIXB-4a` 从此共用同一条规则。

**此前那版"假绿"也记录在此**：早期为了让检查变绿，假模型曾用「历史里出现过 tool 就当工具已返回」，
在真实会话（历史本来就含 tool 行）里会让第一轮直接跳过工具调用 —— 已改成「**最后一条非 user 消息**是 tool」。

阶段 1 的修法（已写进 ADR-0001）：把 `App.tsx` 的回合落库序列提取成
`packages/agent` 的 `TurnWriter`（建 user 行 → 建 assistant 壳 → 工具调用/结果 → 定稿正文
→ 并入可见集），Host 只调用它；判据是"同一轮在 Host 与桌面产生**同一组**模型请求消息序列"。

---

## 2. Spike B · `codem-db serve`（Windows）与线协议 parity

### 2.1 契约测试（Rust，9 条全绿）

```text
running 9 tests
test serve_capabilities_expose_command_inventory ... ok
test serve_keeps_one_connection_across_lines ... ok
test serve_line_cap_is_bounded_but_generous ... ok
test serve_malformed_line_does_not_kill_the_session ... ok
test serve_roundtrip_via_process ... ok
test serve_shutdown_signals_exit ... ok
test serve_unknown_command_is_structured_and_keeps_id ... ok
test serve_write_then_read_in_one_process ... ok
test serve_batch_stops_at_first_failure_and_reports_names_only ... ok
```

### 2.2 parity（CLI 通道 vs serve 通道）

同一份源库的两个副本、同一串命令（含失败面），比较 `ok` + `result` 深度相等 / `code`+`retryable`：

```text
sessions.upsert ✅  messages.create ✅  messages.get ✅  messages.list ✅  messages.count ✅
counts ✅  settings.set ✅  settings.get_all ✅
messages.create（缺 role）✅  sql.raw（未知命令）✅
serve 单连接可见性 ✅
failures: 0 / ok: true
```

**结论**：`serve` 与桌面 Tauri 命令层走的是同一个 `dispatch`，只是信封多了 `id`；
换通道**不会改变语义**（这是"桌面功能不退化"的基础证据之一）。

### 2.3 Linux arm64（**blocked，不假装通过**）

```text
rustup target add aarch64-unknown-linux-gnu           ✅（rust-std 已装）
cargo check --target aarch64-unknown-linux-gnu        ❌
  error: failed to find tool "aarch64-linux-gnu-gcc"
```

原因：`rusqlite` 用 `bundled` 特性在 build script 里编译 SQLite 的 C 源码，
需要**目标平台的 C 交叉编译器**。本机没有（也不使用 WSL/虚拟机）。
源码层面已确认可移植：`codem-db` 全仓 **0 处 `cfg(windows)`**、依赖只有
`rusqlite(bundled)/serde/serde_json`。

解除方式（任一）：
1. Ubuntu CI：`apt-get install gcc-aarch64-linux-gnu` + `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc`；
2. `cargo-zigbuild`（zig 自带交叉 libc）—— 需要在 CI 上装 zig；
3. 真机/PRoot 里 `cargo build`（arm64 原生编译）。

---

## 3. Spike C · 移动视口（390×844）连本机 Host

**形态**：Chromium（Android System WebView 同引擎）headless + CDP 覆写设备指标；
加载 Host 的 `/?open=<session>&selftest=1`，页面自动走完
`host.hello → session.list → session.get → session.watch(SSE) → prompt.send`。

| 判据 | 结果 | 读数 |
|---|---|---|
| SC-1 连上 Host | ✅ | `data-connected=1` |
| SC-2 种子消息可见 | ✅ | `SEED_MARKER` 在 DOM |
| SC-3 最终答复到达 | ✅ | `MOCK_DONE …` 正文出现在 DOM（SSE 闭环） |
| SC-4 工具卡出现 | ✅ | `read {"path":"index.html"}` + `read ✓` |
| SC-5 截图 + 无页面异常 | ✅ | 213 KB PNG；`pageErrors=[]` |
| SC-6 视口确实 390×844 | ✅ | `[390, 844]` |

**结论**：协议、传输、事件流、工具卡、响应式布局、**一轮完整 Agent 回合**全部跑通（**8/8**）。
唯一需要说明的是：这次绿灯建立在 D-1 的三处修法之上（写穿 + `onToolResult` 钩子 + 裁剪语义），
不是调 mock 调出来的。

**没覆盖的**：Kotlin 壳、系统桥、PRoot、真实 Android WebView 的差异。

### 3.1 Android 模拟器（真实运行时，部分验证）

本机已装 `emulator`（WHPX 可用）+ `system-images;android-35;google_apis;x86_64`，并创建 AVD `codem-test`。

```text
设备：emulator-5554 ｜ Android 15 / API 35
访问：http://10.0.2.2:<hostPort>/?open=android-spike&selftest=1
```

| 判据 | 结果 | 读数 |
|---|---|---|
| Android 设备在线 | ✅ | `ro.build.version.release=15` / `sdk=35` |
| 手机侧页面打开 | ✅ | `mCurrentFocus=com.android.chrome/ChromeTabbedActivity` |
| 页面连上 Host | ✅ | 页面显示「已连接」（截图） |
| 会话与种子消息渲染 | ✅ | 标题「Android 模拟器 Spike」+ `ANDROID_SEED_MARKER` |
| 发 prompt 并收到答复 | ❌ | `adb input` 文本未进入 WebView `<textarea>`（uiautomator 只看到占位文字） |
| 截图 | ✅ | `evidence/spike-android-emulator.png` |

**结论**：Android 运行时 + 网络（`10.0.2.2` 映射宿主 loopback）+ 页面加载 + 与 Host 建连**已证明**；
"手机端发消息"这一步的失败是**模拟器输入自动化**问题（同一链路在桌面 Chromium 已跑通），
不是协议/服务端问题。下一步：给壳加一个 `WebView.evaluateJavascript` 的自测入口（Kotlin 壳本来就要做）。

---

## 4. 桌面不退化（parity harness）

| 层 | 判据 | 状态 |
|---|---|---|
| 存储语义 | `parity-db.mjs`（CLI vs serve，12/12） | ✅ |
| 存储契约 | `cargo test -p codem-db`（100 + 2 + 9 + 2 全绿） | ✅ |
| 渲染侧 | 现有 796 文件 / 8842 用例（全量回归） | 见最终交付说明 |
| 类型 | `tsc --noEmit`（根） + `tsc -p packages/host` | 见最终交付说明 |

> 说明：本轮**没有**把桌面 UI 改成连 Host（那是阶段 1），所以"桌面不退化"的证据是
> 现有全量判据 + 存储线协议 parity；不是"新链路已承载桌面"。

---

## 5. 结论

1. **Host 抽取的关键路径风险已消除**：真实 Agent 循环在 Node 里跑起来了，工具执行、事件流、索引写入都有读数。
2. **剩下的是工程问题，不是架构问题**：域镜像/上下文重建（D-1）、文件传输显式化、工具逐个迁移。
3. **手机形态的协议与页面闭环已证明**；端上运行时（PRoot/Node/codem-db）仍 blocked 在**执行环境**，方案本身有明确路径。

---

## 5. 真 Android 外壳（阶段 3，已通过）

手写 APK（`aapt2 + javac + d8 + zipalign + apksigner`，**不依赖 Gradle**）：
`android-shell/`，产物 `android-shell/build/codem-shell.apk`。

| 判据 | 结果 | 读数 |
|---|---|---|
| SH-1 安装成功 | ✅ | `pm list packages` 含 `com.codem.remote` |
| SH-2 外壳在前台 | ✅ | `mCurrentFocus=com.codem.remote/.MainActivity` |
| SH-3 Host 看到回合 | ✅ | `run-1793470150146-xf128c` |
| SH-4 回合成功 | ✅ | `state=succeeded`，正文是真实文件首行 |
| SH-5 截图 | ✅ | 308,924 B（`evidence/spike-android-shell.png`） |

截图里可见：标题「Android 外壳」、状态「已完成」、工具卡 `read ✓` 带完整输出、
最终答复 `MOCK_DONE 读到 <!doctype html>…`。

**仍未做**（不假装）：PRoot + Node + arm64 `codem-db` 的端上运行时；Kotlin/Gradle 工程化
（当前 Activity 是 Java，逻辑可直接翻译）。这两项都在 ADR-0002 的待办里。

**真人形态**（无 intent 参数）也已验证：外壳显示「Host 地址 + 连接」，
地址存 SharedPreferences（默认 `http://10.0.2.2:8787/`），截图见
`evidence/spike-android-shell-launcher.png`。也就是说：不需要 adb、不需要改代码，
填地址就能连 —— 这一步不需要扫码/账号（配对仍是 Host 侧的合同）。

---

## 6. 设备内 Host（阶段 3 核心，已通过）

**同一台 Android 设备上**跑完了整条链路：PRoot（Termux proot + Ubuntu 24.04 base）
→ Node 22 → 静态 `codem-db`（`x86_64-unknown-linux-musl`）→ `codem-host` → WebView。
PC 只提供假模型（设备 `10.0.2.2` 指向宿主机），Host 与数据库**都在设备上**。

| 判据 | 结果 | 读数 |
|---|---|---|
| DH-1 设备内 Host READY | ✅ | `{"ready":true,"port":8787}` |
| DH-2 `adb forward` 后 RPC 可用 | ✅ | `host.hello` 返回 `hostId` |
| DH-3 页面连上 | ✅ | `mCurrentFocus=com.codem.remote/.MainActivity` |
| DH-4 一轮成功 | ✅ | `run-1793483734925-emok8x:succeeded` |
| DH-5 截图 | ✅ | 309,787 B（`evidence/spike-android-ondevice-host-run.png`） |

截图内容：标题「设备内 Host」、状态「已完成」、工具卡 `read ✓`、最终答复 `MOCK_DONE 读到 …`
—— 全部由设备内的 Host 生成。

**产物/复跑**：
- `node android-shell/prepare-device.mjs`（幂等：推 proot/rootfs/Node/静态 db/Host/UI）
- `node android-shell/spike-ondevice-host.mjs`（DH-1..5）
- 交叉编译（Docker）：`x86_64-unknown-linux-musl` 与 `aarch64-unknown-linux-gnu` 两个
  `codem-db-cli` 均已产出（后者只是构建成功，**未在 arm64 真机跑过**）。

**仍未做**：arm64 真机验证（x86_64 模拟器不能代表 arm64 性能）；PRoot 在正式 APK 内的
打包（`jniLibs` + W^X 规避）与 Gradle/Kotlin 工程化。

---

## 7. 自包含 APK（阶段 3 终态，已通过）

`npm run android:build` 产出的 APK 带着 PRoot + Ubuntu rootfs + Node + 静态 codem-db + Host + 共享 UI；
安装后首次启动自解压并起本机 Host，**不需要 adb、不需要电脑**。

| 判据 | 结果 | 读数 |
|---|---|---|
| SC-1 安装 | ✅ | `adb install` 成功 |
| SC-2 首启 Host | ✅ | `host.hello` → `host-64617461` |
| SC-3 欢迎会话 | ✅ | `session.list` → `欢迎使用 Codem` |
| SC-4 WebView 前台 | ✅ | `com.codem.remote/.MainActivity` |
| SC-5 截图 | ✅ | `evidence/spike-android-selfcontained.png` |

复跑：`npm run android:build && npm run android:spike:selfcontained`（约 3 分钟，含首次解压）。

**产物**：`android-shell/build/codem-shell-x86_64.apk`（71.8 MB）、`codem-shell-arm64.apk`（70.8 MB，
只构建未上真机）。

---

## 8. 本机配置 → 真实回合（阶段 3 可用性，已通过）

自包含 APK 装好后，用户只需在启动页填「模型服务地址 / API Key / 模型名」。本判据用 intent extra
注入同样配置（等价于在启动页填写），然后走协议：建会话 → 发 prompt → 回合成功 → 打开会话截图。

| 判据 | 结果 | 读数 |
|---|---|---|
| LT-1 配置启动 | ✅ | `--es llmBase/llmModel` |
| LT-2 Host 就绪 | ✅ | `host-64617461` |
| LT-3 新建会话 | ✅ | `session.create` → `host-…` |
| LT-4 回合成功 | ✅ | `state=succeeded`（工具 `read` + 答复） |
| LT-5 会话页截图 | ✅ | `evidence/spike-android-local-turn.png`（`read ✓` + MOCK_DONE） |

复跑：`npm run android:build && npm run android:spike:local`（约 3 分钟）。
这一条把"手机上能真正对话"从不可能变成可复跑：此前只有欢迎会话，发送会报"没有配置模型"。

---

## 9. 事件序号持久性（阶段 4 第一项，已通过）

Host 的 `seq` 改由 `session_events.seq` 分配：`emit` 先 `events.append` 落库再通知订阅者；
`subscribe` 用 `events.list` 补发；`prompt.send` 等 `run.started` 落库后才返回 `eventSeq`。

| 判据 | 结果 | 读数 |
|---|---|---|
| SEQ-1 建会话 | ✅ | `session.create` |
| SEQ-2 seq 是数据库序号 | ✅ | `seq=21`（不是 epoch ms） |
| SEQ-3 SSE id 单调 | ✅ | 首条 `id=1` |
| SEQ-4 跨重启补发 | ✅ | 重启后 `sinceSeq=0` 补回 21 条 |
| SEQ-5 跨重启单调 | ✅ | `21 → 42` |

复跑：`npm run host:build && npm run host:spike:seq`。

---

## 10. 桌面 Host 自启（阶段 4 / G-6，代码与命令级验证通过）

- 资源：`npm run stage:host` → `src-tauri/resources/host/{host.mjs,web/,codem-db-cli.exe}`；
  Node 复用安装包已有的 `resources/node/node.exe`（不再额外带一份）。
- Rust：`host_start/host_stop/host_status`；`--port 0`，URL 从 READY 行读出（`parse_ready_line` 有单测）。
- 桌面：启动即自启（默认开启），设置页「远程 Host（新协议）」可一键关闭并显示地址。
- 已验：用安装包同款路径（`resources/node/node.exe resources/host/host.mjs …`）拉起后
  `host.hello` / `session.list` 正常；`cargo check` 通过；`cargo test host_cmd` 2/2；`RB-1..3` 4/4。
- **安装包实测（2026-11）**：`tauri build` 完成 NSIS/MSI，静默安装后启动应用 → 内置 Node 自动拉起
  `resources/host/host.mjs` → `host.hello` 返回 `hostId`；`host_stop` 后进程归零。
  （踩坑：`\\?\` 逐字前缀让 node `lstat 'C:'` 报 EISDIR，已 strip。）

---

## 11. 单写者租约（G-8 / D-5，已通过）

`packages/host/src/lease.ts`：首个客户端获得租约（TTL 90s、hello 续期）；他人 hello 不被授予；
`host.lease.takeover` 必须**二次确认**（第一次 needsConfirmation，第二次 granted 并返回前任）；
接管后旧 clientId 的 `prompt.send` 被 `LEASE_HELD` 拒绝。

| 判据 | 结果 |
|---|---|
| LSE-1 首客户端获得 | ✅ |
| LSE-2 后到者被拒 | ✅ |
| LSE-3 二次确认 | ✅ |
| LSE-3b 接管并返回前任 | ✅ |
| LSE-4 旧持有者被拒 / 新持有者可用 | ✅ |

复跑：`npm run host:build && npm run host:spike:lease`（另：`src/test/host-lease.test.ts` 8 条纯函数判据）。

---

## 12. Host 命令执行 + 审批（G-7 后端，已通过）

`packages/host/src/bash-run.ts`（可单测的执行器）+ `tools.ts` 的 `bash` 工具 + runtime 审批门：

| 判据 | 结果 | 取证方式 |
|---|---|---|
| BASH-1 拒绝不执行 | ✅ | 拒绝后目标文件不存在 + 输出含「用户拒绝」 |
| BASH-2 放行真执行 | ✅ | stdout 含 BASH_OK、exit=0 |
| BASH-3 工作区边界 | ✅ | `cwd=..` 直接拒绝（连审批都不发生） |
| BASH-4 超时杀树 | ✅ | 超时 1s 返回 `timedOut/isError` |
| BASH-5 取消 | ✅ | abort 后 `isError` |

复跑：`npx vitest run src/test/host-bash-run.test.ts`（6/6）。

**未做**：共享 UI 的审批卡片（手机端审批交互）；`terminal.*`（交互式终端）仍未支持。

---

## 13. 文件工具与审批 UI（G-7 收尾，已通过）

- `write`/`edit`/`grep` 已迁到 Host（`packages/host/src/file-ops.ts`），写操作必须经审批；
- 共享 UI 新增 `ApprovalCard`（`packages/ui`）：手机/桌面远程同一张卡，允许/拒绝直连 `approval.respond`；
- 判据：`BASH-1..5`（6 条）+ `FOP-1..4`（6 条）+ `ui-session-chat` 审批卡片用例；
- Android 回归：SC-1..5、LT-1..5 重新跑通（新 host + 新 ui.js 打进 APK）。

| 判据 | 结果 |
|---|---|
| FOP-1 写文件拒绝不落盘 / 允许落盘 | ✅ |
| FOP-2 绝对路径与 `..` 拒绝 | ✅ |
| FOP-3 edit 唯一命中 / 拒绝不改 | ✅ |
| FOP-4 grep 跨文件 + glob + 跳过 node_modules | ✅ |
| UI 审批卡片（出现→允许→调用传输层→移除） | ✅ |

`terminal.*`（交互式终端）仍未支持，保持显式 unsupported。

---

## 14. 「一键继续」（P1 的合规替代，已通过）

仓库禁止自动续跑（AGENTS.md §5.9），所以只做**用户点击**的继续：

- `useSessionChat`：`run.finished(succeeded)` ⇒ `canContinue=true`；发送后立即置 false；
- `ContinueBar`：上一轮结束后显示「继续」，点击发送「继续」；
- 判据：CONT-ALT-1（结束后出现、点击才发送、点完消失）。

不改变既有终止语义，不自动开新回合。

---

## 15. 桌面「继续」（与共享 UI 对齐，已通过）

- `src/components/ContinueBar.tsx`；只在**正常结束 + 最后一条是助手正文 + 非流式**时渲染；
- 点击发送「继续」，不做任何自动发送；
- 判据 CONT-D1（点击回调）/ CONT-D2（ChatPanel 出现条件 + 仅点击发送 + 无自动发送）。

---

## 16. Android 本机验证（x86_64 完成，2026-11）

- 环境：Android 15（API 35）x86_64 AOSP AVD；APK `versionCode=2 / targetSdk=28`；
- SC-1..5、LT-1..5 重跑通过；新增 **RST-1..4**（持久化）：跑一轮 seq=13 → force-stop → 重启 → 会话仍在、seq=20；
- `logcat -b crash` 空，`exit-info` 只有主动 force-stop；
- 报告：`docs/architecture/ANDROID-VERIFICATION.md`；arm64 仍待真机。

复跑：`npm run android:spike:restart`（需先 `android:build` 与模拟器）。

---

## 17. 真机操作用例（DC-1..9，已通过）

`npm run android:test:device`：按用户操作顺序在设备 WebView 里点「新建会话」、输入、发送、审批、继续、深链、force-stop 重启。

- 页面操作走 CDP 真实 DOM 事件；RPC 只核对 Host 状态；
- 结果写 `docs/architecture/evidence/device-cases-report.json`；
- **抓到并修复**：bash 因 Ubuntu base 缺 `libtinfo.so.6` 实际 exit 127，而旧断言被命令回显骗过（假通过）；
  现已随包携带 libtinfo + 断言改查 `(exit 0`。

---

## 18. Host 鉴权（AUTH-1..4，已通过）

- `CODEM_HOST_TOKEN` 设置后：`/rpc` 无 token ⇒ **401**；Bearer ⇒ 正常；`/events` 无 token ⇒ **401**；
- 静态页面不拦（不含秘密）；手机端新增「访问令牌」输入，URL 里的 `?token=` 由共享 UI 一次性吸收并持久化、从地址栏抹掉；
- 复跑：`npm run host:build && npm run host:spike:auth`；客户端判据 `TOK-1..2`（3 条）。

**已做**：Host 一次性配对码、设备列表/撤销（`host_pair_*` + `PairingService`，DPAIR-1..8 / DPAIR-CARD-1..3）。
旧 `phone-link` 的 LAN 扫码配对已删除；不要再把它当作配对实现。

---

## 19. 工作区只读浏览 / diff / 搜索（P1 第一批，已通过）

- `workspace.list`（目录，目录在前、逃逸拒绝）→ `WS-1..4`；
- `workspace.diff`（git diff；非 git `supported=false`）→ `DIFF-1..3`；
- 共享 UI：文件浏览器（目录/预览/截断）、Diff 按钮、会话搜索框；
- 判据：`FB-1..4`（4 条）、`SEARCH-1..3`（4 条）、`WS`/`DIFF` spike。

复跑：`npm run host:spike:workspace`、`npm run host:spike:diff`。

---

## 20. 运行中引导（steer）与工具卡展开（P1 收尾，已通过）

- `run.guidance`：运行中把补充指令注入当前循环（不另起 run）；运行结束后调用 ⇒ CONFLICT；
- 共享 UI：运行中输入内容出现「引导」按钮，走 `transport.guidance`；
- 工具卡：长结果默认截断 600 字符，「展开/收起」按需查看；
- 判据：`STEER-1..3`（spike）、`ui-session-chat` 引导用例、`TOOLCARD-1..2`。

复跑：`npm run host:spike:guidance`。

---

## 21. 响应式双列（P2 第一批，已通过）

- ≥640px：侧栏 280px（会话列表/搜索/新建）+ 对话同时显示；<640px：单列（未选会话看列表、选中看对话，Header 有返回）；
- 真机用 CDP 改视口到 900px，`getComputedStyle` 读到 sidebar/chat 都是 `flex`（DC-12）；
- 判据：`LAYOUT-1..3` + DC-12（双列）/ **DC-13**（1200px 三列：`.detail-pane` display=flex、文件行 2 条）。

---

## 22. 真模型端到端（REAL-1..4，已通过）

设备内 Host 用本机 Codem 的 DeepSeek key 真跑：RPC 路径答“北京”、WebView UI 路径答“巴黎”，截图取证。
过程中修复：rootfs 缺 CA 证书（https 全挂）、resolv.conf 指向不存在的 systemd-resolved（DNS 全挂）。

---

## 23. Android UI 截图评审（已完成）

证据：`evidence/ui-{list,chat,approval,files,wide-900,wide-1200-physical}.png`。
结论：功能矩阵达到；但共享 UI 是独立极简壳，桌面未复用同一套组件 —— 负向架构偏差（详见 `ANDROID-UI-REVIEW.md`）。
评审中修掉：工具名丢失（tool→bash，已加判据）、发送/停止同显、搜索框宽度。
