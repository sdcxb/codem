# 20 · 重型任务交接包（v1.18.4，2026-11-04）

> **这份文件是给“新对话接一个重型任务”用的。** 先读本文件，再按里面的顺序读 `00` + `09` + `08`；不要从旧交接文档开始。
>
> **基线**：`master` @ `git log -1`｜版本 **1.18.4**（GitHub `Latest`，2026-11-04）｜全量测试 **880 文件 / 9549 用例**（9532 通过、17 skipped、0 失败）｜`tsc` 0。
>
> **一句话**：Codem 是 Windows 优先的 Tauri v2 + Rust + React/TS 桌面 AI 编程助手；核心是 `App.tsx` → `LLMEngine` → `AgenticLoop` 的“对话 → 计划 → 工具 → 验证”闭环。改代码前先读 `00-AGENT-HANDBOOK.md` 的硬规则，再读 `09-CURRENT-STATE.md` 的未完成项。

---

## 1. 先给新对话的开场白（可直接粘贴）

```text
你在 C:\mimo-gui 接手 Codem 的一个重型任务。先不要改代码。

按顺序读：
1. docs/project-guide/20-HEAVY-TASK-HANDOFF.md（本文件，交接包）
2. docs/project-guide/00-AGENT-HANDBOOK.md（硬规则/基线/坑）
3. docs/project-guide/09-CURRENT-STATE.md（现在哪些绿、哪些没验、哪些别碰）
4. docs/project-guide/08-ENGINEERING-GATES.md（判据/审计/构建/发布）
5. 与任务相关的 03（运行时）、05（UI）、06（存储）或 07（Rust）

然后跑：
git status -sb
git log --oneline -5
npx tsc --noEmit
npx vitest run <相关判据>        # 先单跑；全量放最后

硬规则：先写判据再做实现；能做结构修复就不要只加提示词；不要用 goal mode/自动续跑开发本仓库；
不要整树 git 操作；只按 PID 杀自己 spawn 的进程；发版前先问用户；中文引号用「」；新文件 UTF-8 无 BOM。
禁止为了“让测试变绿”而弱化完成门、验证门或删除既有判据。

先向我汇报：你读到了什么、任务边界、你准备先写哪条判据、有哪些不确定；我确认后再动手。
```

如果新对话没有仓库访问权：把本文件 + `00` + `02-CODE-MAP.md` + `03-RUNTIME-FLOWS.md` 一起给它；不要让它猜实现。

---

## 2. 60 秒现状

| 项 | 当前值 |
|---|---|
| 版本 / 发布 | **1.18.4**，GitHub `Latest`（2026-11-04） |
| 工作区 | 发布提交后应干净；只允许 `.codem/` 运行时文件未跟踪 |
| 全量测试 | **880 文件 / 9549 用例：9532 通过、17 skipped、0 失败**（约 181s） |
| Rust | `cargo test --lib` 基线 **241 passed / 2 ignored**；本轮未改 Rust |
| Flutter | 基线 **10 passed**；新增移动端改动需重跑 |
| 12 任务对标 | 1.18.0 单轮：Codem **10/12**，DSH **9/12**；`insufficient-repetition`，只能作方向性结论 |
| 长尾单任务 | 1.18.2 前构建两轮均通过；总 token 均值 **8.30M**，修复前记录 **104.46M**；但两轮都没有触发红判据停滞终态，不能把全部降幅归因于新闸门 |
| APK | `Codem-Mobile-1.0.0-arm64.apk` / `x86_64.apk`，**debug 签名预览包**，不是正式商店包 |

### v1.18.0 → 1.18.4 的关键变化

1. **完成并验证的回合隐藏「继续」**：`turnOutcome` 结构化终态；旧会话无该字段也按已完成处理。
2. **继续条 CSS 修复**：`.chat-panel > .desktop-continue-bar` 提高优先级，避免 `ui.css` 的 `.continue-bar` 覆盖横向 gutter；内容与正文列右缘对齐。
3. **长任务效率闸门**：
   - 子代理：同会话 10 分钟最多 8 次启动；相同 prompt 去重；同时最多 2 个活跃；
   - `glob/grep` 完全相同参数观察缓存（120s，写操作清空，`refresh:true` 绕过）；
   - 红判据指纹：同一组红 + 期间没有写文件，4 次先自查，12 次停止为 `red_fingerprint_stalled`（绝不 completed）。
4. 发布：`v1.18.1`（长尾/完成态）、`v1.18.2`（CSS/旧会话继续条）、`v1.18.3`（文档任务验证误报修复）、`v1.18.4`（水位提示预热修复）。

---

## 3. 当前证据等级（别把“判据绿”写成“真机已验证”）

| 结论 | 证据等级 | 边界 |
|---|---|---|
| 全量测试绿、tsc 0 | 判据 + 本机实测 | 2026-11-04；计时敏感用例在全量并行下偶发抖动，单独跑过 |
| 12 任务通过 10/12 | 单轮评测 | 1.18.0；每任务 1 次，`insufficient-repetition`；不能外推 |
| 长尾任务 token 大降 | 单任务 2 轮候选 + 1 轮旧基线 | 方差大；新闸门并非每轮都触发；需完整配对批次 |
| 完成回合隐藏继续 | 判据 + v1.18.2 安装实测 | 旧历史无 `turnOutcome` 也隐藏；结构化字段只写新回合 |
| 自动压缩 | 判据 + 真机（1.18.0 前） | 极端 80 万 token 真实长会话仍是边界 |
| Android arm64 | 未验证 | PRoot / WebView / 厂商保活 |
| 项目工作台真实模型 3 并发 | 未证明 | R3 机制通过，不等于真实模型稳定 |

**纪律**：报告里必须把“判据层 / 真机层 / 单轮方向性”分开写；不确定就标「未知」。

---

## 4. 架构最短地图

```text
React/WebView2
  App.tsx（外壳 + runAgenticLoop）
    → core/llm/index.ts（LLMEngine / provider 路由）
    → core/llm/agentic-loop.ts（循环、工具、压缩、完成门、子代理）
    → core/llm/tools.ts + tool-pipeline.ts（工具注册/契约/执行）
    → core/storage/*（JSONL 权威日志 + SQLite 索引）
  components/ChatPanel.tsx（对话/继续条/回合徽章）
  styles.css + packages/ui/src/ui.css（桌面/共享样式；后者后加载）

Rust
  src-tauri/src/lib.rs（窗口/文件/命令/PTY/托盘）
  src-tauri/src/storage.rs + codem-db（WAL、单写者、类型化仓储）
  src-tauri/src/phone/（桌面远程网关）、ofm.rs（免费模型）
```

### 三个必须记住的链

- **Agent 主链**：`App.tsx::runAgenticLoop` → `LLMEngine.process` → `AgenticLoop.run` → `provider.stream` → `StreamingToolExecutor` + `ToolPipeline` → 消息/事件落库。
- **插件装配链**：`config/codem.base.yml` → `loadFromEntries` → Cordis `ctx.plugin()` → 服务/工具/UI 槽位；只改 `builtin-registry.ts` 不会生效。
- **存储链**：`core/storage` → `rust-port.ts` → `storage_invoke` → `codem-db`；只读真实库必须走 `tools/maintenance/read-only-db.mjs` 的复制读取。

---

## 5. 重型任务候选（按优先级）

### A. 完整 12 任务跨实现评测（最该先做）

**目的**：把 1.18.0 的单轮方向性结论升级成可比较的批次；验证长尾优化没有牺牲通过率。

**最低口径**：
- 同任务集、同模型（`deepseek-flash`）、同推理强度；
- 旧构建（v1.18.0）与新构建（v1.18.4）各至少 2 轮，或至少新构建 2 轮 + 旧构建 1 轮；
- 跑批期间**不构建、不跑全量测试**（抢 CPU 会污染墙钟）；
- 用官方 `_collect` / `dedupe-runs` / paired report 口径，不手算“通过率”；
- 记录 `pass/fail`、`totalTokens`、`uncachedInput`、`output`、`cacheRead`、`toolCalls`、`maxIteration`、`totalMs`；
- 结论必须区分“通过率”和“token/墙钟”；不要用单任务外推。

**已知坑**：repo-06 方差大；repo-11/12 的 fixture 与测试基线曾不匹配（两侧同败，不是模型问题），重跑前先确认任务判据与 fixture 一致。

### B. 长尾闸门的因果验证

**目的**：确认 v1.18.1/1.18.2 的子代理预算、观察缓存、红判据指纹是否真的降低 token，而不是模型采样波动。

**做法**：
- 旧 v1.18.0 安装包 + 新 v1.18.4 安装包；同一台机器、同一模型；
- 对长尾任务各跑 2 轮；
- 解析 `.rN.console.jsonl`，统计 `Tool executed: subagent`、`[CACHE HIT]`、`red_fingerprint_*`、`plan_stale*`；
- 如果新阀门没有触发，就不能声称是它带来的降幅。

### C. Android arm64 真机验证

未验证：PRoot、WebView、厂商保活、Keystore 本机模型、Tailscale Serve 零配对码。需要真机/模拟器与 Host 能力位；先读 `09` §5 与 `docs/architecture/ANDROID-VERIFICATION.md`。

### D. 存储/进程结构债

`session_events` 增长已缓解；仍开放：Job Object `KILL_ON_JOB_CLOSE`、软删三态、`message_count` 多口径、数据根两来源、镜像预算“读不到伪装成没内容”。这些需要产品/风险取舍，不要直接大改。

### E. UI/CSS 回归

`styles.css` 21.5k 行，`ui.css` 后加载导致级联覆盖已踩过一次（继续条 gutter）。改 UI 必须：

```powershell
node tools/ui-audit/css-contract.mjs --write
npx vitest run src/test/css-integrity.test.ts src/test/ui-consistency.test.ts
```

---

## 6. 绝对不要做

1. 不要用 goal mode / 自动续跑开发本仓库（用户明确禁止）。
2. 不要弱化完成门、回归门、验证门来让任务“通过”。
3. 不要删除/跳过既有判据来换绿；计时 flake 先单跑确认。
4. 不要整树 `git add -A` / `git stash` / `reset --hard`；只加显式路径。
5. 不要把 `.preview-shot/`、`dist/`、`art/`、`prototype/` 带进提交。
6. 不要在跑评测时构建。
7. 不要把 APK 说成正式签名包。
8. 不要用“模型说了完成”替代完成门；代码/判据 > 文档 > 模型自述。

---

## 7. 第一个 30 分钟

```powershell
cd C:\mimo-gui
git status -sb
git log --oneline -8
node -v; npm -v; rustc --version
npx tsc --noEmit
npx vitest run src/test/version-consistency.test.ts
```

然后：

1. 读 `00` 的 §3 六条硬规则、§8 常见坑；
2. 读 `09` 的 §5 未完成项、§6 结构债；
3. 读与任务相关的 `03/05/06/07`；
4. 写一条会因缺陷而红的判据，再做实现；
5. 相关判据 → 全量 → `npm run audit:docs` → 需要时构建/真机；
6. 最后才提交/发版；发版前问用户。

---

## 8. 交接质量自检（新对话答得出才算读懂）

1. 当前版本、`Latest`、HEAD 是什么？
2. 全量测试基线是多少？出现 1 条计时 flake 时先做什么？
3. 为什么“任务完成”徽章与“继续”按钮曾经同时出现？修复的根因是什么？
4. 长尾优化有哪三道闸门？哪一道可能误杀？为什么红判据指纹只能停成“未完成”？
5. 12 任务评测为什么不能把 10/12 当成统计显著结论？
6. 哪些能力只有判据、没有真机证据？
7. 开发本仓库为什么禁止 goal mode？允许的产品目标模式边界是什么？
8. 发布前必须跑哪些门禁？APK 的签名状态是什么？

如果答不出，回到 `00` / `09`，不要开始改代码。
