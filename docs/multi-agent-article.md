# 最佳实践：从Multi\-Agent到Agent Team 

原创 yan5xu yan5xu 言午 2026年7月31日 09:22 湖北 11人 

在小说阅读器读本章

去阅读

在小说阅读器中沉浸阅读

这是一篇长文，也是一份 Agent Team 的最佳实践。

如果你刚开始使用 Agent，后面有些实践可能会显得过于复杂，比如长期身份、Domain、Agent 之间的协作、跨 Agent 工作的收口、Team 的可观测性，以及对外关系中的身份与权限边界。

你不需要现在就把它们全部掌握。可以先读楔子、01 和 07，理解一个 Agent 为什么会逐渐变成一支 Team。

等你开始同时维护多个 Agent，发现自己不断重复解释背景、搬运 Context、追踪状态，甚至发现“Agent 更多了，人却更忙了”，再回来读 02 到 06，这些问题会立刻变得具体。

这篇文章希望提前给你一张地图：你今天可能还没有遇到这些问题，但当 Agent 从一次性工具变成长期协作者，它们会一个接一个出现。

它来自我长期运行一支真实 Agent Team 的过程。

Agent 怎样从一次性 Task 变成长期责任主体；Scope 过大以后怎样分化；不同 Agent 怎样发现彼此、直接协作并持续收口。

Human 怎样从唯一的 Router 变成整支 Team 的 Owner；以及 Agent 怎样在受治理的边界下进入真实外部关系。

CodexLoom 是承载这套工作方式的产品。这篇文章既介绍它提供了什么，也解释为什么一支 Agent Team 需要这些能力。

它讨论的不是怎样同时启动更多 Agent，而是：

*当 Agent 开始长期存在、形成不同 Domain，并且需要相互协作时，怎样把原本全部集中在 Human 脑子里的责任、关系、交接方式、当前状态和边界，*

*逐渐变成整支 Team 可以使用的工作结构。*

在这个过程中，Human 不再负责串联每一步，而是从唯一的 Router，逐渐上移为整支 Agent Team 的 Owner。

### 你可以怎样读

你不需要一次读完。可以先根据自己正在面对的问题，直接进入对应章节。

- 如果你想先理解“为什么多个 Agent 不等于 Agent Team”，可以读楔子、01 和 07。
- 如果你已经在同时维护多个 Agent，并开始被 Human Routing 拖累，可以重点读 02、03 和 04。
- 如果你关心 Agent 的负载、瓶颈、Scope 调整和 Team Governance，可以直接读 05。
- 如果你想让 Agent 进入 Slack、飞书、客户、社区或者其他真实外部关系，可以直接读 06。
- 如果你想完整理解 CodexLoom 的产品逻辑，可以从头读到最后。

正文也会配合真实产品界面、协作链路和机制示意图。

第一次阅读时，你可以先看标题、加粗句、引用和图片配文，建立完整框架；之后再回到具体章节，阅读其中的实践、机制和边界。

### 全文地图

__一个 Agent，是怎么变成多个 Agent 的__

为什么真实工作会把 Task Agent 推向 Long\-running Agent；为什么一个越来越好用的 Agent 最后又必须分化；多个 Agent 出现以后，瓶颈为什么会转移到 Human。

__先让“谁负责什么”离开 Human 的脑子__

Agent 怎样获得稳定身份、Domain 和 Scope；Human 与 Agent 怎样查询当前 Team 的责任结构；真实协作又怎样逐渐沉淀为 Organization 与 Collaboration。

__让 Agent 自己开始协作__

Agent Message 带来了什么变化；一个 Agent 怎样把工作直接交给另一个 Agent；为什么 Agent 沟通不是一次把一切说完。

__Message 负责沟通，Topic 负责收口__

当工作跨越多个 Agent、多个 Turn 和多天以后，怎样保留唯一的当前版本；Responsible、Participant、Artifact 和 Needs You 分别解决什么问题。

__Overview：让一支持续变化的 Agent Team 变得可治理__

当 Human 不再阅读每个 Agent 的全部过程，怎样从更高层观察 Team；怎样发现等待、积压和瓶颈候选；为什么治理关注的是工作流动，而不是让每个 Agent 看起来都很忙。

__Agent Team 怎样进入真实的外部关系__

为什么把 Agent 接入 Slack、飞书还远远不够；Agent 对外以后，身份、角色、信任、权限和现实后果为什么必须被分别治理。

__CodexLoom 在织什么__

Multiple Agents 与 Agent Team 的真正分水岭是什么；Human 在 Team 中的新位置是什么；为什么需要稳定的 Agent 和动态的 Team。

一条连续责任线依次穿过 Task、Long\-running、Domain Agents、Human Router 和 Agent Team 五个阶段。

*机制示意：从一次 Task 到长期 Agent，再到 Domain 分化、Human Routing 和 Agent Team。Agent 数量增加只是中间阶段，真正的变化是协作责任开始从 Human 转移给 Agent。*

## 楔子：一次意外的外发

这篇文章，其实有点搞笑。我本意是打算把这个做了一个多月的项目先上线 Landing Page，然后慢慢打磨，一次整个大的。

结果负责 Web 的 Agent 接到我上线的指令后，按照之前的协作关系，通知了对外沟通的 Community Agent。Community Agent 一看，大新闻啊，就马不停蹄地整理素材，发到飞书群里。

等我看到的时候，消息已经发出去了。

codexloom\.ai 桌面首页，使用大字标题、暖白编辑画布和下方产品界面作为证据。

*CodexLoom 当前 Landing 页面。开头的外发故事来自这次真实上线，但页面上线、渠道发送和受众反应是三个不同的事实层级。*

虽然事情有些意外，但也并没有脱离我对 Agent Team 的设定，甚至可以说，“它们”这次，干得不错。

我没有站在几个 Agent 中间，亲自选择下一步该找谁、搬运 Context、转交结果；工作仍然沿着已有的责任、协作关系和授权边界继续向前走。

这正是我做 CodexLoom 的原因。

过去，我们一直关心怎样让 Agent 变得更强，怎样让它完成更长、更复杂的任务。

但是单个 Agent 的能力范围总是有上限的。于是，越来越多人开始同时使用多个 Agent。

Agent 多了，新的问题也随之出现：真正的瓶颈不再只是单个 Agent 能做什么，而是怎样把这些 Agent 组织起来。

多个 Agent，并不会自动成为一支 Agent Team。

如果每一项工作仍然要由 Human 选择入口、整理背景、搬运 Context，再把一个 Agent 的结果交给下一个 Agent，那么这些 Agent 本质上仍是一组独立工具。

Human 仍然是整个系统里唯一的 Router，也是事实上的瓶颈。

我理解的 Agent Team，是另一种工作方式。

首先，每个 Agent 会长期负责自己的 Domain。它知道自己应该处理什么、边界在哪里，也知道遇到其他问题时应该去找谁。

其次，一部分原本由 Human 承担的协作责任，开始转移给 Agent。它们可以在明确的责任关系中直接协作，自己完成工作的交接和结果回流，而不是所有事情都要经过 Human 中转。

Human 并没有退出这支 Team。只是不用再串联每一个步骤，而是在方向、事实、选择、Review 和授权的位置回来。

但当 Human 不再盯着每一步，另一个问题也会随之出现：我怎么知道这支 Team 到底运行得怎么样？

所以，Agent Team 的真实工作还需要能够被观察、理解和持续调整。否则我只是从“亲自调度每个 Agent”，变成了“看不见它们在干什么”。

CodexLoom，就是我为这种工作方式做的产品。

它不是为了让你同时打开更多 Agent，而是把一条条独立的 Codex Thread，逐渐织成一支长期负责、能够协作、由 Human 治理的 Agent Team。

那么，多个 Agent，究竟怎样才能真正成为一支 Team？

## 01 一个 Agent，是怎么变成多个 Agent 的

### Task Agent 并没有问题

大部分人开始使用 Agent 时，面对的其实都是一个 Task。

新建一个 Codex Thread，告诉它这次要完成什么，Agent 根据当前的 Context 调用工具、执行任务，给出结果。任务完成，这段工作也就结束了。

这种方式非常自然。一次性、边界清楚的工作，本来就不需要一个 Agent 长期存在。

然而在真实工作中，很多工作并不是一个个彼此独立的 Task。一个 Task 可以完成，它背后的责任却不会随之结束。

工作会围绕同一个长期目标持续发生，并带着新的事实、反馈和限制反复回来。

一篇文章写完了，之后还会继续修改；一个页面上线了，后面还要不断迭代；今天研究过的公司，下个月有了新产品、新融资、新数据，还会再次进入视野。

而且，每一次回来都不是简单重复。上一次的背景、判断和错误仍然有用，Human 给过的纠正、偏好和边界，也应该继续影响下一次工作。

Task 是一次工作的切片，但真实工作是一条持续流动的责任线。

一条持续责任线穿过四个错落的 Task 切片，并把 Context、Correction 和 Boundary 带入 Long\-running Agent。

*机制示意：Task 可以结束，责任仍会带着新的 Context、纠正和边界再次回来。Long\-running 的意义，不是把一次对话无限拉长，而是让同一类责任持续回到同一个主体。*

如果每次都新建一个 Agent，人就要重新解释背景、重新告诉它自己的偏好、重新说明什么能做、什么不能做，甚至重新踩一遍已经纠正过的错误。

所以，反复冷启动更深的成本，不只是 Token，也不是多写几个 Prompt，而是每次都在重新建立合作关系。

最自然的选择，就是不要再把这个 Agent 用完即弃。让它保留在同一个 Thread 中，下一次从上一段工作继续。

过去的工作、人的纠正，以及被 Summary、Memory、Skill 等机制保留下来的经验，开始影响下一轮。

这时，它就从一个 Task Agent，逐渐变成了 Long\-running Agent。

Long\-running 不是单纯把一次对话拉得很长，而是同一类责任开始有了一个持续存在的主体。

Human 也会在反复合作中慢慢形成对它的判断：什么时候应该找它，它擅长什么，通常会怎样工作，哪些边界还需要提醒。

### Long\-running Agent 也有自己的上限

一个 Agent 变得越来越好用以后，接下来通常会发生另一件事：人会不断把更多工作交给它。

一开始让它写文章，后来也让它找材料、研究事实、管理内容；再往后，可能连页面、SEO 和对外分发也一起交给它。

很少有人能在创建 Agent 的第一天，就准确画出它最终的 Scope。

更正常的过程，是 Scope 先随着使用不断扩张，直到问题在真实工作中暴露出来。

不同工作的高分辨率 Context、工作方法和专业判断开始挤在一起。

Agent 可能越来越慢，质量开始下降，需要反复纠正；也可能一直满负荷工作，新的任务不断排队，其他工作都在等它。

这不一定说明模型不够强。很多时候，问题是一个 Agent 已经承担了太多并不内聚的责任。

于是，就需要思考边界。

哪些工作应该共享 Context，放在一起会越来越好；哪些工作其实需要完全不同的方法和判断，继续塞在同一个 Agent 里，只会互相干扰。

Domain 不是先画出来的领域标签，而是在持续使用、Scope 扩张和能力劣化中逐渐显现的工作边界。

它回答的是：哪些事情适合由同一个 Agent 长期负责，哪些事情应该从中分出去。

这时，一个 Long\-running Agent 就会开始分化。

研究工作交给 Research Agent，页面和上线交给 Web Agent，内容收集和写作分别交给 Content、Writer Agent，对外沟通交给 Community Agent。

Task 是工作单位，Long\-running 是生命周期，Domain 回答的是一个 Agent 长期负责什么，又在哪里停止。

多种工作流进入一个不规则压力场，发生拥堵和冲突后从不同边界分化为多个 Domain Agents。

*机制示意：Scope 通常先扩张，直到不同 Context、方法和判断互相干扰，边界才从压力与能力劣化中显现。Domain 分化是对真实摩擦的回应。*

### 多个 Agent 的瓶颈，转移到了 Human

Agent 分化以后，单个 Agent 的 Context 压力下降了，不同工作可以同时推进，每个 Agent 也能在自己的 Domain 里积累经验。

但这个时候，它们仍然只是 Multiple Agents，不是 Agent Team。

因为它们虽然已经分工，协作却仍然发生在 Human 的脑子里。

每次有新工作，还是由人判断应该找哪个 Agent；开始之前，由人整理背景、限制和材料；一个 Agent 做完以后，由人读懂结果、判断能不能用，再转交给下一个 Agent。

不同 Agent 的结论发生冲突时，也仍然只有人知道谁才是这件事真正的 Owner。

看起来，多个 Agent 在并行工作。实际上，所有工作的入口、Context、结果和下一步，最后仍然汇聚到了 Human。

Agent 可以并行，但 Human 仍然只能逐个阅读、逐个判断、逐个路由。Agent 越多，Human 需要维护的 Context 和协作关系也越多。

多条并行 Agent lane 汇聚成 Human 前的 Context queue，再沿一条朱红色串行路由逐项输出。

*机制示意：多个 Domain Agent 可以同时工作，但如果 Context、选择和交接仍然必须经过同一个 Human，系统最终仍然从一个窄出口串行流出。*

于是，系统的瓶颈发生了转移：

__*核心判断*__

*真实工作反复回来，逼出了 Long\-running Agent；Scope 扩张与能力劣化，逼出了多个 Domain Agents；Agent 的分化，又把协作瓶颈集中到了 Human。*

单个 Agent 过载，推动了 Domain 分化。Human Routing 过载，则推动多个 Agent 继续向 Agent Team 演化。

Agent 分化，只是产生了多个 Agent。只有原本藏在 Human 脑子里的责任、关系和交接方式被逐渐外化，一部分协作责任开始从 Human 转移给 Agent，它们才可能真正成为一支 Team。

而这件事的第一步，是让每个 Agent 长期负责什么、在哪里停止、遇到其他问题时应该找谁，变得清楚而且可以被整个 Team 使用。

## 02 先让“谁负责什么”离开 Human 的脑子

多个 Agent 出现以后，我很快发现，新的问题不是没有分工，而是这份分工只存在于我的脑子里。

我知道研究问题应该找 Research Agent，页面和上线应该找 Web Agent，对外沟通应该找 Community Agent。

我也大概知道每个 Agent 擅长什么、最近做过什么、什么事情不应该交给它。

但这些信息如果只有我知道，就没有真正成为 Team 的一部分。

每个 Agent 也许知道自己正在做什么，但它不会因此自动知道这支 Team 里还有谁、别人长期负责什么，以及遇到自己边界之外的问题时可以去找谁。

Human 不仅是整个系统的 Router，也是唯一保存这份分工的 Directory。

所以，CodexLoom 做的第一件事，并不是让 Agent 之间立刻开始互相发消息，而是先让每个 Agent 成为一个稳定、可以被识别的长期主体。

在 CodexLoom 里，一条 Codex Thread 不再只是某次任务留下来的对话。它可以绑定到一个长期 Agent，拥有稳定的名字、身份和工作入口。

之后新的工作仍然回到同一个 Agent，由同一个主体从当前状态继续。

这不代表 Agent 拥有无限、无损的长期记忆，也不是把所有历史记录重新塞回每一次 Context。它解决的是更基础的问题：下一次工作回来时，究竟是谁继续负责。

在此之上，每个 Agent 都有自己的 Profile。

Profile 回答三个非常简单，但对组织非常重要的问题：

- Identity：它是谁
- Domain：它长期负责什么
- Scope：它在哪里停止，什么事情不属于它

Profile 不是给 Agent 发一张工牌，也不是写一段更长的 System Prompt。它是把 Human 已经从真实工作中发现的边界明确记录下来：你是谁，长期接住什么，又在哪里停下。

而且，这份 Profile 不是创建 Agent 时一次写死的。

第一章里提到，人的 Scope 判断一开始通常并不成熟。

一个 Agent 先在真实工作中持续承担责任，Scope 不断扩张，直到不同 Context 和判断开始互相干扰，边界才逐渐显现。

所以，更准确的顺序不是：

__*不是*__

*创建 Agent → 填写 Profile → 得到一个 Domain Agent。*

而是：

__*而是*__

*真实工作暴露边界 → Profile 保存当前理解 → 后续工作继续验证和修正。*

Profile 不是最终答案，而是这支 Team 当前采用的组织假设。

它先把此刻最值得采用的责任边界稳定下来，让 Human 和 Agent 可以据此工作；新的事实出现以后，再继续修正。

它也不是这个 Agent 已经胜任工作的证明。

比如，在开头的 Landing 故事里，Web Agent 的责任是页面实现、上线和生产结果。当页面完成 site\-live，它也就走到了自己的边界。

接下来是否应该对外发送、发到哪个渠道、应该怎样表达，是 Community Agent 的判断。反过来，Community Agent 也不会因为负责对外沟通，就接管页面实现、部署或产品事实。

这就是 Scope 的意义。

Scope 不只告诉 Agent“你负责什么”，也告诉它“你在哪里停下，什么时候已经需要另一个 Domain 的专业判断”。

在 CodexLoom 中，一个 Agent 开始工作时，会带着自己的完整 Profile，以及与自己直接相关的 Organization 和 Collaboration。

它因此不只知道当前 Task，也知道自己长期是谁、负责什么、在哪里停止，以及有哪些已经声明的直接关系。

这里先简单理解即可：Organization 表达责任上的 parent/child 关系，Collaboration 表达两个独立 Domain 之间有方向的长期协作接口。后面还会继续展开。

但它不会自动得到整支 Team 的全部 Profile，也不会获得其他 Agent 的 Thread、历史和私有 Context。

需要了解更大的 Team 时，Human 和内部 Agent 可以主动查询：

loom team  
loom team <agent>  
loom team links <agent>  
loom profile get <agent>

loom team 提供当前这支 Team 的整体视图；loom team <agent> 可以查看一个 Agent 的完整 Profile、相邻关系和相关 Activity；loom profile get <agent> 则只读取它的 Identity、Domain 和 Scope。

这里的 Activity，指的是从真实 Message 中聚合出来的协作迹象。

WebUI 的 Team 页面也提供 Directory、Organization、Collaboration 和 Activity 四个视图。

Directory 让 Human 浏览当前 Team 中的 Agent 与 Profile；其他 Agent 也可以通过 Loom 的查询入口主动读取这些声明。

CodexLoom Team Directory 展示多个匿名 Agent。CodexLoom Profile 详情分区显示 Identity、Domain 和 Scope。

*当前产品界面 · 隔离构造工作区。Team Directory 提供长期 Agent 的可查询入口；Profile 明确保存一个 Agent 当前声明的 Identity、Domain 与 Scope。声明是共同工作基线，不是能力、记忆或授权证明。*

Team 层提供的是可查询的 Profile 和关系，而不是把每个 Agent 的完整 Context 复制给所有人。每个 Agent 完整、细致的专业工作过程，仍然保留在自己的 Thread 中。

随着 Agent 继续分化，Team 还需要表达它们之间相对稳定的关系。

CodexLoom 用 Organization 记录 parent/child 的长期责任边界：一个更大的责任下面，是否已经分化出稳定的子责任。

CodexLoom Organization 关系图，一个父级 Agent 通过细线连接多个子级 Agent。

*当前产品界面 · 隔离构造工作区。Organization 可视化当前声明的 parent/child 长期责任结构；它不会自动选择 Owner、发送 Message 或授予权限。*

用 Collaboration 记录有方向的长期协作接口：两个独立 Domain 是否已经形成反复出现、值得明确保存的协作边界。

Agent 可以查询这些声明，把它们作为理解责任结构和可能协作接口的依据。

在 CodexLoom 里，声明结构和实际发生的工作，本来就是分开记录的。

Profile、Organization 和 Collaboration 保存的，是这支 Team 当前采用的组织假设。它们先提供一个共同工作的基线，再由后续真实工作继续检验和修正。

Activity 记录一定时间里真实发生过的 Message 协作。前者是声明，后者是运行证据，二者不能互相替代。

Collaboration 图显示多个匿名 Agent 之间的有向关系。

*当前产品界面 · 隔离构造工作区。Collaboration 保存有方向的长期协作接口；关系本身不自动完成交接、共享 Context 或授予权限。*

Activity 图显示一段时间内实际记录到的 Message 方向。

*当前产品界面 · 隔离构造工作区。Activity 按记录到的 Agent Message 呈现协作迹象。它可以帮助检验一条声明关系，但不是绩效，也不会自动把重复往来升级成 Collaboration。*

Organization 和 Collaboration 不会自动替 Agent 选择或联系下一个 Agent，也不会因为画了一条关系，就给 Agent 增加工具、凭证、部署、生产或外发权限。

两个 Agent 经常互发消息，也不会自动形成一条长期 Collaboration。反过来，写下了一条 Collaboration，也不能证明它们已经配合得很好。

真正值得沉淀的 Collaboration，要先在多次真实工作中表现为稳定的输入、输出和升级条件。

CodexLoom 通过 Message 与 Activity 提供观察证据，再由 Human 明确写下这条关系，并在后续工作中继续验证。后文讲可观测性与治理时，我们会回到这个过程。

这些声明做的事情非常基础：把原本隐藏在 Human 脑中的责任结构，变成一套 Human 和 Agent 都可以查询、检查，也可以继续修改的组织假设。

所以，从 Multiple Agents 走向 Agent Team 的第一个分水岭是：

__*关键问题*__

*当工作需要协作时，当前 Agent 仍然只能回头问 Human“我应该找谁”，还是它已经可以根据自己的 Scope、直接关系和主动查询到的 Profile，判断下一位候选 Domain Owner？*

CodexLoom 不会自动替 Agent 找到“正确的人”。查询结果只提供责任声明和关系依据。

具体应该找谁，仍然需要 Agent 根据当前工作作出判断；边界不清楚时，也应该继续升级给 Human。

但如果每一次都必须由 Human 指定下一位 Agent，那么 Human 依旧是唯一的 Router。这些 Profile 和关系，也仍然只是一张给人看的组织图。

Agent 能够查询并判断候选责任人，解决的是“应该找谁”。

要真正不再由 Human 搬运 Context，它还必须能够直接把一段有边界的工作交给对方，让对方在自己的专业 Context 中完成，再把结果沿着原来的工作链路交回来。

这就是 Agent Message 开始发挥作用的地方。

## 03 让 Agent 自己开始协作

判断出候选责任人，只解决了一半问题。

如果当前 Agent 走到自己的边界以后，仍然要先回来告诉我，那么 Human 依然是整个系统的人工总线。

我仍然要打开另一个 Agent，重新解释背景、复制材料、转述要求，等它做完以后再把结果搬回来。

只是这一次，我不再负责判断“该找谁”，却仍然负责把所有工作接起来。

所以，Agent Team 的下一步，不只是让 Agent 能够发现其他 Agent，而是让它们能够直接建立协作。

在 CodexLoom 里，这种协作从 Agent Message 开始。

### Human 不再是 Agent 之间唯一的通信通道

这里最重要的变化，不是多了一个聊天框，也不是把 Human 写的交接文档电子化。

一条 Message 有明确的发送方和接收方，也会说明这次沟通是否期待对方返回结果。

它进入接收方自己的长期 Thread，由接收方带着自己的 Profile、直接关系，以及已经积累的专业 Context 来理解和处理。

发送方的完整 Thread、全部历史和私有 Context，并不会因此复制过去。

这意味着，协作不再需要 Human 先把一个 Agent 的工作读懂，再人工翻译给另一个 Agent。

发送方只需要交出这次协作所需的 Context；接收方则从自己的 Domain 出发，判断这个问题应该怎样处理、还缺什么、发送方的前提是否准确，以及它是否已经超出自己的边界。

原本发生在 Human 脑子和手上的过程：

发现工作已经越界  
    ↓  
找到更合适的 Agent  
    ↓  
解释为什么找它  
    ↓  
转交必要 Context  
    ↓  
等待处理  
    ↓  
把结果带回来

开始能够直接发生在 Agent 之间。

但这不意味着 Human 完全退出。

更准确地说，Human Router 原来承担的一整块工作，开始被拆开。

- 发送方负责判断为什么需要协作，以及交出必要的 Context
- 接收方负责用自己的专业 Context 校正问题并返回结果
- 负责整件事收口的 Agent 负责整合局部结果
- Human 继续保留方向、重大选择、Review 和授权

协作责任发生了转移，也发生了分层。

### Request、Notification 和 Reply

CodexLoom 会区分不同的沟通意图。

如果发送方需要对方返回判断、行动或结果，可以发送一个 request：

loom msg TARGET \-\-from SELF \-\-subject "有界请求" \\  
  \-\-response required \-\-body "当前问题、边界、证据要求与返回义务"

如果只是同步一个对方必须知道的状态变化，不要求回复，则可以发送 notification：

loom msg TARGET \-\-from SELF \-\-subject "状态或事实" \\  
  \-\-response none \-\-body "变化、影响和核验入口"

接收方回答 request 时，结果会沿着原 Message 返回，保留真实的因果关系；而 notification 不需要为了“收到”制造一条没有业务价值的确认消息。

CodexLoom Agent Message 详情显示一条需要回复的请求，以及 reply、delivered、completed 和下方因果回复。

*当前产品界面 · 隔离构造工作区。Agent Message 分开记录请求的因果关系、送达状态与接收方处理状态；这些状态不等于业务结果正确。*

如果回复以后又出现了新的事实缺口，双方可以继续发起下一轮有边界的追问。

多轮沟通不是漫无目的地聊天，而是每一轮都说明：现在新增了什么、接下来要解决什么、结果必须回到哪里。

这些看起来像通信细节，但它们决定了一件很重要的事。

当 Human 不再站在中间以后，系统仍然知道一段工作从哪里来、交给了谁、对方是否需要返回结果，以及后续沟通为什么发生。

### Landing 发布中的真实协作

开头那个 Landing 的意外外发，就是一个已经相对成熟、不需要先来回澄清的协作接口。

Web Agent 完成页面实现和 site\-live 以后，已经走到了自己的 Scope 边界。页面是否值得对外发送、发到哪个渠道、应该怎样表达，不再是 Web 的专业判断。

于是，它按照已有的协作关系，向 Community Agent 发送了一条上线通知。

这条 Message 不只有一句“页面上线了”，还包含正式 URL、页面与生产验证、哪些事实可以公开、可以使用的素材、需要避免的重复发送，以及当前仍然存在的限制。

Web Agent 没有替 Community Agent 决定“必须发布”。它只是把一个已经超出自身边界、需要对外沟通判断的问题交给了对应的 Domain Owner。

Community Agent 在自己的 Thread 中判断这件事是否值得发送、面向哪个渠道、怎样根据受众改写、是否使用图片，以及应该立即发送、排期、延后还是跳过。

最终，它选择了对外渠道并完成发送，再把发送结果、回执和异常状态交回原来的工作链路。

这里还有一个很小但重要的细节：Web Agent 最初发送的是一条不要求回复的 notification。

Community Agent 完成以后，没有把完成结果伪装成原消息的 reply，而是沿着同一项工作重新发送了一条 completion notification。

因为这次协作的含义不是“Web 等待 Community 回答一个问题”，而是“Web 告知一个已经发生的状态变化，Community 独立承担后续判断，再明确通知结果”。

左右两个独立 Context 之间，一条折返的因果消息路径经历 Open、Correct、Align 和 Converge。

*机制示意：两个 Agent 保留各自长期 Context，通过 Open、Correct、Align 和 Converge 逐轮增加共同理解。多轮不是把一条完整消息拆碎，而是让真实返回成为下一轮的新 Context。*

#### 最佳实践：Agent 沟通不是“一次把一切说完”

Landing 这次不需要多轮澄清，是因为 Web 与 Community 的责任边界、输入内容和结果回流方式，已经在过去的真实工作中逐渐稳定下来。

但更多时候，发送方和接收方拥有各自长期积累的 Context。

接收方不是一个等待填写 Prompt 的空白执行器：它可能知道发送方不知道的事实，拥有不同的工具和专业判断，也可能发现问题的前提本身就是错的。

如果发送方试图在第一条 Message 里把一切定义完整，它也在替接收方预设：你知道什么、问题为什么发生，以及最后应该得出什么结论。

这很容易把发送方自己的盲区一起带进协作。

多轮沟通的好处，是让接收方尽早从自己的 Domain 校正问题；后续每一轮都建立在真实返回而不是想象之上。

两个 Agent 不需要复制彼此的完整 Thread，也能逐步形成这次协作真正需要的共同理解。

我们在实践中逐渐形成了几条原则：

- 不假设对方知道什么，也不替对方预设原因和结论
- 第一条 Message 只需要让对方正确开始，而不是一次穷尽全部背景
- 下一轮根据对方的真实返回继续，而不是照着预先写好的问题清单机械追问
- 每一轮都应该带来新的信息或决定；Context 足够以后就及时收敛

__*最佳实践*__

*好的多轮沟通，不是把一份完整消息机械地拆碎，而是让上一轮的真实返回成为下一轮新的 Context。*

*多轮也不是越多越好：当责任边界、输入、授权前提和结果回流都已经清楚，一次自包含的 handoff 通常更有效。*

回到这次 Landing 协作，整个过程中，我没有打开 Community Agent 的 Thread，没有重新复制 Landing 的背景，也没有亲自把 Web Agent 的结果转述给它。

这才是 Agent Message 真正重要的地方。它传递的不只是信息，而是让两个拥有不同长期 Context 的责任主体，能够直接建立一条有来源、有边界、可以逐轮校正的沟通回路。

__*边界*__

*Message 被送达，只代表接收方的 Codex Turn 已经接受了这段输入，不代表接收方已经理解、同意或者作出了正确判断。*

*处理状态显示完成，也只说明这次运行正常结束，不代表业务结果已经完成，更不代表它因此获得了新的工具、生产或对外权限。*

结果是否正确、是否应该继续、是否涉及新的授权，仍然要回到对应的 Domain Owner，必要时再升级给 Human。

所以，能互相发 Message，仍然不等于已经成为一支 Team。

真正的变化是，Agent 开始接住原本由 Human 承担的协作责任：识别自己的缺口，判断候选 Owner，直接建立沟通，在各自的专业 Context 中逐步对齐，再把结果接回原来的责任链路。

但真实工作很少只涉及两个 Agent，也很少在一个 Turn 内结束。

一件事情可能跨越多个 Agent、多个阶段，还会经历等待、中断、事实更新和 Human 决策。

Message 可以让 Agent 直接沟通，却还不能单独回答：现在整件事进行到哪里，谁负责最后收口，大家在等待什么，最终结果和证据又应该保留在哪里？

这就需要比 Message 更高一层的协作结构。

## 04 Message 负责沟通，Topic 负责收口

Agent 可以直接互相发送 Message 以后，Human 不再需要搬运每一段 Context。

但真实工作一旦跨过两个 Agent，很快又会出现一个新的问题。

一件事情可能先由 Content Agent 梳理命题，再由 Research Agent 核验事实，由 Product Agent 确认产品实现。

中间还会等待新的材料、Human 的选择，或者外部事实发生变化。

每个 Agent 都可能完成了自己负责的部分，却没有人知道整件事现在进行到哪里。

有些结论留在某条 Message 里，有些限制只存在于某个 Agent 的 Thread 中；有人还在等待上一阶段的结果，另一个人却以为工作已经结束。

局部工作都完成了，整件事依然可能没有收口。

如果这些状态最后还要由 Human 逐条阅读 Message、进入不同 Thread，再在脑子里拼成一张完整进度图，那么 Human 只是从“通信 Router”变成了“项目状态 Router”。

所以，Message 解决点对点沟通以后，Agent Team 还需要一层更高的协作结构：

__*核心判断*__

*不是让所有 Agent 共享同一个 Context，而是让一项跨 Agent 工作拥有一个明确的当前版本，以及一个负责最后收口的 Agent。*

在 CodexLoom 里，这个结构叫 Topic。

### Topic 不是把 Agent 拉进一个群聊

如果只说“多个 Agent 围绕同一个 Topic 工作”，很容易把它理解成一个 Agent 群聊：所有 Agent 进入同一个会话，共享同一段 Context，谁看到问题谁就回答。

但 Topic 的形态并不是这样。

每条 Topic 只有一个 Responsible。

Human 对整件事的方向、选择和纠正，首先回到 Responsible；Responsible 再根据当前需要，把有边界的问题通过 Message 交给不同 Participant。

Participant 不会进入一个公共聊天窗口。Research Agent 仍然在自己的 Thread 中研究，Product Agent 仍然在自己的 Thread 中核验产品。

它们收到的，是与自己那一段责任相关的 Topic Context 和 Message，而不是其他 Agent 的全部对话与工作过程。

完成以后，它们再把局部结果交回 Responsible，由 Responsible 更新 Topic 的 current brief。

它大致是这样的：

1. Human / Owner 把方向、选择和纠正交给 Responsible。
2. Responsible 通过 Message 向不同 Participant 派发有边界的问题。
3. Participant 在自己的 Thread 中完成专业工作。
4. 局部结果回到 Responsible，由 Responsible 更新 Topic。

三个独立 Agent Thread 通过 Message 围绕中央 Topic 协作，Topic 分层显示 Responsible、Current、Waiting、Evidence 和 Result。

*机制示意：Message 连接局部 request 与 reply；Topic 由唯一 Responsible 维护 Current、Waiting、Evidence 和 Result。参与者仍在各自 Thread 中工作。*

如果群聊更像一间所有人同时说话的会议室，那么 Topic 更像一份有明确主责人的协作事项档案。

它保存整件事目前采用的版本，但不替代参与者各自的专业工作空间。

这也意味着，同在一个 Topic 里，不代表所有 Message 都会广播给所有人；Participant 之间也不会因为被放进同一个 Topic，就自动共享彼此的 Thread、历史和私有 Context。

CodexLoom Topic Current 页面显示 brief 版本、等待对象、下一步、限制、Responsible、Participants、Purpose 与完成条件。

*当前产品界面 · 隔离构造工作区。Topic Current 由唯一 Responsible 维护共享 brief、等待条件、下一步、限制和 scoped Participants；各 Agent 的高分辨率工作仍留在自己的 Thread。*

### Team 需要共享当前状态，不需要共享全部 Context

在这种结构里，Topic 首先会说明这项工作为什么存在，以及什么才算完成。Responsible 和每个 Participant 的责任边界也会被明确记录下来。

Topic 会持续保存：

- 由 Responsible 维护的 current brief，也就是这项工作目前采用的事实、判断、下一步和限制
- 每个 Participant 负责什么
- 工作正在等待谁、等待什么
- 关键证据锚点和阶段结果在哪里
- Topic 当前是否已经被标记为收口

这份 current brief 会随着工作推进不断更新。

它不是整件工作的全部历史，也不是把所有 Agent 的 Thread 合并到一起。

它只是让参与者在任何一个阶段回来时，不需要重新翻遍所有消息，就能先知道：我们现在走到了哪里。

每个 Agent 完整、细致的专业过程，仍然保留在自己的 Thread 中。

Research Agent 不需要把全部研究轨迹塞进 Topic；Product Agent 也不需要把代码、日志和每一步核验过程复制给所有人。

它们只需要把这项共同工作必须知道的结果、证据、限制和开放问题返回给 Responsible。

所以，Topic 共享的是整项工作的当前状态，而不是所有人的全部 Context。

### Responsible 不是“什么都自己做”

这里很容易产生一个误解：既然 Responsible 对最终结果收口，是不是所有事情最后又集中到了一个 Agent 身上？

不是。

Responsible 的责任，不是替其他 Agent 做专业判断，而是维护整件事的连续性：

- 把整体目标拆成有边界的专业问题
- 找到合适的 Participant
- 接住不同 Agent 返回的局部结果
- 识别结果之间的冲突、缺口和等待
- 更新所有人应该知道的当前版本
- 最后把整项工作的结果交回发起者

Research 仍然拥有事实与证据强度，Product 仍然拥有当前实现，Community 仍然拥有具体外部渠道的判断。

Responsible 不能因为负责收口，就改写其他 Domain 的专业结论；Participant 也不能因为完成了自己的一段，就宣布整项工作已经完成。

这是一条很重要的协作边界：

__*协作边界*__

*本地完成，不等于协作完成。*

只有局部结果、证据、限制和下一步回到 Responsible，并被整合进整项工作的当前版本，这一段责任转移才真正闭环。

### 这篇文章本身，就是一个 Topic

我们现在写的这篇文章，就是一个真实例子。

我和 Content Agent 持续讨论文章到底想表达什么，哪些判断已经确认，哪些材料应该进入正文，哪些应该停放。

遇到产品实现问题时，Content Agent 不会自己猜，而是把有边界的问题交给 Product Agent。

Product Agent 在自己的 Thread 中回读当前代码、运行状态和产品对象，再返回它能证明什么、不能证明什么。

讨论到 Agent 之间应该怎样沟通时，它又把问题交给 Communication Coach。Coach 从真实协作中整理出多轮沟通的特点、已验证实践和失败边界，再把局部结果返回。

Content Agent 不接管产品事实，也不接管沟通方法的专业判断。它负责把这些结果与我的作者判断重新放在一起，更新文章当前讲到哪里、哪一章已经确认、下一步还缺什么。

如果没有 Topic，这些工作仍然可以通过 Message 完成。但每次我回来，都要重新问：

__*恢复工作时真正需要的问题*__

*Product 核验到哪里了？Coach 返回了吗？哪一个版本才是我们现在认可的？还有什么没有解决？*

Topic 让这项工作拥有了一份可以持续更新的当前状态。

我不需要进入每个 Participant 的 Thread，也不需要把每个专业过程都读一遍；但我仍然可以知道整件事为什么停住、谁正在负责、证据在哪里，以及下一步需要什么。

### Artifact 让正式结果有稳定版本

跨 Agent 工作最后交付的，也不总是一段文字回复。

它可能是一份研究报告、一张截图、一段代码、一个章节草稿、一份 evidence ledger，或者某个已经确认的最终文件。

如果这些文件只存在于某条 Message 或某个不断变化的本地路径里，协作很快又会遇到另一个问题：

__*版本问题*__

*你现在看到的，究竟是哪一版？*

CodexLoom 用 Artifact 保存需要交付的文件快照。

Artifact 会拥有稳定的 ID、文件信息和校验值。即使原文件后来继续修改，已经发布的快照也不会跟着变化。

在这篇文章的 Topic 中，多个章节草稿、Product 和 Communication Coach 的回读、sourcebook 与素材账本，已经被保存为独立 Artifact，再由 Responsible 链接回 Topic。

这样，current brief 负责说明“我们现在怎样理解这项工作”，Artifact 负责保存“这个判断具体对应哪一个文件版本”。

后续 Agent 引用的是同一个已经固定的结果版本，而不是猜测某个本地文件现在又被改成了什么样。

同样，Topic resolved 也只表示：这条协调记录已经被标记为收口。

按照 CodexLoom 的协作责任，这一步应该由 Responsible 对照 completion boundary 来完成。

但系统不会自动验证边界是否真的满足，也不会因为状态变成 resolved，就替 Team 执行后续动作。

所以，它不代表所有相关的下游动作、外部发送或现实结果都已经完成。

开头的 Landing 就有一个很准确的时间边界：页面 site\-live 的截图和阶段结果先被记录，Landing Topic 随后被标记为 resolved；Community Agent 的外部分发发生在之后。

更准确地说，是页面上线的独立验证和 Responsible 发布的阶段结果支撑了 site\-live；resolved 只记录这项协调工作当时已被收口。

之后飞书和 Parall 的发送，则由另外的 Outbox 与 provider receipt 记录。

所以，Topic 和 Artifact 并不是为了制造一个“完成”的假象。

它们真正解决的是：当工作跨越多个 Agent、多个 Turn 和多个阶段以后，Team 仍然拥有一份明确的当前状态，一个负责收口的主体，以及可以回查的正式结果。

### Needs You：在正确的位置找回 Human

Topic 可以记录“这项工作正在等待 Human”、对应的引用，以及 Human 回答后应该怎样恢复。

但如果 Agent 缺少的是人的事实、选择、Review 或授权，它不能替 Human 作出回答。

这时，Agent 也不应该把一句模糊的“接下来怎么办”扔回给 Human。它需要先说明：

- 现在正在完成什么工作
- 已经确认了哪些事实
- 具体缺少人的哪一个判断
- 有哪些可选路径以及各自影响
- Human 回答以后，原工作应该从哪里继续

在 CodexLoom 里，这条路径叫 Needs You。

Needs You 页面显示一个有背景说明、两个选项和回答输入区的 Human 决策请求。

*当前产品界面 · 隔离构造工作区。Needs You 把需要 Human 提供事实、选择、Review 或授权的精确阻断点持久化。问题被回答，不等于后续动作已经发生或有效。*

Needs You 会把问题、必要 Context、被阻断的工作、候选选项和期待回答保存下来。Human 回答以后，结果会回到原来的 Agent 和原来的工作，而不是重新打开一个没有上下文的新对话。

这样，Human 不需要站在所有 Agent 中间推动每一步。大部分工作可以继续向前流动；真正需要人的事实、取舍、Review 或授权时，再把 Human 带回准确的工作位置。

当然，创建 Needs You 并不等于已经获得批准。Human 的回答也只覆盖回答中明确给出的范围。

如果 Human 只同意“继续起草”，Agent 不能把它理解成“可以直接发表”；如果 Human 回答了一个事实，也不代表后续所有相关动作都已经获准。

到这里，一项工作已经可以在多个 Agent 之间被发现、交接、持续协调，并在正确的位置找回 Human。

但当这样的工作越来越多、Agent Team 真正开始长期运行以后，还会出现另一个问题：

Human 怎样看见整支 Team 实际是怎么工作的？

## 05 Overview：让一支持续变化的 Agent Team 变得可治理

当 Agent 有了长期身份，能够找到彼此、直接发送 Message，并通过 Topic 持续推进一项跨 Agent 工作以后，多个 Agent 已经开始像一支 Team 那样协作。

但这支 Team 并不会因此稳定下来。

第一章里我们提到，Domain 不是在创建 Agent 的那一天就能准确画出来的。它是在长期真实工作中，随着 Scope 扩张、能力劣化和协作摩擦，逐渐暴露出来的责任边界。

而且，这个边界还会继续变化。

模型能力提升以后，过去必须拆开的工作，也许可以重新放到一个 Agent 中。

新的工具出现以后，一个 Agent 能够承担的责任可能变大；业务进入新的阶段，会产生新的任务、依赖和风险；外部环境变化，也可能让原本稳定的流程和权限边界突然失效。

Agent 本身也在发展。

它会在长期工作中积累新的经验，被 Human 反复纠正，形成新的 Skill、Memory 和工作方法。随着能力与可靠性发生变化，Human 对它的使用方式也会改变。

所以，Agent Team 不是一张设计完成以后就不会再变的组织图。

Profile、Organization 和 Collaboration 保存的，是这支 Team 当前采用的组织假设。它们先提供一个共同工作的基线，再由后续真实工作继续检验和修正，而不是成为永久正确的答案。

真实工作仍然可能不断暴露新的失配：

- 某个 Agent 的 Scope 变得过大，长期满负荷运行，逐渐成为整支 Team 的瓶颈
- 两个 Agent 虽然已经分开，却花费大量时间反复解释和通信，说明它们的边界可能切错了
- 一个新 Agent 被创建出来，却长期没有真实工作进入
- 声明上互不相关的两个 Domain，在实际工作中却频繁协作
- 问题看起来像 Agent 数量不足，实际原因却可能是工具、方法、路由、权限或者外部 Connector 出了问题

这意味着，建立 Agent Team 不是一次性的设计任务，而是一项持续发生的管理工作。

真正的问题也不再只是：

__*最初的问题*__

*Human 怎样知道这支 Team 实际是怎么工作的？*

而是：

__*真正的治理问题*__

*Human 怎样知道当前的 Agent Team 是否仍然适合正在发生的工作？*

*当声明的结构与真实运行开始出现偏差时，又怎样找到可以调查和调整的抓手？*

这也是 CodexLoom 为什么需要 Overview。

### 管理的前提，是先让问题暴露出来

Human 的注意力是有限的。

当 Team 中只有两个 Agent 时，我还可以分别打开它们的 Thread，看看最近做了什么、卡在哪里、有没有跑偏。

当 Agent 变成十个、二十个以后，这种方式就会失效。

如果我仍然试图阅读每个 Agent 的完整过程，很快就会被信息淹没。

更糟的是，我花了大量时间理解局部细节，却不一定能看见 Team 层真正的问题。

这和管理一支 Human Team 很像。

管理者不可能通过阅读每个人的全部工作记录来管理组织。Team 越大，就越需要先从更高的层级观察运行，让值得关注的问题暴露出来，再沿着证据向下调查。

在精益管理里，可视化不是把更多数据堆到屏幕上，而是让问题先显露出来。

Overview 提供的，就是这样一个运行观察与分诊入口。

它不是一张用来展示“今天运行了多少 Agent”的热闹 Dashboard，也不是给 Agent 做绩效排名。

它更不会自动告诉我应该拆分、合并或者替换哪个 Agent。

它把原本散落在 Agent 状态、Codex Turn、Needs You、Inbox、外部 Connection、队列和 Token 记录中的运行信号，压缩到同一个入口。

时间范围、时区、追踪覆盖、图例和 Data quality 会和这些信号一起出现，让 Owner 知道自己现在看到了什么，又有哪些工作可能没有被当前数据覆盖。

这里有一个很重要的管理选择：Overview 首先度量的是工作怎样发生、等待和流动，而不是评价 Agent。

指标的作用，是帮助 Owner 理解并改善系统，而不是把每个 Agent 排成名次。

如果公司里有 HR 管理 Human Resource，那我自己开玩笑，会把这里叫作 AR，也就是 Agent Resource。

这也是我做 CodexLoom 时最在意的一层：不仅让 Agent 工作，还要让一支持续变化的 Agent Team，可以被 Human 观察、理解和持续调整。

### Status：现在发生了什么

Overview 的 Status 先回答最直接的问题：现在有哪些 Agent 正在执行，哪些事情正在等待 Human，内部 Inbox 是否出现积压，外部 Connection 或处理过程是否留下了需要关注的问题。

在它下面，Daily Activity 会按照时间，把记录到的执行、Turn 和 Token 对齐到 Team 与各个可追踪 Agent 的活动行中。

我可以从这里看到，某一天的工作主要集中在哪些时段，什么时候出现了多个 Agent 并行工作的波次，以及记录到的活动主要分布在哪些 Agent 身上。

至于这种集中是不是已经成为长期模式，还需要继续比较多个日期和观察窗口，不能从一天的页面直接得出结论。

但 Activity 只能说明当前被记录到的工作。

一个 Agent 没有出现在活动行里，可能是它没有进入真实工作，也可能是对应的 Codex rollout 无法读取，或者当前数据覆盖并不完整。

多个 Agent 并行时，汇总的 Agent 执行时间甚至可能超过自然墙钟时间。

所以，低 Activity 不等于低价值，高 Activity 也不等于高绩效。

它只是让我知道：这里可能值得继续调查。

Overview Status 显示四个摘要、日期、八名 Agent 的 30 分钟活动时间轴、图例、Tracked 8/8 和 Asia/Shanghai。

*当前产品界面 · 隔离构造工作区。Status 和 Daily Activity 压缩当前状态与记录到的执行节奏；Tracked、时区和图例限定读数范围。这些是调查信号，不是绩效评分。*

### Capacity：哪里正在形成等待和积压

Status 告诉我工作在哪里发生，Capacity 则进一步展示记录到的 Turn 执行、新工作等待、当前 backlog、工作来源和排队证据。

其中我比较关注一个指标，叫 New\-work wait。

它看的不是“一条消息多久得到回复”，而是一项新的可追踪工作进入队列以后，过了多久才第一次真正开始处理。

这项新工作可能来自另一个 Agent 的 Message，也可能来自 External Inbox、Needs You、Schedule 或 Trigger。

Capacity 还会展示当前 backlog：此刻有哪些可追踪工作仍然在排队或处理中。

需要注意的是，它是当前快照，不是对过去所有队列的完整重建。

精益管理区分资源效率和流动效率。

资源效率关注每一个局部是不是被充分利用；流动效率关注一项工作能不能端到端地顺畅向前。

对 Agent Team 也一样：一个 Agent 时刻满负荷，却让所有下游都在等待，并不是值得追求的高效率。

它可能只是把局部的忙碌，变成了整支 Team 的瓶颈。

如果在连续多个观察窗口中，同一个 Agent 的被记录执行反复集中，指向它的新工作等待较长，而且当前仍然存在 backlog，我会得到一组值得调查的瓶颈候选信号。

但我不会立刻得出“它已经成为瓶颈”的结论。

我会先查看对应的 queue evidence，确认究竟是什么工作在等待。

再进入相关 Agent 和 Messages，并通过 Loom 中的 Topic 等其他入口，检查其他工作是否真的依赖它，以及阻塞发生在哪一层。

只有在这些证据能够互相印证时，我才会进一步追问：这个 Agent 是否正在成为 Team 的瓶颈？

即使答案是“是”，原因也仍然可能完全不同。

可能是 Domain 太大，也可能是工作方法低效、缺少工具、权限卡住、外部 Connector 失败，或者上游把不属于它的任务全部路由了过来。

Capacity 提供的是调查入口，不是自动诊断。

Overview Capacity 页面显示五个 signal cards、时间图、来源分布和 Agent table。Data quality 说明 Capacity 统计口径与已知限制。

*当前产品界面 · 隔离构造工作区。Capacity 将 recorded execution、new\-work wait 与 current backlog 放在同一观察面，帮助 Owner 选择下一步调查对象；单个页面不能证明瓶颈、历史趋势、利用率或原因。*

它还会显示一项 calendar non\-executing proxy，也就是日历时间中没有被记录为 Turn 执行的部分。

但它可能同时包含机器关机或者服务停止的时间，因此不能直接理解为“Agent 的空闲产能”，更不能据此判断还能向它塞入多少工作。

### Token Usage：计算投入主要去了哪里

Token Usage 展示记录到的 input、cached input、output、reasoning output 和 model calls，以及这些计算量在日期、Agent 和模型之间的分布。

我可以从这里看到，哪些 Agent 或 Organization 分组的计算投入比较集中，缓存怎样被使用，不同模型主要被用在了哪里。

但 Token 多不代表一个 Agent 更重要，也不代表结果质量更高。

它能提供的，是另一个继续调查的入口：某个 Agent 的 Context 是否过大，是否存在重复工作，模型组合是否合理，或者这个 Domain 本身是否确实需要大量研究和推理。

最终仍然要结合真实产物与业务结果判断，而不是只看 Token。

Overview Token Usage 页面显示总量、每日堆叠图、图例和各 Agent 的 allocation。

*当前产品界面 · 隔离构造工作区。Token Usage 展示选定时段内不同 token 类型、模型调用和 Agent allocation 的分布；它不等于成本效率、质量、重要性或业务价值。*

### Overview 不会自动理解组织

这里还有一个必须说明的产品边界。

CodexLoom 的 Team 页面保存 Agent 的 Profile、Organization 和 Collaboration，也就是当前声明的责任与关系；Overview 保存的是运行状态、活动、执行、排队和计算投入等观察证据。

当前产品不会自动读取 Profile 中的 Domain 和 Scope，判断实际工作有没有超出边界；也不会把 Collaboration 与真实 Activity 自动对照，然后告诉我哪条关系已经失效。

把声明结构与运行证据放在一起理解，是 Owner 的工作。

我可能先从 Overview 发现某个 Agent 的等待正在上升，然后回到它的 Profile 和 Organization，检查它是否承担了超出当前 Scope 的工作。

也可能先在 Team 页面看到一条长期 Collaboration，再回到 Activity 与 Message，观察它是否真的进入了日常工作。

Overview 不替我完成这个判断，但它让这种判断有了可以追踪的证据入口。

### Signal 不是 Diagnosis

Overview 最重要的价值，不是替 Owner 得出结论，而是把问题暴露出来。

忙不代表有价值，低执行不代表无用，Token 多不代表结果更好，等待也不自动证明 Agent 数量不够。

所以，Signal 不是 Diagnosis。

Owner 需要先从 Overview 把范围缩小到某个日期、Agent 或排队来源。

Overview 可以直接打开部分 Agent、External Inbox、Needs You，以及通用的 Messages 入口；Topic、具体 Turn、Artifact 与业务结果，则需要通过 Loom 的其他页面、对象 ID 和因果关系继续调查。

然后，Owner 还需要询问负责 Agent 怎样理解问题。

最后的干预也不一定是拆分或增加 Agent。

方法有问题，可以修改 Skill 和工作方式；工具不足，可以补工具；路由错误，可以调整 Collaboration；权限造成阻塞，可以修正授权门。

只有当问题长期、反复地来自 Domain 边界，才需要考虑拆分、合并或重新划分责任。

然后，还要继续观察后续的真实工作，判断这次调整是否真的解决了问题，还是只是让某一个局部指标暂时变得更好看。

这不是一次性的组织设计或者 Reorg，而是一轮持续改善：先让问题显露出来，再调查原因，试行一个尽量小、可逆的调整，然后用后续真实工作检查结果。

所以，一套更完整的治理循环是：

__*治理循环*__

*发现 Signal → 下钻 Evidence → 判断原因 → 选择干预 → 用后续真实工作验证。*

Signal 进入多条 Evidence 记录，再汇聚到 Human Diagnosis、Small Change，并沿 Next Work 回到新的观察。

*机制示意：运行信号先缩小调查范围，再沿证据下钻，由 Human 判断原因、尝试小幅可逆调整，最后用下一轮真实工作验证。Signal 不是 Diagnosis。*

这个循环属于 Human 使用 CodexLoom 的治理方法，不是 Overview 已经自动执行的产品流程。

改善成立以后，新的做法才进入 Profile、Organization、Collaboration 或 Skill，成为下一轮工作的基线。

完整的 Agent Team Governance 会比这复杂得多，我们会在后面的文章里专门讨论。

在这篇文章里，我更想说明的是：

__*Human 的新位置*__

*Human 没有从 Agent Team 中消失，而是从每一段工作的人工 Router，上移成了观察、追问、诊断和调整整支 Team 的 Owner。*

Agent Team 不是为了把 Human 排除在外，而是为了让 Human 的注意力用在真正需要人的地方。

当内部 Team 已经能够长期负责、直接协作、持续收口，并且可以被 Human 看见和治理以后，下一个问题才是：

这些能力，怎样进入客户、社区、合作伙伴，以及 Slack、飞书这些真实的外部环境？

## 06 Agent Team 怎样进入真实的外部关系

当内部的 Agent Team 能够长期负责、直接协作、持续收口，并且可以被 Human 看见和治理以后，我自然会走到下一个问题：

__*下一个问题*__

*这些 Agent 能不能不只帮助我完成内部工作，也能够直接帮助我服务外部？*

对个人来说，真正稀缺的资源仍然是自己的时间和注意力。

每天可能会有人来讨论问题、询问信息或者寻求帮助。我也需要服务用户、参与社区、回应客户，或者为合作伙伴和公司里的其他部门提供专业能力。

如果这些对外工作最终都必须回到我本人，由我理解需求、组织内部 Agent、检查结果，再亲自回复，那么无论内部 Agent Team 多么强大，它提升的仍然主要是我的个人效率。

我的能力，仍然被我一个人的时间限制住。

但在长期工作中，一些 Agent 已经逐渐形成了稳定的 Domain 能力。

它们不只是临时调用模型回答问题，而是长期理解同一类工作，积累自己的信息来源、工具、方法、历史判断和停止边界。

内部 Team 也可以通过 Profile 和声明关系，查询谁可能负责哪类问题，以及结果应该回到哪个既有工作链路。

如果这些能力只能被我在内部调用，它们仍然只是我的私人生产力工具。

只有当这些成熟的 Domain 能力可以在明确身份和责任边界下进入外部，它们才可能开始持续服务客户、社区、协作者或者其他部门。

这时，Agent 带来的就不只是效率提升，而是能力扩展。

一部分原本只能由我本人提供的能力，开始可以由一支 Agent Team 持续交付。

这就是我做 External 的原因。

### Agent 一旦对外，风险模型就变了

但是，让 Agent 参与内部工作，和让它进入真实的外部关系，并不是同一件事。

在内部，我非常熟悉自己的 Agent。

我知道它擅长什么、容易在哪里犯错，知道哪些表达只是候选判断，哪些结果已经经过核验。即使它说了一句不准确的话，我也可以继续追问、纠正、重做，或者根本不采用。

我们之间已经存在许多不需要每次说出来的合作默契。

一旦 Agent 对外，这些默契就不存在了。

外部的人并不了解这个 Agent。

他不知道它过去接受过哪些纠正，也不知道它的知识和权限边界，更无法自然分辨一句话究竟是草稿、推断、正式答复，还是可以代表我作出的现实承诺。

同一句不准确的话，在内部可能只是一次容易修正的工作误差；到了外部，却可能被理解成产品事实、组织立场或者已经成立的承诺。

而且，外部输入本身也不能被默认信任。

有人可能提供错误背景，试探 Agent 能看到什么、可以做什么，诱导它披露内部信息，要求它绕过原有规则，甚至主动尝试攻击这个 Agent。

这时，一条进入 Agent 的消息就不再只是一个普通 Task。它也可能是一段带有错误前提、越权意图或者对抗性的输入。

所以，External 要解决的从来不只是“消息能不能进来，结果能不能发出去”，而是五个更具体的问题：

- 谁在代表这支 Agent Team
- 它在当前外部关系中扮演什么角色
- 什么输入可以触发它，它又可以回答或行动到哪一步
- 需要其他专业能力时，怎样调用内部 Domain Team，并让结果回到原来的关系
- 什么情况必须停止，把事实、选择、Review 或授权交回 Human

左侧 Internal correction loop 与右侧多种不确定 External input 被一条垂直 Trust Boundary 分隔，输入从 Governed Entry 进入。

*机制示意：内部协作建立在长期纠正与熟悉边界上；外部输入可能带有错误前提、越权意图或对抗性。受管入口改变通信路径，但不是完整安全隔离。*

这也是为什么 CodexLoom 的 External 看起来远比“接一个 Bot”复杂。

### 外部只面对一个受管入口

CodexLoom 不会把一个 Provider Bot 直接接到整支 Agent Team。

外部用户通过已经配置的 Address 和 Membership，进入拥有这个 Address 的长期 Agent，而不是获得内部 Profile、Organization、Collaboration、Thread、工具或凭证的直接入口。

这个入口通常由一个长期 Agent 承担。

这里的 Interface Agent 不是 CodexLoom 中一种写死的 Agent 类型，而是一种组织形态：某个 Agent 长期负责理解特定外部关系，并把外部需求与内部 Domain Team 连接起来。

有时，Domain Agent 可以直接持有这个外部入口。比如商务关系本身就是它长期专业 Context 的一部分。

有时，对外身份、受众理解、渠道适配、隐私和反馈回流会形成一套独立责任，这时才值得由 Community Agent 这样的 Agent 专门承担 Interface。

但“外部只有一个入口”并不等于已经获得完整安全隔离。

承载这个入口的 Agent 仍然在自己的 primary Thread 中工作，那里可能已经存在内部历史、工具和本地权限。

如果入口 Agent 选择错误、权限过宽，或者角色和 guidance 设计不当，仍然可能带来泄露和越权。

所以，不同信任边界是否应该使用独立 Agent，这个 Agent 应该拥有多少 Context 和工具，以及如何配置 sandbox、approval 与最小权限，仍然是真实的组织和安全设计。

### 同一个 Agent，在不同 Conversation 中也不是同一个角色

CodexLoom 把外部连接、外部身份和具体关系中的局部角色分开保存。

Connection 建立一个 Provider app、bot、account 或 tenant 的连接、能力和健康状态。

它只是平台连接与能力入口；消息能否进入、结果能否发出，还取决于 Address、Membership、Connector 能力和当时的运行状态。

Agent Address 则把一个外部 identity 绑定到一个长期 Agent，回答“究竟是哪一个 Agent 以这个身份出现在外部”。

同一个 Address 进入不同群、频道或者私聊时，使用的仍然是同一个外部身份，但它在每个 Conversation 中可以拥有不同的局部角色和通信策略。

这些差异由 Conversation Membership 保存。

Membership 会记录这个 Agent 在当前 Conversation 中为什么存在、扮演什么角色、应该遵循什么 guidance，以及几类重要的通信边界：

- 什么样的入站消息可以触发它
- 它的结果怎样映射成外部回复
- 它只能回复已有问题，还是也允许主动发送
- 这个 Conversation 使用什么 trust\-domain 标签

一份 Membership 只适用于它对应的 Conversation。

Agent 在一个飞书群里被允许主动发送，不代表它自动获得另一个群、另一个平台或者另一个外部身份中的相同行为边界。

但 Membership 解决的是局部角色和通信策略，不是完整权限系统。

它不会给每个 Conversation 创建独立 Thread，不授予仓库、文件、凭证或部署权限，也不会自动识别机密、现实承诺和业务风险。

trust\-domain 只是用于记录和约束的标签，不是安全沙箱。

Agent 的长期身份可以保持稳定，但它在每段外部关系中的局部角色和行为边界，必须分别治理。

CodexLoom External 页面显示已连接的飞书身份、启用的匿名 Membership，以及 When mentioned、Send final answer、Proactive \+ replies 策略。

*当前产品界面 · 匿名真实运行记录。一个已连接的飞书身份及其已启用 Conversation Membership。Membership 保存该 Conversation 的局部角色与 mention、reply、outbound 策略；名称与标识已匿名。*

### 外部请求怎样调用背后的 Agent Team

当一个外部消息满足当前 Address、Membership 和触发条件以后，它会进入拥有这个 Address 的长期 Agent，而不是自动分发给整支 Team。

完整链路大致是：

Provider event  
    ↓  
Connection / Address / Membership  
    ↓  
Inbox / Handling  
    ↓  
Interface Agent primary Thread  
    ↓  
可选的内部 Agent 协作  
    ↓  
Outbox  
    ↓  
provider result/ receipt

Identity、Membership、Interface、Internal Team、Human、Outbox 和 Delivery 以分层协议结构连接。

*机制示意：External 不是接上一个 Bot。Identity、Conversation Membership、Interface、可选的 Internal Team 协作、Human 边界、Outbox 与 Delivery 分别保存不同责任。*

Inbox 和 Handling 会记录外部实际送来了什么、由哪个 Agent Turn 按哪一个 Membership version 处理。

Interface Agent 可以结合 Membership context 和当前输入，判断请求是否属于范围、还缺少什么 Context，以及是否需要停止，或者向内部 Agent、Lead、Coach 或 Human 求助。

这些仍然是 Agent 的判断，不是 Membership 自动完成的诊断或授权。

如果问题需要其他专业能力，Interface Agent 可以查询内部 Profile 和声明关系，再通过 Agent Message 或 Topic，把一段有边界的工作交给候选 Domain Owner。

External 不会根据 Profile、Organization 或 Collaboration 自动替它选择正确的内部 Agent。

研究问题仍然由 Research Agent 判断，产品事实仍然由 Product Agent 核验，页面和生产结果仍然由 Web Agent 负责。

Interface Agent 不会因为接住了外部请求，就成为所有专业事实的新 Owner。

它拥有的是外部入口、意图翻译、内部路由、受众表达和结果回流，而不是背后每个 Domain 的事实所有权。

内部结果通过 Message 或 Topic 回到 Interface Agent。

它再依据当前 Membership 的 role、guidance 和 outbound policy，以及当前公开边界与实际授权，判断是否创建 Outbox，把结果送回原来的 Conversation。

内部 Domain Agent 不会绕过这个外部角色，直接获得向 Provider 发送结果的权力。

Outbox 会保存目标、内容、幂等信息、发送尝试、状态和 Provider 返回的结果，使这次外部动作可以被追踪和核对。

但 CodexLoom 执行和记录的是已经请求的外发，不会自动验证这次动作拥有的授权是否充分。

Provider receipt 也只能证明 Connector 或 Provider 当时返回了相应的 message 或 attachment 标识，并被 Loom 保存下来。

它不代表对方已经阅读、理解、接受，更不代表结果正确或者产生了业务效果。

CodexLoom Inbox 显示一条匿名飞书消息为 handled，处理尝试为 1，使用 Membership v2，并显示 Reply sent。

*当前产品界面 · 匿名真实运行记录。来自同一匿名 Conversation 的入站消息已进入 Community Agent 的处理记录；UI 保留 handled、attempt、Membership 版本、Context used 与 Reply sent。*

CodexLoom Outbox 显示一条匿名飞书回复为 sent，尝试次数为 1，并保留已脱敏的 provider message result。

*当前产品界面 · 匿名真实运行记录。同一入站消息产生的出站回复已进入 Outbox，并记录 sent、尝试次数与 provider message result。它不证明对方已读、理解、接受或采取行动。*

### Human 保留的是外部后果的边界

External 不是让 Agent 无限制地跑到外面自主行动。

知道一个答案、可以起草一段表达、可以回复已有问题、可以主动发布、可以代表别人作出承诺，以及可以执行具有现实副作用的动作，是完全不同的权限层级。

一个 Agent 长期承担某个 Interface，只说明它负责判断和收口，并不会自动获得更高一级的行动权。

当 Agent 判断工作缺少事实、选择、Review 或授权时，可以主动用 Needs You 暂停当前工作，并向 Human 提出一个明确问题。

但当前产品不会因为内容敏感而自动创建 Needs You，也不会在 Outbox 发送前，自动验证某个 Needs You 的回答是否充分授权了这次外发。

真实授权是否存在、范围是否足够、是否仍然适用于当前动作，仍然需要 Agent 和工作流诚实执行。

Human 不再负责搬运每一段 Context，但仍然拥有外部后果的最终边界。

### 回到开头那次意外外发

现在再回到文章开头。

这次 Landing 外发并不是一个外部请求经过 Inbox 进入 Agent Team 的案例。它走的是另一条主动外发路径。

Web Agent 完成 Landing Page 的上线和验证以后，把正式 URL、可以公开的事实、素材状态和已知限制，通过一条内部 notification 交给 Community Agent。

Community Agent 在自己的长期 Thread 中检查当时的渠道 Context 和 Membership，独立判断这件事是否值得发送、应该发到哪里，以及怎样为不同受众组织表达。

它随后分别为飞书和 Parall 创建了 proactive Outbox。两个 Provider 返回的 message 和 attachment 信息被保存成 receipt。

允许主动发送的 Membership 约束了这次通信路径，但它不是授权本身。

这次外发依赖的是此前已经存在的 Owner 与组织决定，CodexLoom 并没有从 receipt 反推出授权是否充分。

完成以后，Community Agent 又通过一条 completion notification，把渠道判断和投递结果带回 Web Agent 所在的原工作链路。

这段时序还有一个重要边界：Landing 的 site\-live 协调事项已经先完成收口，外部分发是随后发生的工作。

不能因为后来保存了 Outbox 和 receipt，就反过来说原 Topic 等待并确认了这次外发。

我看到消息时感到意外，是因为这一次不再需要我亲自站在 Web Agent 和 Community Agent 中间。

但它并不是一次没有边界的自主行动。

Web Agent 只对页面和生产结果负责；Community Agent 只对渠道、受众和外部表达作判断。

主动外发经过具体 Membership 和 Outbox；结果和 evidence 又回到了原来的工作链路。

所以，External 真正解决的不是“怎样让 Agent 自动发消息”。

它解决的是：

__*External 的核心问题*__

*怎样让一个长期 Agent 以明确身份、局部角色和可检查的行为边界，进入一段不完全可信的真实关系？*

*需要内部专业能力时，它可以调用背后的 Agent Team，但外部表达、权限和现实后果仍然从同一个受治理入口收口。*

当成熟的 Domain 能力可以通过这样的 Interface 进入外部，同时保留可检查的外部身份、Conversation policy、Human 决策点和结果回流记录，

Agent Team 才开始从一套内部生产力系统，变成一种能够持续对外交付的组织能力。

## 07 CodexLoom 在织什么

现在再回头看文章开头那次意外外发，真正让我觉得有价值的，并不是“Agent 居然可以自动发消息”。

自动化并不等于 Agent Team。

如果只要按照一条预先写好的 Workflow，从第一个 Agent 运行到最后一个 Agent，就可以称作 Team，那么我们只是把原来的程序节点换成了 Agent。

这次不一样的地方在于，参与其中的是几个长期存在、拥有不同专业 Context 和责任边界的 Agent。

它们没有把所有事情都做完，而是在自己的边界停止，把下一段工作交给更合适的 Domain Owner；结果完成以后，又沿着原来的工作链路继续向前。

整个过程中，我没有站在几个 Agent 中间，亲自选择每一个下一步，复制每一段 Context，再把一个 Agent 的结果转述给另一个 Agent。

但我也没有从系统中消失。

方向、重要事实、Review、公开边界和关键授权仍然属于 Human。

Overview 让我从更高的层级观察 Team，发现哪里可能正在形成新的问题；当模型、工具、业务和外部环境变化时，我也仍然需要继续调整 Agent 的 Scope、关系和工作方法。

Human 不再是每一段工作的唯一 Router，但仍然是整支 Team 的 Owner。

这里有一组看起来矛盾、但对 Agent Team 很重要的关系：

__*稳定的 Agent，动态的 Team。*__

五条稳定 Agent thread 进入不规则 Dynamic Team surface，Human Owner 在一侧 Observe 与 Adjust，结果沿 Validate records 回到下一轮。

*机制示意：稳定的是长期责任主体，动态的是当前组织假设。Human Owner 通过观察、调整和后续真实工作验证，让 Team 随模型、工具、业务和外部环境持续演化。*

Agent 要足够稳定，才能在自己的 Domain 中积累经验；Team 又必须足够动态，才能适应模型、工具、业务和外部环境的变化。

稳定的是长期责任主体，动态的是当前组织假设。

所以，从 Multiple Agents 到 Agent Team，真正发生的不是 Agent 数量的变化。

而是原本全部集中在 Human 脑子里的责任、关系、交接方式、当前状态和边界，开始被逐渐外化，成为整个 Team 可以查询、使用和持续验证的工作结构。

这也是 CodexLoom 想做的事情。

Codex 已经提供了一条条非常强大的 Thread。

CodexLoom 并不是重新做一个更强的 Agent，也不是让你同时打开更多 Thread。

它希望：

- 让一条 Thread 成为一个长期存在的 Agent，让这个 Agent 拥有稳定的 Identity、Domain 和 Scope
- 让不同 Agent 能够查询彼此的 Profile 和声明关系，通过 Message 直接协作
- 让跨 Agent 的工作通过 Topic 保存一个由 Responsible 维护的当前版本
- 让 Human 在真正需要事实、选择、Review 和授权时重新进入
- 让 Owner 可以通过 Overview 观察 Team 的真实运行
- 最后，再通过受治理的 External，把内部能力带入客户、社区和协作关系

这些能力单独拿出来，都不能自动创造一支 Agent Team。

- Profile 只是一份当前组织假设
- Message delivered 不代表工作正确
- Topic resolved 不代表所有现实结果已经完成
- Overview Signal 不是 Diagnosis
- Membership 不是权限或安全沙箱
- External receipt 不代表对方已经阅读、接受或者产生了业务效果

真正的 Team，仍然是在持续的真实工作中形成的。

这支 Team 是否真的成立，需要继续观察几个问题：

- 责任是不是清楚
- 协作是不是有效
- Human 是否仍然被迫充当唯一 Router
- 某个 Agent 是否正在成为瓶颈
- 对外行为有没有越过真实授权

所有这些，都需要在后续工作中不断验证和调整。

这不是一次性的 Reorg，而是一轮持续改善。

真实工作先让等待、返工、过载和边界冲突显露出来，Human 再做尽量小、可逆的调整，并用下一轮工作验证。

只有真正成立的改变，才继续沉淀进 Profile、Organization、Collaboration 或 Skill，成为新的工作基线。

因此，我理解的 Agent Team，不是一张静态组织图，也不是一次 Workflow 中临时拉起的多个 Agent。

它是一组长期存在的责任主体：各自在自己的 Domain 中积累经验，知道自己负责什么、在哪里停止；需要协作时能够找到彼此、直接沟通并持续收口。

由 Human 保留方向和关键边界，并且随着真实工作不断演化。

这篇文章只给出了这套工作方式的全景。

后面的文章会继续展开这些问题：

- Long\-running Agent 怎样在 Compaction、Memory 和 Human correction 中保持连续
- Agent Team 怎样从摩擦中发现 Scope 问题、调整能力和组织
- 跨系统的 Agent 协议如何连接
- External Interface 怎样长期治理

但至少现在，我们可以更准确地回答文章开头的问题：

__*最终问题*__

*多个 Agent，什么时候才真正成为一支 Team？*

不是当它们同时开始运行。

而是当它们开始长期承担不同责任，能够找到彼此、直接协作、持续收口，并在 Human 的治理下共同推进真实工作。

从一个 Codex Thread，到一支长期负责、能够协作、可以治理，也能够进入真实世界的 Agent Team。

这就是 CodexLoom。

__Loom Your Codex\.__

