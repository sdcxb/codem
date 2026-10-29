# 16 · MCode Stack 外部审计与借鉴（P0/P1/P2 一次落地）

> 基线：2026-10-29 ｜ 版本 **1.16.331** ｜ 审计对象：[MiniMax-AI/mcode-stack](https://github.com/MiniMax-AI/mcode-stack)（MIT；6 个 `engineering-*` 为 CC-BY 3.0 改编）
> 读法：先看 §1 结论，再看 §2–§4 的三张表（这是 P0 的产出），§5 是这一轮真正改了的东西，§6 是**仍然不知道**的事。

---

## 1. 结论

**它不是一个可以「移植」的实现，而是一套外部审计口径 + 方法学 + 分发形态。**

- 全仓 85 个文件：17 个 `SKILL.md`、5 篇工程笔记、每个 stack 一个 `plugin.json` / `WORKFLOW.md`、一个 `check.mjs` 校验器、一个 GitHub Action。**没有 harness 代码**；它在 note 04 里指向的实现（`minimax-code` 的 `packages/local-runtime/src/background-task/`）并没有开源进这个仓库。
- 所以对 Codem 的价值只在三处：**① 用外部清单验收我们已经建好但没验的机制；② 少数我们确实没有的结构（后台任务闭环）；③ 两个产品形态点（干净上下文评审、复盘报告）。**
- 反过来说：**它讲的机制我们几乎都有，而且多数更细。** 评测方法学（flipped tasks / 假绿检测 / 反作弊 / 变异）我们已经超过它；长会话压缩、记忆分域、前缀缓存边界也比它描述得完整。

一句话：**值得花半天体检，值得修一个真缺口，不值得照搬技能内容或重构多智能体。**

---

## 2. 长命令 10 条（`long-command-check`）

| # | 项 | 结论 | 证据 / 说明 |
| ---: | --- | --- | --- |
| 1 | 前台等待上限 | **通过** | `bash` 默认 30s、上限 600s（[tools.ts:1035](src/core/llm/tools.ts#L1035)、[tools.ts:1151](src/core/llm/tools.ts#L1151)），远低于供应商缓存寿命 |
| 2 | 前台→后台不重跑 | **不适用** | 我们没有「迁移」这条路：`bash` 没有 `run_in_background`；`terminal_send` 的前台/后台是两次独立调用，后台仍是同一个 PTY 进程（[terminal-tools.ts:349](src/core/llm/tools/terminal-tools.ts#L349)） |
| 3 | 超时账 | **通过** | 后台等待由 `SEND_MAX_WAIT_MS = 8s` 封顶，读输出不重置截止（[terminal-tools.ts:31](src/core/llm/tools/terminal-tools.ts#L31)） |
| 4 | 结果怎么送达 | **原失败 → 本轮修** | 原来只能轮询 `job_output`；现在完成即登记、下一回合出现在尾部（[background-job-notices.ts](src/core/llm/background-job-notices.ts)） |
| 5 | 通知放在哪 | **本轮通过** | 走 `trailingTurnContext`（尾部 user 消息），不碰 system 前缀（[agentic-loop.ts:2538](src/core/llm/agentic-loop.ts#L2538)） |
| 6 | 反轮询 | **未做** | `job_output` 连续读到同样内容没有提示；`job_list` 没有阻塞上限 |
| 7 | 输出大小 | **部分** | `job_output` 返回整段 stdout（本身无上限），靠工具结果预算（单条 >8192 折叠、合计 >200k 落盘）兜底 |
| 8 | 清理 | **未做** | 用户停止 / 退出 / 重启时不清后台 job；现有纪律是「只按 PID 杀自己 spawn 的进程」，但没有机制 |
| 9 | 压缩后仍能找到未读结果 | **本轮通过** | 未读表在**会话之外**，只有 `job_output` 才销账；压缩只动消息，动不到这张表 |
| 10 | 前置条件 | **未做** | 环境读不到后台结果时仍允许后台化（PTY 不可用会报错，但没有前置禁用） |

> 第 6/8/10 条是这一轮**明确不修**的：分别需要「无变化检测」「跨进程任务表」「能力探测」，都属于 `09-CURRENT-STATE.md` §5.5 那类要新授权的结构项，不在本次借鉴范围。

---

## 3. 长会话 12 条（`long-session-check` Mode B）

| # | 项 | 结论 | 证据 / 说明 |
| ---: | --- | --- | --- |
| 1 | 先清旧工具结果、再整体摘要 | **通过** | 折叠先于压缩，折叠只改发给模型的形态（[03-RUNTIME-FLOWS.md](docs/project-guide/03-RUNTIME-FLOWS.md) §7.2） |
| 2 | 清结果时保持「调用—结果」成对 | **未知** | 折叠按条处理；没有一条判据证明「只清结果、留下孤立的调用」不会发生 |
| 3 | 关键决定写进文件 | **部分** | 交接（`ui-handoff.ts`）会把产物路径与结论落成正文；但「决定」不强制落文件 |
| 4 | 手动压缩接受「保留什么」的指令 | **未知** | 现有手动压缩只有固定保留策略（最近 3 轮 / 20 条），没有「这次重点关注 auth，别管测试调试」这类参数 |
| 5 | 自动压缩留出余量、失败可继续 | **判据通过 / 真机未验** | 阈值 70%、保留 40%；摘要失败保留已累积摘要（[09 §5.1](docs/project-guide/09-CURRENT-STATE.md#L92-L97) 仍是「未验」） |
| 6 | 压缩请求能命中缓存、且不频繁 | **未知** | 没有量过压缩请求的 cache hit；有「连续压缩最多 3 次」的限制 |
| 7 | 压缩只改模型视图、用户历史不动 | **通过** | 折叠/隐藏不改历史原文；摘要标记是追加的 |
| 8 | 告诉模型「上下文自动管理」 | **通过** | 系统提示有整段说明（[i18n-templates.ts:211](src/core/prompt/i18n-templates.ts#L211)） |
| 9 | 项目记忆短、只放稳定规则 | **部分** | 产品层有预算；但本仓库自己的 `AGENTS.md` 就是反例（很长，混了规程与状态） |
| 10 | 记忆分域 | **通过** | 平台级 / 项目级 / 对话级三层（[03 §8](docs/project-guide/03-RUNTIME-FLOWS.md)） |
| 11 | 超预算截断可见、重要规则必载 | **未知** | 没有「截断了哪几条」的界面读数 |
| 12 | 人能打开/编辑/关闭记忆 | **通过** | 记忆面板（待批准 / 作用域 / 批量操作） |

---

## 4. 上下文税 10 条（`context-tax-audit`）+ 实测账本

| # | 项 | 结论 | 证据 / 说明 |
| ---: | --- | --- | --- |
| 1 | 能列出一次请求里除用户那句话之外的全部内容与大小 | **本轮通过** | 新增 [context-tax-budget.test.ts](src/test/context-tax-budget.test.ts)：工具定义、延迟工具、技能清单三类固定成本可复跑 |
| 2 | 每一部分「删了会怎样」 | **部分** | 系统提示各段有存在理由（[prompt.ts](src/core/prompt/prompt.ts) 顶部），但没有逐段的「删掉会错在哪」 |
| 3 | 频次（每轮都要吗） | **部分** | 技能清单与 deferred 提示每轮都注入；它们稳定（利好缓存），但仍是固定成本 |
| 4 | 精度（需要秒吗） | **通过** | 日期到分钟；时间上下文 10 分钟节流（[time-context](src/core/llm/time-context.ts)） |
| 5 | 位置（易变内容不许进前缀） | **通过** | 稳定前缀 + 哨兵 + 易变尾部；判据 `MEM-PLACE-25` / `dsh-d5-prefix-cache-stability` |
| 6 | 不重写历史里的提醒 | **通过** | 提醒只影响未来轮次 |
| 7 | 请求级提醒的频次 | **部分** | 有一次性/每回合一次/每轮一次三档；但没有统一的频次预算 |
| 8 | 移除后会不会在压缩/恢复/子代理里彻底消失 | **未知** | 技能提示有「压缩后重注入」，记忆有固定槽位；其余段落没有逐项确认 |
| 9 | 模式一致性（提示/工具集能否中途变） | **设计上会变** | plan 模式隐藏写工具、无附件隐藏 `read_attachment` —— 这是有意为之，代价是那次请求的前缀失效 |
| 10 | 改动前后看缓存命中率/成本/质量，而不是只看 token | **通过** | 每请求 `cacheHitTokens` + 前缀指纹；本轮又加了字符棘轮 |

**实测读数（2026-10-29，`context-tax-budget.test.ts` 直接打印）：**

| 项 | 读数 | 预算 |
| --- | ---: | ---: |
| 静态常驻工具（`createDefaultToolRegistry`） | **40 个 / 27,545 字符** | 31,000（棘轮） |
| 其中最大的三个 | `project_report` 2,489 ／ `run_code` 2,370 ／ `glob` 1,262 | — |
| 运行时动态工具（委派/团队/Issue/computer-use） | **39 个 / 16,622 字符** | 19,000（棘轮） |
| 　subagent | 4 ／ 1,889 | — |
| 　跨会话委派 | 7 ／ 3,665 | — |
| 　squad（模板层） | 3 ／ 1,735 | — |
| 　agent-teams（运行时团队） | 10 ／ 3,386 | — |
| 　Issue | 4 ／ 2,721 | — |
| 　computer-use | 11 ／ 3,226 | — |
| **静态 + 动态合计** | **79 个 / 44,167 字符** | 48,000（棘轮） |
| 延迟加载工具 | 7 个（完整 schema 不在常驻集） | ≥1 |
| 注册技能 | **12 个 / description 合计 2,444 字符** | 3,000（棘轮） |
| 最长技能描述 | 376 字符 | 1,024（硬上限） |

> 口径修正（本轮发现）：上一版只量了静态 40 个，**漏掉运行时动态注册的 39 个**，把工具定义成本低估了约 38%。
> MCP 服务器带来的工具无法静态计入（取决于用户装了什么），所以 44,167 是**下限**。

> 口径说明：数的是**字符**不是 token。仓库里没有稳定的分词器，编一个换算系数只会制造假精度；字符数的用途是**相对棘轮**（这次比上次长还是短）。真实 token 以 provider 的 `usage` 为准。
>
> 一个值得下一轮讨论的候选：`project_report`（2,489 字符）是最大的常驻工具，但它只服务项目工作台。要不要像 PPT/浏览器那样放进 `DEFERRED_BIG_TOOLS`，是**产品取舍**（省每人每轮约 600 token，代价是项目模式下多一次 `tool_search`），本轮不动。

---

## 5. 这一轮真正落地的东西

| 项 | 改了什么 | 判据 | 变异自证 |
| --- | --- | --- | --- |
| **P1-3 后台任务闭环** | 新增未读登记表（会话之外）；`terminal_send` 完成即登记；`job_output` 才销账；`AgenticLoop` 按回合把它注入**尾部** | [background-job-notices.test.ts](src/test/background-job-notices.test.ts)（9 条：会话隔离 / 同回合只播一次 / 跨回合重现 / 长输出不贴正文 / 播报上限 / 不进前缀） | 去掉注入 ⇒ BJN-5 红；`markRead` 空转 ⇒ BJN-4 红 |
| **P0-2 上下文税账本** | 工具定义、延迟工具、技能清单三类固定成本变成可复跑读数 + 棘轮 | [context-tax-budget.test.ts](src/test/context-tax-budget.test.ts)（5 条） | 把 `clampSkillDescription` 改成原样返回 ⇒ 红 |
| **P1-6 技能描述预算** | 提示侧把 description 裁到 1024 字（每技能只记一次日志），并给出纯函数 `clampSkillDescription` | 同上第 5 条 | 同上 |
| **P1-4 独立评审技能** | 新增内置技能 `independent-review`：只喂 diff / 需求 / 真实测试结果，评审在 `subagent` 的干净上下文里跑，findings 结构化、复核后再改 | 注册表随 `context-tax` 与 `skill-trigger-mechanism` 一起被钉 | 不适用（内容型），但技能描述进预算 |
| **P1-5 交接模板补两段** | `HANDOVER_TEMPLATE` 增加「已排除的方案」「已知坑 / 易抖动用例」（**可选**，不参与机械校验） | [handover-protocol.test.ts](src/test/handover-protocol.test.ts) HANDOVER-6 扩展 | 删掉任一段 ⇒ 红 |
| **P2-7 技能包校验器** | 新增 `tools/audit/check-skill-packs.mjs`：frontmatter / name==目录 / description ≤1024 / BOM / 软预算告警；接入 `npm run audit` | [skill-packs-validate.test.ts](src/test/skill-packs-validate.test.ts)（真实目录 + 5 类坏夹具） | 关掉长度检查 ⇒ 夹具红 |
| **P2-8 复盘只读报告** | 新增 `tools/audit/retro-interventions.mjs`：从本地会话史识别六类人工介入（retry/judge/approve/carry/trigger/stand-in），只读、脱路径、不给结论 | [retro-interventions.test.ts](src/test/retro-interventions.test.ts)（7 条） | 去掉「非人消息」过滤 ⇒ RETRO-2 红 |

命令：

```powershell
npm run audit:skill-packs          # 技能包门禁（已接进 npm run audit）
npm run retro -- --since 2026-10-01   # 只读复盘（默认数据根，可用 --dir/--out/--json）
```

**P1-5 的诚实说明**：Codem 的交接早就比 mcode-stack 的 `handoff-doc` 强 —— 正文是**代码机械生成**的（[ui-handoff.ts](src/core/session/ui-handoff.ts)），带「产物路径经存在性核对」「完成判据必须可判定」「禁止重扫」。它唯一多出来的两段是「已排除的方案」和「已知坑」，这一轮补进了模板；**不需要**照它重写交接机制。

**P2-7 的边界（只做了校验器，没做「stack 包」）**：mcode-stack 的 stack 是「一个 `plugin.json` + 若干技能 + 一份 `WORKFLOW.md` + 版本号 + 市场条目」的分发单位。这一轮只落了其中**不需要产品决策**的那一半 —— 仓库自带技能的结构/预算校验（`check-skill-packs`）。**没有**做 bundle 格式、市场清单、版本递增门禁，原因是：

- 我们的技能分发是「单技能安装 + DSH 插件市场」两条路，引入第三层「包」要先回答**谁拥有版本号、更新怎么传播、禁用/卸载的粒度是什么** —— 这是产品取舍，不是实现细节；
- 它真正的价值在「改了文件必须升版本，否则装了的人永远收不到更新」。这条约束只有在**存在远程市场**时才有意义；当前仓库没有需要版本递增的已发布技能。
- 如果以后要做，最小切口是：`plugin.json` 式清单 + 复用本轮校验器 + 在 `skill-market-client` 的安装路径上比对版本号。**先问用户**。

---

## 6. 五项未验的分析结论（2026-10-29）

> 这一节把上一版列成「未知」的五项逐条查完。**结论分三档**：通过（有判据/结构保证）、部分（机制在但缺读数）、仍未验（需要真机或专项判据）。多智能体那一条已独立成 [17-MULTI-AGENT-INVENTORY.md](docs/project-guide/17-MULTI-AGENT-INVENTORY.md)。

### 6.1 自动压缩：机制 + 触发 + **真机**都已验

- `doCompactMessages` 被多个测试**直接调用**（30 条 → 保留 20、滚动摘要、失败保留累积摘要等）；
  `HEADROOM-1..3` 只断言常量与 `>=` 比较（[compaction-headroom.test.ts](src/test/compaction-headroom.test.ts)）。
- 没有任何用例从 `run()` 把水位真的推过 70% 再观察 `compaction_start/end` ——
  这两个事件目前只被「类型可构造」断言过（`regression-p0-p4-full` / `regression-coding-cross-impact`）。
- 所以 `09` §5.1 那句仍然成立：**真机完整验证未完成**；而且现在可以说得更准：缺的不是压缩算法，
  是「**压力 → 自动触发**这条链的端到端证据」+「打包应用里的横幅/重载」。
- **已补（2026-10-29）**：[auto-compaction-trigger.test.ts](src/test/auto-compaction-trigger.test.ts) 用假存储端口预置 60 条消息 +
  24k 窗口，从 `run()` 真的跑出压缩：断言 `compaction_start/end`、`messagesRemoved > 0`、摘要 `complete()` 被调用、
  历史里出现压缩标记、压缩后的请求更小。变异（禁用触发条件）⇒ 红。
- **真机（2026-10-29，打包 exe + 隔离数据副本）**：用一条 **256 条消息的真实会话**（`对话 5`，约 17.8 万 token），
  只改副本里的模型窗口（deepseek-flash → 200k）让水位越线。发送一条普通消息后：
  - 横幅出现「**正在压缩上下文...**」（截图 `real-compact-banner.png`），`[AgenticLoop] Model-aware context window: deepseek-flash = 200000 tokens`；
  - 压缩完成后该会话 **visible 23 / hidden 239 / 压缩标记 1**，会话事件里 `compaction` 一条；
  - **刷新页面后**标记仍在（滚到顶可见），可见集仍是 23 —— 压缩状态是持久化事实，不是内存态。
  - 说明：窗口是**只在副本里改的测试夹具**（真实用户仍用 1M 窗口），目的是让"压力→触发"这条链在真机上必然发生。

### 6.2 压缩请求的缓存命中：**不命中**（结构决定，不是没量）

- 压缩请求的 system 只有一句「你是一个对话摘要专家。」（[agentic-loop.ts:6640](src/core/llm/agentic-loop.ts#L6640)），
  与主会话的 system 前缀不同 ⇒ 服务端前缀缓存**不可能**命中主会话那一大段。
- 源码里 189 波已经把「replay 主系统提示、复用 KV 缓存」这句错误注释删掉，并写明「与实现不符」。
- 另一半问题「压缩会不会频繁击穿缓存」：每次压缩都会重写历史（摘要标记替换旧消息）⇒
  下一次主请求前缀**必然失效一次**；频率受 70% 阈值 + 连续最多 3 次约束，正常会话一天 0–2 次。
- **已补用法（2026-10-29）**：压缩调用打一行 `[compact] usage prompt=… completion=… cacheHit=… miss=… model=… convChars=…`；
  provider 没上报的字段打 `?`（不编 0）。
- **真机读数（同一次压缩）**：
  - 第一块摘要：`prompt=59466 cacheHit=0` —— **与主会话前缀零命中**，结构性结论成立；
  - 多块合计：压缩记录 `inputTokens=132605 cacheReadTokens=59264`（约 45%）——
    后续块会命中"**上一块累积摘要**"这段共享前缀，但**从不命中主会话那一段**；
  - 记账：压缩单独一条 `cost_records`（`duration=0`、`toolCalls=0`），主回合那条的 `inputTokens=97086` 不含压缩 ——
    "成本可见、口径不混"在真机上成立。
- **仍然没做**：把压缩 usage 并进 `totalUsage`（会改变评测口径），现在它是**独立成本记录**。

### 6.3 折叠是否保持调用/结果成对：**是**，而且有两层结构保证

1. **折叠层**只改 `toolCalls[].result` / `args` 的文本，不删消息、不删调用
   （[tool-output-fold.ts](src/core/llm/tool-output-fold.ts) 的 `{ ...m, toolCalls: calls }`）。
2. **请求构建层**的配对清理已抽成唯一实现 + 纯函数：[tool-pairing.ts](src/core/llm/tool-pairing.ts)
   （隔离孤儿 `tool`、剥掉无结果/部分结果的 `tool_calls`；注释点名 DeepSeek/OpenAI 的严格配对要求）。
3. 判据：[tool-pairing.test.ts](src/test/tool-pairing.test.ts) 7 条（**折叠不拆对** + 三种非法形状 + 消息数/调用数/结果都在），
   变异：把「最近 2 条结果保护」改成 0 ⇒ 红。
- **顺带修掉一个真缺陷**：折叠模块的 `protectedFromIndex` / `protectedFromIndexForTurns` 是**死参数**
  （声明了、一路传进来、从没被读过），而文档却承诺「最近 3 轮不折」。那条承诺本身与折叠存在的前提冲突
  （长回合正是水位爆掉的场景，按轮次保护会让折叠失效）。现在删掉死参数，文档改成真实语义：
  **只保护最近 2 条结果**，更早的（哪怕同一轮）都可折。

### 6.4 记忆截断可见性：**可见**（推翻上一版的「未知」）

- 注入侧：`computeInjection` 计数，`renderBlocks` 追加「还有 N 条可见记忆**未注入**（每作用域每来源最多 20 条、
  总预算 … 字符）。**这不是它们被删除**，只是没进上下文」——[memory.ts:3623](src/core/memory/memory.ts#L3623)。
- 界面/体检：`injectionPlan` / `explain` 逐条给出「为什么没进上下文」，检查面板显示 `truncatedCount`。
- 写入侧：超长截断走 `lastWriteError` 回执 + 批量路径的 `truncated[]`（不是静默截断）。
- 结论：这一条**从「未知」改成「通过」**，没有新的工作要做。

### 6.5 残余未知（本轮没解决）

1. **`tool_search` 的召回**：没在自己的工具集上测过「换个说法还能不能找到 lsp / workflow」。
2. **其他用户的多智能体使用分布**：本地 693 个会话的样本有偏差（见 17 号文档 §2 的说明）。
3. **路由转化的统计口径**：现在每类场景只跑了 1–2 次真机（见 17 号 §5），不是统计量；要结论得跑批次。

---

## 7. 不借鉴的部分（写明理由，避免下一轮重复评估）

| 内容 | 为什么不借 |
| --- | --- |
| `making-content`（小红书图文 / 竖屏短视频） | 域外；与本产品的能力面无关 |
| 6 个 `engineering-*`（Google Engineering Practices 改编） | 通用 PR 礼仪与评审措辞；我们的门禁（判据/变异/审计链）比它严，抄进来只增加维护面 |
| MiniMax 的插件包格式（`.minimax-plugin/` + marketplace.json） | 我们已有 skills + DSH 插件市场；格式本身没有可迁移价值 |
| `notes/` 里的 X 链接与文章结构 | 宣传面内容，不是工程输入 |
| 「多上 subagent」的倾向 | 我们已经有 5 套多智能体机制；该做的是用它的清单**合并**，不是继续加 |

**许可证提醒**：主体 MIT；6 个 `engineering-*` 是 CC-BY 3.0 改编（需要署名）。本轮**没有复制它的任何文本**，只借用了清单的「问题」——问题的措辞已按我们的代码重写。

---

## 8. 维护

- 这张表是**一次快照**（2026-10-29）。改动主链路（工具/压缩/记忆/后台任务）时，顺手更新对应行的结论；新增读数时同步 §4 的预算。
- 判据入口：`npx vitest run src/test/context-tax-budget.test.ts src/test/background-job-notices.test.ts src/test/skill-packs-validate.test.ts src/test/retro-interventions.test.ts`。
- 下一轮如果要做 §6 里的第 1/3/5 条，都属于「补读数」而不是「加机制」，应当先写判据再动代码。
