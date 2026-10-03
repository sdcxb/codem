/**
 * **把"工作区里有哪些测试文件"当成事实摆出来**（第 94 波）。
 *
 * ## 它解决的是哪一类失败
 *
 * 234 对 DSH 唯一"对手稳定过、我们稳定不过"的格子是 `repo-02`，失败形状两版一致：
 * 判据在 `dsh-d9-multi-edit-partial-failure.test.ts`，而 agent **读 1/3、跑 2/3** ——
 * **既没读也没跑那条判据**。`[RED TEST]` 指针只在"测试跑出红"时才触发 ⇒ 对这类**原理上无效**。
 *
 * ## 三条设计约束（都是被上一次失败教出来的）
 *
 * 1. **只陈述事实**：不写"你应该都跑一遍""覆盖不足"这类判断。
 *    上一版覆盖率唠叨（`c7feb4a`）在**通过的运行里 8/8 误报**，就是因为它夹带了判断 ✗。
 *    这里只说"工作区里有这些测试文件、共 N 个" ✓ ⇒ 通过与否的运行看到的东西**完全一样** ✓。
 * 2. **如实说总数**：只列前 N 个时必须写出总数，否则模型会以为"就这么几个" ✗。
 * 3. **不算噪声目录**：`node_modules` / `.git` / `dist` / `target` / 覆盖率与快照目录一律跳过
 *    （否则一个依赖树就能刷出几千个"测试文件"，把清单变成垃圾 ✗）。
 *
 * ## 用法
 *
 * ```ts
 * const notice = buildTestFileNotice(cwd);   // 没有测试文件时返回 null
 * if (notice) trailingTurnContext += notice; // 只注入一次（见 agentic-loop 的迭代判断）
 * ```
 */

import { readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

/** 一次最多列多少个（超过就只列前 N 个 + 如实说总数） */
export const DEFAULT_MAX_TEST_FILES = 40;

/** 扫描时跳过的目录名（噪声/依赖/产物） */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".preview-shot",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "out",
  ".venv",
  "__pycache__",
]);

/** 判定"这是不是一个测试文件" */
function isTestFile(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name);
}

/** 深度上限：够覆盖真实仓库，又能挡住异常深的目录树 */
const MAX_DEPTH = 12;
/** 扫描到的文件数上限：防止在超大目录树里跑太久（超过就停止收集） */
const MAX_SCANNED = 20000;

function collect(root: string): { files: string[]; truncatedScan: boolean } {
  const files: string[] = [];
  let scanned = 0;
  let truncatedScan = false;

  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || truncatedScan) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 读不动的目录（权限/竞态）直接跳过，别让清单构建把会话搞崩
    }
    for (const entry of entries) {
      if (scanned >= MAX_SCANNED) {
        truncatedScan = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        scanned++;
        if (isTestFile(entry.name)) files.push(relative(root, full).split(sep).join("/"));
      }
    }
  };

  walk(root, 0);
  return { files, truncatedScan };
}

/**
 * 生成"工作区测试文件清单"的尾部消息；没有测试文件时返回 `null`。
 *
 * @param root     工作区根目录
 * @param maxFiles 最多列出多少个（默认 {@link DEFAULT_MAX_TEST_FILES}）
 */
export function buildTestFileNotice(root: string, maxFiles = DEFAULT_MAX_TEST_FILES): string | null {
  const { files, truncatedScan } = collect(root);
  if (files.length === 0) return null;

  files.sort();
  const total = files.length;
  const listed = files.slice(0, maxFiles);
  const lines = listed.map((f) => `- ${f}`).join("\n");
  const more =
    total > listed.length
      ? `\n（上面只列了前 ${listed.length} 个；工作区里一共有 ${total} 个测试文件。）`
      : `\n（工作区里一共有 ${total} 个测试文件。）`;

  /**
   * 措辞纪律：只陈述"有什么、在哪"，**不评价、不命令** ✓。
   * 判据 TN-3 会扫"务必/必须都/覆盖不足/确保全部/你应该跑/不要偷懒"这些词。
   */
  return [
    `[工作区测试文件] 这个工作区里有以下测试文件（相对路径）：`,
    lines,
    more.trim(),
    `这些只是事实清单；要看某个文件的内容，用 read 打开它。`,
  ].join("\n");
}
