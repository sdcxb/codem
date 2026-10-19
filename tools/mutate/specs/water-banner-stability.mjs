/** 变异波次：水位提示条防抖（打开时闪烁）。 */
export default {
  description:
    "STAB：提示条可见性防抖（连续 2 拍 ≥70% 才显示、连续 2 拍低于才隐藏、读不到不改可见性）。判据 STAB-1..5；3 条变异各自对红",
  mutations: [
    {
      id: "MUT-1 一拍就显示",
      why: "STAB-1/4：打开会话时第一拍高水位就显示 ⇒ 闪一下（用户实报）",
      patches: [
        {
          file: "src/core/context/water-level.ts",
          from: "  const showAfter = Math.max(1, opts.showAfter ?? 2);",
          to: "  const showAfter = 1;",
        },
      ],
      tests: ["src/test/water-banner-stability.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 读不到就立刻隐藏",
      why: "STAB-2：镜像未就绪不等于「不满」，隐藏会造成闪烁",
      patches: [
        {
          file: "src/core/context/water-level.ts",
          from: "  if (!level.authoritative) {\n    // 读数不可信：保留可见性与 streaks，只更新展示用的 level（避免 UI 闪成 0%）\n    return { ...prev, level };\n  }",
          to: "  if (!level.authoritative) {\n    return { ...prev, level, visible: false };\n  }",
        },
      ],
      tests: ["src/test/water-banner-stability.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 提示条不接防抖 hook",
      why: "STAB-5：接线回到裸水位 hook ⇒ 防抖逻辑等于没写",
      patches: [
        {
          file: "src/components/WaterLevelBanner.tsx",
          from: "  const { level, visible: stableRiskVisible } = useStableContextWaterLevel(sessionId);",
          to: "  const { level } = useStableContextWaterLevel(sessionId);\n  const stableRiskVisible = level.level >= WATER_LEVEL.HIGH;",
        },
      ],
      tests: ["src/test/water-banner-stability.test.ts"],
      expectRed: true,
    },
  ],
};
