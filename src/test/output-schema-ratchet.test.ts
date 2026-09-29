/**
 * 门禁：结果契约（`outputSchema`）的**采纳率棘轮**。
 *
 * ## 为什么需要这条
 *
 * 第 121 轮给 `glob` / `grep` 注册了结果契约，其余 **49 个工具零变化**。
 * 我当时把它写成「示范性质」，但那句话有个问题：**它不可度量**。
 * 下一个人（或我自己）无法从门禁看出"这件事还要不要继续做"，
 * 也看不出"是不是又悄悄退回去了"。
 *
 * 这个仓库对"渐进推进但要求不许倒退"的场景已经有成熟做法（图标字面量棘轮、
 * 覆盖率地板、fail-open 白名单）—— 都用**基线上限/下限 + 只许单向移动**。
 * 这里照同一套：记下当前采纳数，**只许增加**。
 *
 * ## 棘轮的两个方向都要管
 *
 * - **减少** ⇒ 红。有人把已注册的 `outputSchema` 删了（能力倒退），
 *   或者改坏了声明。
 * - **增加** ⇒ 需要同步抬高基线（`--update`）。这是有意的摩擦：
 *   逼着在"多覆盖一个工具"的时候顺手说明它是什么形状。
 *
 * 只加"不许减少"的话，基线会永远停在 2，变成一句没人看的记录。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultToolRegistry } from "../core/llm/tools";

const BASELINE = join(__dirname, "..", "..", "tools", "audit", "output-schema-baseline.json");

interface Baseline {
  _note: string;
  /** 已注册 outputSchema 的工具 id 清单（**只许增长**）。 */
  covered: string[];
  /** 基线建立时的工具总数，用于判断"被稀释"（分母涨了但分子没涨）。 */
  toolCountAtBaseline: number;
}

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
}

/** 当前注册了 `outputSchema` 的工具 id。 */
function coveredTools(): string[] {
  const registry = createDefaultToolRegistry();
  return registry
    .getAll()
    .filter((t) => registry.getRawContract(t.id)?.outputSchema !== undefined)
    .map((t) => t.id)
    .sort();
}

describe("结果契约采纳率棘轮（只许增长）", () => {
  const baseline = loadBaseline();
  const current = coveredTools();

  it("基线文件本身有效（证明它被真的读到了）", () => {
    expect(Array.isArray(baseline.covered)).toBe(true);
    expect(baseline.covered.length).toBeGreaterThan(0);
    expect(baseline.toolCountAtBaseline).toBeGreaterThan(0);
    expect(baseline._note.length).toBeGreaterThan(20);
  });

  it("已覆盖的工具**不许减少**（能力倒退）", () => {
    const lost = baseline.covered.filter((id) => !current.includes(id));
    expect(
      lost,
      `这些工具本来注册了 outputSchema，现在没有了：${lost.join(", ")}\n` +
        `（若是有意去掉，请同时更新 output-schema-baseline.json 并写明原因）`,
    ).toEqual([]);
  });

  it("新增覆盖时要把基线一起抬高（否则棘轮形同虚设）", () => {
    const added = current.filter((id) => !baseline.covered.includes(id));
    expect(
      added,
      `这些工具新注册了 outputSchema：${added.join(", ")}\n` +
        `请跑 \`node tools/audit/output-schema-baseline.mjs --update\` 抬高基线 —— ` +
        `不抬高的话，下次它们被删掉也不会有任何门禁报警。`,
    ).toEqual([]);
  });

  /**
   * 基线里的 `toolCountAtBaseline` 来自**静态文本扫描**（脚本在纯 node 下无法
   * import registry —— 它要 Tauri/Cordis 环境）。实测它偏大（扫到 75，真实 51）：
   * `src/core` 下有若干文件含 `ToolDef` 工厂但与「当前注册表」无关（作用域/动态注册）。
   *
   * 静态扫描做不到精确，那就**别假装它准**。这里改为：
   * **基线工具数必须与真实 registry 一致**，不一致就红并要求跑 `--update`。
   * 于是它从「一个可能永远不对的参考数字」变成「一条会逼你刷新的判据」。
   */
  it("基线的工具数与真实 registry 一致（不一致说明基线过期，要刷）", () => {
    const registry = createDefaultToolRegistry();
    const real = registry.getAll().length;
    expect(
      baseline.toolCountAtBaseline,
      `基线记的是 ${baseline.toolCountAtBaseline} 个工具，真实 registry 是 ${real} 个 —— ` +
        `跑 \`node tools/audit/output-schema-baseline.mjs --update\` 刷新基线`,
    ).toBe(real);
  });

  it("工具总数没被稀释（分母涨了但一个都没多覆盖）", () => {
    const registry = createDefaultToolRegistry();
    const now = registry.getAll().length;
    expect(now, "registry 工具数异常").toBeGreaterThan(0);

    // 工具数增长本身没问题；但**增长的同时一个契约都没加**说明这件事被遗忘了。
    // 注意：这条判据只有在分母真的涨了的时候才会触发 —— 所以上面那条
    // 「基线与 registry 一致」是它的前提（否则这里的比较可能因为基线过期而失真）。
    if (now > baseline.toolCountAtBaseline) {
      expect(
        current.length,
        `工具从基线时的 ${baseline.toolCountAtBaseline} 增到 ${now}，但注册结果契约的仍是 ${current.length} 个 —— ` +
          `新工具应当顺手声明结果形状（见 glob / grep 的示例）`,
      ).toBeGreaterThan(baseline.covered.length);
    }
  });

  it("基线记录的采纳率与真实 registry 一致（口径交叉核对）", () => {
    // 基线由**静态扫描**生成、判据走**真实 registry**。两者若不一致，
    // 说明扫描口径坏了（例如把非工具的 id 当成工具）—— 那时基线不可信，
    // 必须红，而不是悄悄用一个错数字去比。
    const registry = createDefaultToolRegistry();
    const realCovered = coveredTools();
    expect(
      realCovered,
      "基线与真实 registry 的已覆盖集合不一致 —— 跑 tools/audit/output-schema-baseline.mjs 核对口径",
    ).toEqual(baseline.covered);
    expect(registry.getAll().length).toBeGreaterThan(0);
  });

  it("已覆盖的工具，其 outputSchema 必须是非空对象（不是占位）", () => {
    const registry = createDefaultToolRegistry();
    for (const id of current) {
      const schema = registry.getRawContract(id)?.outputSchema;
      expect(schema, `${id} 的 outputSchema 为空`).toBeTruthy();
      expect(Object.keys(schema as object).length, `${id} 的 outputSchema 是空对象`).toBeGreaterThan(0);
    }
  });
});
