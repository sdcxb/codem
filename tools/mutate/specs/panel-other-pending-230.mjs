/**
 * 变异自证（第 230 波 · 判据 `MOP-1`…`MOP-5`）：记忆面板「本处 0 条、别处还有」那一行。
 *
 * ## 这波要证明什么
 *
 * 那一行是**读数**，它的价值全在"条件与数字都对"。所以每一处可观察错误各来一条真的坏法：
 *
 * | 变异 | 坏法 | 必须红在哪 |
 * | --- | --- | --- |
 * | MUT-1 | 条件恒真（去掉 `globalPending > 0`） | `MOP-2`（本处>0 不该出现）/ `MOP-3`（空库不该出现） |
 * | MUT-2 | 条件恒假（改成本处>0 才显示） | `MOP-1`（本处 0 时必须出现） |
 * | MUT-3 | N 换成本地数（`stats.pendingEntries`） | `MOP-1` / `MOP-4`（数字必须等于闸门口径） |
 * | MUT-4 | N 换成常量 0 | `MOP-1` / `MOP-4` |
 * | MUT-5 | 取数口径换成"面板那个统计数"（两处口径分叉） | `MOP-1` / `MOP-4` |
 * | MUT-6 | 把「本处」那份换成全项目（`showAllProjects`）⇒ 别处的条目泄进面板 | `MOP-4` / `MOP-2` |
 *
 * 锚点都取"当前源码里**唯一命中**"的一段原文（本仓检出是 CRLF，运行器按 LF 归一化匹配并还原行尾）。
 */
export default {
  description:
    "第 230 波：本处待批准 0 条而全局 >0 时补一行读数的判据（MOP-1..5），6 条变异各改坏一处",
  mutations: [
    {
      id: "MUT-1 条件恒真（去掉 globalPending > 0）",
      why:
        "MOP-2 / MOP-3：本处有待批准、或库内一条都没有时也会渲染 —— 那行字会开始解释一个不存在的积压",
      patches: [
        {
          file: "src/components/MemoryManager.tsx",
          from: "{pending.length === 0 && globalPending > 0 && (",
          to: "{true && (",
        },
      ],
      tests: ["src/test/memory-other-projects-pending.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-2 条件恒假（改成本处 >0 才显示）",
      why: "MOP-1：本处 0 条、全局 3 条时那一行不出现 —— 用户又看不到「别的项目还有积压」这个事实了",
      patches: [
        {
          file: "src/components/MemoryManager.tsx",
          from: "{pending.length === 0 && globalPending > 0 && (",
          to: "{pending.length > 0 && (",
        },
      ],
      tests: ["src/test/memory-other-projects-pending.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-3 N 换成本地数（stats.pendingEntries）",
      why: "MOP-1 / MOP-4：本处为 0 时显示「还有 0 条」—— 数字口径与闸门分叉",
      patches: [
        {
          file: "src/components/MemoryManager.tsx",
          from: "其它项目还有 {globalPending} 条待批准（去记忆体检处置）",
          to: "其它项目还有 {stats.pendingEntries} 条待批准（去记忆体检处置）",
        },
      ],
      tests: ["src/test/memory-other-projects-pending.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-4 N 换成常量 0",
      why: "MOP-1 / MOP-4：恒显示「还有 0 条」（把读数写死成常数是最容易被误当成「修好了」的形态）",
      patches: [
        {
          file: "src/components/MemoryManager.tsx",
          from: "其它项目还有 {globalPending} 条待批准（去记忆体检处置）",
          to: "其它项目还有 {0} 条待批准（去记忆体检处置）",
        },
      ],
      tests: ["src/test/memory-other-projects-pending.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-5 取数口径换成面板统计（两处口径分叉）",
      why:
        "MOP-1 / MOP-4：那一行的数不再等于 `countPendingEntries()`（闸门读的那个数）" +
        "⇒ 界面开始解释一个与降级闸门无关的数字",
      patches: [
        {
          file: "src/components/MemoryManager.tsx",
          from: "setGlobalPending(service.countPendingEntries());",
          to: "setGlobalPending(service.getStats(ctx).pendingEntries);",
        },
      ],
      tests: ["src/test/memory-other-projects-pending.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-6 把「本处」那份换成全项目（别处内容泄进面板）",
      why:
        "MOP-4 / MOP-2：用「把列表也改成全局」来抹平两个读数的差异 ⇒ 别的项目的待批准内容" +
        "（含摘要，可编辑/可删）被摊在面板里，这是 `listPending` 按 ctx 过滤要防的跨项目泄漏",
      patches: [
        {
          file: "src/components/MemoryManager.tsx",
          from: "const ctx = { projectId, sessionId };",
          to: "const ctx = { projectId, sessionId, showAllProjects: true };",
        },
      ],
      tests: ["src/test/memory-other-projects-pending.test.tsx"],
      expectRed: true,
    },
  ],
};
