# 交接单：停滞守卫误杀（根因已定位）+ Codem 编码能力评测（2026-10-02 · v1.16.223）

> **新对话请从这里开始。** 目的：让你**不用重新推导**就能接手。
> 本文件是**事实与约定**，不是叙事。所有数字与文件行号都是实测/实读的。
>
> ⚠️ **本文件是 gitignore 的**（`docs/*.md` 在 `.gitignore` 里 ⇒ 提交要 `git add -f`）。
> 档名刻意不含 `GAP|PLAN|TODO|STATUS|...` 这些词，所以**不需要**「历史文档（不再维护）」横幅
> （那条规则见 `src/test/docs-current-gap-list.test.ts` 的 DOCS-2）。
> 同目录另有两份相关文档：`docs/DSH-ALIGNMENT-FIX-PLAN.md`、`docs/PI-ALIGNMENT-FIX-PLAN.md`、
> `docs/MEASUREMENT-PLAN-DSH-VS-CODEM.md`（**这三份带横幅**，是历史记录）。

---

## §0 先做这三件事

```powershell
# 1) 基线必须绿，不绿就先报告，别在它上面叠加改动
npx vitest run                                          # 期望 473 文件 / 6871 用例
cargo test --manifest-path src-tauri\Cargo.toml --lib    # 期望 130 passed（+2 ignored）
npm run audit                                            # 期望 exit 0
cd .deepseek-harness-ref; git pull; cd ..                # DSH 参考副本，期望 0 落后

# 2) 先读 §2（根因）—— 那是这一轮最有价值的产出
# 3) 再读 §3（遗留任务，按优先级）
```

**最重要的工作方式（本仓库的规矩，别省）**：
> **每一项改动都要有「判据 + 变异自证」，然后发版、装机验证。**
>
> "判据全绿"**不算证据** —— 必须**证明判据能变红**（做一次变异：把关键那一行改坏，看到断言变红，再还原）。
> 这一轮我被自己的判据骗过 **4 次**（§5 有清单）。**每次变异"没咬住"，先怀疑变异，再怀疑判据，最后才怀疑实现。**

---

## §1 当前状态（可核对）

| 项 | 值 |
|---|---|
| 版本 | **1.16.223**（已装机：`HKCU\...\Uninstall\Codem` 的 `DisplayVersion`） |
| HEAD | **`e8a89a0`**，工作区干净 |
| 测试 | TS **473 文件 / 6871 用例（16 skipped）**；Rust **130 条**（+2 `#[ignore]` 活体） |
| `npm run audit` | exit 0（**含三套评测自证**：成对评测器 19/19、链路 11/11、编码档 5/5） |
| `tsc --noEmit` | 0 错误 |
| 额度 | 用户授权 **¥100** 做 token 测试，**约已用 ¥30** |

**本轮提交（从新到旧）**：

| 提交 | 内容 |
|---|---|
| `e8a89a0` | 「改了文件却没验证，不许安静地当作完成」守卫（**注意：这不是 §2 那个 bug 的修复**，见 §3.2） |
| `40ad932` | 真实仓库档扩到 8 个任务 + 判据加入回归子集（改坏别处会扣分） |
| `942126f` | 真实仓库档两次实测（4/5 与 5/5）+ 成本数字 |
| `ca7288a` | 真实仓库档任务集（我们自己的仓库上回退修复当任务） |
| `b7aa02d` | 把 treatment 臂卡点写成可执行配方（DB+CDP / 无头入口两条路） |
| `21e3a0f` | 编码档基准 + 修压缩摘要输入（500 字截断 / 只砍尾） |
| `9b67614` | 更正"DSH 没有 CLI"的错误结论 + 拿到 DSH control 基线 |
| `346ba82` | 补上一版漏的三处（workflow 权限绕过 / 活跃目标死守卫 / planContext 前缀） |
| `86a21be` | 对标 DSH/Pi：修计量、修 11 处"假成功"、关 run_code 权限绕过 |

---

## §2 ★根因（本轮最重要的产出）：停滞守卫把「读」当「没推进」

### 2.1 用户报的现象

> **「任务提前停掉，然后说完成了」** —— 用户自己反复遇到过。

### 2.2 一手证据（不是推测）

在咱们自己仓库上跑一个真实任务（把 `edit` 二义性修复回退，让 Codem 自己找出来修），
它留下的事件流在数据库里，会话 id **`1790981803954-u5dmdoahw`**（211 条事件）：

```
事件类型分布：119 trajectory_step / 38 tool_result / 38 tool_call / 12 assistant_text / 2 user_message / 2 loop_stopped
loop_stopped  seq=9530  {"reason":"plan_stale_ask","stalledFor":12}
loop_stopped  seq=9599  {"reason":"plan_stale",    "stalledFor":24}
```

被杀那一刻它正在说的话（seq=9603）：

> "Now I have the full picture. Let me read the actual edit tool implementation and run the D8 test to see the real state."
> ⚠️ **检测到停滞，已停止**：已连续 24 个迭代**没有任何推进**…

守卫自己注入的自查提示（seq=9529）把判据说得很清楚：

> 「计划没有修订…也没有产出任何交付物（**没有写入/编辑/会改盘的命令**）」

### 2.3 所以真正的缺陷是两条

| # | 缺陷 | 位置 / 现状 |
|---|---|---|
| **①** | **停滞判据只看"有没有写盘 / 改计划"，不看"有没有获得新信息"。** 在真实大仓库里，称职的探索（逐文件读、越读越准）被判成"没推进"：**第 12 轮提醒、第 24 轮直接杀掉循环**。 | 推进信号 = `iterationProducedArtifact`（`agentic-loop.ts` 第 65 波那段，搜 `artifactTracker.note`）+ `planRevision`。**守卫其实已经有信息增益信号却没用它**：`this.repeatGuard.noteResult(name, effectiveArgs, result.output)` 返回 `{gained, streak}`（零信息增益/重复内容）。 |
| **②** | **被杀掉之后被呈现成「任务完成」。** 用户看到的那句"完成了"就是从这来的。 | `reason: "plan_stale"` 在界面侧没有被当成失败/中断，落到了"完成"那一支。相关：`src/App.tsx` 的 `describeTurnOutcome`（`src/core/llm/turn-outcome.ts`）。 |

### 2.4 为什么前面的档位没暴露它（重要）

| 档 | DSH 通过率 | 会不会触发停滞守卫 |
|---|---|---|
| 自包含基线档（14 任务） | 14/14 | 不会 —— 读一两个文件就开写 |
| 自包含编码档（8 任务） | 8/8 | 不会 —— 同上 |
| **真实仓库档（8 任务）** | 4/5 → 5/5 | **会** —— 需要在大代码库里长时间探索 |

**这解释了用户"文本处理用了一个月效果很好"**：那是短会话。**只有真实仓库级任务会踩到它。**
也解释了为什么我前面几轮"修了一堆假成功"却没解决用户报的这个问题 —— 那些是**别的**病。

### 2.5 治本的两个改法（位置已定位，未实施）

1. **把停滞判据从"写盘"扩成"信息增益"**：
   用 `repeatGuard.noteResult(...)` 的 `gained` 作为推进信号之一 ——
   **读到新内容就是推进**；只有"反复拿回同样的内容 / 连续零信息增益"才叫停滞。
   同时把 12 / 24 这两个阈值改成**按"连续零增益次数"计**，而不是"连续迭代数"。
2. **杀掉时不许呈现为完成**：`plan_stale` 应当是**独立终态**（照 `too_many_errors` 的做法），
   界面明确显示"因停滞而停止，请人工确认下一步"，而不是"任务完成"。

### 2.6 复现方法（下次直接跑，不用再猜）

```powershell
# 看任意一次运行的停因 / 最后正文 / 注入的提示（只读数据库）
node .preview-shot/_probe-stop-reason.mjs      # 写死了会话 id，改开头那行即可
node .preview-shot/_probe-why-stopped.mjs      # 列最近会话 + 事件类型分布
```
更省事的复现：跑 §3.3 的真实仓库任务（用真实大仓库 + 需要多次阅读的任务），**基本必触发**。

---

## §3 遗留任务（按优先级）

### 3.1 ★把停滞守卫治本（§2.5 两条一起做，最高优先）

- 改 `src/core/llm/agentic-loop.ts`（停滞判定处，搜 `plan_stale` / `stalledFor` / `iterationProducedArtifact`）
  与 `src/core/llm/loop-stop-log.ts`（`LoopStopReason` 已含 `plan_stale` / `plan_stale_ask`）。
- **判据**：用假 provider 驱动循环，让它连续多个迭代**只读新文件**（每次返回不同的文件内容）⇒
  **不许**出现 `plan_stale`；反向对照：连续迭代读**同一份**内容（零信息增益）⇒ **必须**出现 `plan_stale`。
- **变异**：把信息增益那一项从推进判据里去掉 ⇒ 第一条判据必须变红。
- 然后**用真实仓库任务复测**：预期它不再在第 24 轮被杀，而是能读完并动手修。

### 3.2 给 `e8a89a0` 的守卫补判据（它现在**没有自己的判据**）

`e8a89a0` 加了「改了文件却一次都没验证就不许安静地当作完成」，但**没有行为判据、没做变异自证** ——
按本仓库规矩它**只算"实现就绪"，不算"验证通过"**。待补：

- **判据**：假 provider 驱动循环 —— 迭代 1 发一个 `write`、迭代 2 不发工具调用，
  断言出现「没有验证」的提示；**反向对照**：迭代 1 跑一条 `npx vitest`（或任何 `looksLikeVerificationCommand` 认的命令）则**不该**触发。
- **变异**：删掉 `turnRanVerification` 的赋值（`agentic-loop.ts` 交付物判定那段）应当变红。
- 顺手确认：它**对 §2 那个 bug 不生效**（停滞守卫是直接 `return` 杀掉循环的，走不到 completed 分支）——
  所以别把它当成 §3.1 的替代品。

### 3.3 用真实仓库档测 Codem（机制**已经跑通**，只跑了 1 个任务）

机制（`.preview-shot/` 里三个脚本，见 §4.4）。**我只跑了 `repo-01`：Codem 0/1**
（它跑了 38 次工具调用、界面报「任务完成」，判据 3/7 红 —— 但按 §2 的发现，
**真因是停滞守卫在第 24 轮把它杀了**，不是它"自以为做完了"）。

下一步：把 `repo-01…repo-08` 依次跑一遍拿**总分**，再按分数低的先修。
预计每个任务要几分钟到十几分钟。

### 3.4 `append_file` 不检查尾换行 ⇒ **合法记录会被永久删除**（真实数据丢失）

证据链（已核实）：
- Rust `append_file` 是 `OpenOptions::append(true)` + `writeln!`（`src-tauri/src/lib.rs` 约 `:768-780`），
  **从不检查文件是否以换行结尾**，也**没有 `fsync`**（而同文件 `write_file` 的 `:732` **有** `sync_all()`）。
- 崩溃留下的半截尾行会让**下一条记录被粘在同一行**上 ⇒ 整行 `JSON.parse` 失败。
- 而 `compactSessionLog` 把解析不了的行**直接丢掉**（`src/core/storage/session-jsonl.ts` 附近 `:868`），
  它的安全闸门只比行数（`linesAfter < linesBefore`）⇒ **看不见"一行坏行里裹着一条合法记录"** ⇒ 合法记录被永久删除。
- 附带：`skippedLines`（半截行的计数）**在生产代码里没有任何消费者**（只在定义与 3 个测试里出现），
  所以"半截行"事实上是**不可见**的。

**修法**：`append_file` 追加前确保文件以换行结尾（必要时先补一个）+ 加 `sync_all()`；
读侧识别"无换行的最后一条 = 残尾"并**上报**（照 DSH 的 `truncateTornTail`）。
判据要能变红：写 2 条完整行 + 半截尾行 → 再 append 一条 → 断言那条**仍然可读**。

### 3.5 `fs-observation-policy`：读后写 / 版本比对（DSH 有，我们没有）

DSH：`.deepseek-harness-ref/packages/fs/fs-observation-policy/src/index.ts`
`:78-82` `editIntent` 抛 `FS_NOT_OBSERVED`（"edit requires reading ... first"），
`:62-70` `writeIntent` 走 `createIfAbsent` / `replaceIfVersion`（版本 CAS）。

我方：`src/core/provider/fs-observation-policy-provider.ts` **全文 16 行**，只有文件监听的防抖配置，
**没有任何写入前置条件**（名字与能力不符，容易让人以为已有保护）。
建议与 `edit` 二义性（`src/core/llm/tools.ts` + `edit-matchers.ts`）**同批做**。

### 3.6 `isAutoApprovable` 对外层工具仍自动放行

`src/core/permission/security-mode.ts:149-184` 只特判 `if (tool === "bash" && resource)`，末尾 `return true;`
⇒ 外层 `run_code` / `workflow` 在「替我审批」(auto) 模式下**仍可被自动放行**。
闸门目前只关在**嵌套调用**那一层（`src/core/llm/tool-gates.ts`）。
要不要连外层也改成需要确认，是**产品决定** —— 需要用户拍板。

### 3.7 真实仓库档可以继续扩 + 判据再收紧

- 现在 8 个任务（`tools/eval/tasks-repo.mjs`）。本轮会话修过的 bug 都能变成任务（回退修复 + 用已有判据）。
- 判据已含 `relatedTests`（回归子集），但仍是**手挑的**；可以扩成"相关测试子集全绿"甚至按模块跑。
- 局限（写清的）：每任务只跑一个子集 ⇒ 仍不是完整回归；这些 bug 是"我们自己的"。

---

## §4 环境事实（别重新推导）

### 4.1 DSH 有 CLI，而且有 headless 执行器（我上一轮搞错过，已更正）

- 我上一轮只看 `dsh-headless` / `dsh-cmdline` 两个子包的 `bin`（都是空）就断言"没有 CLI" —— **错的**。
- **`@deepseek-ai/dsh`（主包）声明了 `bin: { dsh: "lib/bin.js" }`**；机器上 PATH 里就有 `dsh.cmd`
  （位置在 `%APPDATA%\DSH Desktop\host-commands\desktop\generations\...\bin\dsh.cmd`，**不在装机 app 目录里**）。
- **`dsh --profile headless`** = 无头任务执行器：「answer one task, print the result, and exit」。
  `--json` 输出**逐行 JSON 事件**；`-` 表示从 stdin 读任务（避开 Windows 引号地狱）。
- 事件契约（`tools/eval/drivers/dsh-driver.mjs` 依赖它）：
  ```
  {"type":"session","sessionId":...,"cwd":...}
  {"type":"status","phase":"step_end","turn":N,"step":M,"usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}}
  {"type":"tool_call","callId":...,"tool":"read","input":{...}}
  {"type":"final","text":"..."}
  ```
  **一次任务的用量 = 所有 `step_end` 各桶求和**（每个 step 的 `totalTokens` 是该步的，不是累计值）。

### 4.2 模型与授权

- DSH 侧实际配置（读 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）：
  `provider: deepseek-account`、**`model: deepseek-flash`**、`reasoningEffort: high`、
  `defaultPreset: danger-full-access`（sandbox full / approval never）。
- 用户口径：**两边都用 `deepseek-flash`**；**模型调用两边都已配好，不用去搞密钥**；
  授权 **¥100** 做 token 测试；**用户不懂也不想懂内部机制**（对外话术要一屏说清，机制留在代码注释里）。

### 4.3 Codem 的 DeepSeek 密钥是**密封存储**的（外部拿不到）

- 数据库里是 `"id":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKeySealed":"dsh1:0100…"`。
- **不要去逆向用户的凭据库** —— 对一个安全敏感的平台那是错的选择。
- 引擎活在 **WebView**：`src-tauri/src/*.rs` 里 **77 个 Tauri 命令没有任何一个能跑一轮 agent**
  （只有 `run` / `storage_invoke` / `truncate_utf8` 这类基础设施）。
- 应用**没有**把 store / 调试钩子挂到 `window`（只有 Tauri 自己的 `__TAURI__`）。

### 4.4 怎么驱动正在跑的 Codem（**机制已跑通**）

- 启动（必须带调试端口）：`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"`，
  然后跑 `C:\Users\abee\AppData\Local\Codem\codem.exe`。
- **CDP 取 target 时要按 URL 过滤 `tauri.localhost`** —— 否则会抓到 DevTools 页（我踩过）。
- 聊天输入框：**`textarea.message-input`**（placeholder「输入消息，回车将自动新建全局对话」）。
  写值要用 native setter + `dispatchEvent(new Event('input',{bubbles:true}))`，然后派发 `Enter` 键。
- 三个现成脚本（都在 `.preview-shot/`，gitignore）：
  | 脚本 | 作用 |
  |---|---|
  | `_set-last-project.mjs [projectId]` | 把「上次打开的项目」写进 DB。**`C:\mimo-gui` 的项目 id = `1788268442101-mzvox72w5`**；传 `'""'` 复位成全局对话 |
  | `_codem-send-task.mjs "<任务>"` | 把任务打进聊天框并回车 |
  | `_codem-finish.mjs` | 判断是否跑完 → 跑判据 → **还原仓库** |
- **关键设置（已在 DB 里）**：`codem-security-mode-project:C:\mimo-gui = full` —— 跑任务不会卡审批。
  另有 `codem-project-execution-modes`、`codem-last-project`（我复位成了 `""`）。
- **数据库**：`%APPDATA%\com.codem.app\codem-db-rust.bin`（SQLite）。
  **Node 24 自带 `node:sqlite`（`DatabaseSync`）可用** ⇒ 只读取证很方便（本次就是靠它拿到的停因）。
  表：`projects / sessions / v2_sessions / settings / session_events`（**列是 `seq, session_id, event_type, payload, timestamp`**）。
  写库前**要先停应用**（它会持有 DB）。
- ⚠️ 跑完之后**务必还原仓库**（`git checkout HEAD -- <回退掉的文件>` + `git reset`），
  并**先把 diff 存下来再还原**（我这次先还原了、没留 diff，拿不出"它改了什么"）。

### 4.5 评测三档（`tools/eval/`）

| 档 | 文件 | 任务数 | DSH | 用途 |
|---|---|---|---|---|
| 基线档 | `tasks.mjs` | 14 | 14/14 **饱和** | 链路与成本 |
| 编码档 | `tasks-coding.mjs` | 8 | 8/8 **饱和** | 成本维度有区分度（比基线高 55% token / 37% 调用） |
| **真实仓库档** | `tasks-repo.mjs` | 8 | **4/5 → 5/5 不饱和** | **唯一能区分水平的档** |

- 真实仓库档机制：`git worktree add --detach <tmp> HEAD`（`node_modules` 用 junction 指回主仓库）
  → `git checkout <buggyCommit> -- <实现文件>` 造 bug → agent 跑
  → **评分前 `git checkout HEAD -- <判据文件 + 回归子集>`（反作弊）** → `npx vitest run <…>`。
- 自证：`noop` 臂必须**全红**、`reference` 臂（还原实现）必须**全绿**。
- 常用命令：
  ```powershell
  node tools/eval/run-arm.mjs --arm control --model deepseek-flash --task-set coding --runs 1 --out <jsonl> --agent-cmd "node C:\mimo-gui\tools\eval\drivers\dsh-driver.mjs"
  node tools/eval/run-repo-arm.mjs --arm reference --reference --model deepseek-flash --runs 1 --out <jsonl>
  node tools/eval/run-arm.mjs --report --out <jsonl>
  ```
- 成本量级（真实仓库档，DSH）：**每任务中位 ≈5.88M tokens / 77 次工具调用**；
  5 个任务合计 29.4M tokens / 1095 秒；**缓存读占 97.8%**。
  ⇒ **要比 token，比的其实是缓存命中率**（这也是为什么前缀稳定性（`planContext`/时间戳）修得值）。

---

## §5 判据与变异自证的约定 + 我这轮踩过的坑（别重复）

### 5.1 规矩

- **每一项改动都要有行为判据**（断言落在序列化结果 / 请求体 / 磁盘内容 / 可观察状态上，
  **不要**断言"源码里有没有某个词"）。
- **必须有变异自证**：改坏关键那一行 → 判据**变红** → 还原 → 变绿。没红的判据 = 没覆盖。
- **变异没咬住时，先怀疑变异和判据，最后才怀疑实现。**
- 变异要用**精确单点替换**，**绝不要** `replace_all` 做还原（有 agent 因此把文件改烂过）。
- 判据命令**不要**用 `Select-Object -First N` 接原生命令（会提前杀进程，退出码骗人）。
- **别用 `Set-Content` / `Out-File` 写源码**（会加 BOM，esbuild 直接挂）——用 `write`/`edit` 工具。
  （我违反过一次，用 `.preview-shot/_strip-bom.mjs` 清掉的。）
- **中文文案里不要用 ASCII 双引号**（嵌套引号会把 esbuild 弄挂）——用「」。
- 多行字符串不要走 `pwsh -Command`；`node -e` 遇到中文/引号几乎必挂 —— 写成 `.mjs` 文件再跑。
- **"我没找到" ≠ "不存在"**：声称某个东西不存在，必须说清**在哪里找过、找的是什么形式的入口**。
  （我因此错误地说过"DSH 没有 CLI"，被用户当场纠正。）

### 5.2 这一轮被自己的判据骗过的 4 次（都要引以为戒）

1. **`cache-prefix-stability.test.ts`** 测的是 `buildSystemPrompt` 纯函数，而真实链路上那段注入
   （`apiMessages[0].role === "system"`）**恒为假、从未执行** ⇒ 判据在一个不执行的链路上长期稳定地绿着。
2. **`interrupt-behavior-architecture.test.ts:48`** 只钉"abortAll 后 running 为空"，
   没钉"之后不再起新调用" ⇒ "按了停止还在写"能全绿。
3. **`trigger-call-execute-loop.test.ts:887`** 用**源码字符串断言**伪装成行为断言
   （注释声称覆盖 LLM 连续失败 → too_many_errors，实际只是 `expect(loopSrc).toMatch(...)`）。
4. **`goal-injection.test.ts`** 同理，而且掩盖了真功能失效：**「活跃目标」从来没到达过模型**
   （同一个恒为假的守卫）。已改写成行为判据。
5. **我自己的变异脚本报错了行**：用 `line.includes("FAIL")` 找红行，而**通过**行的文案里就写着「必须 FAILED」⇒
   记录指向一条**绿线**。一份会误导人的记录比没有记录更糟。（`tools/eval/pipeline.mutation.mjs` 已修成 `startsWith`。）
6. **我的一次误报**：曾据"两个文件名不相等"断定 `.tmp` + rename 必失败 —— 核对了实现，**那条是错的**（未采用）。
7. **我的一次误判**：把"守卫看起来是对的"当成了"守卫会通过"（见上面第 1 条）。
8. **我的一次工具 bug**：`run-repo-arm.mjs` 第一版把 `readUsage(ws)` 放在 `cleanupRepoWorkspace(ws)` **之后**
   ⇒ worktree 已删、**第一次跑的 token 数字全丢**。已修（先读再清理）。
   ⇒ **"判据要看真实产物"这条纪律，对工具本身同样适用。**

### 5.3 装机验证（§5.1 的最后一环）

- 版本号在**四处**：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `Cargo.lock`。
  用 `node .preview-shot/_bump-version.mjs <from> <to> --write`。
- `CHANGELOG.md` 顶部必须有当前版本条目、`docs/PROJECT-GUIDE.md` 的已发布版本表必须有 `| vX.Y.Z |`
  （`src/test/version-consistency.test.ts`、`src/test/update-manifest-generator.test.ts` 会判）。
  这两份是**白名单**（不在 `docs/*.md` 忽略里），正常 `git add` 即可。
- 构建：设 `TAURI_SIGNING_PRIVATE_KEY`（读 `.tauri\codem-updater.key -Raw`）+
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD="dummy"`，然后 `npm run tauri:build`（约 4 分钟）。
  装之前 `Stop-Process -Name codem -Force` 并等 ~6 秒（文件锁）。
- 装完：`node tools/release/make-latest-json.mjs <ver> --notes-file <notes.md>` →
  `node tools/release/verify-update-manifest.mjs <ver>`（本地 5 项）。
- 装机验证探针：`.preview-shot/_verify-223.mjs`（**从 `package.json` 读期望版本**，可复用）。
  它只验「产物对不对 + 起不起得来」——**行为修复由测试覆盖，不是它**。
  ⚠️ 界面上版本号只在「**帮助**」设置页被挂载时才在 DOM 里（React 条件渲染）——
  我第一版探针在默认页找它而报红，**那是判据写错了，不是应用的问题**。
- **未做**：未 push、未打 tag、未 `gh release create`（对外且不可逆的动作，用户没要求）。

---

## §6 脚本与工具清单（`.preview-shot/` 是 gitignore 的，但很有用）

| 脚本 | 用途 |
|---|---|
| `_probe-stop-reason.mjs` / `_probe-why-stopped.mjs` | **看某次运行的停因 / 最后正文 / 注入提示**（§2 就是靠它） |
| `_set-last-project.mjs` / `_codem-send-task.mjs` / `_codem-finish.mjs` | 驱动正在跑的 Codem（§4.4） |
| `_probe-codem-dom.mjs` / `_probe-codem-project.mjs` | 探 DOM 选择器 / 看它打开哪个项目 |
| `_smoke-dsh-headless.mjs` | 单任务冒烟 `dsh --profile headless --json` |
| `_probe-credentials.mjs` | 只看"有没有可用凭据"（**不打印任何密钥值**） |
| `_strip-bom.mjs` | 去掉文件开头的 BOM |
| `_bump-version.mjs` / `tools/release/*` | 发版 |
| `tools/eval/*`（**已提交**） | 三档任务集 + 两档执行器 + 桩臂 + 成对评测器 + 三套自证 |

---

## §7 一句话总结给下一个对话

**根因已经找到并有一手证据：不是"模型自以为做完了"，而是「停滞守卫把大代码库里的正常探索当成没推进，
在第 24 轮把循环杀掉，然后这个终止被呈现成『任务完成』」。**
先按 §3.1 治本（推进判据加入信息增益 + 停顿改成独立终态），
再按 §3.2 给已有的守卫补判据，然后用 §3.3 拿 Codem 的真实得分。
