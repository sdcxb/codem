/**
 * 变异自证（GAP-LIST `O-42` / 判据 `UNREAD-V1` / `UNREAD-V2` / `UNREAD-V3` / `XSESS-3b`）。
 *
 * ## 这波要证明什么
 *
 * `O-42` 的实质是**时序**：写消息必须让计数**同步可见**，标未读必须发生在**写之后**，
 * 于是 `markSessionUnread` 走精确分支（水位不动、未读恰好 1）；而"计数不可见"的调用点
 * 仍然必须走兜底分支（恰好踩一格，保住"至少 1 条"）。两条不变量互为反向对照，
 * 所以这一波的变异按"每一处可观察行为各来一条真的坏法"排：
 *
 * | 变异 | 坏法 | 必须红在哪 |
 * | --- | --- | --- |
 * | MUT-1 | 读模型不再把本次写入算进去（"同步可见"消失） | `UNREAD-V1` |
 * | MUT-2 | 精确分支改回"踩一格"（计数可见时多显示 1 条） | `UNREAD-V1` / `XSESS-3b` |
 * | MUT-3 | 兜底分支不生效（计数不可见时一条都不显示） | `UNREAD-V2` |
 * | MUT-4 | 兜底"相对水位踩一格"（漂移态下未读算成 0） | `UNREAD-V2` |
 *
 * ## ⚠️ 如实记账：`countVisible` 这个入参**没有**对应的变异（量过，不是漏了）
 *
 * 本波的目标是"把注释里那句『什么时候该改回去』变成机器条件"，所以理想情况是
 * 「把同步可见的判据钉死」也能被判据抓红。**实测做不到**，原因是这一波在写变异时读出来的结构：
 *
 * `markSessionUnread` 的三支由 `known` 与 `prev` 的大小关系决定：
 * - `known > prev`（**写后计数可见**的形态，正是 `O-42` 要修的那一支）⇒ 上面的守卫直接返回
 *   "什么都不做"，**不经过** `countVisible`；
 * - `known === prev` ⇒ 只有这一支经过 `countVisible`，而"计数可见"的调用点在这一支上被
 *   守卫与兜底**同时**判成"什么都不做"（水位本来就不该动）；
 * - `known < prev`（漂移）⇒ 走兜底，也与 `countVisible` 无关。
 *
 * 也就是说：把 `Boolean(persist) && persisted` 钉死成 `false`，**所有既有判据照样绿**
 * （实测：写成 MUT-5 之后 `UNREAD-V1/V2/V3` 全绿）。一条恒定绿的变异等于没测，
 * 所以这里**不写它**，改为在代码注释里如实记账（`session-read-state.ts` 的
 * `markSessionUnread` 与 `loop-owned-message.ts` 的调用点各有一处说明）：
 * `countVisible` 今天是**保守缺省**（判据缺省退到"宁可多显示 1 条"那一侧），
 * 而不是一条能判红的机器条件；`O-42` 的真实修复落在**顺序 + 同步读模型**上，
 * 那两处各有一条能红的变异（MUT-1 / MUT-2 / MUT-3 / MUT-4）。
 *
 * 锚点都是当前源码里**唯一命中**的一段原文（LF 归一化后匹配；本仓检出是 CRLF）。
 */
export default {
  description:
    "O-42：写消息 → 读计数同步可见 ⇒ 标未读走精确分支（水位不动、未读恰好 1）；计数不可见时兜底恰好踩一格",
  mutations: [
    {
      id: "MUT-1 去掉「写入即刻算进读模型」（同步可见消失）",
      why:
        "UNREAD-V1：写路径不再维护会话计数增量 ⇒ 写入返回时 getSession().messageCount 停在旧值，" +
        "未读徽标拿不到写入后的真值（这条判据必须红，否则它没在测「同步可见」这件事）",
      patches: [
        {
          file: "src/core/storage/message.ts",
          from: "  const counted = hasMirrorContract && noteMessageWroteToMirror(sessionId, message.id);",
          to: "  const counted = false;",        },
      ],
      tests: ["src/test/session-unread-count-visibility.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 精确分支改回「踩一格」（计数可见时多显示 1 条）",
      why:
        "UNREAD-V1 / XSESS-3b：去掉 countVisible 分支 ⇒ 计数同步可见时水位仍被踩到 anchor - 1，" +
        "计数涨上来之后未读变成 2 而实际 1 条 —— 这正是 O-42 记的那个偏差",
      patches: [
        {
          file: "src/core/session/session-read-state.ts",
          from: "  if (countVisible) return false;",
          to: "  if (false) return false;",
        },
      ],
      tests: ["src/test/session-unread-count-visibility.test.ts", "src/test/loop-owned-message.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 兜底分支不生效（计数不可见时一条都不显示）",
      why:
        "UNREAD-V2：计数不可见时不再踩那一格 ⇒ 水位停在条数上，`unreadFor` 算出 0，" +
        "那条消息在计数涨上来之前**静默丢**（这条判据必须红）",
      patches: [
        {
          file: "src/core/session/session-read-state.ts",
          from: "  const target = Math.max(0, known - 1);",
          to: "  const target = Math.max(0, known);",
        },
      ],
      tests: ["src/test/session-unread-count-visibility.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 兜底基准改成「相对水位踩一格」（漂移态下未读算成 0）",
      why:
        "UNREAD-V2：兜底改成按 prev 踩一格 ⇒ 漂移态（水位被 ChatPanel 的 Math.max(...) 推高过）下" +
        "目标水位停在「旧计数」附近，未读数算成 0 —— 兜底失效，那条消息一条都不显示",
      patches: [
        {
          file: "src/core/session/session-read-state.ts",
          from: "  const target = Math.max(0, known - 1);",
          to: "  const target = Math.max(0, prev - 1);",
        },
      ],
      tests: ["src/test/session-unread-count-visibility.test.ts"],
      expectRed: true,
    },
  ],
};
