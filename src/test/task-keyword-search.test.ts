/**
 * 第 98 波：**替它把"拿任务里的词搜仓库"这一步做了**。
 *
 * ## 为什么是这个机制（不是"列文件清单"）
 *
 * 直接读对照臂（DSH）在 `repo-02` 上通过的那次会话事件，它的路径是：
 * `Get-ChildItem`/`glob` 摸形状 → **`grep "一次性要求"`、`grep "写入确认"`**（拿任务描述里的词搜仓库）
 * → 顺着代码线索走 → `grep "classifyToolResult|applyToolResultStatus|isError" include:"*.ts"`
 * → **从 117 条命中里看出命名规律（D8/D9/D10）** → `read src/test/dsh-d9-multi-edit-partial-failure.test.ts` ✓。
 *
 * 而我前两版机制（列全部测试文件、按词面排序）在真实工作区里都无效 ✗：
 * 工作区有 **496–4000+** 个测试文件，按字母序前 40 全是 `aa-*`，目标在第 200–380 位开外 ✗；
 * 而且**任务描述是中文、判据文件名是英文** ⇒ 词面排序也排不出来 ✗。
 *
 * ⇒ 正确的等价物是**做那一步搜索**：从用户消息里抽关键词，**只在测试文件里搜**，
 * 把命中的文件（含命中次数）列出来 ✓。这是"针对本次任务的搜索结果"，
 * 与"无关目录清单"是两件事 ✓；而且仍然**只陈述事实**（不评价该不该跑 ✓）。
 *
 * ## 判据要点
 *
 * TSN-1 找得到、TSN-2 按命中数排序、TSN-3 **只列测试文件**（源码命中不算本清单的职责）、
 * TSN-4 没有命中就**什么都不输出**（不留噪声）、TSN-5 措辞只陈述事实、
 * TSN-6 不读 vendored/隐藏目录。
 *
 * 变异自证见 `.preview-shot/_mutate-task-search.mjs`。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractSearchTerms, buildTaskSearchNotice } from "../../src/core/llm/task-keyword-search";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "codem-task-search-"));
  mkdirSync(join(root, "src", "test"), { recursive: true });
  mkdirSync(join(root, "src", "core"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(root, ".vendored", "ref"), { recursive: true });
  // 目标判据：含中文短语与标识符
  writeFileSync(
    join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts"),
    "// 写入确认 写入确认 写入确认\nconst x = pendingWriteConfirms;\n",
  );
  // 另一个测试文件：只命中一次
  writeFileSync(join(root, "src", "test", "other.test.ts"), "// 写入确认 一次而已\n");
  // 源码命中（不该进清单）
  writeFileSync(join(root, "src", "core", "writer.ts"), "// 写入确认 写入确认 写入确认 写入确认\n");
  // 噪声目录里的测试文件（不该被读）
  writeFileSync(join(root, "node_modules", "dep", "x.test.ts"), "// 写入确认\n");
  writeFileSync(join(root, ".vendored", "ref", "y.test.ts"), "// 写入确认\n");
  return root;
}

describe("第 98 波：任务关键词 → 测试文件命中清单", () => {
  it("TSN-1: 从消息里抽出关键词（中文短语 + 标识符），并能找到含它的测试文件", () => {
    const terms = extractSearchTerms('用户反馈「写入确认」选了一次性要求，结果 pendingWriteConfirms 没生效');
    expect(terms).toContain("写入确认");
    expect(terms).toContain("pendingWriteConfirms");
    const root = workspace();
    try {
      const notice = buildTaskSearchNotice(root, '用户反馈「写入确认」选了一次性要求，结果 pendingWriteConfirms 没生效');
      expect(notice, "有命中就必须给出清单").toBeTruthy();
      expect(notice).toContain("dsh-d9-multi-edit-partial-failure.test.ts");
      expect(notice).toContain("other.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-2: 命中次数多的排前面（相关度信号）", () => {
    const root = workspace();
    try {
      const notice = buildTaskSearchNotice(root, "写入确认")!;
      const lines = notice.split("\n").filter((l) => l.trim().startsWith("- "));
      expect(lines[0], `命中次数多的应当排第一（实际：${lines.join(" | ")}）`).toContain("dsh-d9-multi-edit-partial-failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-3 反向对照: **只列测试文件** —— 源码里的命中不进这份清单", () => {
    const root = workspace();
    try {
      const notice = buildTaskSearchNotice(root, "写入确认")!;
      expect(notice).not.toContain("src/core/writer.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-4 反向对照: 一个测试文件都没命中 ⇒ 返回 null（不留噪声）", () => {
    const root = workspace();
    try {
      expect(buildTaskSearchNotice(root, "这段话与仓库里的任何内容都无关，比如量子纠缠与风笛")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-5: 措辞只陈述事实（不许出现命令/评判式表达）", () => {
    const root = workspace();
    try {
      const notice = buildTaskSearchNotice(root, "写入确认")!;
      for (const banned of ["务必", "必须都", "覆盖不足", "确保全部", "你应该跑", "不要偷懒"]) {
        expect(notice, `不该出现评判式措辞「${banned}」`).not.toContain(banned);
      }
      expect(notice).toMatch(/命中|匹配/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-6: 不读 vendored / 隐藏目录里的测试文件（否则一个参考检出就能把清单撑爆）", () => {
    const root = mkdtempSync(join(tmpdir(), "codem-task-search-vendor-"));
    try {
      mkdirSync(join(root, ".vendored", "ref"), { recursive: true });
      writeFileSync(join(root, ".vendored", "ref", "only-here.test.ts"), "// 写入确认 写入确认\n");
      expect(buildTaskSearchNotice(root, "写入确认"), "只存在于 vendored 目录里 ⇒ 视为没命中").toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * TSN-7（第 98 波补，**由真实数据逼出来的**）：**过泛的词必须被剔除**。
   *
   * 实测：第一版按命中次数排序，结果 `agent` 这种到处都是的泛词
   * （单文件 61 处命中）把真正的信号全压掉了 ✗。
   * 判据：造一堆文件里都出现的泛词 + 一个只出现在目标文件里的具体词，
   * 目标文件必须仍然排第一 ✓（即泛词被文档频率过滤掉）。
   */
  it("TSN-7: 到处都是的泛词被剔除，具体词决定排序", () => {
    const root = mkdtempSync(join(tmpdir(), "codem-task-search-df-"));
    try {
      // 60 个文件都含泛词 "agent"（每个 5 次），只有目标文件含具体词 "记账"
      for (let i = 0; i < 60; i++) {
        writeFileSync(join(root, `noise-${String(i).padStart(2, "0")}.test.ts`), "agent agent agent agent agent\n");
      }
      writeFileSync(join(root, "usage-buckets.test.ts"), "记账 记账\nagent\n");
      const notice = buildTaskSearchNotice(root, "agent 记账的桶数不对")!;
      const lines = notice.split("\n").filter((l) => l.trim().startsWith("- "));
      expect(lines.length, "有命中就该有清单").toBeGreaterThan(0);
      expect(lines[0], `具体词所在的文件该排第一（实际：${lines.join(" | ")}）`).toContain("usage-buckets.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-8: 成员不多的小族要把成员全列出来（只给三个例子不够 —— 对手赢在看到具体文件名）", () => {
    const root = mkdtempSync(join(tmpdir(), "codem-task-search-family-"));
    try {
      // ⚠️ 必须先让工作区"够大"（≥ MIN_FILES_FOR_CLUSTERS），否则分族路径根本不走、清单为 null ✗
      //    —— 第一版夹具只造了 7 个文件，于是这条判据测的是"null 不为真"，什么都没测到 ✗
      for (let i = 0; i < 60; i++) writeFileSync(join(root, `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");
      for (let i = 1; i <= 6; i++) writeFileSync(join(root, `dsh-d${i}-something.test.ts`), "// x");
      const notice = buildTaskSearchNotice(root, "与仓库无关的一句话（触发分族路径）")!;
      expect(notice, "文件够多时应当给出分族").toBeTruthy();
      // 6 个成员应当**全部**出现在清单里
      for (let i = 1; i <= 6; i++) {
        expect(notice, `dsh-d${i} 必须被列出来`).toContain(`dsh-d${i}-something.test.ts`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * TSN-9（第 104 波，**由 repo-03 的真实行为数据逼出来的**）：
   * **族的排序要按"族内成员与任务文本的相关性"**，而不是按族的大小。
   *
   * 实测：repo-03 的清单里明明有 `dsh-d6-usage-accounting`、`dsh-d7-usage-cache-buckets`，
   * 但 `dsh-*` 族被排在第三（前面是 25 个的 library-*、21 个的 tool-* ✗）⇒
   * 那次运行只碰了 d6、没碰 d7 ✗。按相关性排，含 usage 的那个族会浮到第一 ✓。
   */
  it("TSN-9: 族的排序按「族内成员与任务文本的相关性」，不按族的大小", () => {
    const root = mkdtempSync(join(tmpdir(), "codem-task-search-rank-"));
    try {
      // 一个"很大但无关"的族，和一个"很小但相关"的族
      for (let i = 0; i < 60; i++) writeFileSync(join(root, `library-noise-${String(i).padStart(2, "0")}.test.ts`), "// n");
      writeFileSync(join(root, "dsh-d6-usage-accounting.test.ts"), "// x");
      writeFileSync(join(root, "dsh-d7-usage-cache-buckets.test.ts"), "// x");
      const notice = buildTaskSearchNotice(root, "用量统计面板的数字明显偏低，怀疑记账只记了一部分 usage")!;
      /**
       * ⚠️ 过滤条件要同时匹配**两种**分族行格式（第 104 波踩到）：
       * 小族是 `- dsh-*（2 个）：…`，大族是 `- library-*：60 个（例如 …）`。
       * 第一版只匹配前者 ⇒ 把大族那行滤掉了 ⇒ 判据**恒真**、什么都没测到 ✗。
       */
      const clusterLines = notice.split("\n").filter((l) => l.trim().startsWith("- ") && l.trim().includes("-*"));
      expect(clusterLines.length, `应当给出分族（实际：${notice.split("\n").length} 行）`).toBeGreaterThanOrEqual(2);
      expect(clusterLines[0], `相关族应当排第一（实际：${clusterLines.join(" | ")}）`).toContain("dsh-*");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
