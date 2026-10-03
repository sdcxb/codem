/**
 * 第 94 波：**把"工作区里有哪些测试文件"当成事实摆出来**。
 *
 * ## 为什么加这条（证据，不是直觉）
 *
 * 234 对 DSH 的读数里，唯一"对手稳定过、我们稳定不过"的格子是 `repo-02`，
 * 而它的失败形状**两版都一样**：判据输出指向
 * `dsh-d9-multi-edit-partial-failure.test.ts > D9-1`，行为指标却显示 **读 1/3、跑 2/3** ——
 * 它**既没读、也没跑**那条判据 ✗。
 *
 * `[RED TEST]` 指针（234 已有）的触发条件是"某次测试跑出红"——
 * **没跑就没有红** ⇒ 指针在**原理上**救不了这一类 ✗（§13.28c 已写清）。
 * 所以这一类要换抓手：**别让它"想不到有那个文件"**。
 *
 * ## 与已被撤下的覆盖率唠叨（`c7feb4a`）的区别（这条是硬要求）
 *
 * 上一版是"**我**判断它覆盖不够就唠叨"，结果在**通过的运行里 8/8 误报** ✗（噪声）。
 * 这一版**只呈递事实**：工作区里有哪些测试文件、共几个。
 * ⇒ 它**不含任何"你没跑够/你该跑更多"的判断**，
 * ⇒ 因此**在通过与否的运行上完全一样**，不产生选择性偏见 ✓。
 * 判据 TN-3 专门钉这一点（措辞里不许出现命令式/评判式表达）。
 *
 * 变异自证：把 cap 去掉（列全部）⇒ TN-2 红；把措辞改成"请务必都跑一遍" ⇒ TN-3 红；
 * 不排除 node_modules ⇒ TN-4 红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildTestFileNotice, DEFAULT_MAX_TEST_FILES } from "../../src/core/llm/test-file-notice";

/** 造一棵小工作区：3 个测试文件 + 1 个 node_modules 里的假测试 + 1 个非测试文件 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "codem-test-notice-"));
  mkdirSync(join(root, "src", "test"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "test", "alpha.test.ts"), "// a");
  writeFileSync(join(root, "src", "beta.spec.ts"), "// b");
  writeFileSync(join(root, "src", "gamma.test.js"), "// c");
  writeFileSync(join(root, "node_modules", "pkg", "dep.test.ts"), "// 不该出现");
  writeFileSync(join(root, "src", "index.ts"), "// 不是测试文件");
  return root;
}

describe("第 94 波：工作区测试文件清单（只呈递事实）", () => {
  it("TN-1: 列出测试文件（相对路径），不带无关文件", () => {
    const root = makeWorkspace();
    try {
      const notice = buildTestFileNotice(root);
      expect(notice, "有测试文件时必须给出清单").toBeTruthy();
      expect(notice).toContain("src/test/alpha.test.ts");
      expect(notice).toContain("src/beta.spec.ts");
      expect(notice).toContain("src/gamma.test.js");
      expect(notice, "非测试文件不该出现").not.toContain("src/index.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TN-2: 超过上限时只列前 N 个，并**如实说出总数**（不能假装就这么多）", () => {
    const root = mkdtempSync(join(tmpdir(), "codem-test-notice-many-"));
    try {
      const total = DEFAULT_MAX_TEST_FILES + 7;
      for (let i = 0; i < total; i++) {
        writeFileSync(join(root, `t${String(i).padStart(3, "0")}.test.ts`), "// x");
      }
      const notice = buildTestFileNotice(root)!;
      const listed = notice.split("\n").filter((l) => l.trim().startsWith("- ")).length;
      expect(listed, "列出的条数不得超过上限").toBeLessThanOrEqual(DEFAULT_MAX_TEST_FILES);
      expect(notice, "必须如实说明总数（否则模型会以为只有这些）").toContain(String(total));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TN-3 反向对照: **只陈述事实**，不许出现命令/评判式表达（重蹈 c7feb4a 覆辙）", () => {
    const root = makeWorkspace();
    try {
      const notice = buildTestFileNotice(root)!;
      // 事实性措辞
      expect(notice).toMatch(/测试文件/);
      // 不许有"你必须都跑""覆盖不足""确保全部运行"这类判断/命令
      for (const banned of ["务必", "必须都", "覆盖不足", "确保全部", "你应该跑", "不要偷懒"]) {
        expect(notice, `不该出现评判式措辞「${banned}」`).not.toContain(banned);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TN-4: node_modules / .git / 构建产物里的「测试文件」一律不算", () => {
    const root = mkdtempSync(join(tmpdir(), "codem-test-notice-ignore-"));
    try {
      for (const dir of ["node_modules/x", ".git/y", "dist/z", "target/w", ".preview-shot/v"]) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, "should-not-appear.test.ts"), "// no");
      }
      expect(buildTestFileNotice(root), "整个工作区没有**真**测试文件时应当返回 null").toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
