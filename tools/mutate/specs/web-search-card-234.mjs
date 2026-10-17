/**
 * 第 234 波：`web_search` 的报告**不再被当成 grep 结果**渲染。
 *
 * 真机取证见 `docs/evidence/deepseek-web-200-2026-10-17/`：DeepSeek Search 的报告里
 * `站点: … · 日期: 2026-10-17T09:12:12.122Z` 命中 `^(.+?):(\d+):(.*)$`，把卡片渲染成
 * 「3 个假文件 + 每个 1 match」，而专用卡片 `WebSearchResultCard` 永远到不了。
 *
 * 三条变异各钉一个盲点：
 *   1. 门禁退回子串（旧写法）⇒ 1/3 红；
 *   2. 白名单漏掉 grep ⇒ 2 红（反向守卫：不许把真的文件行卡片弄坏）；
 *   3. `isWebSearch` 恒 false ⇒ 1 红（证明「不误判」不等于「渲染对了」—— 专用卡片必须真的在）。
 */
export default {
  description:
    "web_search 的报告不许被当成「路径:行号:内容」渲染（门禁从子串改成精确 id 白名单；判据 WEBSEARCH-CARD-1/2/3）",
  mutations: [
    {
      id: "MUT-1 门禁退回名字子串（旧写法）",
      why: "WEBSEARCH-CARD-1/3：`includes('search')` 会把 web_search / search_notebook 放进『猜 grep 形状』的分支，报告里的日期行就变成假文件行",
      patches: [
        {
          file: "src/components/ToolCallCard.tsx",
          from: "  if (!FILE_SHAPE_SEARCH_TOOLS.has(lower)) return null",
          to: "  if (lower !== 'grep' && lower !== 'glob' && lower !== 'search' && !lower.includes('search')) return null",
        },
      ],
      tests: ["src/test/web-search-card-not-grep.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-2 白名单漏掉 grep",
      why: "WEBSEARCH-CARD-2（反向）：grep 的输出契约就是文件行，漏掉它等于把真的搜索结果卡片弄坏",
      patches: [
        {
          file: "src/components/ToolCallCard.tsx",
          from: "const FILE_SHAPE_SEARCH_TOOLS = new Set(['grep', 'glob'])",
          to: "const FILE_SHAPE_SEARCH_TOOLS = new Set(['glob'])",
        },
      ],
      tests: ["src/test/web-search-card-not-grep.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-3 专用卡片关掉（isWebSearch 恒 false）",
      why: "WEBSEARCH-CARD-1：不误判只是『没画错』；专用卡片必须真的渲染出来（否则等于把一次搜索退化成通用 IN/OUT 卡）",
      patches: [
        {
          file: "src/components/ToolCallCard.tsx",
          from: "  const isWebSearch = toolName.toLowerCase() === 'web_search'",
          to: "  const isWebSearch = false",
        },
      ],
      tests: ["src/test/web-search-card-not-grep.test.tsx"],
      expectRed: true,
    },
  ],
};
