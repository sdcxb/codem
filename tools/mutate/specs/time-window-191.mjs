/**
 * 变异自证：`time-window-191`（第 191 波 O-40 + O-55 的窗口/时区判据）
 *
 * 跑法：
 * ```
 * node tools/mutate/run.mjs time-window-191
 * ```
 *
 * 这一批钉的是「按天分格」的**窗口口径**（`src/core/time/local-time.ts` 的唯一实现）：
 * ①②把窗口推翻回 `now - i * 24h`（一处是唯一实现、一处是只改一个组件 ⇒ 证明「两个组件共用
 * 同一处实现」这件事有判据在守），③把本地日 00:00 的偏移迭代删掉（跳变吞掉本地 00:00 的时区
 * 会落到**前一天** 23:00），④给 `TIME-DST-4` 的例外表塞一条**过期条目**（指向不存在的字面量），
 * ⑤把 UsageStats 的可视化取数窗口退回裸字面量（同文件里已登记 1 处 ⇒ 计数对不上必须红）。
 *
 * ⚠️ 锚点必须是**当前源码里唯一命中**的一段原文（运行器在 LF 归一化后匹配，写回时还原行尾）。
 */
export default {
  description:
    "O-40/O-55：本地日历日窗口（localDayWindows / localDayStartMs）与裸日长对账 —— 改回 24h 步长、只改一个组件、漏掉偏移迭代、例外表过期、组件退回裸字面量 都必须被 TIME-WINDOW-* / TIME-DST-* 抓红",
  mutations: [
    {
      id: "MUT-1 唯一实现里的窗口改回 now - i * 24h",
      why: "TIME-WINDOW-1/2/3 + TIME-DST-1/2：24h 步长在 23/25 小时那两天会与本地日 key 错开（记录算进相邻格子），且「今天」那一格变成未来 24 小时",
      patches: [
        {
          file: "src/core/time/local-time.ts",
          from: `  const out: LocalDayWindow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    // i 天前那一格 = [它的起点, 次日的起点) —— \`end\` 取次日的 start，而不是 \`start + 24h\`
    out.push({ start: bounds[i + 1], end: bounds[i], date: bounds[i + 1] });
  }
  return out;`,
          to: `  const out: LocalDayWindow[] = [];
  const fromNowMs = refMs;
  const legacyDayMs = 24 * 60 * 60 * 1000;
  for (let i = count - 1; i >= 0; i--) {
    const start = fromNowMs - i * legacyDayMs;
    out.push({ start, end: start + legacyDayMs, date: start });
  }
  return out;`,
        },
      ],
      tests: ["src/test/time-window-dst.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 只改一个组件：UsageChart 绕开共用实现（TokenActivityGrid 仍走 localDayWindows）",
      why: "TIME-DST-1（UsageChart 那一半）+ TIME-DST-4：绕开唯一实现 ⇒ 组件判据红，且裸字面量未登记 ⇒ 对账也红（这就是「两个组件不许各写一份」的两道闸）",
      patches: [
        {
          file: "src/components/UsageVisuals.tsx",
          from: `    for (const w of localDayWindows(days, Date.now())) {
      const dayStart = w.start;
      const dayEnd = w.end; // = 次日本地日的起点（不是 start + 24h）
      const dayDate = new Date(dayStart);`,
          to: `    const chartNowMs = Date.now();
    const chartDayMs = 24 * 60 * 60 * 1000;
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = chartNowMs - i * chartDayMs;
      const dayEnd = dayStart + chartDayMs;
      const dayDate = new Date(dayStart);`,
        },
      ],
      tests: ["src/test/time-window-dst.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 本地日 00:00 的换算漏掉 DST 偏移迭代（只猜一次偏移）",
      why: "TIME-WINDOW-1（跳变吞掉本地 00:00 的时区）：只按一次偏移猜会返回**前一天** 23:00，该日起点不再是「该日实际最早的瞬时」",
      patches: [
        {
          file: "src/core/time/local-time.ts",
          from: `  const first = wallDayStartMs - offsetMinutesOf(wallDayStartMs) * 60_000;
  const second = wallDayStartMs - offsetMinutesOf(first) * 60_000;
  // 收敛判据：候选瞬时的**本地墙上时间**是否已进入目标日。没进入 ⇒ 该日无本地 00:00，
  // 取那个已经进入目标日的候选（= 跳变结束那一刻 = 该日实际最早的瞬时）。
  return wallClockMs(second, offsetMinutesOf) >= wallDayStartMs ? second : first;`,
          to: `  return wallDayStartMs - offsetMinutesOf(wallDayStartMs) * 60_000;`,
        },
      ],
      tests: ["src/test/time-window-dst.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 TIME-DST-4 的例外表加一条过期条目（指向不存在的字面量）",
      why: "TIME-DST-4：过期条目（文件里根本没有这个字面量）必须被「声明次数 vs 实际次数」的对账抓出来；放过它 = 例外表只是掩盖",
      patches: [
        {
          file: "src/test/time-window-dst.test.ts",
          from: `  {
    file: "src/core/storage/spill.ts",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 1,
    kind: "elapsed",`,
          to: `  {
    file: "src/core/storage/spill.ts",
    literal: "86_400_000",
    occurrences: 1,
    kind: "elapsed",
    reason: "变异对照：spill.ts 里根本没有这个字面量 ⇒ 过期条目必须被判据抓出来",
  },
  {
    file: "src/core/storage/spill.ts",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 1,
    kind: "elapsed",`,
        },
      ],
      tests: ["src/test/time-window-dst.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-5 UsageStats 的可视化取数窗口退回裸 24h 字面量",
      why: "TIME-DST-4：同一文件里已登记 1 处（历史页的经过时长）⇒ 多出来的那一处「漏登记」必须让计数对不上；同时可视化窗口不再与本地日历日格子同源",
      patches: [
        {
          file: "src/components/UsageStats.tsx",
          from: `    const vizFrom = localDayWindows(VIZ_DAYS, Date.now())[0]?.start ?? Date.now();`,
          to: `    const vizFrom = Date.now() - VIZ_DAYS * 24 * 60 * 60 * 1000;`,
        },
      ],
      tests: ["src/test/time-window-dst.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-6 Sidebar 的「今天」退回滚动 24h（标题与判定两套口径）",
      why: "TIME-WINDOW-4a：侧栏分组标题写「今天」而判定用 now - sessionTime < 24h ⇒ 昨天 10:30 的会话在 23.5 小时内被标成今天（非 DST 时区就已经错）",
      patches: [
        {
          file: "src/components/Sidebar.tsx",
          from: `    const todayStart = localDayStartMs(Date.now());`,
          to: `    const todayStart = Date.now() - 24 * 60 * 60 * 1000;`,
        },
        {
          file: "src/components/Sidebar.tsx",
          from: `      if (sessionTime && sessionTime >= todayStart) {`,
          to: `      if (sessionTime && now - sessionTime >= 0 && now - sessionTime < 24 * 60 * 60 * 1000) {`,
        },
        {
          file: "src/components/Sidebar.tsx",
          from: `  const groupSessionsByTime = (sessions: any[]) => {`,
          to: `  const groupSessionsByTime = (sessions: any[]) => {\n    const now = Date.now();`,
        },
      ],
      tests: ["src/test/time-window-dst.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-7 OverviewTab 退回自己 setHours(0,0,0,0)（第二处本地日 00:00 实现）",
      why: "TIME-WINDOW-4b：「本地日 00:00」只许有一处实现（localDayStartMs）；自己再写一遍必须被判红",
      patches: [
        {
          file: "src/components/task-center/OverviewTab.tsx",
          from: `    const today = localDayStartMs(Date.now());`,
          to: `    const todayDate = new Date();\n    todayDate.setHours(0, 0, 0, 0);\n    const today = todayDate.getTime();`,
        },
      ],
      tests: ["src/test/time-window-dst.test.ts"],
      expectRed: true,
    },
  ],
};
