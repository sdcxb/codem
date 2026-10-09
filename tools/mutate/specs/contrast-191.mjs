/**
 * 变异自证：`CR-CONTRAST-1`（亮度阈值单一来源，GAP-LIST O-39，第 191 波）。
 *
 * 守的判据：`src/test/contrast-luminance-single-source.test.ts` ——
 * 「全仓只允许一份阈值字面量」+「产品侧与审计侧读同一个来源」。
 *
 * 四条变异各自瞄准判据的一面：
 *   MUT-1 产品侧自己写回旧阈值   ⇒ CR-1（代码里多出一份字面量）+ CR-2（产品≠审计）都该红
 *   MUT-2 审计侧自己写一份旧阈值 ⇒ 同上（而且它正是 O-39 原始形态里 `.mjs` 那一份）
 *   MUT-3 测试文件把镜像函数改回去 ⇒ CR-1 该红（这就是"同一簇 bug 会成三份出现"那一份）
 *   MUT-4 **反向对照**（`expectRed: false`）：只改唯一来源的 `_why` 文案，不动数值
 *         ⇒ 判据必须**保持绿**（证明它钉的是阈值与结构，不是"文件一被碰就红"）
 *
 * ⚠️ 旧阈值字面量在这里**用拼接构造**（`["0.039", "28"].join("")`）：
 * CR-CONTRAST-1 会扫 `tools/**` 的代码，规格文件若直接写出字面量，它自己就成了"第二处实现"。
 * 拼接出来的东西在 `to` 里跟真值一模一样，变异照旧生效。
 */
const OLD = ["0.039", "28"].join("");

export default {
  description: "CR-CONTRAST-1：亮度阈值只许有一处实现（产品/审计/测试三侧各来一条 + 一条反向对照）",
  mutations: [
    {
      id: "MUT-1 产品侧把阈值写回旧值（绕开唯一来源）",
      why: "CR-1 要求代码里字面量只许在 wcag-luminance.json；CR-2 要求产品侧与审计侧同源。产品侧硬编码旧值 ⇒ 两条都该红。",
      patches: [
        {
          file: "src/core/theme/contrast-checker.ts",
          from: "  return s <= srgbLinearThreshold ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);",
          to: `  return s <= ${OLD} ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);`,
        },
      ],
      tests: ["src/test/contrast-luminance-single-source.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 审计侧自己写一份旧阈值（不再读单一来源）",
      why: "这正是 O-39 的原始形态：纯 node 侧另写一份、且用的是 WCAG 2.0 初版的旧值。CR-1+CR-2 都该红。",
      patches: [
        {
          file: "tools/audit/scan-color-roles.mjs",
          from: "    return s <= srgbLinearThreshold ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;",
          to: `    return s <= ${OLD} ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;`,
        },
      ],
      tests: ["src/test/contrast-luminance-single-source.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 测试文件把镜像的亮度函数改回去",
      why: "O-39 里 3 个测试文件各镜像了一份旧阈值（同一事实 4 处实现）。改回去 ⇒ CR-1 该红。",
      patches: [
        {
          file: "src/test/style-token-gates.test.ts",
          from: "      return 0.2126 * channelLinear(c.r) + 0.7152 * channelLinear(c.g) + 0.0722 * channelLinear(c.b);",
          to: `      const f = (v: number) => { v /= 255; return v <= ${OLD} ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };\n      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);`,
        },
      ],
      tests: ["src/test/contrast-luminance-single-source.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 只改唯一来源的说明文案（反向对照：不该红）",
      why: "判据钉的是阈值数值与「只有一处实现」，不是「文件一被碰就红」—— 改一段不含数字的 `_why` 文案必须保持全绿。",
      patches: [
        {
          file: "src/core/theme/wcag-luminance.json",
          from: "（GAP-LIST O-39 / 判据 CR-CONTRAST-1）",
          to: "（GAP-LIST O-39 / 判据 CR-CONTRAST-1；本段文案被 MUT-4 改过，数值没动）",
        },
      ],
      tests: ["src/test/contrast-luminance-single-source.test.ts"],
      expectRed: false,
    },
  ],
};
