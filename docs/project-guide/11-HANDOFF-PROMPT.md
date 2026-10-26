# 11 · 交接提示词：怎么让新模型 / 新 Agent 快速接手

> 用途：把下面的话**原样复制**给新模型或新 Agent 平台。
> 原则：不要让它“通读所有文档”；给它 **5 份文档 + 一条硬约束 + 一个验收回复**。它答得出验收问题，才算真的读懂了。

---

## 1. 标准开场白（有仓库访问权，推荐）

```text
你在 Windows 仓库 C:\mimo-gui 工作。这是 Codem：一个 Windows 桌面 AI 编程助手，
技术栈是 Tauri v2 + Rust + React 18 + TypeScript，本地优先，把「对话 → 计划 → 工具调用 → 验证」
做成 GUI。当前版本 1.16.330。

第一步不要改代码。先按顺序读这 5 份文档：
1. docs/project-guide/README.md
2. docs/project-guide/00-AGENT-HANDBOOK.md
3. docs/project-guide/02-CODE-MAP.md
4. docs/project-guide/08-ENGINEERING-GATES.md
5. docs/project-guide/09-CURRENT-STATE.md

如果任务涉及对话/工具/上下文，加读 docs/project-guide/03-RUNTIME-FLOWS.md；
涉及 UI 加读 05-UI-UX.md；涉及存储加读 06-DATA-STORAGE.md；涉及 Rust 加读 07-BACKEND-IPC.md；
涉及大富翁/Godot 加读 10-GAME-AND-PROTOTYPE.md。

硬规则（违反会被判据或用户挡住）：
- 先写判据，再做变异自证，最后才提交；不许只写用例不做变异。
- 禁止目标模式 / 持久目标 / 自动续跑；多步用 todo，岔路直接问用户。
- 不要整树 git 操作（git add -A / git stash / git reset --hard）；只 git add 显式路径。
- 只按 PID 杀自己 spawn 的进程；不要 taskkill /IM codem.exe。
- 发布必须先问用户；不要擅自构建/发布。
- 不要为了让测试全绿去改产品代码；先看 09 的两条已知失败。
- 中文引号用「」；新文件 UTF-8 无 BOM。

当前基线（以你实测为准）：
- 版本 1.16.330，master；tsc 0 错误。
- 全量测试 733 文件 / 8516 用例：8497 通过、17 跳过、2 失败。
- 两条失败来自未跟踪游戏文档（BOM + 缺历史横幅），不是产品回归；不要先修它们。

开工前先跑：
pwd
git status -sb
git log --oneline -3
npx tsc --noEmit

读完先不要改代码。用不超过 10 行回答我：
1) 这个项目一句话是什么、技术栈是什么；
2) 三条主动脉分别是什么（Agent 主链路 / 插件装配链 / 存储链）；
3) 当前版本、HEAD、测试基线、两条已知失败是什么；
4) 你准备先改哪个文件、为什么；
5) 你明确不会做什么（至少说 3 条硬规则）；
6) 有什么必须我拍板的问题。

答不出来就回去补读，不要猜。
```

---

## 2. 极简版（平台上下文很小，或只想先聊方案）

```text
你在 C:\mimo-gui 工作，这是 Codem（Tauri v2 + Rust + React/TS 的桌面 AI 编程助手，当前 1.16.330）。
先读 docs/project-guide/00-AGENT-HANDBOOK.md 和 09-CURRENT-STATE.md，再按任务查 02/03/05/06/07/08。
硬规则：先写判据 + 变异；禁止 goal mode / 自动续跑；不要 git add -A；发布先问用户；
当前测试 8497 通过 / 17 跳过 / 2 失败（失败来自未跟踪游戏文档，不是产品回归）。
读完先用 6 行复述项目、三条主动脉、当前基线、你准备改什么、你不做什么、要问我什么。
```

---

## 3. 只有文档、没有仓库访问权时

```text
你只有 Codem 的文档，没有仓库访问权。先读 docs/project-guide/README.md、00-AGENT-HANDBOOK.md、
02-CODE-MAP.md、09-CURRENT-STATE.md。
约束：不要编造文件内容或行号；凡是需要看代码才能确认的结论，明确写「需要仓库访问」；
先做方案、风险与需要我拍板的清单，不要假装已经实现或验证。
```

> 如果它连上传文件都读不到：把 `00-AGENT-HANDBOOK.md` 的全文贴进对话，再附 `09-CURRENT-STATE.md` 的 §1–§5；不要贴 823 KB 的 `PROJECT-GUIDE.md`。

---

## 4. 按任务加读（不要一次塞全部）

| 新任务 | 必读 | 加读 |
|---|---|---|
| 修对话/工具/流式 bug | 00、02、03、08、09 | 06（落库） |
| 加工具/改审批 | 00、02、03、08 | 07（Rust 命令面） |
| 改设置/UI/皮肤 | 00、02、05、08、09 | 03（事件） |
| 改存储/迁移 | 00、02、06、08、09 | 07（引擎/authorizer） |
| 改 Rust/IPC | 00、02、07、08、09 | 03（调用方） |
| 项目工作台 | 00、02、03、09 | `docs/manuals/PROJECT-MODE.md`、`docs/PROJECTS-MVP-REVIEW.md` |
| 大富翁/Godot | 00、10、09 | `prototype/wealth-island-2.5d/README.md`、`docs/REBUILD-SPEC.md`、`docs/BOARD-GAMEPLAY.md` |
| 发版 | 00、08、09 | `docs/RELEASE-GUIDE.md`、`CHANGELOG.md` 顶部 |

---

## 5. 验收它的“读懂”没有（重要）

让它回答这 6 条；答错/含糊就说明没读：

1. 项目一句话 + 技术栈；
2. 三条主动脉：`App.tsx::runAgenticLoop → LLMEngine.process → AgenticLoop.run` / `config/codem.base.yml → loadFromEntries` / `storage → rust-port → storage_invoke → codem-db`；
3. 当前版本、HEAD、测试基线、两条已知失败；
4. 它准备先改的文件与理由；
5. 它明确不会做的 3 条硬规则；
6. 需要你拍板的问题。

**不要**只问“你了解了吗？”——它一定说了解了。

---

## 6. 不要这样交接

- ❌ 把 823 KB 的 `docs/PROJECT-GUIDE.md` 整个贴进去：上下文爆炸，而且正文状态停在 1.16.305。
- ❌ 让它通读 `CHANGELOG.md`（1.2 MB）或 `docs/HANDOFF-NEXT-SESSION.md`（3000+ 行）：用 grep 查关键词，不要通读。
- ❌ 只说“随便看看项目，然后开始改”：没有验收标准，它会在旧结论上开工。
- ❌ 不告诉它工作区有未跟踪的 `art/`、`prototype/`、`docs/ref-analysis/`：它可能 `git add -A`。
- ❌ 不告诉它两条测试失败来自未跟踪游戏文档：它会花时间“修”与产品无关的 BOM/横幅。
- ❌ 不告诉它“禁止 goal mode / 自动续跑”：它会用多轮自动续跑把半成品留在工作区。

---

## 7. 一句话版（贴给新会话）

```text
读 C:\mimo-gui\docs\project-guide\00-AGENT-HANDBOOK.md，按里面的 30 分钟清单开工；
先只读不写，读完用 6 行复述：项目/三条主动脉/当前版本与测试基线/两条已知失败/准备改什么/不会做什么。
硬规则：先判据后改代码、禁止 goal mode、不要 git add -A、发布先问用户。
```
