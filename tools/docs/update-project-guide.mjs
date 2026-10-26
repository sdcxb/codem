#!/usr/bin/env node
/**
 * 项目文档集（docs/project-guide）基线的同步 / 检查。
 *
 * 用法：
 *   node tools/docs/update-project-guide.mjs --write   # 发版第一步：刷新 BASELINE.json + 打印手改清单
 *   node tools/docs/update-project-guide.mjs --check   # 门禁：版本/必读文档/BOM/索引/章节
 *
 * 退出码：0 = 通过；1 = 有硬错误（版本不一致、文档缺失、BOM、索引缺失、章节缺失）。
 * 计数类漂移只警告，不红；发版时 --write 刷新。
 */

import { checkProjectGuide, syncProjectGuide, GUIDE_DIR } from "./project-guide-lib.mjs";

const arg = process.argv[2];
const mode = arg === "--write" ? "write" : arg === "--check" || !arg ? "check" : "help";

if (mode === "help") {
  console.log("用法：node tools/docs/update-project-guide.mjs --write|--check");
  process.exit(0);
}

if (mode === "write") {
  const { facts, path } = syncProjectGuide();
  console.log(`[docs] 已写入 ${path}`);
  console.log(`[docs] version=${facts.version} testFiles=${facts.testFiles} coreDirs=${facts.coreDirs} sqliteTables=${facts.sqliteTables} tauriCommandAnnotations=${facts.tauriCommandAnnotations}`);
  console.log("");
  console.log("仍需手动更新（发版前必须做）：");
  console.log("  1. docs/project-guide/README.md —— 版本 / 发布日期 / HEAD / 测试基线 / 文档清单");
  console.log("  2. docs/project-guide/00-AGENT-HANDBOOK.md —— 基线表（版本 / 发布 / 测试）");
  console.log("  3. docs/project-guide/01-PRODUCT-OVERVIEW.md —— 版本 / 规模 / 版本历程（如需要）");
  console.log("  4. docs/project-guide/09-CURRENT-STATE.md —— §1 版本与发布、§3 测试基线、§5 未完成项、§7 文档债");
  console.log("  5. CHANGELOG.md —— 面向用户的版本段");
  console.log("  6. docs/PROJECT-GUIDE.md —— 版本历史表（VERSION-4 判据守着）");
  console.log("");
  console.log("完成后跑：npm run audit:docs");
  process.exit(0);
}

const result = checkProjectGuide();
if (result.warnings.length) {
  console.log("[docs] 警告（不阻塞，但发版前应刷新）：");
  for (const w of result.warnings) console.log(`  - ${w}`);
}
if (!result.ok) {
  console.error("[docs] 文档门禁失败：");
  for (const p of result.problems) console.error(`  - ${p}`);
  console.error("");
  console.error("修法：");
  console.error("  1. npm run docs:sync");
  console.error("  2. 按输出清单更新 README/00/01/09 与 CHANGELOG/PROJECT-GUIDE");
  console.error("  3. npm run audit:docs");
  process.exit(1);
}
console.log(`[docs] 文档门禁通过：version=${result.facts.version}（${GUIDE_DIR}）`);
