/**
 * **颜色用量注册表**门禁的契约用例（第 161 轮 P2-4，audit 第 20 道）。
 *
 * 这一组守的是**一类真实缺陷**：第 157 轮我手工数出全项目 57 处"状态色文字压在同色浅底上"，
 * 其中浅色档 error 在 20% 浅底上只有 **3.87:1**（10–12px 小标签）。那次靠人肉扫 + 一次性脚本，
 * 也就是说同一类问题下次还会漏。现在把它变成机器判据（`tools/audit/scan-color-roles.mjs`）：
 *   ① 文字色 × 底色必须是**登记过的组合**；② 登记过的还要**实算对比度**过角色下限；
 *   ③ 解析不了的（渐变底等）记进预算，只许降。
 *
 * 用例分两层：夹具层（判据本身）与真实仓库层（当前代码必须干净）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scanColorRoles, collectVars, ROLE_FLOORS, DEFAULT_FILES } from "../../tools/audit/scan-color-roles.mjs";

const ROOT = path.resolve(__dirname, "..", "..");
const registryPath = path.join(ROOT, "tools/audit/color-roles.json");

/** 构造"令牌表 + 文件"的夹具：两档主题各给一份 vars（底色都用白，免得夹具自己引入跨档差异） */
const fixture = (lightVars: Record<string, string>, css: string) => {
  const vars = {
    light: { "--bg-primary": "#ffffff", ...lightVars },
    dark: { "--bg-primary": "#ffffff", ...lightVars },
  };
  const registry = { pairs: {} as Record<string, unknown>, unresolvedBudget: 0 };
  return { vars, registry, files: [{ path: "fixture.css", css }] };
};

describe("COLOR-ROLES 颜色用量注册表（第 161 轮 P2-4）", () => {
  it("CR-1：未登记的组合 → 红（新写一处「状态色文字压在同色浅底上」就该被拦下）", () => {
    const { vars, registry, files } = fixture(
      { "--error": "#cf222e", "--error-surface": "color-mix(in srgb, var(--error) 20%, transparent)" },
      `.a { color: var(--error); background: var(--error-surface); }`,
    );
    const r = scanColorRoles({ files, vars, registry });
    expect(r.pairs.size, "应识别出 1 对（角色 × 表面）").toBe(1);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].kind).toBe("unregistered");
    expect(r.violations[0].key).toBe("--error|--error-surface");
  });

  it("CR-2：登记了但对比度不达标 → 红（这正是 157 轮那个 3.87 会被自动抓到的地方）", () => {
    const { vars, files } = fixture(
      { "--error": "#cf222e", "--error-surface": "color-mix(in srgb, var(--error) 20%, transparent)" },
      `.a { color: var(--error); background: var(--error-surface); }`,
    );
    /* 故意登记成「已批准」，但**不让它过对比度** —— 门禁的第二层必须拦住 */
    const registry = { pairs: { "--error|--error-surface": { registeredAt: "2026-09-26" } }, unresolvedBudget: 0 };
    const r = scanColorRoles({ files, vars, registry });
    const below = r.violations.filter((v) => v.kind === "below-floor");
    expect(below.length, "两档主题都该报（浅色档 20% 浅底上只有 ~3.9）").toBeGreaterThan(0);
    expect(below[0].why).toMatch(/只有 [\d.]+:1（下限 4\.5）/);
  });

  it("CR-3：换成一档够用的文字角色（-content）→ 绿（修法也要被证明有效）", () => {
    const { vars, files } = fixture(
      {
        "--error": "#cf222e",
        "--error-surface": "color-mix(in srgb, var(--error) 20%, transparent)",
        "--error-content": "color-mix(in srgb, var(--error) 86%, #1f1f1e)",
      },
      `.a { color: var(--error-content); background: var(--error-surface); }`,
    );
    const registry = { pairs: { "--error-content|--error-surface": { registeredAt: "2026-09-26" } }, unresolvedBudget: 0 };
    const r = scanColorRoles({ files, vars, registry });
    expect(r.violations, `不该报：${JSON.stringify(r.violations)}`).toEqual([]);
  });

  it("CR-4：解析不了的底（渐变/多层）记进 unresolved 预算，不许静默跳过", () => {
    const { vars, registry, files } = fixture(
      { "--text-primary": "#1f1f1e" },
      `.a { color: var(--text-primary); background: linear-gradient(180deg, #fff, #eee); }`,
    );
    const r = scanColorRoles({ files, vars, registry });
    expect(r.pairs.size, "解析不了就不该假装扫过（不进 pairs）").toBe(0);
    expect(r.unresolved.length, "必须记进 unresolved").toBe(1);
    expect(r.unresolved[0].why).toMatch(/渐变|字面量|多层/);  });

  it("CR-5：非令牌的文字色不算这一题（避免把整仓都拖进来）", () => {
    const { vars, registry, files } = fixture(
      { "--bg-primary": "#ffffff" },
      `.a { color: #333; background: var(--bg-primary); }\n.b { color: #333; background: #444; }`,
    );
    const r = scanColorRoles({ files, vars, registry });
    expect(r.pairs.size).toBe(0);
    expect(r.unresolved.length, "两个都不是「角色 × 表面」的配对：一个底色是令牌但没有角色，一个是纯字面量").toBe(0);
  });

  /**
   * CR-7：**报出来的行号必须能直接用**。
   *
   * 起因：第一版去注释用的是 `replace(comment, "")`，后面所有偏移前移 ⇒ 报告里
   * `src/styles.css:11265 .quote-context-banner` 实际指向一个 `@keyframes`（差了几百行）。
   * 门禁报的位置不能用，等于让人拿假线索去改代码。现在改成"注释换成等长空格"，偏移与原文一致。
   */
  it("CR-7：带注释的夹具里，报出的行号与原文一致（注释不能把偏移吃掉）", () => {
    const css = `/* 第一行注释\n   第二行注释 */\n.a { color: var(--error); background: var(--error-surface-strong); }\n.b { color: var(--text-primary); background: var(--bg-hover); }`;
    const { vars, registry, files } = fixture(
      {
        "--error": "#cf222e",
        "--error-surface-strong": "color-mix(in srgb, var(--error) 20%, transparent)",
        "--text-primary": "#1f1f1e",
        "--bg-hover": "#eeeeec",
      },
      css,
    );
    const r = scanColorRoles({ files, vars, registry });
    const lines = [...r.pairs.values()].flatMap((p: { samples: string[] }) => p.samples);
    expect(lines.some((s) => s.startsWith("fixture.css:3")), `规则 .a 在第 3 行，实际报告：${JSON.stringify(lines)}`).toBe(true);
    expect(lines.some((s) => s.startsWith("fixture.css:4")), "规则 .b 在第 4 行").toBe(true);
  });

  it("CR-6（真实仓库）：注册表存在、覆盖当前所有配对，且都过角色下限", () => {    const files = DEFAULT_FILES.filter((rel) => readFileSync(path.join(ROOT, rel), "utf8") !== "").map((rel) => ({
      path: rel,
      css: readFileSync(path.join(ROOT, rel), "utf8"),
    }));
    const vars = collectVars(files.map((f) => f.css).join("\n"));
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const r = scanColorRoles({ files, vars, registry });
    expect(r.violations, `颜色用量违规：\n${r.violations.map((v) => `  - [${v.kind}] ${v.key} ${v.why}`).join("\n")}`).toEqual([]);
    expect(r.pairs.size, "配对数量骤降说明扫描坏了").toBeGreaterThan(30);
    /* 预算按**去重后**的键算（同一形态出现 N 次只算 1 条）—— 第一版拿原始条目数比预算，报出 322 vs 145 的假红 */
    expect(r.unresolvedKeys.length, `解析不了的配对涨了（预算 ${registry.unresolvedBudget}）`).toBeLessThanOrEqual(registry.unresolvedBudget);
    /* 角色的下限必须有出处：数值只能是 3 / 4.5 / 6 / 7 这几档（拍出来的数不允许悄悄进来） */
    for (const [role, floor] of Object.entries(ROLE_FLOORS)) {
      expect([3, 4.5, 6, 7], `${role} 的下限 ${floor} 不在允许的档位上`).toContain(floor);
    }
  });
});
