// 生成/更新结果契约采纳率基线（`output-schema-baseline.json`）。
//
// 用法：
//   node tools/audit/output-schema-baseline.mjs            # 只看当前状态
//   node tools/audit/output-schema-baseline.mjs --update   # 写入基线
//
// ## 为什么这是一个脚本而不是一条 git diff
//
// 「哪些工具注册了结果契约」是**从代码里推导出来的事实**，不是手写清单。
// 让基线由脚本生成，才能保证它与实际注册状态永远一致 ——
// 手写清单迟早会与实际漂移（本仓已经栽过多次「名单与实际不一致」）。
//
// 脚本本身**不做门禁判断**（那是 `src/test/output-schema-ratchet.test.ts` 的事）；
// 它只负责把「当前事实」落盘，以及在 `--update` 时把基线往**上**抬。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const OUT = path.join(HERE, "output-schema-baseline.json");
const UPDATE = process.argv.includes("--update");

/**
 * 从源码里静态收集「哪个工具定义了 outputSchema」+ 真实工具数。
 *
 * ## 为什么静态扫而不是 import 真实 registry
 *
 * `createDefaultToolRegistry()` 需要 Tauri/Cordis 运行环境（在纯 node 下会抛
 * `Cannot read properties of undefined (reading 'glob')`，实测）。
 *
 * ## 口径：只认 `export function createXxxTool(): ToolDef` 里的 id
 *
 * 第一版把 `src/core` 下**所有** `id: "x"` 都算成工具，得出 **144** 个 ——
 * 而真实工具只有 **51** 个。那个虚高的分母直接让棘轮里的「稀释」判据
 * `50 > 144` 恒为 false（**断言从没跑过**，典型的假绿）。
 *
 * 现在只从 `ToolDef` 工厂函数里取 id，并用「后面 60 行内出现 `contract: {`
 * 或 `guidance:` 或 `parameters:`」作为形态确认 —— 这三个字段是工具定义的特征。
 *
 * 数字仍**只作参考**：真正的判据在 `src/test/output-schema-ratchet.test.ts`，
 * 它跑真实 registry 并用「基线集合 == registry 集合」做交叉核对，两边不一致就红。
 */
function scanCovered() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) files.push(full);
    }
  };
  walk(path.join(REPO, "src", "core"));

  const covered = new Set();
  let toolCount = 0;

  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const lines = text.split(/\r?\n/);
    // 只在「这个文件里有 ToolDef 工厂」时才算它的 id（排除 plugin/config 等）
    const hasToolFactory = /export function create\w*Tool\s*\(\s*\)\s*:\s*ToolDef/.test(text);
    if (!hasToolFactory) continue;

    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*id:\s*['"]([a-z_0-9]+)['"],\s*$/.exec(lines[i]);
      if (!m) continue;

      // 形态确认：往后 60 行内必须出现工具定义的特征字段
      let isToolDef = false;
      let sawSchema = false;
      for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
        if (/^\s*id:\s*['"][a-z_0-9]+['"],\s*$/.test(lines[j])) break;
        if (/^\s*(contract:\s*\{|guidance:|parameters:)/.test(lines[j])) isToolDef = true;
        if (/^\s*outputSchema:/.test(lines[j])) sawSchema = true;
      }
      if (!isToolDef) continue;
      toolCount++;
      if (sawSchema) covered.add(m[1]);
    }
  }
  return { covered: [...covered].sort(), toolCount };
}

const { covered, toolCount } = scanCovered();
console.log(`当前注册了 outputSchema 的工具（${covered.length} / ${toolCount}）：`);
for (const id of covered) console.log("  " + id);
console.log("");

if (!UPDATE) {
  if (fs.existsSync(OUT)) {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const lost = prev.covered.filter((x) => !covered.includes(x));
    const added = covered.filter((x) => !prev.covered.includes(x));
    console.log(`基线：${prev.covered.length} 个`);
    if (lost.length) console.log(`  ⚠ 比基线少了：${lost.join(", ")}`);
    if (added.length) console.log(`  ＋ 比基线多了：${added.join(", ")} · 跑 --update 抬高基线`);
    if (!lost.length && !added.length) console.log("  与基线一致 ✅");
  } else {
    console.log("基线不存在；跑 --update 建立");
  }
  process.exit(0);
}

const payload = {
  _note:
    "结果契约（outputSchema）采纳率基线 —— **只许增长**。由 tools/audit/output-schema-baseline.mjs 生成；" +
    "判据在 src/test/output-schema-ratchet.test.ts。给某个工具注册结果契约后跑 --update 抬高基线；" +
    "若要有意去掉某个契约，同时更新这里并写明原因（否则门禁会红）。",
  covered,
  toolCountAtBaseline: toolCount,
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`已写入基线：${covered.length} 个工具 / 共 ${toolCount} 个`);
