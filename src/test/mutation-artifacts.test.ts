/**
 * `MUTATE-ARTIFACT-1`：**变异证据必须是仓库里可复核的产物**（O-53 的判据）。
 *
 * ## 被守的缺陷（O-53，第 189 波的反面教材）
 *
 * 第 189 波那批 `MEM-PLACE-*` 判据的自述是「每一条都实测能变红（见交付报告的变异清单）」——
 * 而**变异脚本与结果都不在仓库里**（只写在给上级的报告文本里）。于是下一轮想复核
 * 「这批判据是不是真的能红」只能重做一遍；更糟的是照摘要下结论。
 * 本仓纪律「变异不做等于没测」，那么「做了但证据没进仓库」同样是**没测**。
 *
 * ## 本判据钉什么
 *
 * 直接调用闸门的**同一份实现**（`tools/mutate/check-artifacts.mjs` 的 `checkArtifacts()`），
 * 所以「`npm run audit:mutations` 说通过」与「判据说通过」不可能各说各话：
 *
 * - `MUT-ART-1`：至少登记了一个波次（一个都没有 ⇒ 这道闸门是摆设，本判据红）；
 * - `MUT-ART-2`：每个登记波次都有结果文件、`restored === true`、每条变异 `ok === true`、
 *   规格指纹一致、锚点未过期；
 * - `MUT-ART-3`（反向对照）：在**指纹算对**（即只有被测那一项坏）的前提下，分别喂
 *   `restored:false` 与「有变异没红」两种坏结果 ⇒ 检查器必须各报出问题
 *   （证明这两条检查不是恒真）；再喂一份**全都对**的结果 ⇒ 必须不报问题
 *   （证明检查器不是"永远报错"）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { specFingerprint } from "../../tools/mutate/run.mjs";

const ROOT = process.cwd();
const CHECKER = path.join(ROOT, "tools", "mutate", "check-artifacts.mjs");

/** 反向对照用的假规格（故意只有一条变异，锚点指向临时根里的 `fake.txt`） */
const FAKE_SPEC = {
  description: "反向对照用的假规格",
  mutations: [
    {
      id: "MUT-FAKE",
      why: "反向对照",
      patches: [{ file: "fake.txt", from: "a", to: "b" }],
      tests: [],
      expectRed: true,
    },
  ],
};

/** 在一个临时根目录里摆一份 registry/specs/results，再用同一个检查器去看它 */
async function checkInTempRoot(resultOverride: Record<string, unknown> | null) {
  const dir = mkdtempSync(path.join(tmpdir(), "codem-mutate-"));
  try {
    const files: Record<string, string> = {
      "tools/mutate/registry.json": JSON.stringify({ waves: ["fake-wave"] }),
      // 规格用 **JSON** 载体：判据在临时根目录里造规格，而 `.mjs` 载体要走模块加载器
      // （打包器会拒绝解析项目外的绝对路径 —— 这正是这条反向对照第一版踩到的坑）
      "tools/mutate/specs/fake-wave.json": JSON.stringify(FAKE_SPEC),
      "fake.txt": "a",
    };
    if (resultOverride) {
      files["tools/mutate/results/fake-wave.json"] = JSON.stringify({
        wave: "fake-wave",
        restored: true,
        specFingerprint: specFingerprint(FAKE_SPEC),
        results: [{ id: "MUT-FAKE", expectedRed: true, observedRed: true, ok: true }],
        ...resultOverride,
      });
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    /*
     * 检查器的根目录是**可注入参数**（不是 `process.chdir()`）：vitest 同一个 worker 里可能
     * 依次跑多个测试文件，改进程级 cwd 会把别人的相对路径也一起改掉。
     */
    const mod = await import(`${pathToFileURL(CHECKER).href}?t=${Date.now()}${Math.random()}`);
    return await mod.checkArtifacts(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MUTATE-ARTIFACT-1：变异脚本 + 结果必须落进仓库并可复核", () => {
  it("MUT-ART-1/2: 仓库里登记的波次全部有可用且未过期的变异证据", async () => {
    const registry = JSON.parse(readFileSync(path.join(ROOT, "tools", "mutate", "registry.json"), "utf8"));
    expect(Array.isArray(registry.waves), "registry.json 必须有 waves 数组").toBe(true);
    expect(
      (registry.waves as string[]).length,
      "至少要登记一个波次：一个都没有意味着「变异证据」这件事没有任何机器条件在守",
    ).toBeGreaterThan(0);

    const mod = await import(`${pathToFileURL(CHECKER).href}?t=${Date.now()}`);
    const { problems } = await mod.checkArtifacts();
    expect(problems, `变异产物闸门报出的问题：\n${problems.join("\n")}`).toEqual([]);
  });

  it("MUT-ART-3 反向对照: 坏结果必须被各条检查抓出来，好结果不许被误报", async () => {
    // ① 结果文件缺失
    const missing = await checkInTempRoot(null);
    expect(missing.problems.join("\n"), "没有结果文件必须报出来").toContain("没有结果文件");

    // ② restored = false（指纹与变异都对 ⇒ 只有这一项坏）
    const notRestored = await checkInTempRoot({ restored: false });
    expect(notRestored.problems.join("\n"), "restored=false 必须被单独报出来").toContain("restored !== true");

    // ③ 有变异没红（指纹对、restored 对 ⇒ 只有这一项坏）
    const notRed = await checkInTempRoot({
      results: [{ id: "MUT-FAKE", expectedRed: true, observedRed: false, ok: false }],
    });
    expect(notRed.problems.join("\n"), "「改坏了判据还是绿」必须被单独报出来").toContain("判据可能是恒真的");

    // ④ 锚点过期（代码变了，规格里的原文找不到了）
    const staleDir = mkdtempSync(path.join(tmpdir(), "codem-mutate-stale-"));
    try {
      mkdirSync(path.join(staleDir, "tools/mutate/specs"), { recursive: true });
      mkdirSync(path.join(staleDir, "tools/mutate/results"), { recursive: true });
      writeFileSync(path.join(staleDir, "tools/mutate/registry.json"), JSON.stringify({ waves: ["fake-wave"] }));
      writeFileSync(path.join(staleDir, "tools/mutate/specs/fake-wave.json"), JSON.stringify(FAKE_SPEC));
      writeFileSync(
        path.join(staleDir, "tools/mutate/results/fake-wave.json"),
        JSON.stringify({
          wave: "fake-wave",
          restored: true,
          specFingerprint: specFingerprint(FAKE_SPEC),
          results: [{ id: "MUT-FAKE", expectedRed: true, observedRed: true, ok: true }],
        }),
      );
      writeFileSync(path.join(staleDir, "fake.txt"), "锚点已经不在文件里了");
      const mod = await import(`${pathToFileURL(CHECKER).href}?t=${Date.now()}${Math.random()}`);
      const stale = await mod.checkArtifacts(staleDir);
      expect(stale.problems.join("\n"), "锚点过期必须报出来").toContain("锚点");
    } finally {
      rmSync(staleDir, { recursive: true, force: true });
    }

    // ⑤ 全对 ⇒ 不许报问题（否则这道闸门是"永远红"，没人会看它）
    const good = await checkInTempRoot({});
    expect(good.problems, `好结果被误报：${good.problems.join("\n")}`).toEqual([]);
  });
});
