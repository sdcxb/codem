# 系统优化计划（2026-10-18）—— 追加可见性 / 追加附件 / 窄容器自适应 / 流式滚动

> 触发：用户在真机上报了两个缺陷（运行中追加的消息看不见；追加的图片模型没看到），
> 外加一次对标分析（`github.com/Caho1/open-claude-ui`）得出的可借鉴项。
> 本文件是**执行清单**：先写判据 → 改实现 → 变异自证 → 真机 → 全量审计（有任何红，无论新旧，当场修到 0）。

## 0. 范围

### 本轮执行（P0/P1，必须全部完成）

| 编号 | 事项 | 类型 |
|---|---|---|
| A | 运行中追加的消息**必须可见**（入队即可见 · 注入后进会话历史 · 刷新仍在） | 缺陷 |
| B | 运行中追加的**附件**（图片/文件）必须送到模型且界面可见；不支持的类型不得静默丢弃 | 缺陷 |
| C | 工具卡 / 设置行的**窄容器自适应**（`@container` 四阶），消灭"挤成竖排/溢出" | 对标借鉴 |
| D | 流式期间的**滚动图钉**：150ms 用户输入冷却 + 40px 容差 + `behavior:auto` + 忽略自身滚动 | 对标借鉴 |

### 第二批（2026-10-18 09:35 已完成）

边缘 7 档渐隐、Diff 分屏/统一、图片预览 View Transitions、组件目录 + 文档 token 对账、
roving focus 统一、WebAudio 合成提示音、动效令牌棘轮 —— 七项全部落地，判据
`EDGEFADE/DIFFVIEW/VIEWTRANS/UIDOC/ROVING/SOUND/MOTION`，变异波次 `ui-craft-p2`（8 条全红），
真机取证 `docs/evidence/ui-craft-p2-2026-10-18/`。

## 1. 缺陷 A：运行中追加的消息看不见

### 现象
对话执行中给 agent 追加一句话 → 点"立刻注入" → 界面**什么都不剩**：既不进对话流，也没有回执；
刷新后更是彻底消失，用户无法判断是否成功。

### 根因（已核对的代码事实）
| 环节 | 现状 |
|---|---|
| `GuidanceQueue`（`src/core/llm/guidance-queue.ts:27`） | item 只有 `id/message/timestamp`；**只活在内存**，注释明写 "NOT persisted" |
| 消费点（`src/core/llm/agentic-loop.ts:2646`） | 把 guidance 拼成一条**临时** user 消息塞进本轮请求；**不落库、不建索引** |
| 事件（同处 `:2658`） | 只发 `guidance_received` ⇒ 前端把状态栏气泡**删掉** |
| 前端（`src/App.tsx:3487`） | "立刻注入"分支先 `removeGuidanceMessage(existingGuidanceId)` 再中断 ⇒ 唯一的可见物被删 |
| 唯一展示点（`src/components/ChatPanel.tsx:1475`） | 引导栏只在 `isSessionStreaming` 时渲染 ⇒ 回合结束后必然消失 |

⇒ 三个"看不见"叠在一起：注入前只有状态栏气泡、注入时气泡被删、注入后没有任何持久记录。

### 方案（复用已有先例，不新造概念）
`run()` 开头**遗留引导**那条路径（`agentic-loop.ts:1974`）已经把残留消息**落库成真实 user 消息**。
把同一套做法搬到"被正常消费"这条路径：

1. `GuidanceItem` 加 `attachments?: MessageAttachment[]`（见缺陷 B）。
2. 消费时：`createMessage({ id: "guidance-<item.id>", role: "user", content: 附件内联块 + GUIDANCE_MESSAGE_TEMPLATE(message), attachments, metadata: { midTurnGuidance: true, guidanceRaw: message }, ... })`；
   `this.msgCache = null`（与 carryover 同源）；**不再**注入临时消息，改为 `messagesForIteration = await this.buildMessages(sessionId)` —— 保证与落库内容逐字节一致、不会出现"临时一份 + 历史一份"。
3. `guidance_received` 事件加上 `message`（刚落库的那条）；App 收到后：移除气泡 + `addMessage(message)`（不再二次落库）。
4. 界面：`MessageBubble` 对 `metadata.midTurnGuidance` 渲染「运行中追加」徽标，正文显示 `guidanceRaw`（原始文本），附件照常显示。
5. 回合结束后它已经是普通历史消息 ⇒ **刷新仍在**。

### 上下游影响（改动前逐项确认）
| 可能被牵动的 | 影响 | 处置 |
|---|---|---|
| `buildMessages` / 消息投影 | 多一条 user 消息（模板形态与 carryover 一致） | 消费后重建；`msgCache=null` |
| compaction | 新消息进入历史，压缩会算它 | 与普通 user 消息同权，无需特判 |
| `checkHasDocumentAttachment`（`read_attachment` 工具可见性） | 带文档附件时才会放开 | 期望行为（与普通发送一致） |
| vision proxy（图片） | 图片块来自**落库消息的 attachments**（`storage/message.ts:3991`）⇒ 只要落库就对 | 见缺陷 B |
| memory 提取 | 会看到这条 user 消息 | 模板前缀已明示"运行期指令"，与 carryover 同类 |
| 未读/会话计数 | 由 loop 侧落库，App 侧只 addMessage | 不能走 `deliverOwnedMessage`（会重复落库） |
| 既有判据 | `core-guidance-pause-resume` / `guidance-carryover-not-dropped` 的假设会变 | 读一遍按新语义改（见 §3 判据） |

### 判据（`GUIDE-VIS-*`）
1. 入队后状态栏**立刻**出现带附件的条目；2. 消费后该条目从状态栏消失**且**对话流里出现一条带「运行中追加」徽标的 user 消息；
3. 再调用一次 `getMessages()`（模拟刷新/重开）仍有这条消息；4. 同一条不会出现两次；5. 界面显示的是用户原文，**不是**模板文本。

## 2. 缺陷 B：追加的图片模型看不到

### 根因
`onSendGuidance?: (message: string) => void`（`src/components/InputArea.tsx:76`）—— 引导通道**只有文本参数**，
`pendingAttachments` 在这条路径上既不传给引擎、也不清空；`GuidanceItem` 也没有附件字段。
正常发送走的是另一条路：`formatAttachmentsInline()` + `syncAttachmentsToWorkspace()` + 落库（`App.tsx:3360-3400`），
图片再由 `messagesToLLMMessages` 从**落库附件**转成 image block（`storage/message.ts:4001`）。
⇒ 引导没有落库消息，图片自然永远不会进入请求。

### 方案
1. 打通参数：`InputArea` 把 `pendingAttachments` 传给 `onSendGuidance(message, attachments)`；App 透传给 `engine.sendGuidance(sessionId, message, attachments)`；队列 item 带 `attachments`。
2. 消费落库时：与正常发送同源地拼 `formatAttachmentsInline(attachments)`（附件正文/图片元信息），并把 `attachments` 写进消息；图片经 `messagesToLLMMessages` 自动成为 image block。
3. 界面：引导栏与对话流都渲染附件（名称/图片缩略），入队后**清空输入框附件**（否则用户会以为没发出去而重复发）。
4. 不支持的类型/超大附件：不静默丢 —— 在引导栏与回执里明确说明"这部分没有随引导发送"。

### 上下游影响
| 项 | 影响 | 处置 |
|---|---|---|
| 附件同步到工作区（`syncAttachmentsToWorkspace`） | 引导也可能需要 sandboxPath 供工具读 | 消费时按 cwd 同步一次（与发送一致）；失败不阻塞，内联内容仍在 |
| 附件表 / 清理 | 多一条消息的附件 | `attachments` 表以 message_id 归属，随会话清理 |
| 输入框状态 | 附件被清空 | 明确（并写判据） |
| 失败路径 | 落库失败时不能假装成功 | 回执文案说清"未写入，请重发"（沿用 carryover 的失败口径） |

### 判据（`GUIDE-ATT-*`）
1. 文本 + 图片引导 ⇒ 落库消息含该附件，且 `messagesToLLMMessages` 产出 `image_url` block；
2. 引导栏与对话流都能看到附件；3. 入队后输入框附件被清空；4. 纯文本引导不产生空附件数组/空 `<attachment>` 块。

## 3. 判据与变异（A + B 一起）
- 新增 `src/test/guidance-visible-and-attachments.test.ts`：`GUIDE-VIS-1..5` + `GUIDE-ATT-1..4`。
- 改既有：`guidance-carryover-not-dropped`（现在"被消费"也会落库，carryover 只覆盖"没被消费"）、
  `core-guidance-pause-resume`（队列 item 形状 + 消费后消息）。
- 变异波次 `guidance-persist-attachments`：
  M1 消费时不落库 ⇒ VIS 红；M2 落库但不发 `message` 事件 ⇒ VIS-2 红；M3 只传文本不传附件 ⇒ ATT-1/2 红；
  M4 入队后不清空附件 ⇒ ATT-3 红；M5（反向）只给引导栏加个 CSS 类 ⇒ 必须保持绿。

## 4. 对标借鉴项 C：窄容器自适应（`@container`）

### 为什么排第一（对标结论）
对方把"窄容器"当成一等公民：命名容器 + 4 阶断点（≥576 / <480 / <384 / <320）+ 极端防挤压安全网
（`ContainerResponsiveBar` / 手册 §6.5）。我们 `grep @container` = **0**，而真实事故是同一个类型：
`@` 提及候选被 240px 裁到只剩 9px、设置窗塌成 160px 窄条。

### 本轮落点（只做两个已被真实挤压过的容器，避免大面积改 CSS）
1. **工具卡**（`.tool-card` 系列）：容器宽度 < 420px 时隐藏 args 预览、收紧内边距、标题单行省略；
2. **设置行**（`.setting-group` 在有 `container-type` 的 `.settings-body` 里）：< 480px 时标签与控件**上下堆叠**，
   说明文字折两行不溢出；< 360px 时控件占满整行。

### 判据（`NARROW-*`）
新 fixture `narrow-containers-probe.html`（加载真实 CSS，把工具卡与设置行放进 320/384/480/576/760 的容器里），
用现有 CDP 探针取值：每个宽度下 `scrollWidth <= clientWidth + 1`、关键控件可见、正文不出现"单字换行"。
变异：去掉 `container-type` ⇒ 窄宽度下溢出计数 > 0 ⇒ 红。

## 5. 对标借鉴项 D：流式滚动图钉

### 差距
我们有"底部/近底/已滚开"的分类（`store.scrollPosition`），缺三件：**150ms 用户输入冷却**（刚滚过就别抢）、
流式期用 `behavior:'auto'`（`smooth` 会与流式追加互相拉扯）、**忽略自身滚动**触发的 scroll 事件。

### 方案（纯函数 + 组件接线，便于判据）
新增 `src/core/ui/scroll-pinning.ts`：`decideAutoScroll({ isPinned, distanceFromBottom, msSinceUserInput, streaming })`
→ `{ scroll: boolean, behavior: "auto" | "smooth" }`（阈值 40px / 冷却 150ms；流式一律 auto）。
ChatPanel 在消息增量处调用它；`programmaticScroll` 标记忽略自身事件。

### 判据（`SCROLLPIN-1..4`）
近底 + 无输入 ⇒ 滚（auto/smooth 按流式）；滚开后来消息 ⇒ 不滚；用户刚滚过（<150ms）⇒ 不滚；
距离 ≤40px 视为贴底。变异：去掉冷却 / 改回 smooth。

## 6. 审计与门禁（修到 0 才算完）
1. `npx tsc --noEmit`；
2. 新增/修改判据单跑 → 全量 `npx vitest run`；
3. 非 eval 审计链（knip / report-sites / css-contract / style-literals / reachability / schema-parity /
   command-parity / node-syntax / control-bytes / 证据体量 / check-artifacts）；
4. 变异波次跑一遍（`restored=true`、锚点未过期）；
5. 真机：构建 + 静默安装 + CDP 驱动"执行中追加文本 + 追加图片"，截图取证（`docs/evidence/guidance-append-*`）；
6. **审计中出现的任何红（含既有 flutter/环境类）**：先单跑确认，能修的当场修；不能修的写进交接并说明为什么。

## 7. 需要你拍板（睡觉时不用回，醒了再看）

1. ~~边缘 7 档渐隐 / Diff 分屏 / 图片预览 View Transitions / 组件目录 / roving focus / 合成音效 / 动效令牌棘轮~~
   —— **已于 2026-10-18 09:35 全部完成**（见 §0 第二批）。
2. **`--dump-dom` 类环境问题**已用 CDP 绕过；若你希望彻底摆脱对 Edge 的依赖，可以装 Chrome（需你同意）。
3. **发版**：本轮结束后是否发 1.16.325（含追加可见 + 追加附件），由你决定。
4. **`addCustomProvider` 是否并入 `handleSave`**（历史遗留的产品取舍）。
