/**
 * 变异自证（第 231 波 · 判据 `PERFENTRY-231-1..4` / `RODB-231-1..7`）。
 *
 * 这一波收两条尾巴：
 *
 * 1. **Sidebar 的两个死 prop**（`onPerf` / `onCicd`，从 `7d768d3f` 起就没有读者）清掉，
 *    并把「perf 从 Sidebar 跳设置页」那条守死代码的旧前提换成现实里的入口（底部页签）；
 * 2. **只读钻取不许动真库一个 mtime**：钻取改走 `tools/maintenance/read-only-db.mjs`
 *    （复制 `.bin` + `-wal` + `-shm` 到临时目录再读），判据见 `src/test/read-only-db.test.ts`。
 *
 * | 变异 | 坏法 | 必须红在哪 |
 * | --- | --- | --- |
 * | MUT-1 | 只读入口改回**直接打开原库**（上一轮的真实现） | `RODB-231-1` / `RODB-231-2` |
 * | MUT-2 | App 重新给 Sidebar 传 `onPerf`（死 prop 复活） | `PERFENTRY-231-2` / `PERFENTRY-231-3` |
 * | MUT-3 | perf 页签入口去掉门控（入口与开关脱钩） | `PERFENTRY-231-3` |
 * | MUT-4 | 只改一句注释（**反向对照**：不许红） | 无（`expectRed: false`） |
 *
 * MUT-4 是刻意的反向对照：判据读的是源码文本，如果它把"注释改动"也判红，
 * 就说明它盯错了东西（本仓在 `PERFENTRY-231-1` 上主动选择了"连注释也算"，
 * 但那条钉的是**两个具体标识符**，不是任意注释 —— 反向对照把这条边界说清楚）。
 */
export default {
  description:
    "第 231 波：①Sidebar 死 prop（性能 / CI-CD 的旧跳转）清干净、perf 的正当入口是底部页签；②只读钻取复制副本、真库三件套的 mtime 与 sha256 一动不动",
  mutations: [
    {
      id: "MUT-1 只读入口改回直接打开原库（上一轮的真实现）",
      why:
        "RODB-231-1 / RODB-231-2：直接只读打开带 WAL 的库会更新 -shm 的 mtime 与内容" +
        "（SQLite 连接标记）⇒ 真库被动过，判据必须红",
      patches: [
        {
          file: "tools/maintenance/read-only-db.mjs",
          from: "  const db = new DatabaseSync(snapshot.dbPath, { readOnly: true });",
          to: "  const db = new DatabaseSync(dbPath, { readOnly: true });",
        },
      ],
      tests: ["src/test/read-only-db.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 App 重新给 Sidebar 传 onPerf（死 prop 复活）",
      why:
        "PERFENTRY-231-2：没人读的 prop 传进来就是假接线；PERFENTRY-231-3 同时会红，" +
        "因为那段实参里带着 setSettingsInitialTab(\"performance\")（perf 又从设置页进）",
      patches: [
        {
          file: "src/App.tsx",
          from: "                    onAgents={() => setShowAgentManager(true)}\n",
          to:
            "                    onAgents={() => setShowAgentManager(true)}\n" +
            '                    onPerf={perfEnabled ? () => { setSettingsInitialTab("performance"); setShowSettings(true); } : undefined}\n',
        },
      ],
      tests: ["src/test/sidebar-user-settings-click.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 perf 入口从登记表里删掉",
      why:
        "PERFENTRY-231-3（第 233 波改写后）：页签栏已隐藏，perf 的入口是登记表里的「设置 → 性能」分区；" +
        "把这条登记删掉 ⇒ 判据必须红（否则「有其它入口」就成了一句话，没有机器事实）",
      patches: [
        {
          file: "src/core/ui/bottom-tab-entries.ts",
          from:
            '  perf: [\n' +
            '    {\n' +
            '      kind: "settings-section",\n' +
            '      file: "src/components/SettingsPanel.tsx",\n' +
            '      symbol: \'activeTab === "performance"\',\n' +
            '      why: "设置 → 性能分区渲染**同一个** PerformanceDashboard（第 231 波从主区顶部移入设置）",\n' +
            '    },\n' +
            '  ],\n',
          to: "  perf: [],\n",
        },
      ],
      tests: ["src/test/sidebar-user-settings-click.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 只改一句注释（反向对照：不许红）",
      why:
        "判据读源码文本，但必须只盯「行为契约」（那两个标识符与入口归属）；" +
        "改注释不该让任何判据变红 —— 否则以后没人敢把理由写进代码里",
      patches: [
        {
          file: "src/components/Sidebar.tsx",
          from: "那一条判据连**注释里**都不许出现这两个标识符（防止有人顺手把名字抄回来就复活了 prop），",
          to: "那一条判据连注释也算（理由见下面的入口归属）。",
        },
      ],
      tests: ["src/test/sidebar-user-settings-click.test.ts"],
      expectRed: false,
    },
    {
      id: "MUT-5 受版本控制的 tools/ 里的报告脚本改回直接打开真库",
      why:
        "RODB-231-7a：`tools/` 那一层是这条纪律**在干净 clone 上也生效**的那一半 —— " +
        "`codem-records-report` 的事后复核要读真库会话事件，退回直读就会在用户现场 -shm 上留痕",
      patches: [
        {
          file: "tools/eval/audit-codem-record.mjs",
          from: "const db = openReadOnlyDb(DB_PATH);",
          to: "const db = new DatabaseSync(DB_PATH, { readOnly: true });",
        },
        {
          /* 真实的回退会连 import 一起换回来（不然脚本根本跑不起来）—— 变异也要还原这一步，
             否则测的是「引用了一个没导入的符号」，不是「退回直读真库」 */
          file: "tools/eval/audit-codem-record.mjs",
          from: 'import { openReadOnlyDb } from "../maintenance/read-only-db.mjs";',
          to: 'import { DatabaseSync } from "node:sqlite";',
        },
      ],
      tests: ["src/test/read-only-db.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-6 副本不带 -wal（等效于「只读 .bin」的口径）",
      why:
        "RODB-231-8：复制时漏掉 -wal ⇒ 未 checkpoint 的行静默消失（行数 3 → 1），" +
        "报告数字缩水而没人报错。判据必须能看见这件事",
      patches: [
        {
          file: "tools/maintenance/read-only-db.mjs",
          from: "      if (!fs.existsSync(file)) continue;",
          to: '      if (!fs.existsSync(file) || file.endsWith("-wal")) continue;',
        },
      ],
      tests: ["src/test/read-only-db.test.ts"],
      expectRed: true,
    },
  ],
};
