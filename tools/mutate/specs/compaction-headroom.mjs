/** 变异波次：压缩后留余量（避免「压完下一轮又满」）。 */
export default {
  description:
    "HEADROOM：自动压缩阈值=提示阈值 70%（>= 比较），压缩保留预算=窗口 40%（留 30% 余量）。判据 HEADROOM-1..3；3 条变异各自对红",
  mutations: [
    {
      id: "MUT-1 保留预算退回窗口 50%",
      why: "HEADROOM-2：压完 50–55%，下一轮涨 15–20% 又触发提示（用户实报「压完还是很快满」）",
      patches: [
        {
          file: "src/core/llm/agentic-loop.ts",
          from: "    const keepBudget = Math.max(8000, Math.floor(windowTokens * 0.4));",
          to: "    const keepBudget = Math.max(8000, Math.floor(windowTokens * 0.5));",
        },
      ],
      tests: ["src/test/compaction-headroom.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 自动压缩阈值退回 80%",
      why: "HEADROOM-1：提示线 70% 而压缩线 80% ⇒ 先打扰用户、再自己动手",
      patches: [
        {
          file: "src/core/llm/agentic-loop.ts",
          from: "  compactionThreshold: 0.7,",
          to: "  compactionThreshold: 0.8,",
        },
      ],
      tests: ["src/test/compaction-headroom.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 压缩触发改回严格大于",
      why: "HEADROOM-1：正好 70% 时只提示不压缩",
      patches: [
        {
          file: "src/core/llm/agentic-loop.ts",
          from: "this.state.contextPressure >= this.config.compactionThreshold",
          to: "this.state.contextPressure > this.config.compactionThreshold",
        },
      ],
      tests: ["src/test/compaction-headroom.test.ts"],
      expectRed: true,
    },
  ],
};
