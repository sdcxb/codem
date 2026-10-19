/** 变异波次：长回合里折叠陈旧工具输出（2026-10-19 用户实报"3–5 个长对话就满"）。 */
export default {
  description:
    "FOLD-LONGTURN：折叠保护边界改为「末尾 8 条消息 + 最近 2 条工具结果」，让单个长回合里陈旧的工具输出也能折；变异：退回按轮保护 / 去掉尾部保护 / 连最近 2 条也折 ⇒ 各自对红",
  mutations: [
    {
      id: "MUT-1 退回「只按最近 3 轮保护」",
      why: "FOLD-LONGTURN-1：长回合整轮被保护 ⇒ 折叠一条不动、水位仍 >70%（正是用户现场）",
      patches: [
        {
          file: "src/core/llm/tool-output-fold.ts",
          from: "    if (!Array.isArray(m?.toolCalls)) return;",
          to: "    if (i >= opts.protectedFromIndex) return;\n    if (!Array.isArray(m?.toolCalls)) return;",
        },
      ],
      tests: ["src/test/tool-output-fold-long-turn.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 去掉第二档短存根",
      why: "FOLD-LONGTURN-5：第一档折完仍高于 70% 时不再换存根 ⇒ 长会话还是弹提示",
      patches: [
        {
          file: "src/core/llm/tool-output-fold.ts",
          from: "  if (opts.estimate(current) > opts.targetTokens) {",
          to: "  if (false) {",
        },
      ],
      tests: ["src/test/tool-output-fold-long-turn.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 连最近 2 条工具结果也折",
      why: "FOLD-LONGTURN-1：最近 2 条是当前步骤正在依赖的结果，折了会让模型读残缺内容",
      patches: [
        {
          file: "src/core/llm/tool-output-fold.ts",
          from: "export const FOLD_KEEP_RECENT_RESULTS = 2;",
          to: "export const FOLD_KEEP_RECENT_RESULTS = 0;",
        },
      ],
      tests: ["src/test/tool-output-fold-long-turn.test.ts"],
      expectRed: true,
    },
  ],
};
