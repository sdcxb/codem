/**
 * 第 124 波：**源码命中**（把搜索范围从"只搜测试文件"扩到"整个仓库"）。
 *
 * ## 依据（会话级对比，§13.46）
 *
 * - **我们**（244 的 repo-02，102 次调用）：`ls src/test/ | grep -i "write|reject|false"` +
 *   按文件名 glob（星号星号斜杠 write 星号 .test.ts）⇒ 只按**文件名**筛 ⇒ 落到 `dsh-d10-write-…` ✗，从没碰被判分的 `dsh-d9` ✗；
 * - **对照臂**（赢的那次）：一次**全仓库符号 grep**（"Found 117 matches"）⇒
 *   匹配清单里**同时列出源码与测试文件**，`src\test\dsh-d9-multi-edit-partial-failure.test.ts`
 *   就在里面 ✓ ⇒ 它直接去读 d9 ✓。
 *
 * 而我的清单**只搜测试文件** ✗（236 波刻意如此、还有判据 TSN-3 明文钉住 ✗），
 * 偏偏 repo-02 的任务原词（「写入确认」「一次性要求」）**根本不在测试文件里** ✓
 * ⇒ 命中段为空 ✗ ⇒ 只剩分族列表，被 `ls | grep write` 带偏 ✗。
 *
 * ## 本波改法
 *
 * 命中段拆成两节 ✓：**测试文件命中**（沿用原来的按内容扫 ✓）
 * + **源码命中**（用应用自己的 `grepSearch` ✓，与 `grep` 工具同一条 IPC ✓）。
 * **TSN-3 被改写** ✓：它原来断言"源码里的命中不进这份清单" ✗ —— 那条设计已被证据推翻 ✗，
 * 改写原因写在下面对应判据里 ✓。
 *
 * 变异自证：把源码命中那段去掉 ⇒ TSN-12/13 红；把两节合并 ⇒ TSN-13 红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildTaskSearchNotice } from "../../src/core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";
import { nodeGrepSource } from "./helpers/node-grep-source";

describe("第 124 波：源码命中（让清单覆盖对手真正用到的信息）", () => {
  it("TSN-12: 任务词只出现在源码里 ⇒ 清单必须把那些源码文件列出来", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-source-hits-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "test"), { recursive: true });
      // 任务原词只出现在**源码**里（测试文件里没有）—— 这正是 repo-02 的形状
      writeFileSync(join(root, "src", "core", "tools.ts"), "// 写入确认：用户选「按我的一次性要求改」时不要直接覆盖\n");
      for (let i = 0; i < 60; i++) writeFileSync(join(root, "src", "test", `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");

      const notice = await buildTaskSearchNotice(root, "他在写入确认里选「按我的一次性要求改」，结果文件根本没变", {
        src: nodeFsSource(),
        search: nodeGrepSource(),
      });
      expect(notice, "夹具前提：应当给出清单").toBeTruthy();
      expect(notice!, "必须列出源码命中").toContain("src/core/tools.ts");
      expect(notice!, "并且要说明这是源码命中（与测试命中分开）").toMatch(/源码|实现文件/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-13 反向对照: 两节必须分开（测试命中一节、源码命中一节），不许混在一起", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-source-hits2-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "test"), { recursive: true });
      writeFileSync(join(root, "src", "core", "tools.ts"), "// pendingWriteConfirms 相关实现\n");
      writeFileSync(join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts"), "// pendingWriteConfirms 的判据\n");
      for (let i = 0; i < 60; i++) writeFileSync(join(root, "src", "test", `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");

      const notice = await buildTaskSearchNotice(root, "pendingWriteConfirms 没生效", {
        src: nodeFsSource(),
        search: nodeGrepSource(),
      });
      expect(notice, "夹具前提").toBeTruthy();
      const lines = notice!.split("\n");
      const testSection = lines.findIndex((l) => l.includes("测试文件") && l.includes("命中"));
      const sourceSection = lines.findIndex((l) => l.includes("源码") || l.includes("实现文件"));
      expect(testSection, "应当有测试命中一节").toBeGreaterThanOrEqual(0);
      expect(sourceSection, "应当有源码命中一节").toBeGreaterThanOrEqual(0);
      expect(sourceSection, "两节应当分开（源码那节在测试那节之后）").toBeGreaterThan(testSection);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-3（**已改写**）: 测试命中一节里**只**列测试文件；源码命中另有专节", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-source-hits3-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "test"), { recursive: true });
      writeFileSync(join(root, "src", "core", "tools.ts"), "// 记账 usage 的实现\n");
      writeFileSync(join(root, "src", "test", "usage-normalize.test.ts"), "// 记账 usage 的判据\n");
      for (let i = 0; i < 60; i++) writeFileSync(join(root, "src", "test", `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");

      const notice = await buildTaskSearchNotice(root, "记账 usage 不对", { src: nodeFsSource(), search: nodeGrepSource() });
      expect(notice, "夹具前提").toBeTruthy();
      /**
       * ⚠️ **这条判据在 1.16.245 被改写**（原文断言"源码里的命中**不进**这份清单" ✗）。
       * 改写原因（会话级证据，§13.46）：对照臂赢的那次 repo-02 正是靠**跨源码+测试的符号 grep**
       * （117 条匹配）在清单里看到 `dsh-d9-…` 才找到判据的 ✓；而"只搜测试文件"导致
       * 任务原词（「写入确认」）在测试里零命中 ⇒ 清单命中段为空 ⇒ 帮不上 ✗。
       * 现在钉的是"**分节**"：测试命中的那一节里只允许测试文件 ✓，源码命中另起一节 ✓。
       */
      const lines = notice!.split("\n");
      const testSectionStart = lines.findIndex((l) => l.includes("测试文件") && l.includes("命中"));
      const sourceSectionStart = lines.findIndex((l) => l.includes("源码") || l.includes("实现文件"));
      const testSectionLines = lines.slice(testSectionStart + 1, sourceSectionStart > 0 ? sourceSectionStart : undefined).filter((l) => l.startsWith("- "));
      for (const l of testSectionLines) {
        expect(l, `测试命中一节里不该出现源码文件：${l}`).toMatch(/\.test\.tsx?/);
      }
      expect(lines.slice(sourceSectionStart).join("\n"), "源码一节里要有那个源码文件").toContain("src/core/tools.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
