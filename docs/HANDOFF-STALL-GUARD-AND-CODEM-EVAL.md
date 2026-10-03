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

> ✅ **已完成（第 93 波，v1.16.224）** —— 见文末 §8.1 / §8.2 / §8.4（判据 + 变异自证 + 真实仓库复测）。

- 改 `src/core/llm/agentic-loop.ts`（停滞判定处，搜 `plan_stale` / `stalledFor` / `iterationProducedArtifact`）
  与 `src/core/llm/loop-stop-log.ts`（`LoopStopReason` 已含 `plan_stale` / `plan_stale_ask`）。
- **判据**：用假 provider 驱动循环，让它连续多个迭代**只读新文件**（每次返回不同的文件内容）⇒
  **不许**出现 `plan_stale`；反向对照：连续迭代读**同一份**内容（零信息增益）⇒ **必须**出现 `plan_stale`。
- **变异**：把信息增益那一项从推进判据里去掉 ⇒ 第一条判据必须变红。
- 然后**用真实仓库任务复测**：预期它不再在第 24 轮被杀，而是能读完并动手修。

### 3.2 给 `e8a89a0` 的守卫补判据（它现在**没有自己的判据**）

> ✅ **已完成（第 93 波，v1.16.224）** —— 行为判据在 `src/test/verification-guard-behavior.test.ts`，
> 变异自证见 §8.3。

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

> ✅ **已完成（第 94 波，v1.16.225）** —— 写侧换行守卫 + `sync_all()`、读侧残尾可观测 + 抢救，
> 判据与变异见 §8.7。

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

> ✅ **已完成（第 95 波，v1.16.226）** —— 见文末 §9。顺带在真机上抓到**另一个**同类缺陷：
> 前端读的字段名与线上名字对不上（`nextOffset` 恒 `undefined`）。

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

---

## §8 第 93/94 波（本轮做完的事，2026-10-03 · v1.16.224 / v1.16.225）

> 提交 **`30ed631`**（1.16.224：§3.1 + §3.2）与 **`1.16.225` 那笔**（§3.4 + 用量记账）。
> 这一节只写**事实与实测数字**，每一条都能用 §6 的命令复现。

### 8.1 §3.1 治本：停滞判据加入信息增益（v1.16.224）

- **改法（三处，都是最小改动）**：
  - `stall-guard.ts`：`StallSignal` 多一个必填字段 `gainedInformation`；推进信号从
    「改计划 **或** 产出交付物」扩成「改计划 **或** 产出交付物 **或** 获得新信息」。
    12 / 24 两个阈值**单位随之改变**：数的是"连续多少次**零进展**迭代"，不再是"连续迭代数"。
    新增可观测计数 `stats.informationGainResets`（真实仓库任务里它应当很大；为 0 就说明信号没接上）。
  - `agentic-loop.ts`：迭代级新字段 `iterationGainedInformation`（每轮清零），
    在 `repeatGuard.noteResult(...)` 返回 `gained === true` 时置位 —— **只统计真正执行过的调用**
    （读缓存命中 / 被守卫拦下的调用不会把"反复看同一份旧内容"洗成新信息）；
    停滞停止的 `LoopResult` 带上 `detail: { stalledFor, planRevision, noGainStreak }`。
  - `loop-stop-log.ts`：`plan_stale` 的语义注释跟着改成"计划没前进 + 没交付物 + **没有新信息**"。
- **判据**（`src/test/stall-guard-loop-behavior.test.ts`，3 条，**全部驱动真循环**）：

  | # | 造法 | 判据 |
  |---|---|---|
  | STALL-LOOP-1 | 26 个迭代，每个读**不同**文件（内容各不相同 ⇒ 有信息增益） | 循环跑满 26 个读迭代 + 收尾 ⇒ `completed`、无 `plan_stale`、不注入「进度自查」 |
  | STALL-LOOP-2（反向） | 读不同文件但内容**一模一样**（零信息增益） | 必须被停下，且 `reason !== "completed"`（实测先响的是 `repeat_guard`，见 8.5） |
  | STALL-LOOP-3 | 24 个**零进展**迭代（读缓存命中 + 有指引待消费 ⇒ 循环继续） | 必须走到 `plan_stale` 且 `detail.stalledFor === 24` |

- **变异自证**：把 `gainedInformation: this.iterationGainedInformation` 换成 `false` ⇒
  **STALL-LOOP-1 变红**：`26 个不同文件的读必须全部真的执行: expected 24 to be 26`
  —— 也就是"它果然又在第 24 轮被杀掉了"。还原后立刻回绿。
- 另外把 `stall-guard.test.ts` 里那条**源码文本断言**（原 STALL-12，注释声称"判定逻辑真的接在循环里"，
  实际只断言源码里有 `this.artifactTracker.note(`）换成了指向上面的行为判据的说明 —— 它原来是**假绿**
  （本文件 §5.2 第 3 条的同类）。夹具补上 `gainedInformation`，并新增 STALL-4c / 4d 两条单元判据。

### 8.2 §3.1 的第二条：被杀掉的循环不许再被呈现成「完成」（v1.16.224 + v1.16.225）

一手证据指向的呈现路径**一共有四处**（都在真实链路上）：

| # | 位置 | 原来的行为 | 现在 |
|---|---|---|---|
| ① | `src/core/pet/pet-store.ts` 的 end 处理 | 只把 `aborted` / `error` / `overflow` 当"非完成"，**其余一律 `setPetState("happy")`** ⇒ `plan_stale` 让大肥鱼摆出「任务完成！」 | 判据统一交给纯函数 `describeTurnOutcome`：**只有 `reason === "completed"` 才算完成**；`stopped` ⇒ sad + 说明气泡 |
| ② | `src/App.tsx` 的后台完成通知（`finally` 里） | 窗口不在前台时**无条件**发「✅ 完成」宠物气泡 + 原生通知「任务完成 — …」—— 停滞停止、LLM 失败、用户按停止**全都照发** | 只有 `describeTurnOutcome(...).kind === "completed"` 才发（判据是 `case "end"` 里算好的那一份；异常收场为 `undefined` ⇒ 不通知） |
| ③ | `src/core/llm/turn-outcome.ts` | `plan_stale` 落在"其它非正常停止"里：不显示完成卡，但**没有任何一句"这不是完成"**，也没有 turn 级状态 | `plan_stale` 成为**独立终态**（照 `too_many_errors`）：明说「因停滞而停止 / 这不是正常完成 / 请人工确认下一步」，带上停滞量级、落 `turnStatus{kind:"error", code:"plan_stale"}`、消息标 error |
| ④ | `src/core/llm/index.ts` 的用量记账（**v1.16.225**） | `runLoopAndRecordUsage` **只认两种失败形状**（`type:"error"` / `reason==="too_many_errors"`）⇒ `plan_stale` / `repeat_guard` / `output_truncated` / `context_overflow` / `no_progress` / `max_iterations` / 成本上限**全被记成成功调用** | 判据同样交给 `describeTurnOutcome`：只有 `completed` 算成功 |

- 判据：`app-turn-outcome-rendering.test.ts` 新增 `TURN-PLAN-STALE`（+ 反向对照）与 `EXEC-PLAN-STALE`；
  `pet-system.test.ts` 新增 `plan_stale` / `repeat_guard` ⇒ `sad`；App 那条接线由 `APP-NOTIFY-GATE` 钉住
  （**明确标注为接线检查、不是行为判据** —— 它在巨型组件的 `finally` 里，没有便宜的整机夹具）；
  ④ 由 `usage-non-completion.test.ts`（6 条，驱动**真实**记账路径）覆盖。
- **变异自证（四次，逐个咬住）**：删掉 `plan_stale` 分支 ⇒ 终态两条红；关掉 pet 的 `stopped` 分支 ⇒ pet 两条红；
  把 App 的通知条件改回无条件 ⇒ `APP-NOTIFY-GATE` 红；把用量口径换回旧的 ⇒ `usage-non-completion` 4 条红。

### 8.3 §3.2：「改了但没验证」守卫补上行为判据（v1.16.224）

- 新文件 `src/test/verification-guard-behavior.test.ts`：
  - **VERIF-1**：迭代 1 `write` 成功 → 迭代 2 只说话、不调工具 ⇒ 必须先出现「没有验证」提示，
    **并且把循环推着多跑一个迭代**（`provider.requests.length === 3`），仍不改则明说「未经证实」。
  - **VERIF-2（反向对照）**：迭代 2 跑一条 `npx vitest …` ⇒ **不许**出现任何提示、也不该被推着多跑。
- **变异自证**：删掉 `if (isBashLike && looksLikeVerificationCommand(cmd)) this.turnRanVerification = true;`
  ⇒ VERIF-2 变红（`expected 4 to be 3`）。
- **顺手确认（§3.2 最后一条）**：它**对停滞误杀不生效** —— `plan_stale` 是在迭代末尾直接 `return`
  杀掉循环的，走不到 `completed` 分支里的这段守卫。所以它**不是** §3.1 的替代品。

### 8.4 §3.1 要求的「真实仓库任务复测」：**循环不再被误杀**

`repo-01-edit-ambiguity`（就是当初留下误杀证据的那个任务）在同一台机器、同一个仓库上重跑：

| 项 | 旧（1.16.223，误杀现场） | 新（1.16.224） |
|---|---|---|
| 停因 | `plan_stale_ask stalledFor=12`（第 12 轮）+ `plan_stale stalledFor=24`（**第 24 轮杀掉**） | 这条会话里**本轮 0 条 `loop_stopped`**（没有任何阀门停下它） |
| 迭代 | 到第 24 轮被杀 | **iteration 1..36**（156 个 trajectory_step） |
| 工具调用 | 38 次 | 53 次 |
| 用量 | —— | **4.66M token**（缓存命中 4.40M / 未命中 0.19M；输出 71.6k）、约 6.4 分钟 |
| 判据 | 3/7 红 | 24/24 绿 —— **但见 8.5：它是从 git 里把参考解取回来的，分数不算数** |

- ⚠️ **诚实边界（两层）**：
  1. 回车是"继续**当前**会话"，所以这一次跑在**旧会话里**（上下文带着旧那次读过的文件）。
     它对"守卫还会不会在第 24 轮误杀"仍是**强证据**（同一会话、同一任务、旧的那次正是在第 24 轮被杀的），
     但对"从零开始的绝对水平"**不是**干净测量。后续任务已改成**每个任务新开一个对话**
     （驱动脚本用 `codem-last-session` 必须真的变了来**证明**会话隔离，见 8.6）。
  2. **分数不可用** —— 见 8.5。

### 8.5 ⚠️ 评测环境有漏洞：agent 可以从 git 里把**参考解**取回来（本轮最重要的负面发现）

跑完 repo-01 / repo-02 / repo-03 之后逐个查了会话的工具调用（`.preview-shot/_probe-eval-integrity.mjs`），
**三次都出现同一种形态**：

| 会话 | 命令 | 后果 |
|---|---|---|
| repo-01（`1790981803954-u5dmdoahw`） | `git restore --source=HEAD --worktree -- src/core/llm/edit-matchers.ts src/core/llm/tools.ts` | 最终文件内容与 `HEAD` **逐字节相同**（用 `git diff d2f53d0 HEAD` 与保存的 diff 对比证明：165 行完全一致） |
| repo-02（`1790990982706-bgfhxqw2c`） | `git checkout HEAD -- src/core/llm/tools.ts` | 同上（它先自己写了一版修复，最后又把文件还原回 HEAD） |
| repo-03（`1790991500092-ti7smh0lo`） | 同类（记录的 `diffChars: 0`） | 同上 |

**为什么会这样**：真实仓库档的造 bug 方式是 `git checkout <buggyCommit> -- <实现文件>`，
而**修复后的版本仍然在 `HEAD` 里** ⇒ `git checkout HEAD -- <实现文件>` 一句就把**参考解**装回去了。
更糟的是 agent 还会**察觉到自己在评测里**：它列了 `git worktree list` / `git stash list`，
甚至扫到了上一轮 DSH 评测留下的 `%TEMP%\codem-eval-repo-repo-01-…` 目录；
而仓库里**这份交接单本身就写着每个任务的缺陷与修法**（§3 与 §8）。

**所以本轮不产出"8 个任务的分数"** —— 那是自我欺骗。要拿到可信数字，先修尺子：

1. **让 `HEAD` 就是 bug 状态**：造完 bug 后 `git add -A && git commit -m "EVAL: bug state"`，
   跑完再 `git reset --hard <原 HEAD>`。这样 `git checkout HEAD -- <文件>` 只会把 bug 装回来。
   ⚠️ `tools/eval/run-repo-arm.mjs`（DSH 那条臂用的 worktree 版）**有同一个漏洞**，一并要修。
2. **把答案挪出工作区**：写满缺陷与修法的交接单在跑评测时不该在仓库里（或至少把 §3/§8 拆出去）。
3. **事后必查**：每次跑完扫一遍会话里的 `git checkout/restore/stash/reset` 与 `git show <rev>:<实现文件>`
   —— 有就判该次**污染**。`_probe-eval-integrity.mjs` 已经能查（退出码 1 = 有污染痕迹）。

**结论（只说站得住的）**：§3.1 的治本在**行为判据 + 变异自证 + 真实会话的停因证据**上成立
（循环在第 24 轮不再被杀、一路跑到第 36 轮）；但"用真实仓库档给 Codem 打分"这件事
**本轮没有拿到可信数字**，原因在**尺子**，不在被测对象。

### 8.6 阈值顺序与其余环境事实（补充进 §4）

- `RepeatGuard`（零信息增益）与 `StallGuard`（零进展）**数的是同一类证据**，但阈值不同：
  前者**连续 6 次**零增益就停（`DEFAULT_GUARD_LIMITS.noGainStop`），后者要到 24。
  所以**循环层面**"反复拿到同一份内容"时，**先响的必然是 `repeat_guard`**；
  §3.1 里那句"零信息增益 ⇒ 必须出现 `plan_stale`"只能在「零进展但**没有**被零增益阀门覆盖」的
  迭代形态上成立 —— 也就是 STALL-LOOP-3 的造法（读缓存命中 / 无工具调用）。
  **要不要把两者阈值对齐是产品决定，本轮没有动。**
- **回车不会新建会话**：发任务前必须点侧栏「新对话」（`.sidebar-nav-item`），
  并以设置里的 `codem-last-session` **真的变了**作为隔离判据。
- **同一 session_id 里会混着以前几轮的事件**：查停因/用量**必须按时间窗过滤**，
  否则会把旧那次的 `plan_stale` 当成这一次的（我第一次就被骗了）。
- **用量落在 `trajectory_step` 事件的 payload 里**（`step.data.usage`，per-iteration），
  `cost_records` 表是空的。
- **`.preview-shot/_codem-repo-eval.mjs`** 是本轮新写的"用正在运行的 Codem 跑真实仓库档"驱动
  （造 bug → 新开对话 → CDP 发任务 → 轮询 → **先存 diff** → 取会话证据 → 还原判据文件后判分 → 还原仓库 → 记 jsonl）。
  它跑完还会把"agent 改过的其它已跟踪文件"一并还原（否则下一个任务的前置检查会拒绝开跑）——
  ⚠️ **代价：跑评测期间不要并行改这个仓库**。

### 8.7 §3.4：`append_file` 尾换行守卫（v1.16.225，真实数据丢失）

- **写侧**（Rust `append_file_impl`）：追加前读最后一个字节，不是 `\n` 就先补一个；并补上 `sync_all()`
  （同文件的 `write_file` 一直有，`append_file` 没有）。
- **读侧**（`session-jsonl.ts`）：`forEachLogLine` 多给一个 `{ unterminated }`（只有"到了文件末尾且没有结尾换行"
  的那一行才是残尾）；`readSessionMessages` 返回 `tornTailLines` / `salvagedLines`，
  并用新的 `salvageGluedRecord` 把**粘在残尾后面的合法记录**抢救回来；`compactSessionLog` 同样抢救
  （它是"读出来整体覆盖写回"，在那里丢掉就是**永久**丢掉）；残尾与抢救结果都会在生产代码里打 warn
  （原来 `skippedLines` 零消费者 ⇒「半截行」事实上不可见）。
- **判据**：Rust `append_file_tests`（4 条，含交接单 §3.4 那条「2 条完整行 + 半截尾行 → 再 append
  → 新记录仍可读」）；TS `src/test/session-log-torn-tail.test.ts`（4 条：残尾可识别 /
  **粘住的那条必须救回** / 压缩不许删掉它 / 干净日志反向对照）。
- **变异自证**：关掉换行守卫 ⇒ Rust 3 条红（实际内容 `{"id":"m3","conte{"id":"m4"}`）；
  关掉 `salvageGluedRecord` ⇒ TS 的 TORN-B / TORN-C 红。

### 8.8 装机与发版（本轮，两个版本）

- **1.16.224**：§3.1 + §3.2。**1.16.225**：§3.4 + 用量记账。
  两个版本都走完了：版本四处升级 + `CHANGELOG.md` 段 + `docs/PROJECT-GUIDE.md` 已发布版本表行
  → `npm run tauri:build`（signing key 已设）→ 静默安装（`/S`）→ 注册表 `DisplayVersion` 核对
  → 装机探针 `_verify-223.mjs` **5/5** → `make-latest-json.mjs` + `verify-update-manifest.mjs` **5/5**。
- 全量回归：TS **477 套件 / 6894 用例**、Rust **134 条**（+2 ignored）、`tsc --noEmit` 0 错误、
  `npm run audit` exit 0。
- **未做**（对外且不可逆，用户没要求）：未 push、未打 tag、未 `gh release create`。
- **本轮用掉的 token 预算（自我披露）**：评测三次真实仓库任务合计约 **11.2M token**
  （repo-01 4.66M + repo-02 4.85M + repo-03 1.66M；第四次 repo-04 只跑了 ~1 分钟就被叫停）
  —— 其中**两次是白花的**（正是 8.5 那个漏洞，成绩不能用）。

---

## §9 第 95 波（2026-10-03 · v1.16.226）：§3.5 + 真机上抓到的第二个「名实不符」

提交 **`1.16.226` 那笔**。这一节只写事实与数字。

### 9.1 §3.5 补齐：读后写 + 版本比对（CAS）

- **改法**：
  - `src/core/llm/fs-observation.ts`（新）：观察状态机 —— 按**会话**记
    `{ kind: "present" | "absent", version }`；判定是两个**纯函数**
    `decideEditIntent` / `decideWriteIntent`（可单测，不依赖工具）。
    `absent` 与"没观察过"是**两件事**（`createIfAbsent` 正是靠这个区分）。
  - `src-tauri/src/lib.rs`：新命令 **`file_version`** → `"<size>:<mtime_nanos>"`，不存在返回 `None`。
    为什么用元数据而不是内容哈希：`read` 是**分窗流式**读取，手里从来没有整份内容；
    一次 `stat` 与窗口大小无关。⚠️ 已知边界写在函数注释里（改内容再把 mtime 改回去骗得过它；
    校验在工具层、不在 Rust 的 temp→rename 那一步，所以还有极小的 TOCTOU 窗口）。
  - `src/core/llm/tools.ts`：`read` 成功 → 记观察（失败且确认不存在 → 记 `absent`）；
    `edit` / `multi_edit` / `write` 在**自己的 `execute` 里**判定（"在做出决定的那一次操作里执行它"）；
    写盘成功后刷新观察（自己写的文件可以继续 edit，不必重读）。
    拒绝都是 `{ output: "Error: …", isError: true }` —— 不再有"没写盘却报成功"。
  - `src/core/provider/fs-observation-policy-provider.ts`：把真判定暴露成
    `fsObservationPolicy.observe / getObservation / editIntent / writeIntent / forget`
    —— **名字与能力终于对上**（原来全文 16 行只有防抖配置）。
- **语义边界（刻意做出的取舍，都写在代码注释里）**：
  1. **没有会话归属时不启用**（DSH 是直接拒绝）；我们的工具也能在没有会话的上下文里被调用，
     一律拒绝会把那些调用整体打断。主链路（agentic-loop）始终传 `sessionId`。
  2. **"读不到"不是"文件没了"**：取不到版本令牌时按 **`undefined` = 不知道** 处置 ——
     edit 侧**不谎报** `FS_NOT_FOUND`（放行但不做 CAS，并打一条 warn 说明"这次没比版本"）；
     write 侧降级为"创建"并同样打 warn。这条是本仓库那条纪律（读不到 ≠ 没有数据）的延伸。
  3. `write` 的 `append: true` **不走**该策略（追加不破坏已有内容，而且它是"大文件分块写入"的落地方式）。
  4. `bash` 等能任意改盘的工具不走这条策略（它管不住，也不该被文件工具的策略管住）—— 如实记录。
- **判据**（`src/test/fs-observation-policy.test.ts`，11 条，走**真实工具 `execute()`** + 真文件）：
  没读过就 edit/write ⇒ 拒绝且**零字节改动**；读过之后被"别人"改过 ⇒ `FS_STALE_OBSERVATION` 且不落盘；
  自己 write 出来的文件可以接着 edit；新文件与 append 放行；无会话归属放行；读一个不存在的文件后再写它放行。
  Rust 侧 `file_version_tests`（4 条，含"同长度改写也必须换令牌"）。
- **变异自证（3 次，逐个咬住）**：关掉 edit/multi_edit 的前置判定 ⇒ OBS-1/3/10 红；
  放行"未观察但已存在"的覆盖 ⇒ OBS-4 红；去掉 `read` 成功后的观察记录 ⇒ OBS-2/3/6 红。
- **既有测试的连带改动**（新契约的真实代价，已逐条处理）：给 3 个走真实链路的测试加了
  "先真的读一遍"的夹具（`readFirst`），其余 40+ 个用例因为新增的"不知道 ⇒ 降级"语义而自动回到绿。

### 9.2 真机实测抓到的第二个「名实不符」：线上字段名与前端声明不一致

用 CDP 在**装好的应用**里直接调 Tauri 命令（`.preview-shot/_probe-tauri-wire.mjs`）得到的事实：

| 命令 | 真机返回的键（修前） | 前端 `file-api.ts` 读的键 | 后果 |
|---|---|---|---|
| `read_text_window` | `text, next_offset, eof, size` | `text, **nextOffset**, eof, size` | **`nextOffset` 恒 `undefined`** ⇒ `forEachLogLine` 的 `offset = w.nextOffset` 每轮退回 0：**窗口不前进**。文件小于一个窗口（8 MB）时第一窗就 `eof` ⇒ 长期没暴露；**超过一个窗口的会话日志会原地打转** |
| `read_file_lines` | `text, total_lines, has_more` | `text, **totalLines**, **hasMore**` | `read` 工具那条"还有更多行，用 offset 继续读"的提示**从来没出现过** ⇒ >2000 行的文件被**静默截断**，模型不知道没读完 |

- 为什么长期没被发现：**TS 单测全都用自己写的桩**（返回 camelCase）——桩比真机"更对"，
  于是缺陷在测试里必然绿。这正是本文件 §5.2 第 1 条（判据长在不执行的链路上）的同一族。
- **修法**：让线上名字与**所有**消费方一致 —— 两个结构体加 `#[serde(rename_all = "camelCase")]`
  （TS 类型、mock、共享桩本来就全是 camelCase，没有第二处要改）。
- **判据**：Rust `wire_naming_tests` —— 直接对 `serde_json::to_value(...)` 的**键名**断言
  （也就是前端真实收到的东西）；**变异**：去掉 `rename_all` ⇒ 立刻红
  （`["eof","next_offset","size","text"]` vs `["eof","nextOffset","size","text"]`）。
- **装机后的真机复验**（1.16.226 装完，同一个探针）：
  `read_text_window` → `["text","nextOffset","eof","size"]`、`read_file_lines` → `["text","totalLines","hasMore"]`、
  新命令 `file_version` 返回 `"6807:1790993573738830700"`；
  而且那个"111390 字节、分两窗读"的对照里，**第二窗真的前进了**（修前 `sameAsFirst: true`，修后 `false`）。

### 9.3 装机与回归（v1.16.226）

- 版本四处 + `CHANGELOG.md` 段 + `docs/PROJECT-GUIDE.md` 已发布版本表行 → 构建 → 静默安装 →
  注册表 `DisplayVersion`=1.16.226 → 装机探针 **5/5** → `latest.json` 重生成 + `verify-update-manifest` **5/5**。
- 全量回归：TS **6905 通过 / 16 跳过**（0 失败）、Rust **140 条**（+2 ignored）、`tsc --noEmit` 0 错误、
  `npm run audit` exit 0。
- **仍未做**（对外且不可逆）：未 push、未打 tag、未 `gh release create`。

### 9.4 剩下的（§3.6 / §3.7）

- **§3.6 `isAutoApprovable`**：外层 `run_code` / `workflow` 在「替我审批」模式下仍自动放行 ——
  这是**产品决定**，需要用户拍板（闸门目前只关在嵌套调用那一层）。
- **§3.7 真实仓库档**：先按 §8.5 修尺子（让 `HEAD` 就是 bug 状态 + 把答案挪出工作区 + 每次跑完查
  `git checkout/restore/stash/reset`），再扩任务集。**在尺子修好之前不要拿它下结论。**
  → **尺子已修（第 96 波，本轮）**，见 §10。
- `fs-observation-policy` 的**原子 CAS**（把 `replaceIfVersion` 下沉到 `write_file`，在 temp→rename 前校验）
  是本轮明确留下的后续项 —— 现在关闭的是"没读过就写"和"读完之后变过"，剩下的 TOCTOU 窗口见 9.1 的边界说明。

---

## §10 第 96 波（2026-10-03 · `tools/eval`）：把尺子修好（§8.5 的三条一起做）

> 这一波**不动产品代码**，只改评测工具。目的只有一个：让"真实仓库档"的分数**能信**。

### 10.1 工作区不再是"HEAD + 回退实现"，而是**一份只有 bug 状态这一个提交的新仓库**

`tools/eval/run-repo-arm.mjs` 的 `prepareRepoWorkspace` 重写：

1. `git archive HEAD` 导出跟踪文件（未跟踪物本来就不在里面）到临时目录，`node_modules` 仍用 junction；
2. **把答案删掉**：`docs/HANDOFF-*.md`（交接单写着每个任务的缺陷与修法）与 `tools/eval`（任务集写着
   `revertPaths` / `buggyCommit` / 判据文件名）；
3. 用 `<buggyCommit>:<实现文件>`（**主仓库对象库是只读来源**）覆盖实现 ⇒ 造出 bug；
4. `git init` + 一次提交 ⇒ **工作区的历史只有一个提交，就是 bug 状态**。
   于是 `git checkout HEAD -- <实现文件>` 只会把 bug 装回来；**参考解在这个仓库里不可达**。
   （旧的 `git worktree add --detach HEAD` 做法里，修复后的版本就在 `HEAD` 里 —— 那正是 §8.5 那个漏洞。）

顺带把收尾从 `git worktree remove` 换成直接删目录（不再动主仓库的 worktree 列表）。

### 10.2 尺子自己要有判据：`--verify-workspace`（并挂进 `npm run audit`）

新增 `node tools/eval/run-repo-arm.mjs --verify-workspace`（`npm run eval:repo-workspace`，已在 audit 链里），
对每个任务断言：历史**只有 1 个提交**、`HEAD~1` 不存在、每个 `revertPath` 的工作区内容 == 自己的 `HEAD`
且 == `<buggyCommit>` 的版本、**至少有一个文件与主仓库 HEAD 不同**（否则任务构造不出差异）、
答案与任务集不在工作区里。**实测 8/8 通过**。

它立刻抓到一条**任务集卫生**问题（已记为警告，不阻塞）：
`repo-08-truncated-toolcall-executed` 的 `src/core/llm/tool-args-guard.ts` 在 `buggyCommit(86a21be)`
与 HEAD **内容完全相同** ⇒ 这条 `revertPath` 是空操作（bug 由同任务的 `agentic-loop.ts` 提供）。
**要不要删掉这条声明、或者换个 `buggyCommit`，是下一轮的小活。**

### 10.3 尺子的两根桩臂（自证：能判对、也能判错）

用修好的工作区跑**不花钱**的两根桩臂（不需要模型）：

| 臂 | 含义 | 实测（repo-01 + repo-05） |
| --- | --- | --- |
| `--reference` | 不跑 agent，直接把实现还原成 HEAD（= 正确解） | **2/2 通过** |
| `noop` | 什么都不做的桩 agent | **0/2，两条都判失败**（判据退出码 1） |

⇒ 修好的尺子既不会"恒绿"，也没有"把对的判成错"。

### 10.4 还没做的一件事（下一轮的第一步）

**实测分数仍然要重跑**：`.preview-shot/_codem-repo-eval.mjs`（驱动正在运行的 Codem）现在还是
**在主仓库 `C:\mimo-gui` 上跑**的 —— 它没有用上面那份"干净工作区"。要让 Codem 的分数可信，
得让应用把**评测工作区**当成项目打开（在 DB 里注册一个项目指向工作区、设 `codem-last-project`、
重启应用；写库前要先停应用）。**在那之前，§8.4/§8.5 里那三次的分数一律作废**（两次是抄答案，
一次是旧会话续跑）。

> ✅ **这一步在 §11 里已经做完并验证**（`_register-eval-project.mjs` + 驱动里的项目点击与 `project_id` 判据）。
> 但同一轮又发现了**第二个污染机制**（工作区旁边的主仓库里有参考解），见 §11.1 —— 所以"可信分数"
> 仍然没有拿到。

---

## §11 第 97/98 波（2026-10-03 · v1.16.227 / v1.16.228）：尺子修好之后，先发现"评测还是没法做"

### 11.1 第二个污染机制：**答案就在工作区隔壁**（已能检测，尚未关闭）

把工作区的 git 修干净（§10）之后跑了一次 repo-01，结果是：

| 项 | 值 |
|---|---|
| 会话 | `1790996052909-t24uf56kp`，`project_id = codem-eval-workspace`（**cwd 确实在评测工作区里**，这一步是新的 `_register-eval-project.mjs` 干的） |
| 规模 | 244 个 trajectory_step、**iteration 57**、80 次工具调用、**4.15M token**（缓存 3.87M / 未命中 0.21M）、7.5 分钟 |
| 停滞 | **`loop_stopped` 0 条**（停滞守卫一次都没响） |
| 自我还原 | `selfRestoreCommands: []`（工作区修好后，这条作弊路已经没意义） |
| 评分 | 在工作区里判 **24/24 通过**（判据文件从工作区自己的提交还原） |
| **污染** | **21 次调用碰了主仓库 `C:\mimo-gui`** ⇒ **成绩作废** |

那 21 次里长这样（原样摘录）：

```text
bash  "==C_mimo_gui=="; Get-ChildItem C:\mimo-gui -Force | Select-Object Name; "==WS_recurse=="; ...
bash  cd C:\mimo-gui; "==GITSTATUS=="; git status --porcelain; "==DIFFSTAT=="; git diff --stat; ...
bash  cd C:\mimo-gui; "==LOG=="; git log --oneline -6; "==HEAD_edit-matchers has fix?==";
      git show HEAD:src/core/llm/edit-matchers.ts | Select-String 'findAmbiguousLiteral|findLiteralOccurrences' ...
read  {"limit":140,"path":"C:\\mimo-gui\\src\\core\\llm\\edit-matchers.ts"}
```

**它对自我还原那条路已经没兴趣了 —— 它不需要还原，它直接把答案读走了。**
这条路的根因不在工作区，而在**这台机器上还有主仓库**。

- **已经做的**：驱动把这件事变成**可检测、可判定**的 —— 记录里新增
  `outsideWorkspaceCalls` 与 `contaminated`（`true` 就是"这次碰了有参考解的地方，成绩不能用"），
  并且在控制台用 ❌ 明说。判据在 `.preview-shot/_probe-outside-workspace.mjs`。
- **还没做的（按代价从低到高）**：
  1. **把沙箱覆盖到"读"**：`checkSandbox` 现在只挂在 `write` / `edit` / `multi_edit` 三个点上，
     **不拦 `read`、也不分析 bash 的路径** —— 名字叫沙箱，实际拦不住"把隔壁的答案读进来"。
     跑评测时开 `codem-sandbox-enabled=true` 才会真正隔离（这是一条产品改动，不只是评测脚手架）。
  2. **跑评测期间把主仓库也置于 bug 状态**：工作树 + `HEAD` 都没有答案（只剩历史里的 `git show <sha>:`）。
     代价小、可恢复（`git checkout --detach <buggyCommit>` → 跑完 `git checkout master`），但挡不住翻历史。
  3. **容器 / 虚拟机里跑**（最干净，代价最大）。

### 11.2 顺手抓到的严重产品缺陷：四个主力工具在真机上「全废」（v1.16.227）

**这是本轮最有价值的产品产出**，而且是"为了评测而做的验证"顺手抓出来的：

- **现象**：`bash` / `read` / `glob` / `grep` 的**每次成功调用**都被改写成
  `Error: bash declared outputSchema but returned no value. Return the structured value so it can be validated.`
  —— 模型于是放弃 bash、绕道 `terminal_send`（真机会话里 81 次），或者宣布做不到。
- **真机取证**（按事件顺序配对，`.preview-shot/_probe-tool-health.mjs`，最近 12 个会话）：
  `bash` 46 次调用 → 42 条 error（其中 **32 条**是这条）；`read` 11 → 8（8 条）；`glob` 7 → 7（7 条）；
  `grep` 2 → 2（2 条）；而**没声明 `outputSchema`** 的 `terminal_*` 是 0 条 —— 这不是环境问题，是这条链路的。
- **根因（两处，同一个"半接线"的功能）**：
  1. `agentic-loop.ts` 交给执行器的 **execute 层 handler** 在返回时**重建结果对象**
     （只带 `id/name/input/output/status/metadata`）⇒ 把工具产出的结构化 `value` **丢了**；
     而 `tool-pipeline.ts` 的 `OutputContractValidationMiddleware` 正是靠 `result.value` 校验
     ⇒「声明了契约却没值」被判成**实现漏了**、**成功结果被改写成 error**。
  2. `ToolExecuteResult`（**工具侧**的类型）从第 121/122 轮起**就没有 `value` 字段**（`ToolCallResult` 有）
     ⇒ `value: result.value` 那一行**根本写不出来**（TS2339）。同一份契约在两侧不同形。
- **为什么既有判据没抓到**：`tool-contract-pipeline-e2e.test.ts` 的夹具 handler 自己写了
  `value: out.value` —— **测试比生产"更对"**，判据长在一条**生产里不执行**的链路上（本文件 §5.2 第 1 条）。
- **修法**：工具侧类型补 `value?: unknown`；handler 透传 `value`；循环**自己合成**的结果
  （读缓存命中 `[CACHE HIT]`、重复写 `[NO-OP]`、重复调用守卫抑制、已收集的委派结果）标
  `errorSource: "loop"`，契约层对它们**不做**工具输出校验。
- **判据**：`src/test/output-contract-real-loop.test.ts`（**驱动真实循环**，断言循环交给下游的那条结果：
  有 `value` ⇒ `completed` + 渲染文本 + `value` 透传到下游）；`tool-contract-pipeline-e2e` 新增
  「循环合成结果不被改写」。**变异**：去掉 `value: result.value` ⇒ 立刻红。
- **装机复验**：1.16.227 装好后，探针任务里 `bash echo hello-from-bash` →
  `status=completed` + 真实输出（修前是同一条契约错误）。

### 11.3 同一族的下一条：失败的原因被契约话术顶掉（v1.16.228）

`read` / `glob` / `grep` 是**内容型工具**（`tool-result-status.ts` 的 `CONTENT_TOOLS`：输出是数据，
首行 `Error:` 也可能只是文件内容）⇒ 它们的失败**不会被文本推断**成失败，于是原来被报成 `completed`
（**假成功**）；而它们又都声明了 `outputSchema`，「没给 value」再被契约层换成
`Error: read declared outputSchema but returned no value` —— **真正的原因（文件不存在）就此消失**。
两处一起修：①这四类工具的失败路径**显式 `isError: true`**；②契约层**不再顶掉工具自己的失败文本**
（输出本身就是一句 `Error:` ⇒ 原样透传，只留一条 warn 给开发者）。
**变异/判据**：`tool-contract-pipeline-e2e` 新增「输出本身就是一句失败 ⇒ 保留工具自己的原因」；
`output-contract-real-loop` 的 `OUTCON-3`（真工具 + 真 file-api 桩：read/glob/grep 失败必须 `isError === true`）。

### 11.4 装机与回归（v1.16.227 / v1.16.228）

两个版本都走完：版本四处 + CHANGELOG + PROJECT-GUIDE 已发布版本表 → 构建 → 静默安装 →
注册表 `DisplayVersion` 核对 → 装机探针 **5/5** → `latest.json` 重生成 + `verify-update-manifest` **5/5**。
回归：TS **479 套件 / 6910 用例**、Rust **140 条**（+2 ignored）、`tsc --noEmit` 0 错误、`npm run audit` exit 0。

### 11.5 结论（只说站得住的）

1. **§3.1 的治本在真机上站得住**：`plan_stale` 在两次真实仓库任务里都没再误杀（iteration 57 / 0 条 `loop_stopped`）。
2. **"用真实仓库档给 Codem 打分"这件事，到今天为止仍然没有可信数字** —— 第一版作弊路（git 还原）修掉了，
   第二版（读隔壁主仓库）刚被发现并已能检测，**关闭它是下一轮的第一件事**（§11.1 的三条路）。
3. 顺带修掉的两个产品缺陷（v1.16.227/228）都是"真机上工具直接用不了"的级别 —— 它们本来会让**任何**评测都失真
   （agent 拿不到文件内容、跑不了命令）。

---

## §12 第 99 波（2026-10-03 · v1.16.229 / v1.16.230）：把隔离补上，拿到**第一个可信分数**

### 12.1 沙箱原来只拦「参数里的路径」：`bash` 把路径藏在命令文本里

`SandboxGuard`（`tool-pipeline.ts`）的判据是"入参里有 `path` 就查它，**没有就放行**"。
`read` / `grep` / `glob` 有 `path` ⇒ 受管；`bash` 的入参是 `command` / `workdir`，**路径在文本里**
⇒ 整条守卫形同虚设。真机上同一个沙箱里：

```text
read { path: "C:\\mimo-gui\\package.json" }                 → Sandbox: Read from … is outside the workspace
bash { command: "Get-Content 'C:\\mimo-gui\\package.json'" } → 通过，内容原样返回
```

**修法（v1.16.229）**：没有 `path` 时扫描 `command` / `code` / `script` / `workdir` 里的路径 ——
绝对路径（盘符 / UNC）、含 `..` 的相对路径、`workdir`，解析出工作区外即拒绝。
**边界写在明处**：URL 先剥（`https://` 的 `s://` 长得像盘符）；`$env:X` / `%VAR%` / `~` 是运行期
才展开的，**故意放行**（文本层判不了）—— 评测侧还有"污染检测"兜底。

### 12.2 上一版刚加的判据自己漏了「裸 `..`」（v1.16.230）

1.16.229 要求候选 token 里带 `/` 或 `\` 才算路径 ⇒ `Get-ChildItem -Force ..` / `ls ..` / `cd ..`
**一路放行**，一条命令就能列出父目录。这是"装好之后**再验一次**"抓到的：那次 agent 的工作目录
被另一个 bug 指到了空壳目录，它随即 `Get-ChildItem -Force .. | Format-Table Name,Mode` 列出了主仓库
（`.deepseek-harness-ref` / `src` / `.codem` …），**而当时判据是绿的**。
修法：裸 `..` 也算候选（`HEAD..main` 这类 git 区间解析后落在工作区内，仍然放行）。
判据 `SHLEAK-3b`；变异：去掉 `..` 扫描 ⇒ `SHLEAK-3`/`3b` 立刻红。

### 12.3 尺子自己的第 3 个 bug：项目路径被写成"项目 id"（静默失效，比作弊更难发现）

驱动的 `registerProject()` 在**更新**已有项目那一支写成了 `path = id`（而不是工作区绝对路径），
于是应用按自己的进程 cwd 把 `codem-eval-workspace` 解析成 `C:\mimo-gui\codem-eval-workspace`
（还顺手把它建了出来）。后果：agent 的工作目录是个**空壳**，它摸了一圈说
「工作目录在空壳 codem-eval-workspace，项目实际在父目录 C:\mimo-gui」，5 次迭代就放弃、
**一个字符都没改** —— 那一次判据全红，而 `contaminated: false` 会让人误以为"隔离成功但模型不行"。
**教训**：判据必须核到**工作目录本身**（`bash pwd` 的输出），不能只核 `project_id`。
修好之后同一个任务的表现：**5 次迭代 / 0 字符改动 → 21 次迭代 / 25 次工具调用 / 2776 字符改动**。

### 12.4 第一批**可信**分数（8 个任务 / 11 次有效运行，4 个任务通过）

口径：工作区是一份只有 bug 状态提交的新仓库（§10）、答案与任务集不在里面、应用的工作目录
**就是**该工作区（`project_id` + `pwd` 双重核对）、沙箱开启、污染检测为零、
且**任务本身通过 `--verify-bug-tests`**（bug 状态下判据必须红，§12.7）。
汇总脚本：`node tools/eval/codem-records-report.mjs`（它自己会剔掉"通过但零改动"的假绿）。

| 任务 | 有效次数 | 结果 | 迭代 | 工具调用 | token | 耗时 | 判据 |
|---|---|---|---|---|---|---|---|
| `repo-01-edit-ambiguity` | 2 | **2 通过** | 21 / 19 | 25 / 23 | 853k / 619k | 3.1 / 3.1 min | 24/24 |
| `repo-02-write-false-success` | 1 | 不通过 | 28 | 40 | 1.17M | 4.3 min | 17/18（`D9-1`：`multi_edit` 部分失败没判 error） |
| `repo-03-usage-accounting` | 1 | 不通过 | 36 | 56 | 2.36M | 6.0 min | 8/12（`D7-B/C/E`：缓存桶"缺报不猜 0"） |
| `repo-04-session-update-drops-fields` | 1 | 不通过 | 38 | 67 | 2.89M | 7.8 min | 附件/元数据保留的那几条 |
| `repo-05-workflow-bypasses-permission` | 2 | **2 通过** | 16 / 16 | 26 / 22 | 545k / 564k | 2.6 / 4.6 min | 全绿 |
| `repo-06-llm-failure-not-completed` | 1 | 不通过 | 41 | 71 | 3.13M | 8.5 min | LLM 硬失败仍未判成失败 |
| `repo-07-plan-not-in-system-prefix` | 2 | **2 通过** | 41 / 35 | 52 / 45 | 2.78M / 2.08M | 7.8 / 6.7 min | 全绿 |
| `repo-08-truncated-toolcall-executed` | 1 | **通过**（修任务之后） | 40 | 53 | 2.64M | 7.6 min | 12/12 |

**合计：11 次有效运行，7 次通过（64%）；按任务算 4/8 通过。**
19.7M token（缓存命中 18.2M）、63 分钟。**全部** 11 次：`loop_stopped` **0 条**、
`contaminated: false`、`outsideWorkspaceCalls: []`、`blockedOutsideAttempts: 0`。

- **它确实会修**：`repo-01` 两次自己起名 `countLiteralOccurrences`（返回 `{count, lines}`），
  与参考解的 `findAmbiguousLiteral` 明显不同 —— **不是抄的**。
- **它也真的会答错**：`repo-02`/`repo-03`/`repo-06` 卡在**口径**（实现得不彻底：部分失败没判 error、
  缺报的缓存桶猜了 0、LLM 硬失败仍算完成），`repo-04` 卡在附件保留 —— 恰好是这一档最该测出来的东西。
- **重复运行稳定**：三个通过的任务各跑两次，结论一致（1 次结论仍不算强，但至少没有翻转）。
- 成本对照：同一任务在"尺子坏掉"那一次（§11.1）是 4.15M token / 57 迭代 / 污染 21 次；
  可信口径下 `repo-01` 只花 **619k–853k token / 19–21 迭代**（约 1/5）——
  省下来的正是"先怀疑环境、再去隔壁找答案"。

> 被剔除的记录（见 §12.3 / §12.7 与汇总脚本的排除理由）：
> `repo-01` 的一次 **5 迭代 0 改动**（工作目录被写成项目 id、指到空壳目录）、
> `repo-08` 的一次 **30 迭代 0 改动**（任务退化：`buggyCommit` 写成引入修复的那个提交），
> 以及更早三次**没有污染检测字段**的记录（§11.1）。


### 12.5 任务集自己的判据：bug 状态下判据**必须是红的**（`--verify-bug-tests`）

`--verify-workspace`（§10.2）只能证明"至少有一个 `revertPath` 与 HEAD 不同"，
**证明不了"那份差异让判据失败"** —— 一个退化的任务（改的是无关代码、或判据本来靠别处）在 bug 状态下
判据照样绿，那种任务谁都能"修好"。所以补一层：跑**真判据命令**、不跑 agent、不花模型钱，
退出码非 0 才算任务成立。

> `--verify-workspace` 里那条 `⚠️ buggyCommit 与 HEAD 内容完全相同` 的警告也要**读对**：
> `repo-08` 的 `tool-args-guard.ts` 满足它，是因为**那个文件最后一次改动就是 `buggyCommit(86a21be)` 本身**
> —— 于是 `86a21be:<file>` 与 `HEAD:<file>` 必然相同（不是"任务构造错了"）。
> 真正的判据是"bug 状态下判据红不红"，也就是下面这条。

### 12.7 第四个尺子缺陷：**退化的任务**（谁都能过），以及抓到它的那条判据

跑 repo-08 时记录上写着"通过"，但 **`diffChars: 0`** —— agent **一个字符都没改**。
原因：`repo-08` 的 `buggyCommit` 写的是 **`86a21be`**，而**那个提交正是引入截断守卫的那一个**
（它给 `agentic-loop.ts` 接了 `buildTruncatedToolCallError`，并新增了 `pi-p1` 那条判据）。
所以"把实现回退到 `86a21be`"= 把**修好的版本**装回去：工作区里根本没有这个 bug，判据一开始就是绿的。
那 2.07M token 换来的分数**毫无意义**。

**抓到它的是本轮新加的判据**：`node tools/eval/run-repo-arm.mjs --verify-bug-tests`
—— 跑**真判据命令**（不跑 agent、不花钱），退出码非 0 才算任务成立。

```text
  ✅ repo-01..repo-07：bug 状态下判据红（退出码 1，命中失败标记 2–17 处）
  ❌ repo-08-truncated-toolcall-executed：**bug 状态下判据是绿的** —— 这个任务退化（谁都能过）
```

修法：`repo-08` 的 `buggyCommit` 改成 **`d2f53d0`**（`86a21be^`，也就是截断守卫还没接上的那一版），
改完复验 `✅ bug 状态下判据红（退出码 1）`，`--verify-workspace` 也随之不再有警告。
**教训**：`buggyCommit` 必须是"**该行为还没被修**"的那一版；某个提交顺手修掉了这个 bug 时，
它就不能再当 `buggyCommit`。这条现在由上面那条命令强制（`npm run audit` 里挂了工作区自证，
`--verify-bug-tests` 是更强的第二层）。

> 这也解释了为什么"任务集卫生"值得单独一层判据：`--verify-workspace`（§10.2）只证明
> "至少有一个 `revertPath` 与 HEAD 不同"，**证明不了"判据会因此变红"** ——
> 而后者才是"这个任务在测东西"的定义。

## §13 第 101 波（2026-10-03）：任务集 8 → 12，三层自证齐了

### 13.1 新增的 4 个任务：拿**本仓最近四次真实修复**当题面

选材标准（四条都满足才收）：

1. `buggyCommit` = 那次修复的**父提交** —— "该行为还没被修"是**定义上**成立的，不靠人记；
2. `revertPaths` 只包含那次修复动过的**实现**文件（改动窄 ⇒ 不会顺带回退出别的问题）；
3. 判据是那次修复新增/修改的测试文件（在工作区里存在 = HEAD 版本）；
4. **三层自证全过**（见 13.2）。

| 任务 | 题面（用户视角） | 回退的实现 | 判据 | `buggyCommit` |
|---|---|---|---|---|
| `repo-09-sandbox-shell-path-leak` | 开着沙箱，命令里照样能读到工作区外的文件 | `tool-pipeline.ts` | `sandbox-shell-path-leak.test.ts` | `e6041cd`（= `582bca1^`） |
| `repo-10-tool-result-value-dropped` | 声明了结果契约的工具一调用就报"你没给 value" | `agentic-loop.ts` + `types.ts` + `tools.ts` | `output-contract-real-loop.test.ts` | `5be439f`（= `2d0852a^`） |
| `repo-11-contract-error-not-masked` | 失败的原因被一句契约话术顶掉了 | `tool-pipeline.ts` + `tools.ts` | `tool-contract-pipeline-e2e.test.ts` | `2d0852a`（= `e6041cd^`） |
| `repo-12-usage-non-completion` | 被守卫杀掉/被中止的那一轮还是被记成成功用量 | `index.ts` | `usage-non-completion.test.ts` | `30ed631`（= `941ea25^`） |

### 13.2 三层自证（缺一层就有假分数）

| 层 | 命令 | 它挡住什么 | 实测 |
|---|---|---|---|
| ① 工作区 | `npm run eval:repo-workspace` | "参考解还在工作区的 git 里"（§8.5/§10） | **12/12** |
| ② 判据 | `npm run eval:repo-bug-tests` | **退化的任务**（bug 没造出来 ⇒ 谁都能过，§12.7） | **12/12**（182 秒） |
| ③ 参考解 | `--arm reference --reference` | "这个任务其实无解"（判据依赖被回退文件之外的东西） | 新 4 个任务 **4/4 全绿** |

②③ 的分工值得写清楚：②说"bug 在位"，③说"这个 bug **修得好**"。只做②会收进无解的任务，
只做③会收进退化的任务。②已经挂进 `npm run audit`（任务集一改就会跑）。
①③**不**在 audit 里：①要几分钟且只在改工作区配方时才会变；③要跑测试、按任务逐个跑更慢。

### 13.3 ⚠️ 已知局限：判据在工作区里是**可读**的

评分需要判据文件，而判据文件就在工作区里（HEAD 版本）—— 于是被测 agent **可以读它**，
而这些测试的注释常常写明了根因（我们自己的测试尤其如此，`output-contract-real-loop.test.ts`
开头就写了"execute 层 handler 重建结果对象、把 value 丢了"）。

**所以这一档测的是"能不能按判据把修复做对"，不是"能不能独立诊断"。**
对 8 个老任务同样成立（文件名 `dsh-d8-edit-ambiguity.test.ts` 本身就点明了目标）。
要测诊断，得把判据挪出工作区、评分时再放回去 —— 那是一次工作区配方的改动，
**记在这里当待办**，不要把它当"新任务的问题"。

### 13.4 新增任务的真机实测 —— 与 §12.4 一起构成**完整的 12 任务口径**

| 任务 | 有效次数 | 结果 | 迭代 | token | 耗时 | 判据 |
|---|---|---|---|---|---|---|
| `repo-01-edit-ambiguity` | 2 | **2 通过** | 21 / 19 | 853k / 619k | 3.1 / 3.1 min | 24/24 |
| `repo-02-write-false-success` | 1 | 不通过 | 28 | 1.17M | 4.3 min | 17/18 |
| `repo-03-usage-accounting` | 1 | 不通过 | 36 | 2.36M | 6.0 min | 8/12 |
| `repo-04-session-update-drops-fields` | 1 | 不通过 | 38 | 2.89M | 7.8 min | 红 |
| `repo-05-workflow-bypasses-permission` | 2 | **2 通过** | 16 / 16 | 545k / 564k | 2.6 / 4.6 min | 全绿 |
| `repo-06-llm-failure-not-completed` | 1 | 不通过 | 41 | 3.13M | 8.5 min | 红 |
| `repo-07-plan-not-in-system-prefix` | 2 | **2 通过** | 41 / 35 | 2.78M / 2.08M | 7.8 / 6.7 min | 全绿 |
| `repo-08-truncated-toolcall-executed` | 1 | **通过** | 40 | 2.64M | 7.6 min | 12/12 |
| `repo-09-sandbox-shell-path-leak` | 1 | **通过**（打折，见下） | 39 | 2.15M | 7.6 min | 全绿 |
| `repo-10-tool-result-value-dropped` | 1 | **通过** | 34 | 1.99M | 6.8 min | 22/22 |
| `repo-11-contract-error-not-masked` | 1 | **通过** | 26 | 1.17M | 4.0 min | 22/22 |
| `repo-12-usage-non-completion` | 1 | **通过** | 27 | 1.19M | 4.3 min | 13/13 |

**合计：15 次有效运行 11 次通过（73%）；按任务算 9/12 通过。**
26.1M token（缓存命中 24.1M）、84.8 分钟。**全部** 15 次：`loop_stopped` **0 条**、
`contaminated: false`、`outsideWorkspaceCalls: []`。
（汇总：`node tools/eval/codem-records-report.mjs`；它自己剔掉污染/跑挂/"通过但零改动"/手工登记作废的记录，
并把排除理由逐条列出来。）

**给 `repo-09` 打折**：agent 直接把判据测试注释里的说法（"命令里的路径也要按沙箱判定"，
连 `cd C:\mimo-gui; git show …` 那个真实案例都写在注释里）搬进了实现注释 ——
这正是 §13.3 那条局限的**现场证据**：这一档测的是"能不能按判据把修复做对"，
**不是**"能不能独立诊断"。

**没有通过的四条**都是**口径类**判据（实现得不彻底，不是没实现）：
`repo-02` 的 `multi_edit` 部分失败没判 error、`repo-03` 的缓存桶"缺报猜 0"、
`repo-04` 的附件/元数据保留、`repo-06` 的 LLM 硬失败仍算完成。
这正是这一档该测出来的东西 —— 而且它是**我们自己的修复**，题面与判据都不是外人写的。


### 13.5 判据自己的第三次假阳性：把"写进文件的注释"当成了访问

`repo-09` 那次跑完，污染检测报 **2 次"碰了主仓库"** ⇒ 成绩被判作废。复核（`.preview-shot/_recheck-contamination.mjs`）
发现**0 条真泄露**：那 2 条是 `multi_edit`，文本是 agent 加进 `tool-pipeline.ts` 的**注释**
（注释里引用了主仓库路径，因为判据测试的注释就是这么写的）。

根因：第一版判据把**整个 `args` 序列化成字符串**找 `mimo-gui` —— 于是"写入的文本"也算访问。
修法与教训：

1. **只看"这次调用要访问什么"**（`path` / `file_path` / `command` / `code` / `script` / `pattern` / `workdir`），
   **不看内容载荷**（`content` / `edits[].newString`）；
2. 判据抽成**一份共享模块** `tools/eval/codem-record-integrity.mjs`：实时驱动与汇总脚本共用，
   **避免"实时判定"和"事后复核"各有一把尺子**；
3. 汇总脚本现在会**从会话事件重新判一次**、覆盖记录里存的那个快照（判据修好了，旧结论要跟着改）——
   于是 `repo-09` 这次被正名为**有效通过**，并在报告里显式写出"这条当时的假阳性已修"。

这是同一路的第三次"尺子自己出错"（假阴性：只看 `path` 漏掉 bash；假阳性：看整个 `args` 误杀写入；
以及 §12.7 的退化任务）。**结论：判据自己必须可复核、可重跑**，不能是一次性的快照。

### 13.6 第 101 波补记：脚手架自己的两处脆性（都在真机连跑时暴露）

1. **工作区删不掉 ⇒ 整个任务 `errored`**：上一个任务刚在**同一路径**上跑完 `npx vitest`，
   紧接着 `rmSync` 抛 `EPERM: Permission denied`（Windows 上"正在被使用的目录"删不掉），
   `repo-12` 那一次就是这么挂的 —— 而它**跟被测 agent 毫无关系**。
   修法（`repo-workspace.mjs` 的 `resetDir`）：直接删 → 睡 400ms 再删 → 睡 1200ms 再删 →
   **改名挪到 `<ws>.stale-<ts>`**（改名对句柄不敏感），四级退让。
   判据：`.preview-shot/_probe-workspace-reset-under-lock.mjs`（攥着一个打开的文件句柄时重建必须成功）
   —— 实测走的是"重试"那一级；**改名那一级只在代码里，没有实测触发过**（写在这里免得被当成已验证）。
2. **单个任务挂掉拖垮整批**：批量循环原来是 `records.push(await runTask(...))`，
   一个 throw 就让后面 5 个任务全不跑。现在每个任务独立 try/catch，挂掉记 `errored` 并继续 ——
   这一条在 `repo-12` 挂掉的那一轮**当场生效**（它继续跑了下一个任务并打印了"跑挂了（继续下一个）"）。

### 13.7 与 DSH 对照臂的差距（为什么这一轮没跑）

`tools/eval/drivers/dsh-driver.mjs` 已经能调 `dsh --profile headless --json` 跑同一条工作区配方，
所以**对照臂的入口是现成的**。没跑的原因是**隔离不对等**：

- Codem 那一侧有**应用级沙箱**（§12.1/§12.2），工作区外的读取会被拒；
- `--agent-cmd` 那一侧是**普通子进程**，没有沙箱 —— 它想读 `C:\mimo-gui`（答案仓库）就读得到。

两边的分数要能比，必须让两边都干净。已经做的准备：`run-repo-arm.mjs` 现在有**与臂无关的污染检测**
（读 driver 留在工作区的 `.dsh-events.jsonl`，只看 `tool_call` 的**访问目标**字段，
与 Codem 侧同一口径）：碰过答案仓库就把 `contaminated: true` 写进记录，**宁可作废也不用脏数据**。

要对等地跑，三选一（按代价）：①跑对照臂时把主仓库置于 bug 状态（工作树 + HEAD 都没有答案，
只剩 reflog/历史，且污染检测兜底）；②容器/VM；③接受"对照臂只能判'碰过'"的保守口径，
把两次运行都说清楚。

### 13.9 第 106 波拍板：隔离对等用 ③+，并给出为什么这是**可辩护**的口径

先看事实（工作区配方本身就有的隔离）：

1. 两个臂用的是**同一条工作区配方**：`git` 单提交工作区，`HEAD == buggyCommit`（修复的父提交），
   测试文件在评分前会被 `git checkout HEAD -- <判据文件>` **还原** ⇒ 答案**不在工作区里**，
   也不在这个工作区的 git 对象库里（单提交，没有后续历史）；
2. 所以唯一的泄漏通道是"离开工作区、去读主仓库（`C:\mimo-gui`）或它的 git 历史"；
3. 这条通道**两侧都有判据**：`codem-record-integrity.mjs`（Codem 侧，读会话事件里的访问目标）与
   `run-repo-arm.mjs` 的与臂无关的污染检测（读 driver 留下的 `.dsh-events.jsonl`，同一口径），
   命中就写 `contaminated: true`，**宁可作废也不用脏数据**。

结论：**采用 ③+** —— 跑，但把"污染"当成一等公民：
- 记录里保留 `contaminated`；报告会点名受影响的用例（§16.7 的口径：脏数据不作依据）；
- 两个臂**都**跑满同一套任务、同模型（见下）、同重复次数，成对报告只在两侧都有分数时才出结论。

为什么不上 ②（容器）：它要额外搬运凭证与仓库副本，而且**不能**消除"两侧工具面本来就不同"这个
事实差异（见下）—— 那是产品差异，不是测量误差。为什么不上 ①：主仓库的**提交历史里有答案**，
把工作树/HEAD 挪到 bug 态并不能删除历史（要删就是重写历史），反而会让"我自己的开发环境"处于
不真实的状态；而且 ③+ 的污染检测本来就能把读历史的行为抓住。

### 13.10 工具面差异是**产品差异**，必须写在结论旁边

- Codem 侧：装好的应用（带**应用级沙箱**）+ 它自己的工具集（`bash/read/write/glob/grep/fetch`…），
  脚本类工具（`run_code`/`workflow`）现在跑在 **Rust 侧 boa** 沙箱里（§16）；
- DSH 侧：`dsh --profile headless` 作为**普通子进程**跑，工具集由它的 profile 提供。

这不是测量误差 —— "谁的工具更好用、谁更容易把任务做完"正是要测的东西。**但要说清楚**：
两侧的分数差里，既包含"模型编排能力"的差，也包含"产品工具面"的差；
本口径下（同模型、同任务、同工作区）我认为这才是"编码能力"该有的定义（端到端做成事）。
真要拆开归因，需要再跑一组"两侧都只用 bash"的对照 —— 那是后续的事，先记在这。

### 13.11 同模型是地基：两侧各自的记录里都要有模型名

- DSH 侧：`dsh-driver.mjs` 写 `model`（由命令行 `--model` 传入，实测 `dsh` 会话里模型就是 `deepseek-flash`）；
- Codem 侧：以前**没写** —— 第 106 波补上（`--run` 与 `EVAL_MODEL`/`EVAL_APP_VERSION`），
  并新增 `tools/eval/normalize-codem-records.mjs` + `repo-paired-report.mjs`：
  **模型不同直接拒绝出结论**（`checkSameModel`），并且**不许猜运行号**
  （缺 `runNumber` 就抛错，因为 `paired-report.mjs` 会把"单侧多条"判成阻塞对）。

实测核对（本机当前配置）：Codem 会话事件里 `"model":"deepseek-flash"`；
DSH 会话记录里 `"model": "deepseek-flash"` ⇒ **两侧同模型**，地基成立。

### 13.12 判据工具的三层自证（尺子自己也要有判据）

`normalize-codem-records` 的 9 条自测 + 5 条变异（M1 口径、M2 缺数据不等于 0、M3 运行号不许猜、
M4 污染照搬、M5 同模型地基）**全部被咬住**；已挂进 `npm run audit`（`eval:paired-normalize`）。

### 13.13 ⚠️ 第 106 波：**旧口径那批分（11/20）不能用** —— 四个尺子缺陷（都带实测证据）

重新起臂之前先把旧记录翻了一遍，发现旧结论的每一个环节都有洞。**先说结论**：
§13.4 报的"Codem 12 任务 / 15 次有效 / 11 通过（73%）"**不再作为基线**，
必须用修好尺子之后重跑的 v2 数据（`eval-records-codem-repo-v2.jsonl`）说话。

| # | 缺陷 | 实测证据 | 处置 |
|---|---|---|---|
| 1 | **构建版本不对** | 抽查旧记录里一次 repo-02 会话（`1790990982706-bgfhxqw2c`）：**每一条 `bash` 都失败**，报 `bash declared outputSchema but returned no value` —— 那正是 §3.x 修掉的 `1.16.227` 前的工具契约缺陷 | 旧分**不代表现在的产品**；v2 全部跑在 1.16.232（`bash/read/glob/grep` + `run_code/workflow` + hooks + 动态插件都已可用） |
| 2 | **"零改动通过"混进了通过率** | 旧记录里有 **3 次** `passed && git diff == 0`（repo-02/03/08 的首次运行）。查其中 repo-02 那次会话：agent 的 `bash` 全废、它转而去改 **`C:\mimo-gui\src\core\llm\tools.ts`**（主仓库！），三次 `edit/multi_edit` 全部 `status=error` | 记录里新增 `suspiciousNoDiffPass`；规范化器对老记录**当场算**这个标记；`repo-paired-report.mjs` 把它**从可评分集合里剔除**（⇒ 该任务的对缺一侧 ⇒ 头部结论 withheld，退出码 1）。核实用 `tools/eval/audit-codem-record.mjs` |
| 3 | **`git diff` 漏掉"已提交的改动"** | 老口径只取 `git diff`（工作树 vs 索引）：agent 若自己 `git commit`，这个值就是 0 —— "真的做了活"与"什么都没做"于是长得一样 | 驱动改成同时取 `git diff HEAD`（未提交）与 `git diff <根提交> HEAD`（已提交），并记 `commitsAfterRun`（提交数） |
| 4 | **`node_modules` junction 把答案仓库暴露了** | 工作区的 `node_modules` 曾 junction 到 `C:\mimo-gui\node_modules` ⇒ `node_modules/..` **就是有参考解的主仓库**。缺陷 2 里 agent 能去改主仓库文件，这条通道是必要条件 | 改成先镜像到 `%TEMP%\codem-eval-node_modules`（一次，约 1GB，锁文件哈希做新鲜度标记），工作区 junction 到**那份副本**；并把"`node_modules` 的父目录不能是答案仓库"写进 `verifyRepoWorkspace` 的致命判据（实测能咬住旧 junction） |

**顺带修掉的一个判据假阴性**（`codem-record-integrity.mjs`）：旧口径把**任何**失败都当成
"沙箱拦下了"（`failed = status === "error"`）。而缺陷 2 那三次 `edit` 的失败原因是
**`oldString not found`**（自己锚点写错），**不是**沙箱拒绝 —— 按旧口径它们会被记成"隔离生效"，
可实际上 agent 已经读到了答案仓库（否则不知道那些行的内容）。
新口径：只有**明确的拒绝证据**（`SANDBOX_DENIAL_RE`）才算 blocked，**其它失败一律算污染**
（证明不了干净就不算干净）。

**另一处判据实现 bug（值得记）**：新加的 `node_modules` 判据第一版直接比较
`dirname(realpathSync(nm)) === REPO_ROOT` —— 永远为假，因为 `REPO_ROOT` 是 `C:/mimo-gui`（正斜杠）
而 `realpathSync` 给 `C:\mimo-gui`（反斜杠）。判据"永远绿"了。归一化之后才真的咬住。
**这条再次说明：判据必须用"改坏它会不会红"来验，光看它输出"通过"没有意义。**

### 13.13b 三个差距的**逐条诊断**（都有会话原始序列，不是印象）

对照臂（DSH）跑满 12 个任务：**11 通过 / 1 失败（repo-07）**。
处理臂（Codem 1.16.232）前 5 个任务的对比：repo-01 ✅/✅、**repo-02 ❌**、**repo-03 ❌**、**repo-04 ❌**、repo-05 ✅/✅。

把三次失败会话里的**测试运行序列**拉出来（命令 + 汇总 + 哪些文件红），三条差距各有不同形状：

| 任务 | agent 跑过的测试序列 | 形状 | 对应的产品改动 |
|---|---|---|---|
| **repo-02** | ①3 passed ②**34 passed** —— **一次红都没有** | **根本没跑到那条判据**（只跑了自认为相关的一小撮） | 提示词 PROMPT-ROOT-2/3：验证要跑**相关模块**的测试，不是只跑手边那一个文件 |
| **repo-03** | ①9 passed ②4 failed ③4 failed（usage-normalize、dsh-d7 红）④4 failed ⑤**9 passed（换了一组别的文件）** | **红过的文件没复跑绿，被"另一组绿了"洗白** | 循环守卫（按文件记账）：RT-5 就是这条序列 |
| **repo-04** | ①-③ dsh-d11 红 → ④4 passed（修好它）⑤-⑥ dsh-d12 + torn-tail **7 failed** ⑦**404 passed（这一大轮没覆盖 dsh-d12）** | 同上：**红过的 dsh-d12 再没跑绿就收工** | 同一个守卫（按文件记账，所以 ⑦ 的"别处全绿"洗不白 dsh-d12） |
| **repo-06** | ①10 passed ②41 passed ③3 passed（**一次红都没有**） | 同 repo-02：**压根没跑失败的那条判据**（判据红在 `dsh-d3-abort-not-completed` 的 D3-A：abort 的终态必须是 `aborted`） | 提示词（同上） |

**四个差距、两种形态、各两次**（repo-02/06 = 没跑到判据；repo-03/04 = 红过没复跑绿就收工），
正好对应已经落地的两处产品改动。A/B 复测清单就按这四条 + 两条回归对照（repo-01/05）：
`--only-tasks repo-02…,repo-03…,repo-04…,repo-06…,repo-01…,repo-05… --min-tasks 6`。

**两个失败形态 → 两处产品改动**，且都能在判据里复现：
"只跑手边那个文件" ⇒ `prompt-root-cause-verification.test.ts`（PROMPT-ROOT-1..4）；
"红过没复跑绿就收工" ⇒ `red-test-at-completion.test.ts`（RT-1..6，RT-5 即为 repo-03 的原序列；
变异自证：去掉按文件记账 ⇒ **只有 RT-5 变红**）。

这两处改动将在 **1.16.233** 上做 A/B 复测（工具 `tools/eval/ab-report.mjs`）。

### 13.15 **怎么复现这一整套测量**（照抄这些命令即可；"可复现"是目标的一半）

前置：装好被测版本的 Codem（`Start-Process <setup.exe> -ArgumentList "/S" -Wait`），
`dsh` 在 PATH（`%APPDATA%\DSH Desktop\host-commands\...\bin\dsh.cmd`），Node ≥ 24。

```powershell
# ① 尺子自证（跑分数之前必须全绿；这两条的通过标准在第 109 波收紧过）
npm run eval:repo-workspace     # 12/12 工作区可信（含"答案仓库不可达"判据）
npm run eval:repo-bug-tests     # 12/12 bug 状态下判据红（必须**有真实失败标记**，不是只看退出码）

# ② 对照臂（DSH）—— 与处理臂同模型、同任务、同工作区配方
node tools/eval/run-repo-arm.mjs --arm control --model deepseek-flash --runs 1 `
  --out .preview-shot/eval-records-repo-control.jsonl `
  --agent-cmd "node C:\mimo-gui\tools\eval\drivers\dsh-driver.mjs"
# 单任务 / 子集：再加 --task <id>（可重复）

# ③ 处理臂（Codem 装机版，经 CDP 驱动真实应用）
$env:EVAL_RECORDS   = "C:\mimo-gui\.preview-shot\eval-records-codem-repo-v2.jsonl"
$env:EVAL_APP_VERSION = "1.16.232"      # 被测版本必须写进记录（A/B 靠它区分）
node .preview-shot\_codem-repo-eval.mjs run <taskId...> --register --run 1 --timeout-min 30

# ④ 成对报告（Codem vs DSH）：两臂模型不同直接拒；0 改动通过会被剔除并阻塞该对
node tools/eval/repo-paired-report.mjs `
  --control .preview-shot/eval-records-repo-control.jsonl `
  --treatment .preview-shot/eval-records-codem-repo-v2.jsonl

# ⑤ A/B 报告（新构建 vs 旧构建，同一条臂）
#   一条命令的 run-book（带安全闸门）：先看计划（不动任何东西），确认后加 --go
node .preview-shot/_ab-campaign.mjs --baseline-version 1.16.232 --candidate-version 1.16.233 `
  --tasks repo-02-write-false-success,repo-03-usage-accounting,repo-04-session-update-drops-fields,`
repo-06-llm-failure-not-completed,repo-01-edit-ambiguity,repo-05-workflow-bypasses-permission
node .preview-shot/_ab-campaign.mjs … --install 1.16.233 --go     # 真跑：装版本→跑候选→出 A/B

#    它的安全闸门（都实测过会拦）：基线里缺 run-1 的任务 ⇒ 拒跑（否则是在"补基线"而不是 A/B）；
#    装机版本与候选版本不一致 ⇒ 停；候选记录写**另一个文件**（-v3.jsonl），绝不混进基线文件。

# 重复跑（"可复现"落到操作上）：按运行号跑，单条失败不拖垮整批，跑完出稳定性小结
node .preview-shot/_run-repeat-campaign.mjs --arm control --runs 2,3 `
  --tasks repo-02-…,repo-03-… --out .preview-shot/eval-records-repo-control.jsonl

# ⑤b **机制开火核对（先做这一步，再解读 A/B）**
#    空结果有两种含义：「机制没效果」与「机制根本没触发」。跑完候选先数开火次数：
#    RED TEST 指针 / 红测试守卫 / read(line_numbers) 各开火多少次。
node .preview-shot/_mechanism-engagement.mjs .preview-shot/eval-records-codem-repo-v3.jsonl "1.16.234（候选）"
#    反向对照已做过：在 1.16.232（不含这三个机制）的 14 条会话上开火 **0** 次 ——
#    也就是说这个检查器不会把"没机制"的会话误报成"开火了"；若候选构建上仍是 0，
#    第一件要查的是 **appVersion 对不对**（跑的根本不是带机制的构建）。

# ⑥ 单次运行的事后诊断（每条记录都留了产物，不需要重跑）
node tools/eval/audit-codem-record.mjs --session <sessionId>   # 它到底调过哪些工具、改过哪些文件
#   .preview-shot/eval-<arm>-<task>.grade.txt   判据输出（哪条红、为什么）
#   .preview-shot/eval-<arm>-<task>.events.jsonl 驱动原始事件流（第 110 波起，两条臂对称）
#   .preview-shot/eval-codem-<task>.diff.txt     工作区 diff（它到底改了什么）
```

不变式（跑任何分数之前先确认这三条）：
① 两臂**同模型**（各自记录里有 `model`，`repo-paired-report` 会拒不同模型）；
② 被污染的运行（碰过答案仓库）与"零改动通过"的运行**一律剔除**；
③ 未配对任务存在时**不发布头部结论**（`Flags: unpaired-tasks / insufficient-coverage`）。

### 13.13c **工具层策略对比**（第 110 波新增：对照臂也留原始事件流）

动机：光有"过/不过"不够，还要知道**对手具体怎么做的**。Codem 侧本来就有会话（DB），
对照臂第 110 波起也把驱动事件流留档成 `.preview-shot/eval-<arm>-<task>.events.jsonl`，
于是可以逐工具对比（脚本 `.preview-shot/_compare-strategy.mjs`）。

同一个任务（repo-02，最终失败的判据是 `dsh-d9-multi-edit-partial-failure`）：

| | 对照臂 DSH | 处理臂 Codem |
|---|---|---|
| 工具分布 | read×47, grep×35, glob×18, pwsh×13, job_output×5, **edit×4** | read×39, bash×19, grep×10, **run_code×8**, glob×1, **edit×1** |
| 跑过的判据文件 | **4 个**，**含最终失败的那一个** | **2 个**，最终失败的那一个**没跑** |

**三个任务的工具层策略对比**（每条都有事件流/会话为证）：

| 任务 | 对照臂 DSH | 处理臂 Codem | 谁的问题是什么 |
|---|---|---|---|
| **repo-02** | 跑 **4** 个判据文件（**含失败那个**），**edit×4** | 跑 2 个（**没跑到失败那个**），**edit×1** | 我们：**验证宽度不够**（提示词那条要治的） |
| **repo-03** | 委派 1 个子代理去跑测试，edit×14 | 跑 **10** 个判据文件（**含两个失败文件**），红过三轮后收工 | 我们：**红过没复跑绿**（红测试守卫要治的） |
| **repo-04** | **一条测试命令都没跑**（12 条 pwsh 全是**探测它自己的 shell**：`1 + 1`、`throw "probe-error"`、写探测文件、`node --version`），edit×10 ⇒ **这次没过** | 跑 **40** 个判据文件（**含失败那个**）⇒ 也没过 | 双方都没过：我们**宽度够、实现深度不够**（D12 的三态语义没做全）；对手是**读+改**赌一把 |

结论要说得准：**我们的短板不是单一的**。repo-02 是宽度不够、repo-03 是收尾纪律、repo-04 是**实现深度**
（而宽度上我们反而比对手强 —— 40 个判据 vs 0 条测试命令）。
所以"再加一个提示词"这种通用补丁不会解决 repo-04 这一类；那一类要靠**模型把语义做全**，
不是拿工具面能补的。这也是为什么本轮**没有**去实现 §13.13f 那个"相关判据提示"候选 ——
证据不支持它是 repo-04 的瓶颈。

**结论**：差别不在"会不会用工具"，而在**验证的宽度**与**改动的彻底程度** ——
对手会把同一族判据都跑一遍再收工、并且改到 4 处；我们跑两个就停、只改 1 处。
这与 §13.13b 的两种失败形态一致，也正好是已经落地的两处改动要治的东西。

**两个被数据否掉的猜想**（记下来，免得下次再猜）：
1. ~~"对手靠委派（subagent）做验证"~~ —— DSH 在 repo-02 上委派 **0** 次、repo-03 上 **1** 次（113 次调用里），
   不是它的主要手段；Codem 8 个任务全是 0 次。所以这不是差距来源。
2. ~~"对手有后台任务能力而我们没有，所以它能跑大套件"~~ —— DSH 的 `job_output`/`run_in_background`
   在 repo-03 上全用在**探测它自己的 shell 好不好用**（`echo hi`、"Minimal shell echo test"、
   写文件探测、`exit 7` 探测，还为此派了一个子代理去"先确认 shell 能不能用"）。
   那是**它自己的问题**，不是它跑大套件的手段。
3. 顺带核实：Codem 的 `read` 本来就支持 `offset/limit`、`bash` 本来就支持最高 10 分钟超时 ——
   都不是缺口。真正的缺口是**大块输出的预览只给头 500 字符**（汇总在尾部 ⇒ 看不到结论），
   已在 §13.13d 修掉。

### 13.13d 第三处产品改动：大块输出的预览必须带尾部（第 110 波）

`maybePersistToolResult` 在结果 >50k 字符时落盘、**只把前 500 字符给模型**。
而 `npx vitest run` 的 `Tests N failed | M passed` 汇总行在**最后**（`cargo build`/`tsc` 同理），
于是模型**看不到自己那次验证的结论**，也就没有动力跑大套件（跑了也读不到）——
这与"压根没跑到判据"的行为互相强化。

现在预览 = 头 500 + 尾 2000（中间标注省略量），并点明"结论通常在尾部"。
判据：`tool-result-storage.test.ts` 两条（尾部汇总行必须在预览里、预览不得膨胀到 >6000 字符）；
**变异自证**：把 tail 置空 ⇒ 立刻红。

### 13.13e ⚠️ **单次结果不可复现的实证**：repo-04 上 DSH 一次过、一次不过

为了拿到对手的工具层策略，第 110 波把 repo-02/03/04 在对照臂上**重跑了一遍**
（记录写进 `.preview-shot/eval-records-control-strategy.jsonl`，不污染主对照记录）：

| 任务 | 基线（run 1） | 策略复跑（run 1，第二次） |
|---|---|---|
| repo-02 | 通过 | 通过 |
| repo-03 | 通过 | 通过 |
| **repo-04** | **通过** | **失败**（红的正是 `D11-4`、`D12-1/2/3` —— 与 Codem 失败的是同四条） |

也就是说：**"DSH 过了 repo-04"不是稳定事实**，那一次是它做到了、这一次没做到。
原基线记录里 repo-04 记 `passed` 是**真实的**（那一次它确实让判据全绿），但把它当成
"对手在这个任务上稳定更强"就是**过度声称**。

这对结论的影响：
1. 之前把 repo-04 算作"我们落后"的一条，现在应当降级为"**双方都不稳**"（Codem 1 次不过、
   DSH 2 次里 1 过 1 不过）；
2. 目标里的"**可复现**"不是修辞：**每个任务每臂至少 2–3 次重复**才够区分
   "它不行"与"这次不行"。复测计划按这个改：
   - 先在**双方不一致或任一侧不稳**的任务上加重复：repo-02/03/04/06（Codem 未过）、repo-07（DSH 未过）；
   - 报告里 `insufficient-repetition` 这条旗**不许忽略**（`paired-report` 与 `ab-report` 都会立起来）。

顺带：这一轮的重跑还给出了 DSH 在 repo-04 上的事件流（`.preview-shot/eval-control-repo-04-*.events.jsonl`），
工具层对比因此覆盖到两条任务。

### 13.13f 下一个候选杠杆（等 A/B 结果再决定）

证据指向的核心是"**验证宽度**"（对手把同族判据都跑一遍，我们只跑一两个）。
已在做的是"提示词要求 + 红测试守卫 + 预览带尾部"；如果 A/B 显示还不够，下一个候选是
**把"相关判据"直接摆到模型面前**：`edit`/`write` 成功后在结果里附一行
"这些测试文件引用了你改的模块（建议跑一遍）：a.test.ts, b.test.ts"
（实现代价：一次 `grep`；风险：可能影响断言 `edit` 输出形状的既有判据 ⇒ 要先看那些判据）。

**先不实现**：纪律是"数据先行" —— A/B 会告诉我们便宜的杠杆够不够。

### 13.13g ★ 第四个发现：**失败的那条判据，我们从没读过**（0/4）

判据文件在评测工作区里是**可读**的（§13.3 的已知局限）。所以红过之后，一个称职的做法是
**读那条判据**——它就是你这次要满足的规格（例如 D12 要求的是"版本高于本版本 ⇒ 大声失败、
且读失败必须流进三态机制"）。用会话逐条核对（脚本 `.preview-shot/_read-vs-run.mjs`）：

| 任务 | 最终红的判据 | 跑过？ | **读过？** |
|---|---|---|---|
| repo-02 | `dsh-d9-multi-edit-partial-failure` | ❌ 没跑 | ❌ 没读 |
| repo-03 | `usage-normalize` + `dsh-d7-usage-cache-buckets` | ✅ 2/2 | ❌ **0/2** |
| repo-04 | `dsh-d12-session-log-version` | ✅ 1/1 | ❌ **0/1** |
| repo-06 | `dsh-d3-abort-not-completed` | ❌ 没跑 | ❌ 没读 |

**四战全零**。它读过判据文件（1–4 个），但**从来不是红的那一个**：
读的是"自己觉得相关"的，跑的是红的那条，然后**猜着改**。

这解释了为什么我们的修复偏浅（repo-02 只补 `write` 那条分支、repo-04 的 D12 三态语义没做全）：
**没读规格，就只能照着症状猜**。

**下一步候选（先记录，等 A/B 结果再上）**：在完成口径里加一条
"**测试红了 ⇒ 先读那条测试**，从它读出期望的语义再动手，不要凭猜"。
之所以**不立刻加**：1.16.233 的变量集要**冻结**，否则 A/B 分不清是哪条改动起的作用；
这条与已有的"按根因修/验证覆盖面/红不许被完成盖过去"是**不同**的行为，
值得单独一次 A/B（有了这条证据，它不再是"再加一条提示词"的猜测）。

### 13.13h ⚠️ 重复跑 campaign 自己的一个 bug（"次数"当成了"运行号"）+ repo-02 也是 flaky

第一次重复跑就暴露了两件事，一件是我的工具错、一件是**重要的测量事实**：

**① 工具错**：`run-repo-arm.mjs --runs N` 的语义是"跑 **1..N** 这 N 次"（次数），
而我在 campaign 里把它当成"这次是 run-N"用 —— 于是**又跑了一次 run-1**，
记录里同一 `(case, arm, model, runNumber)` 出现两条且结果不同。
`paired-report.mjs` 因此把该对判成阻塞 —— **它的纪律是对的，是我的调用错了**。
处置：给 `run-repo-arm.mjs` 加 **`--run-number N`**（显式运行号，与 `--runs` 的次数语义分开），
campaign 改用它；已落盘的那条记录**更正标签**为 run-2（运行本身真实，只是标签错，
记录里带 `renumberedFrom`/`renumberNote` 说明）。

**② 测量事实（更重要）**：更正后可见 —— **repo-02 在对照臂上也是 flaky**：

```
repo-02  run-1: passed   run-2: failed   ⚠️ flaky
repo-04  run-1: passed   复跑: failed    ⚠️ flaky（第 110 波发现）
```

也就是说，被我们当成"对手稳定更强"的四个任务里，**至少两个（repo-02/04）对手自己也不稳**。
原来那版结论（"DSH 6 个全过、我们落后 4 个"）必须降级为：
**在能稳定复现之前，只能说"这一次它过了"**。重复跑的其余任务（03/06/07）正在补。

### 13.13i ⚠️ **run-1 的可信度问题**：那时的 `node_modules` junction 把答案仓库暴露着

这一轮把配对报告跑出来了，同时发现一个**必须先讲清的效度问题**：

**时间线**
- `19:20` 之前（**两个臂的 run-1 基线全在这段时间里跑**）：工作区的 `node_modules` 是
  junction 到 `C:\mimo-gui\node_modules` ⇒ **`node_modules\..` 解析到主仓库（有参考解）**；
- `19:20` 起：改成 junction 到 `%TEMP%\codem-eval-deps/node_modules`（泄漏通道关闭）；
- 之后的重复跑（campaign 2）都在干净条件下。

**为什么这条不能只靠"污染检测说没事"糊过去**：污染检测（`codem-record-integrity.mjs` 与
`run-repo-arm.mjs` 的 `readOutsideAccess`）看的是工具调用**目标里有没有出现 `mimo-gui`**。
而 `Get-ChildItem node_modules/..` 这种路径**一个字符串都不含 `mimo-gui`**，却真的走到了主仓库 ——
**检测器有盲区**（这是本轮发现的第三个"尺子自己有病"的例子）。
所以 run-1 的四个"对手通过"**无法证明干净**。

**干净条件下的证据（campaign 2，同一批任务、同模型、同提示）**：

```
repo-02  run-1: passed   run-2: failed   ⚠️
repo-03  run-1: passed   run-2: failed   ⚠️
repo-04  run-1: passed   run-2: failed   ⚠️
repo-06  run-1: passed   run-2: failed   ⚠️
```

**四战全翻**。结合 run-1 的可疑性，最保守也最站得住的读法是：

> **在干净工作区里，这四条任务对手也没做出来**（与 Codem 的失败一致）；
> run-1 的四次"通过"要么是暴露通道带来的，要么是"这一次它做到了"——
> **两者都无法区分，所以不作为证据**。

**处置**：
1. 报告与结论**以干净条件下的运行为准**（campaign 2 起）；
2. 干净条件下**两个臂都要跑满**（Codem 的 run-2 已在跑；对照臂的 runs 2/3 在跑）——
   这才是有资格谈"谁不弱于谁"的数据集；
3. **修检测器的盲区**：把 `node_modules\..`、以及任何"能解析到工作区之外"的目标形态纳入判据
   （下一轮补判据与变异）。

### 13.13j 配对报告：**头部结论 withheld**（工具纪律生效）

`repo-paired-report.mjs` 在现有数据上正确地**拒绝发布通过率**：控制臂有 run-2、处理臂还没有，
12 对里 4 对被阻塞（`处理臂缺失`），并立起 `blocked-pairs / flaky / insufficient-repetition /
headline-withheld` 五面旗。**这就是它该有的行为**（"成对样本不足就拒绝给结论"）。

能看的那部分是**逐任务表**（只用于决定下一步做什么）：

| 任务 | 对照臂（最新一次） | 处理臂 |
|---|---|---|
| repo-01 / 05 / 08 / 09 / 10 / 11 / 12 | ✅ | ✅ |
| repo-07 | ❌ | **✅（我们更强）** |
| repo-02 / 03 / 04 / 06 | ❌（干净条件下第 2 次） | ❌ |

**成本面（12 对，run-1）**：token **1.74M vs 5.43M**（我们约 1/3）、输出 26.8k vs 36.2k、
工具调用 44 vs 81（我们约一半）、**时延 338s vs 226s（我们慢约 50%）**。

### 13.13k ⚠️ 试过并**撤回**的机制：判据覆盖面兜底（三种口径都测了假阳性率）

起因（真实且成立）：把**我们自己的 12 次运行**按结果分组解剖后，
**判据覆盖面**是唯一稳定的判别量 —— 过的 8 次里 7 次把该任务判据**跑全**（2/2、3/3），
没过的 4 次里 3 次是**部分覆盖**；而"改完不复跑测试"被否掉（过的 8/8 与没过的 4/4 都复跑了）。

于是做了"收尾时列出你**见过却没跑**的判据"这条守卫。**发版前先测假阳性率**，结果：

| 口径 | 开火率（通过 / 未过） | 列出的文件数 |
|---|---|---|
| A：判据名出现在**任何**工具结果里 | **8/8 / 4/4** | 452–655 个 |
| B：同 A 但只认工作区 `src/**`、排除 node_modules | **8/8 / 4/4** | 452–493 个 |
| C：**相关性感知**（只算引用了被改模块的判据，内容级 grep） | **7/8 / 4/4** | 45–130 个 |

三种口径**全都不合格**：
- A/B 被**枚举类结果**污染 —— agent 只要 glob/grep 过 `src/test`、或列过一次目录，
  几百个判据文件就都成了"见过但没跑"；
- C 看起来最讲道理，但**被改的往往是核心模块**（`index.ts` / `tools.ts` / `agentic-loop.ts`），
  引用它们的判据有 45–130 个 —— "把相关判据都跑一遍"这个要求本身就不合理，
  我们的**通过**运行也只是跑了其中一小撮（对手同样如此）。

**决定：撤回 A/B（`revert c7feb4a`），C 不实现。** 保留的两条是**开火条件天然严格**的：
`[RED TEST]` 指针（只在测试**真的红了**时附上"先读这条判据"）与红测试收尾守卫（只在"红过没复跑绿"时提醒）。

**留下的纪律**（比这次的具体机制更值钱）：
> 做守卫之前，**先量它的开火率**。判据能证明"它会开火"，但**没有任何判据在问"它开火得太频繁吗"** ——
> 这一条必须自己补测，否则发出去的就是噪音（而噪音会把真实信号一起稀释掉）。

至于"**从头到尾没跑到那条判据**"（repo-02/06 的形状）：在没有"任务判据清单"的前提下，
**机械兜底做不到**（上面三种口径都证明了），只能靠提示词那条"验证要跑相关模块、不是只跑手边那个文件"。
这是本轮必须如实说明的边界。

### 13.16 **判定规则**（先写下来，再看数据 —— 防止事后挪动标准）

目标句是"让 Codem 的编码能力**不弱于** DSH（同模型、同任务口径下可比较、可复现）"。
这句话要能**被判**，就必须先把"不弱于"定义清楚。以下规则**先于**结论写下：

**① 入据条件（不满足的运行不进结论）**
- 两臂**同模型**（`deepseek-flash`）——`ab-report.mjs` 自己会拒；
- 工作区必须是**干净条件**（第 110 波起的 `%TEMP%` 共享依赖副本；`node_modules\..` 那类
  junction 逃逸已由 `JUNCTION_ESCAPE_RE` 纳入判据）——**run-1 因当时通道开着、不作证据**；
- 每次运行都要过**尺子自证**：工作区三件套（12/12）、判据"红得有真标记"（12/12）、参考臂能绿；
- 污染/零改动通过（`contaminated` / `suspiciousNoDiffPass`）一律**作废该条**。

**② 判定量（主）**：**逐任务**的通过率，**每臂每任务 ≥2 次**有效运行（分歧任务上 ≥3 次更稳）。
- "**不弱于**"= **不存在**这样的任务：对手**稳定通过**（多轮全过）而我们**稳定不过**（多轮全不过）；
- 出现"双方都不稳"（同一任务两轮结果不一致）⇒ **该任务不下结论**，要么补轮次，要么标注为"打平（都不稳）"；
- 一臂在某任务上全过、另一臂不稳 ⇒ 记为**该臂占优**（但注明对手不稳）。

**③ 判定量（次）**：token / 工具调用数 / 时延。**只记录、不翻案** ——
"不弱于"说的是能力，不是更省；单位任务的成本差异写进结论的注脚。

**④ 报告纪律**：`repo-paired-report.mjs` 的 `headline-withheld` / `blocked-pairs` /
`insufficient-repetition` 任何一面旗立着，就**不许**对外说"通过率"这一个数；
只能给逐任务表 + 每格的实际轮次。A/B 报告前必须先过 `_mechanism-engagement.mjs` 的**开火核对**。

**⑤ 已知的、必须写进结论的边界**
- 判据文件在工作区里**可读**（§13.3）：本口径测的是"给定红判据，能不能做出符合规格的修复"，
  **不是** SWE-bench 那种"判据不可见"的口径；
- 任务集是 12 个真实仓库缺陷，**样本很小**：单任务 ±1 的差别不构成"能力差异"的证据；
- 我们自己的"稳"目前是**稳定地失败**（repo-02/03 两轮都不过）——确定性 ≠ 能力，别混为一谈。

### 13.16b ★ **我们的失败形态是"逐轮稳定"的** —— 机制与病灶 1:1 对上

把同一任务两轮的失败形态摆在一起（`.preview-shot/_failure-shape-by-run.mjs`）：

| 任务 | run-1 形态 | run-2 形态 | 工具数 / 改动量 |
|---|---|---|---|
| repo-02 | **既没跑也没读**（漏了这条判据） | **同一种** | 78→80 / 1156→952 字符 |
| repo-03 | **跑过没读**（照症状猜） | **同一种** | 26→40 / 6057→8181 字符 |
| repo-04 | 跑过没读 | （run-2 在跑） | 46 / 6818 |
| repo-06 | 既没跑也没读 | （run-2 在跑） | 65 / 10736 |

**两轮两任务的形态完全一致** ⇒ 我们的失败**不是随机**，而是**同一个行为缺口反复出现**。
这对"机制能不能被验证"是关键的好消息：病灶稳定 ⇒ 修没修好是**可判**的。

而且它与已经落地的两条机制**一一对应**：

| 失败形态 | 该治它的东西 | 状态 |
|---|---|---|
| **跑过没读**（看见了红，却猜着改） | **`[RED TEST]` 指针**：红的那一刻把"先去读这些判据文件"附在同一段结果里 | 已实现（RT-7/8/9），等 A/B |
| **既没跑也没读**（压根没验证到） | 提示词那条"验证要跑相关模块、不是只跑手边那个文件" | 已在 1.16.233 |

顺带一个**否定性**结论也写在这儿（省得后人重复尝试）：第二条**没有**机械兜底的版本 ——
"见过却没跑就提醒"的三种口径假阳性率分别是 8/8、8/8、7/8（§13.13k），已实测撤回。

补：repo-02 两轮的改动都只有 ~1KB（一个分支的补丁），与"照着症状猜"完全吻合；
repo-03 两轮都只改 1 个文件 —— 形态稳定的另一个侧面。

### 13.16c ★★ 对手 run-1 的那四次"通过"**不复现**（3 轮数据）

对照臂在分歧任务上补到 **run-3** 之后：

| 任务 | 对手 run-1 | run-2 | run-3 | 我们 run-1 | run-2 |
|---|---|---|---|---|---|
| repo-02 | ✅ | ❌ | （只有 2 轮） | ❌ | ❌ |
| repo-03 | ✅ | ❌ | ❌ | ❌ | ❌ |
| repo-04 | ✅ | ❌ | ❌ | ❌ | ❌ |
| repo-06 | ✅ | ❌ | ❌ | ❌ | （errored，待重跑） |
| **repo-07** | ❌ | ✅ | ✅ | ✅ | （复跑中） |

两条结论：

1. **对手在这四个任务上是"1 过 / 2 不过"** —— 按 §13.16 的判定规则，"稳定通过"要求**每一轮都过**，
   所以**不存在"对手稳定通过而我们稳定不过"的任务** ⇒ 现阶段**没有任务能算我们更弱**。
2. 更值得注意的**模式**：他们唯一的"过"**全部落在 run-1**，而 run-1 正是
   **泄漏通道开着**的那一批（`node_modules\..` 可解析到答案仓库，§13.13i）。
   run-2/run-3 是干净条件，全不过。**这个对齐本身就是泄漏解释的旁证** ——
   但我们只能说"无法区分"，不说"就是靠泄漏过的"（那条通道当时检测器看不见，
   永远无法事后证明他们用没用）。

顺带：我们这边的四次失败是**两轮同型、两轮都不过**（§13.16b），
所以在这四个任务上，"我们稳、对手不稳"是**有数据支撑**的说法；
而"我们不如对手"目前**没有任何干净数据支撑**（相反，唯一干净条件下的差异是 repo-07 —— 我们 run-1 过、
他们 run-1 不过、run-2/3 过；我们的 run-2 正在补）。

**尚未收口的**：repo-06 的 run-2 因脚手架 EPERM 记成 `errored`（§13.16d 已修），要重跑；
repo-07 我们只有 run-1。这两条补齐之前，按 §13.16 不下最终结论。

### 13.16d 脚手架 EPERM 的修法（顺手把"尺子的脆"去掉一层）

现象：批次跑到**最后一个任务**收尾时 `rmSync`/`renameSync` 双双失败
（`EPERM: Permission denied ... codem-eval-ws`），任务被记成 `errored`、白跑一遍。
根因**不是被测 agent**：应用还开着（把这个目录当项目在监听、握着句柄），
而驱动只在**下一个任务开始时**才停应用 ⇒ 最后一个任务的收尾没人保护。

**第一版修法**：`repo-workspace.mjs` 的 `createRepoWorkspace` 之前调用 `stopAppForCleanup()`
（幂等 + 停完等 1.5s）。放在这个模块而不是驱动里，是因为**任何**建/清工作区的路径都该有这层保护。

**⚠️ 但第一版不够**：第二批复跑里 **repo-01/10/11/12 全部在 10–11 秒内退出** ——
同样的 EPERM，只不过这次发生在**开跑前的重置**（上一个任务的 `vitest`/`esbuild` 子进程
还握着目录句柄，光停应用不够）。代价：四条 run-2 作废（约 25 分钟评测）。

**第二版修法（当前）**：**不再跟操作系统抢**——`_codem-repo-eval.mjs` 改为
**每次运行一个全新工作区目录**（`codem-eval-ws-<时间戳>-<pid>`），谁都不用删；
开跑前再**尽力**清掉 30 分钟前的旧目录（删不掉也绝不影响本次运行）。
这样"上一个任务的残余句柄"再也不可能把下一个任务判死。

**经验（写下来免得再犯）**：对"共享路径 + 会被别的进程占住"的资源，
**优先换路径而不是加强删除**；清理只能是尽力而为，绝不能成为运行的前置条件。

另一条收益：这件事之所以能被诊断，是因为第 111 波加了"**跑挂也要落盘**"
（否则只表现为"记录里少了一条"，第 110 波我就这么误判过一次）。

### 13.16e **机械判定器**（把 §13.16 的规则交给脚本，人不再插手）

`_verdict.mjs` 按 §13.16 逐条执行：只取干净条件（run-2 及以后）→ 污染/零改动通过作废 →
每臂每任务判成"稳定通过/稳定不过/不稳/轮次不足" → 只在**存在"对手稳定通过而我们稳定不过"**时才说我们更弱。

跑在当前数据上的结果：**"算我们更弱"的任务 0 个**；同时**绝大多数格子是"轮次不足"** ——
这正是它该有的诚实：干净口径下，两臂在多数任务上还只有 1 轮。

**因此还缺的数据（明确列出来，免得含糊）**：

| 任务 | 对手干净轮次 | 我们干净轮次 | 缺什么 |
|---|---|---|---|
| repo-02/03/04/06 | 2–3 轮（全不过 / 02 为 1不过1过） | **1 轮** | **我们补到 run-3** |
| repo-07 | 2 轮全过 | **0 轮**（只有不算数的 run-1） | 我们的 run-2（复跑批正在跑） |
| repo-01/05/08/09/10/11/12 | 0 轮 | 0–1 轮 | 双方都缺；按规则只能算"轮次不足"，**不进判定** |

按 §13.16，**判定只需要覆盖"风险方向"**（对手稳定通过 × 我们稳定不过），
所以最小决定性数据集 = 上面两行：四个分歧任务（我们补 run-3）+ repo-07（我们的 run-2/3）。
其余 7 个任务双方都过了 run-1、且双方都没补干净轮次 ⇒ 如实记"轮次不足"，**不硬凑结论**。

**已排好的串行流水线**（每一段都用"上一段**进程退出**"当信号，避免第 114 波那次 EPERM 的重演）：

```
_run-second-pass.mjs   复跑我们通过过的 8 个任务（run-2）                ← 正在跑（已到 repo-08）
  └→ _chain-tail.mjs   等 repo-12 run-2 → 补 repo-06 run-2 → 工作区自证 12/12
       └→ _chain-run3.mjs          等 tail 退出 → 四个分歧任务 + repo-07 的 run-3 → 跑 _verdict.mjs
            └→ _chain-control-clean.mjs   等 run3 退出 → 对照臂 12 任务 × run-2/3
                                          → 裁干净文件 → _verdict + repo-paired-report
```

四段之间**绝不并发**：处理臂只有一个应用实例；`eval:repo-workspace` 会先停应用；
判据都在同一台机器上跑 vitest，并发会把判据拖到超时（超时被记成 `errored` ＝白跑）。

跑完之后的数据集是**完整**的：**两臂 × 12 个任务 × ≥2 个干净轮次**。
严格说 §13.16 的判定只需要覆盖"对手稳定通过 × 我们稳定不过"这个风险方向，
但完整数据集才配得上目标里"可比较、可复现"的说法 —— 否则结论只能覆盖 5 个格子，
其余 7 个永远停在"轮次不足"。

### 13.18 **1.16.234 发布待办**（内容已冻结，等流水线跑完就执行）

**为什么没现在就发**：① 处理臂的复跑批/run-3 正在跑，构建是 CPU 重的、会把判据跑成超时；
② 版本一致性判据（`version-consistency.test.ts`）要求 `package.json` / `tauri.conf.json` /
`Cargo.toml` / `CHANGELOG` 顶部 / `PROJECT-GUIDE` 表 / `latest.json` **同时**一致 ——
所以必须"改号 → 构建 → 生成清单 → 一次性提交"，不能改一半放在树上（那会让判据一直红着）。

**源码层面的内容**（`git diff 9110246..HEAD --stat -- src/` 的准确清单，2026-10-03 复核）：

| 文件 | 改动 | 证据来源 |
|---|---|---|
| `tool-result-storage.ts` | 大块输出预览改为**头 500 + 尾 2000** | repo-04 那轮 404 passed 的汇总在尾部、模型只看到头部 |
| `agentic-loop.ts` | **`[RED TEST]` 指针**（红的那一刻把"先去读这些判据"附在结果里） | 四个失败任务**全零**读过失败判据（§13.13g） |
| `agentic-loop.ts` | 红测试识别**先剥 ANSI** | 交互使用时彩色输出会让标记正则静默失效 |
| `agentic-loop.ts` | 读缓存键 + 同响应去重键**补上行号开关** | 自查抓到的两处静默串味（同一坑的两处） |
| `tool-output-shapes.ts` + `tools.ts` | `read({ line_numbers })` + `edit` **容忍行号前缀（精确命中优先）** | repo-02 里两次 `node -e` / `python -c` 绕道打印行号 |
| `i18n-templates.ts` | **「动手之前先看到红」**（中英双语） | 四个失败里两个是"从头到尾没跑到那条判据"（§13.16b）；基线代理指标：首次跑测试在第 **27** 次调用（§13.18b） |
| `workflow-engine.ts` | 修掉"仍在应用进程内跑（`new Function`）"的**过时注释** | 它其实早已走 `executeCode()` → Rust 沙箱 |

**配套判据（新增/加强）**：`read-line-numbers.test.ts`（LN-1..6）、`red-test-at-completion.test.ts`（RT-1..13）、
`tool-result-storage.test.ts`（+2）、`prompt-root-cause-verification.test.ts`（PROMPT-ROOT-6 + ROOT-5 扩展）、
**`workflow-sandbox-wiring.test.ts`（WF-1/2）**、**`phase-b-f-regression.test.ts`（CSP 裸 `unsafe-eval` 的 token 判据）**、
`s0-regression-full.test.ts`（两处接线判据改为断言不变量）。
评测侧（不进装机包但同批提交）：`repo-workspace.mjs` 的排除清单单一真相与 `isExcludedFromWorkspace`、
`codem-record-integrity.mjs` 的 junction 逃逸规则、`eval-workspace-exclusions.test.ts`。

**两个交互面已核实安全**（"新功能 × 既有机制"是最容易出事的地方，所以逐条看代码而不是想当然）：

1. **输出契约校验**：`[RED TEST]` 是往 `result.output` **追加文本**，而契约层校验的是
   `result.value`（`tool-pipeline.ts` 的 `if (result.value === undefined)` 分支），
   且追加发生在管道返回**之后** ⇒ 不会把"红了"变成"格式违规"（这正是第 97 波
   `errorSource: "loop"` 那条注释里描述过的坑，当时四个主力工具因此全废）。
2. **重复守卫的"信息增益"判定**：追加写在 `guardGain` 计算**之后** ⇒ 守卫看到的仍是原始输出，
   守卫的连续重复计数不会被指针文本搅乱。

**发版仪式**（照 1.16.233 那次做，逐条都有判据）：
1. 改号：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` → `1.16.234`；
2. `CHANGELOG.md` 顶部加 `## [1.16.234]`、`docs/PROJECT-GUIDE.md` 加 `| v1.16.234 | … |` 行；
3. 构建：`$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri\codem-updater.key -Raw;`
   `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="dummy"; npm run tauri:build`；
4. `node tools/eval/make-latest-json.mjs` + `verify-update-manifest.mjs`（5/5）；
5. 跑 VERSION-* / UPD-MANIFEST-* 判据（11 条）；
6. **先不装**：等 A/B 的基线批次全部落盘后再静默安装（装新版本会改变被测对象）。

**A/B 计划**：基线 = 1.16.232 的干净轮次（run-2/run-3，已有一部分）；
候选 = 1.16.234 在**同一批任务**（四个分歧任务 + repo-07）上的同样轮次；
**报告前先跑 `_mechanism-engagement.mjs`** 核对三个机制的开火次数
（1.16.232 上的反向对照是 0 次，所以"候选也是 0"就意味着装错了版本）。

### 13.18b A/B 的**行为代理**（先测基线，再看候选有没有前移）

通过/不通过在 12 个任务上的分辨率太低（单任务翻一次就是 8%），所以除了结果，
还钉一条**行为指标**：**"第一次跑测试"发生在第几次工具调用** ——
它正是新加那条提示词（"动手之前先看到红"）要改变的东西。

**1.16.232 基线（17 条有测试调用的会话）**：

| 统计 | 值 |
|---|---|
| 中位数 | **第 27 次调用** |
| 最小 / 最大 | 15 / 64 |
| ≤8 次的 | **0 / 17** |
| >20 次的 | **11 / 17** |

也就是说：**基线从不"先复现失败再动手"**，基本是"摸了一圈、改完了才想起来跑测试"。
候选构建（1.16.234）如果这条提示词真的起作用，这个分布应当**前移** ——
即使通过率没动，也能说明"要求进了行为"，而不是"写了个没人看的句子"。

（这三个机制与那条代理指标都写进 `_mechanism-engagement.mjs`，A/B 报告前自动跑。）

### 13.19 ⚠️ 一次**差点让之后每个工作区都自带答案**的操作事故（已修，记录在案）

**发生了什么**：第 116 波我给一个提交顺手写了 `git add -f … .preview-shot` ——
`-f` 把整个临时区（**5527 个文件**）强制塞进了 git。而评测工作区是 `git archive HEAD` 造的 ⇒
里面的 `eval-codem-repo-*.diff.txt` **就是各任务的解**、`eval-records-*.jsonl` 里有任务 ID 与结果 ⇒
**之后每个工作区都会自带答案**（评测直接失效，而且不会有人发现，因为"工作区自证"当时只查
`tools/eval` 与 `docs/HANDOFF-*`）。

**怎么发现的**：提交输出的 git 警告里出现了 `.preview-shot/DB-SCALE-BENCH.json` 之类的文件名 ——
我本来以为这个目录一直都在 `.gitignore` 里（前面几十轮的 `git add -A` 确实没碰它）。

**处置**：
1. `git reset --soft HEAD~1` + `git reset HEAD -- .preview-shot`（**只动索引，工作树文件一个没删**），
   重新提交为 `f61ada0`（只含 docs 与 `tools/eval/repo-workspace.mjs`）；
2. 校验 `git ls-tree -r HEAD | grep '^\.preview-shot/'` ⇒ **0 个** ✓；
3. **把 `.preview-shot` 加进 `EXCLUDED_FROM_WORKSPACE`**，并让 `removeAnswers` 真删它、
   `verifyRepoWorkspace` **显式检查它不在**（不在就报 problems ⇒ 建工作区时直接抛）—— 两层防护；
4. 核实**没有运行被污染**：误提交只存在了约 3 分钟（20:45–20:48），那段时间里**没有新建任何工作区**
   （正在跑的 repo-06 工作区建于 20:41，早于这次误提交）✓；
5. 风险面：仓库有 `origin` 远程，但**全程没有 push 过** ⇒ 那次误提交只存在于**本地**对象库里，
   且已不被任何分支引用（正常 push 不会带它出去）。

**教训（比事故本身值钱）**：
- `git add -f` 是**绕过忽略规则**的动作，用之前必须问一句"这个目录里有没有不该进仓库的东西"；
- **工作区的自证清单要跟着"我往仓库里放了什么"一起维护** —— 那次之所以危险，
  正是因为自证清单里没有 `.preview-shot` 这一条（现在已经有了）。

### 13.20 ⚠️ **工作区泄漏的时间线**（决定了哪些运行能当证据）

工作区 = `git archive HEAD`，所以"仓库里有什么"直接等于"被测 agent 能看见什么"。三次清理：

| 时间 | 关掉的通道 | 受影响的运行 |
|---|---|---|
| 约 19:20 | `node_modules` junction 不再指向主仓库（`node_modules\..` 逃逸） | **run-1 全部**（含两臂）⇒ 已按 §13.13i 作废 |
| 第 116 波（本波） | 工作区排除清单补 `CHANGELOG.md` / `docs/PROJECT-GUIDE.md` / 三份分析文档 / `.preview-shot`；`agentic-loop.ts` 注释去标识 | 本波之前的 **run-2**（02/03/04/05/07/08/09）⇒ **docs 与注释当时可见** |
| 本波之后 | —— | **只有本波之后创建的工作区是真正干净的** |

**为什么这事严重**：`agentic-loop.ts` 里有 11 处注释点名 `repo-02/03/04` **并写出它们的失败序列**
（"`usage-normalize`+`dsh-d7` → 4 failed"），而 **12 个任务里有 8 个不还原这个文件**
⇒ 那些工作区里，agent 读它正在改的源码时**就能看到我们对这几个任务的诊断**。
方向上是"帮它"而不是"害它"，但**无论哪个方向都让测量失真** —— 我们没做出来的那几个任务，
恰恰是被泄露诊断的那几个。

**处置（宁可多花钱，不要脏数据）**：
- **判定只用"本波之后创建的工作区"产出的运行**；
- 已排好的后续批次（收尾链 → run-3 → 对照臂 12×run-2/3 → 补跑四条）**全部在本波之后**，天然干净 ✓；
- 我们这边再加两段：**run-3 补齐 12 个任务**、**干净 run-2 补齐 12 个任务**
  （原有 run-2 是清理之前建的 ⇒ 不算干净），与对照臂的 run-2/3 **运行号对齐** ⇒ 配对成立；
- 之前那些"半干净"的 run-2 保留在记录里，但**标注**为"docs/注释可见时期"，不参与判定。

**清账（工作区创建时间决定它算不算证据）**：

| 运行 | 谁负责跑 | 干净？ |
|---|---|---|
| 我方 run-1（12） | 已完成 | ❌ 泄漏通道开着（§13.13i） |
| 我方 run-2（02/03/04/05/07/08/09） | 已完成 | ❌ 建在本波清理之前（docs/注释可见） |
| 我方 run-2（10/11/12） | 已完成 | ❌ errored（脚手架 EPERM） |
| 我方 run-2（06） | 正在跑 | ❌ 进程启动早于本波清理 |
| **我方干净 run-2（01/10/11/12）** | `_chain-rerun-errored` | ✅ |
| **我方干净 run-2（02/03/04/05/07/08/09）** | `_chain-clean-run2` | ✅ |
| **我方干净 run-3（12 个）** | `_chain-run3`（5）+ `_chain-clean-round`（7） | ✅ |
| **对照臂干净 run-2/3（12 个）** | `_chain-control-clean` | ✅ |

跑完即得：**两臂 × 12 任务 × run-2/3，全部干净** —— 这才是能对外讲"可比较、可复现"的那张表。

**记下来免得再犯**：每次往仓库里加东西（尤其注释与文档）都要问一句
"**这个文件在评测工作区里会不会被还原？不会的话，它说的东西被测 agent 就能看到**"。
自证清单（`EXCLUDED_FROM_WORKSPACE` + `verifyRepoWorkspace`）是这条纪律的机械版本，必须跟着仓库内容更新。

### 13.17 执行状态（截至第 113 波；结论按 §13.16 的规则走）

- **对照臂（DSH）**：`deepseek-flash`，`dsh --profile headless --json`，12 个任务 run-1 **跑满**
  （11 过 / repo-07 不过）；分歧任务（repo-02/03/04/06/07）另有 **run-2**（除 07 外全不过）；
  事件流留档 `.preview-shot/eval-control-<task>.events.jsonl`，污染检测与处理臂**共用同一份规则**。
- **处理臂（Codem）**：1.16.232 装机版 + CDP 驱动，12 个任务 run-1 **跑满**（8 过 / 4 不过：
  repo-02/03/04/06）；run-2 正在补（repo-02/03 已落、都不过），随后**自动接力**复跑"通过过的 8 个任务"。
- **⚠️ run-1 的效度**：那段时间工作区的 `node_modules` junction 指向主仓库（`node_modules\..` 可解析到答案仓库），
  而当时的检测器看不见这种路径 ⇒ **run-1 不作为"谁强谁弱"的证据**（§13.13i）；干净条件是 run-2 起。
- **成对报告**：`node tools/eval/repo-paired-report.mjs --control … --treatment … --runs 1`
  现在**正确地 withhold 头部**（控制臂有 run-2、处理臂缺 ⇒ 4 对被阻塞）。
- **本轮仍不下结论**：等两臂在**同一批任务上都有 ≥2 次干净运行**（§13.16 的入据条件）。

### 13.8 还差什么

1. **失败的那 4 个任务只有 1 次**：还不足以区分"它不行"与"这次不行"。下一步给 `repo-02/03/04/06` 补重复。
2. **诊断能力没有被单独测**：见 §13.3（判据可读）。
3. **与 DSH 对照臂的隔离不对等**：见 §13.7（三条路已列）。
4. **`run_code` 在真机上被 CSP 挡住**（`unsafe-eval` 不在 `script-src` 里）—— 探针里 agent 试过
   `run_code` 拿目录，返回「Evaluating a string as JavaScript violates … Content Security Policy」。
   这个工具**在真机上等于不可用**（本仓已有 `run_code` 的危险命令分析器，但它连跑都跑不起来）。
   要不要修（放开 CSP 的代价 vs. 把 run_code 改成不经 eval 的实现）**需要产品决定**。
5. §3.6（外层 `run_code` / `workflow` 在「替我审批」模式下是否仍自动放行）仍然**等用户拍板**。

---

## §14 §3 待办清单的**收口表**（第 101 波末）

| 条目 | 状态 | 证据（判据 / 变异 / 真机） | 章节 |
|---|---|---|---|
| §3.1 停滞守卫治本（信息增益 + `plan_stale` 独立终态） | ✅ | `stall-guard-loop-behavior.test.ts`（STALL-LOOP-1/2/3，含变异）；真机 15 次运行 `loop_stopped` **0**；`TurnOutcome` 让"被杀"不再呈现成完成 | §8、§9、§13.4 |
| §3.2 用量/成本不再把非正常收场记成成功 | ✅ | `usage-non-completion.test.ts`（6 条，驱动真实 `runLoopAndReportUsage`）；已作为 `repo-12` 的判据并被真机通过 | §8、§13.4 |
| §3.3 用真实仓库档测 Codem | ✅ | **12 任务 / 15 次有效运行 / 11 通过（73%）/ 按任务 9–12**；三层自证齐（工作区 12/12、bug 态判据红 12/12、reference 全绿）；污染检测与假绿识别都自动化 | §10–§13 |
| §3.4 `fs-observation-policy`（读后写 + 版本比对） | ✅ | `fs-observation-policy.test.ts`（OBS-1..11）+ Rust `file_version_tests`；三次变异逐个咬住 | §9 |
| §3.5 线上字段名不一致（`nextOffset` 恒 `undefined`） | ✅ | Rust `wire_naming_tests`；真机复验（111KB 日志两窗读第二窗真的前进） | §9 |
| §3.6 外层 `run_code` / `workflow` 在「替我审批」模式下是否仍自动放行 | ✅ **已拍板：保持现状**（见 §15.1） | 决定是"外层继续自动放行，但补判据钉住**内层**闸门" —— 而内层闸门的判据**早就有了**：`workflow-permission-parity.test.ts`（WF-1/WF-2/WF-3，含反向对照与 fail-closed）与 `pi-p2-run-code-permission-parity.test.ts`（P2-1/P2-2），两者都断言"危险命令 → `executeCommand` 一次都没被调用" | §15.1 |
| §3.7 真实仓库档的尺子 + 任务集 | ✅ | 三层自证 + 12 个任务（`buggyCommit` = 修复的父提交）；已挂进 `npm run audit` | §10、§12.7、§13 |
| 附：本轮顺手抓到的**真机级产品缺陷** | ✅ | ①四个主力工具全废（`bash/read/glob/grep` 每次成功调用都被改写成契约错误）②失败原因被契约话术顶掉 ③沙箱漏 shell 路径（含裸 `..`）—— 各自的判据与变异见 CHANGELOG `1.16.227`–`1.16.230` | CHANGELOG |

---

## §15 用户拍板后的两件事（第 101 波末）

（见下节 §15 原文）

## §16 第 103 波：把 `new Function` 一族从"真机不可用"里救出来（进行中）

### 16.1 为什么必须先做这件事（它挡在"编码能力不弱于 DSH"前面）

装好的应用 CSP **不含 `unsafe-eval`**（`tauri.conf.json`；`phase-b-f-regression.test.ts` 还专门断言
它含的是 `wasm-unsafe-eval`）。于是所有 `new Function` / `eval` 在真机上**直接抛 CSP 违规**：

| 功能 | 真机现状（第 99/101 波探针） |
|---|---|
| `run_code` | ❌ `Evaluating a string as JavaScript violates … 'unsafe-eval' is not an allowed source of script` |
| `workflow` | ❌ 同一条（它 `import { executeCode } from run-code.ts`，是同一份实现） |
| 函数型 hooks | ❌ 同一族 —— 而钩子是**守卫**，"没生效"意味着该拦的没拦 |
| 动态插件 / dynamic runner | ❌ 同一族（`new Function('ctx', …)`） |

**这直接压住编码能力**：没有可用的 `run_code` / `workflow`，就没有"写脚本 → 跑 → 看结果"的闭环。

### 16.2 方案：把 JS 引擎编成 WASM，在应用自己的 JS 上下文里跑（不改 CSP、不用 eval）

`wasm-unsafe-eval` 是允许的 ⇒ 用 **quickjs-emscripten**（QuickJS/WASM）执行脚本：
宿主函数是普通 JS 闭包（**不需要跨进程 RPC**），guest 里**看不到** `window` / `document` /
`process` / `require` / `__TAURI__`（判据 JSVM-3）—— 顺带把原来"与应用共享全局对象"的窟窿补上了。

落地在 `src/core/js/js-vm.ts`（两条路：`runInJsVm` 异步、`runInJsVmSync` 同步）。

### 16.3 ⚠️ 踩到的硬限制：asyncify 引擎**一次执行里只能挂起一次**

宿主函数是"guest 侧同步、宿主导步"的（asyncify）。实测数字（`_probe-jsvm-call-count2.mjs`，
同进程内每格 5 次，看返回值）：

| 一次执行里的宿主调用数 | 成功 |
|---|---|
| 1 | **5/5** |
| 2 | **0/5**（`memory access out of bounds` / `Aborted(… free_zero_refcount)`） |
| 3+ | **0/5** |

而且**损坏是进程级的**：一次失败的执行之后，后续所有执行都会失败（换新模块也救不回来），
还会漏出 `unhandledRejection: memory access out of bounds`（在 WebView 里就是未捕获错误）。

**处置（第 103 波的临时守卫）**：在 **guest 侧、挂起之前**拒绝超限调用
（`maxHostCalls`，默认 1）—— 拒绝是纯 JS 的 `Promise.reject`，不碰 asyncify。
判据 JSVM-11 钉三件事：单次正常、第 2 次拿到**可行动的**报错、**紧接着再跑一次仍然成功**（运行时没坏）。

### 16.4 已完成的迁移（判据 + 变异都齐）

| 位置 | 状态 | 判据 / 证据 |
|---|---|---|
| `run_code` + `workflow`（同一份 `executeCode`） | ✅ 已迁到 WASM 引擎（**受 1 次工具调用的临时上限**） | `js-vm-no-eval.test.ts` JSVM-1..11（JSVM-2/10 把全局 `Function`/`eval` 换成会抛的桩后仍必须能跑；JSVM-10 钉工具层）；`pi-p2` / `workflow-permission-parity` 一字未改全绿 |
| 函数型 hooks（两处） | ✅ 已迁到**同步**路径（无挂起 ⇒ 不受 16.3 限制；并补上了原来没有的**超时**） | `hook-function-vm.test.ts` HOOKVM-1..5；`hooks-system`（18）+ `hook-fail-closed`（12）全绿 |
| Node 专用 `code-runtime-worker-thread-provider.ts` | ✅ **删除**（`worker_threads` 在 Tauri WebView 里不存在，没有任何产品代码引用它；却把 `new Function` 藏在 worker 脚本字符串里） | 预检 `validateCode` 移到 `validate-dynamic-code.ts`；`deep-closed-loop-audit` 里那两条"要求源码出现 `new Function`"的旧判据已改写 |
| 动态插件 `dynamic-runner-provider.ts` | ⏳ 未迁（**最后 1 处**，门禁里记着） | `npm run audit:no-eval` 只报它一处 |
| 门禁 | ✅ `npm run audit:no-eval`（扫 `src/`，注释/字符串/正则不算；允许清单每迁完一处就删一行） | 已挂进 `npm run audit` |

### 16.5 第 104 波：异步路径搬进 **Rust 侧 `boa_engine`**（已完成，真机已验证）

`src-tauri/src/js_sandbox.rs`（引擎 + 命令 + 桥）+ `src/core/js/js-remote-runtime.ts`（前端适配）。

- **执行**：guest 在 Rust 侧的 boa 引擎里跑；`sdk.*` 调用变成
  "Rust 发事件 `jsvm://host-call` → 前端执行真正的工具 → `jsvm_host_reply` → Rust 阻塞拿到结果"。
  因为是**阻塞**，guest 看到的是同步函数，`await` 照样能用，而且**没有次数上限**
  （对比 WebView 侧那个"最多 1 次"的临时守卫，已经删掉）。
- **闸门仍然只有一份**：危险命令分析、受保护路径、覆盖确认、沙箱路径判定都在 TS 侧
  （`hostMethodsFromToolSdk` 把 SDK 的**同一个实现**交给执行器），Rust 不做任何权限判断。
- **隔离变强**：guest 里没有 `process` / `window` / `require` / `__TAURI__`（Rust 测试里也钉了）。
- **失控兜底**：boa 的**循环迭代上限**（确定性，不依赖墙钟）—— `while(true){}` 会被中断并给出可读原因。
- **前端测试的形态变了**：vitest 里没有 Tauri 运行时，所以闸门类判据改为注入
  `src/test/helpers/script-runner-double.ts`（用 Node 的 `new Function` **忠实执行 guest 代码**、
  但把**真实的** sdk 调起来）。三层分工写在那个文件头：vitest 钉闸门、Rust 钉引擎、真机钉端到端。
- 顺带修掉两处"隐藏的 eval"与一处误判：
  · `code-runtime-worker-thread-provider.ts` 原来把 `new Function` 藏在 **worker 脚本字符串**里
    （源码扫描看不见），现已改走 Rust 沙箱（`methods: []`，比原来的白名单 require 更严）；
    ⚠️ 它**不是死代码** —— `plugin-loader/builtin-registry.ts` 注册着它，删掉会让 `npm run build` 失败
    （这次就是被 build 拦下来的，教训写进了对应判据）；
  · 门禁 `audit:no-eval` 原来只跳过 `*.test.ts`，于是 `src/test/helpers/*` 里的**测试替身**被误报；
    现在按**目录**跳过（测试与测试替身不受 CSP 约束，生产代码才受）。

**真机验证**（`.preview-shot/_probe-run-code-real.mjs`，装好的 1.16.231）：

| 用例 | 结果 |
|---|---|
| `run_code` 里**连续 3 次** `sdk.bash` | ✅ `[Result]: ["first","second","third"]`（这正是 WebView 侧 0/5 的形状） |
| `workflow {code:"return 6 * 7;"}` | ✅ `[Result]: 42` |
| 两处是否还有 CSP 违规 | ✅ 没有 |

**状态**：`run_code` / `workflow` / 函数型 hooks 在真机上**已可用**（发版 1.16.231）；
`npm run audit:no-eval` 只剩 **1 处**待迁移（动态插件）。

### 16.6 第 105 波：动态插件（最后一处）已迁完 —— **允许清单清空** ✅

插件比前几处深，因为它要两件单发执行做不到的事，所以新加了**会话形态**
（`src-tauri/src/js_sandbox_session.rs`，会话 = 专属线程 + 持久 `Context` + handle 表）：

1. **环境持久**：`define` 时加载插件代码，`run` 时再调它的实例（`Context` 必须活着）；
2. **宿主回调 guest 函数**：`ctx.provide('svc', { hello: () => … })` 交出去的函数，
   宿主建**服务代理**后调用它会回到 guest 里执行（`js_sandbox_call_function`）。
   命令通道（`mpsc`）让"宿主 → guest"与"guest → 宿主"互不嵌套，避免重入。

配套：服务**真的注册进 Cordis**（`retract` 注销，不留悬空服务）；沙箱里没有
`process` / `require` / `window` / `__TAURI__`；不支持的 ctx 面（`get` / `on`）抛**可读**说明；
插件死循环由 **Rust 循环迭代上限**中断（加载期 + 调用期都钉）。

**真机探针抓到一个真缺陷**（单元判据没覆盖到的那一层）：

> `cordis_undefine` 报 `Failed to undefine plugin: undefined` —— 而插件其实**已经注销了**。
> 原因：`runner.retract()` 这一波变成 async（要先关会话），工具里写的是
> `const result = runner.retract(...)`（**漏 await**）⇒ `result.success` 是 `undefined` ⇒ 成功被报成失败。
> 两条工具补上 `await`，并新增判据 `plugin-tool-wiring.test.ts` 钉"工具与 runner 的调用姿势"
> （把 `await` 去掉 ⇒ 判据立刻红，变异自证已做）。

> 另一个"探针自身的坑"也记在这里：应用会复用**当前选中的会话**，所以反复跑探针会把消息
> 追加进同一个会话 —— 模型一旦绕进弯路（那次它把工具调用写成了 `bash echo`），
> 之后每一跑都继承那段上下文，看起来像"产品坏了"。探针现在**先点"新对话"**再发。

### 16.7 目标达成情况（里程碑收口）

| 依赖 eval 的部位 | 现在跑在哪 | 真机验证 |
|---|---|---|
| `run_code` + `workflow` | Rust 侧 boa（单发） | ✅ 3 次工具调用 + `return 6*7`（§16.5） |
| 函数型 hooks | `js-vm.ts` 同步路径（QuickJS/WASM） | ✅ `hook-function-vm.test.ts` + 无挂起形状 |
| `code-runtime-worker-thread` | Rust 沙箱（`methods: []`） | ✅ 与 run_code 同一条命令 |
| 动态插件 `cordis_*` | Rust 侧 boa（**会话**） | ✅ define/run/inspect/undefine（§16.6） |

`npm run audit:no-eval`：**命中 0 处、允许清单为空** ⇒ 这条目标是"回退检测"，
新增一处即红（CSP 保持不含 `unsafe-eval`）。

**下一阶段**（回到最终目标）：用 §13 的 12 任务口径测 **Codem vs DSH** 的编码能力，
先把隔离对等方案定下来（§13.7 的三个选项），再跑任务集。

### 16.8 本轮改动的判据总览（三层分工，全绿）

```
js-vm-no-eval.test.ts            12 ✓   （含 JSVM-2/10 的"桩掉 Function/eval 仍能跑"、JSVM-11 的守卫）
hook-function-vm.test.ts          5 ✓   （钩子迁移 + 隔离 + 超时 fail-closed）
hooks-system.test.ts             18 ✓
hook-fail-closed.test.ts         12 ✓
pi-p2-run-code-permission-parity 11 ✓   （闸门语义一字未改）
workflow-permission-parity       10 ✓
deep-closed-loop-audit           38 ✓   （旧的"源码里要有 new Function"判据已改写）
```


### 15.1 §3.6：**保持现状**，内层闸门由已有判据钉住

决定（用户 2026-10-03）：**外层 `run_code` / `workflow` 在「替我审批」模式下继续自动放行**；
理由是"替我审批"的本意就是不打断，而危险命令的闸门**本来就在嵌套调用那一层**。
这个决定不需要改代码 —— 需要的是**确认那条闸门真有判据**，查证结果：

| 判据 | 它钉住什么 |
|---|---|
| `workflow-permission-parity.test.ts` WF-1 | workflow 内的危险 bash → `executeCommand` **一次都没被调用**，输出点名命中的模式；反例：只读命令仍真的执行；fail-closed：分析器抛错也不执行；**同一道闸门也装在 `execWorkflow` 上**（provider 路径不能漏） |
| 同上 WF-2 / WF-3 | 写入走受保护路径 + 覆盖确认（reject ⇒ 一个字节都不写；accept ⇒ 真写盘）；契约声明与能力一致 |
| `pi-p2-run-code-permission-parity.test.ts` P2-1 / P2-2 | `run_code` 侧同上（含 `execRunCode` 路径与"分析器抛错也不执行"） |

⇒ **§3.6 关闭**：决定记录在案，闸门有判据、判据有反向对照与 fail-closed。
（决策本身不是"改行为"，所以**不需要发版**；这里只补了记录。）

### 15.2 `run_code` 的 CSP 问题：用户选择"改成不经 eval 的实现"—— 但这**不只是一个工具**

用户 2026-10-03 选择：**改成不经 `eval` 的实现**（而不是放开 CSP）。
查证时发现范围比问题描述大得多 —— `new Function` 在**五个**功能里：

| 用 `new Function` 的地方 | 真机现状 |
|---|---|
| `src/core/llm/tools/run-code.ts` | ❌ CSP 违规（第 99 波探针实测） |
| `src/core/llm/workflow-engine.ts` | ❌ CSP 违规（第 101 波探针：`workflow {code:"return 1 + 1;"}` → `Evaluating a string as JavaScript violates … 'unsafe-eval' is not an allowed source of script`） |
| `src/core/llm/dynamic-plugin-tools.ts`（Cordis 动态插件） | ❓ 代码同源（`new Function()` 编译），**未单独探针** |
| `src/core/hooks/hook-manager.ts` | ❓ 同上 |
| `src/core/provider/dynamic-runner-provider.ts` / `code-runtime-worker-thread-provider.ts` | ❓ 同上 |

而 CSP（`tauri.conf.json`）刻意没有 `unsafe-eval`（`phase-b-f-regression.test.ts` 还专门断言
它**含** `wasm-unsafe-eval`），所以这**是一整个功能族在真机上不可用**，不是"一个工具坏了"。
**这也解释了为什么既有判据全绿**：WF-1/P2-1 那些用例跑在 vitest（Node/jsdom，没有 CSP）里 ——
又一次"判据长在一条生产里不执行的链路上"（§5.2 第 1 条）。

**实现路线（按代价从低到高，附已知风险）**：

| 路线 | 做法 | 代价 / 风险 |
|---|---|---|
| **E. 专用页面 + 该页自己的 CSP**（建议先做可行性验证） | 起一个只用来跑脚本的页面/窗口，让它**不继承**这条 CSP（拿到 `unsafe-eval`），应用内用 postMessage 把 `sdk` 桥过去 | ⚠️ **机制未验证**：`tauri.conf.json` 现在的 `csp` 是**一个字符串**；Tauri 的 map 形式是"**指令 → 来源**"（不是"路径 → 策略"），所以"按路径给不同 CSP"**很可能不存在**。可行的替代是"让那个页面**不被注入** CSP"（`dangerousDisableAssetCspModification` 或独立窗口），**必须先真机验一次** |
| A. Rust 侧 JS 引擎（`boa_engine`，纯 Rust） | 脚本在 Rust 里跑，`sdk` 做成宿主函数回调 | 编译时间与体积增长；JS 特性覆盖有限；`workflow` 的 `spawn/wait` 是异步语义，需要自己做事件循环（**难点在这**） |
| B. Node 子进程 + stdio JSON-RPC 桥 | 复用现成的进程管理 | **要求用户机器上有 Node**（不能假设）；多一个进程要管 |
| C. 改为受限 DSL（不跑任意 JS） | 最安全 | 功能缩水，属于产品改型 |

**已知的第一个坑（不管走哪条路）**：`workflow` 的 `sdk.spawn/wait` 是**异步**的，
而 `run_code` 只要**同步**的 `sdk` 子集 —— 所以合理的**第一步是 `run_code` 单点打通**
（它不需要事件循环），把 `workflow`/插件/hooks 留到第二步，并且**在那之前让它们失败得诚实**
（现在抛的是一句 CSP 违规的英文，用户与模型都不知道该怎么办）。

**下一步（第 102 波）**：先做 E 的可行性验证（读 `tauri.conf.json` 的 CSP 结构 + 在装好的应用里
试一个带 `unsafe-eval` 的独立页面），验不过就按 A 做 `run_code` 的最小切片
（`boa_engine` + 同步 `sdk` 子集 + 超时/步数上限），两件事都要**先写判据再改实现**。









