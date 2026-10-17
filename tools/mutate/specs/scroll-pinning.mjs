/**
 * 变异波次：流式滚动的图钉判定（判据 SCROLLPIN-1..4）。
 *
 * 这三条参数如果被"顺手改掉"，用户就会看到"我刚滚上去又被弹回底部"或
 * "滚动一直在追、追不上"——都是真机容易感知、单测却容易漏的形态。
 */
export default {
  description:
    "流式滚动图钉：贴底容差 40px / 用户输入冷却 150ms / 流式期 auto 对齐。变异：容差归零、冷却归零、流式改 smooth ⇒ 各自对应的判据必须红",
  mutations: [
    {
      id: "MUT-1 贴底容差归零",
      why: "SCROLLPIN-1：容差 0 意味着离底 1px 就被判成「用户滚开了」，新消息不再跟底",
      patches: [
        {
          file: "src/core/ui/scroll-pinning.ts",
          from: "export const SCROLL_PIN_TOLERANCE_PX = 40;",
          to: "export const SCROLL_PIN_TOLERANCE_PX = 0;",
        },
      ],
      tests: ["src/test/scroll-pinning.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 去掉用户输入冷却",
      why: "SCROLLPIN-3：冷却为 0 时，用户刚滚上去的一瞬间就会被新 token 拽回底部",
      patches: [
        {
          file: "src/core/ui/scroll-pinning.ts",
          from: "export const SCROLL_USER_INPUT_COOLDOWN_MS = 150;",
          to: "export const SCROLL_USER_INPUT_COOLDOWN_MS = 0;",
        },
      ],
      tests: ["src/test/scroll-pinning.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 流式期退回 smooth",
      why: "SCROLLPIN-2：smooth 动画会与高频 token 追加互相拉扯（观感是「一直在滚、追不上」）",
      patches: [
        {
          file: "src/core/ui/scroll-pinning.ts",
          from: 'return { scroll: true, behavior: input.streaming ? "auto" : "smooth" };',
          to: 'return { scroll: true, behavior: "smooth" };',
        },
      ],
      tests: ["src/test/scroll-pinning.test.ts"],
      expectRed: true,
    },
  ],
};
