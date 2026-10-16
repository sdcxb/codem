/**
 * **判据不许钉在死代码上**（2026-10-16）。
 *
 * ## 守的缺陷
 *
 * 上一轮修 `@codem/shell-ops` 时，判据 SO-6 被写成了「断言
 * `src/core/provider/index.ts` 的文本里有 `shellOpsProvider`" —— 而那个文件是**死代码**：
 * 全仓没有调用者、可达性扫描判它不可达、打包时被摇掉。于是：
 *
 * - 判据**绿**（它在断言一个真实存在的文件里的字符串）；
 * - 功能**全死**（插件从来没被 `ctx.plugin`）；
 * - 真机上命令照样落到 Windows PowerShell 5.1。
 *
 * 这就是「判据钉在错入口」的形状：**断言目标本身不可达 = 判据在测空气**。
 *
 * ## 判据
 *
 * 对「可达性扫描判为不可达的生产文件」，若某个测试文件**在代码里**引用了它
 * （注释里提到不算 —— 先剥注释），这条引用必须出现在下面的白名单里并写清理由；
 * 白名单里的每一条也必须仍然被实际引用（双向相等，防白名单长草）。
 *
 * | # | 行为 |
 * |---|---|
 * | CTR-1 | 未登记的「判据 → 不可达文件」引用一律红（反向对照证明检测器有效） |
 * | CTR-2 | 白名单条目必须仍然成立（过期条目也红） |
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanReachability } from "../../tools/audit/reachability-scan.mjs";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = path.resolve(__dirname, "..", "..");

/** 本文件自身排除：它的 ALLOWED 表**故意**写着那些不可达路径（否则自己会把自己判红）。 */
const SELF = "src/test/criteria-target-reachability.test.ts";

/**
 * 允许的「判据 → 不可达文件」引用（**逐条给理由**）。
 *
 * 都是「刻意测那个不可达模块本身」的正当情形，不是「判据钉在错入口上」：
 * 那些模块的可达性结论由 `tools/audit/reachability-allowlist.json` 单独登记。
 */
const ALLOWED: Array<{ test: string; target: string; reason: string }> = [
  {
    test: "src/test/bytes-single-source.test.ts",
    target: "src/core/skills/skill-creator/scripts/package-skill.ts",
    reason: "技能仓内工具脚本（不进装机包）：判据测的是脚本自身的字节/编码契约",
  },
  {
    test: "src/test/bytes-single-source.test.ts",
    target: "src/core/skills/skill-creator/scripts/quick-validate.ts",
    reason: "同上",
  },
  {
    test: "src/test/no-sync-mirror-reads.test.ts",
    target: "src/core/storage/sync-engine.ts",
    reason: "sync-engine 是**已知未接线**的旧引擎：判据断言生产代码**不再**读它（测的是「它没被用」）",
  },
  {
    test: "src/test/persist-failure-reporting.test.ts",
    target: "src/core/storage/sync-engine.ts",
    reason: "同上（断言上报路径不再经旧引擎）",
  },
  {
    test: "src/test/reachability-gate.test.ts",
    target: "src/core/storage/sync-engine.ts",
    reason: "可达性门禁自己的自检：它必须引用一个已知不可达文件作为对照",
  },
  {
    test: "src/test/reachability-gate.test.ts",
    target: "src/components/RegenerateModelPopover.tsx",
    reason: "可达性门禁自检用到的未接线组件（白名单里有登记）",
  },
  {
    test: "src/test/reachability-gate.test.ts",
    target: "src/core/environment/file-edit-capture.ts",
    reason: "可达性门禁自检用到的未接线能力（白名单里有登记）",
  },
  {
    test: "src/test/ui-game-switch.test.ts",
    target: "src/core/slots/declarations.ts",
    reason: "槽位类型声明文件（knip 里按声明文件 ignore、可达性扫描判不可达）：判据断言 app.game **没有**被声明 —— 必须直接读它才算数",
  },
  {
    test: "src/test/renderer-standin-guards.test.ts",
    target: "src/stubs/node-fs-stub.ts",
    reason: "构建期桩：判据断言「生产代码里不许 import node:fs」时把桩本身当对照",
  },
];

/** 检测器本体（抽出来是为了反向对照：合成输入上必须也能抓到）。 */
function findDeadTargets(
  sources: Array<{ file: string; text: string }>,
  unreachable: readonly string[],
): Array<{ test: string; target: string }> {
  const out: Array<{ test: string; target: string }> = [];
  for (const s of sources) {
    const code = stripComments(s.text);
    for (const target of unreachable) {
      if (code.includes(target)) out.push({ test: s.file, target });
    }
  }
  return out.sort((a, b) => (a.test + a.target).localeCompare(b.test + b.target));
}

function testSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        out.push({ file: path.relative(ROOT, p).replace(/\\/g, "/"), text: fs.readFileSync(p, "utf8") });
      }
    }
  };
  walk(path.join(ROOT, "src/test"));
  return out.filter((s) => s.file !== SELF);
}

describe("判据不许钉在死代码上（不可达文件）", () => {
  it("CTR-1: 未登记的『判据 → 不可达文件』引用必须为零", () => {
    const unreachable = scanReachability(ROOT).unreachable;
    expect(unreachable.length, "前置条件：必须真的有不可达文件（否则这条判据没有对象）").toBeGreaterThan(0);

    // 反向对照：检测器必须能抓到一条合成出来的引用
    const synthetic = findDeadTargets(
      [{ file: "src/test/synthetic.test.ts", text: 'expect(fs.readFileSync("src/core/dead/x.ts")).toBeTruthy()' }],
      ["src/core/dead/x.ts"],
    );
    expect(synthetic, "反向对照：合成引用必须被检测器抓到（否则这条判据是哑巴）").toEqual([
      { test: "src/test/synthetic.test.ts", target: "src/core/dead/x.ts" },
    ]);

    const found = findDeadTargets(testSources(), unreachable);
    const allowedKeys = new Set(ALLOWED.map((a) => `${a.test}::${a.target}`));
    const unlisted = found.filter((f) => !allowedKeys.has(`${f.test}::${f.target}`));
    expect(
      unlisted.map((f) => `${f.test} -> ${f.target}`),
      "这些判据在代码里引用了**不可达**（死）的生产文件。如果它是在测那个模块本身（刻意），" +
        "请带理由加进 ALLOWED；如果它是想断言「功能已接线」，那它测的是空气 —— 目标文件根本不会被打包，" +
        "必须改成断言**真实装配路径**（见 plugin-assembly-path.test.ts）。",
    ).toEqual([]);
  });

  it("CTR-2: 白名单条目必须仍然被引用（防白名单长草）", () => {
    const unreachable = new Set(scanReachability(ROOT).unreachable);
    const found = new Set(findDeadTargets(testSources(), [...unreachable]).map((f) => `${f.test}::${f.target}`));
    const stale = ALLOWED.filter((a) => !found.has(`${a.test}::${a.target}`)).map((a) => `${a.test} -> ${a.target}`);
    expect(stale, "这些白名单条目已经不成立了（引用被删 / 文件变可达）—— 请删掉条目").toEqual([]);
  });
});
