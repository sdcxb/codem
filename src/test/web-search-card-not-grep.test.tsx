/**
 * WEBSEARCH-CARD —— `web_search` 的报告**不许**被当成「文件:行号:内容」渲染。
 *
 * ## 真机取证（2026-10-17，docs/evidence/deepseek-web-200-2026-10-17/）
 *
 * DeepSeek Search 打开后，`web_search` 的输出是一份带元数据行的报告；其中
 * `站点: … · 日期: 2026-10-17T09:12:12.122Z` 这一行**恰好命中** `trySearchModel` 的
 * `^(.+?):(\d+):(.*)$`（把 `T09:12:12.122Z` 读成 `09` 行号），于是：
 *
 * - 卡片被渲染成 `SearchBlockCard`（"3 个假的文件 + 每个 1 match"），
 * - 本该显示的 `WebSearchResultCard`（标题/URL/snippet 列表）**永远到不了** ——
 *   它排在 `searchModel !== null` 之后，条件永远被前一支吃掉。
 *
 * 根因是那道门禁写成了 `toolName.toLowerCase().includes('search')`：
 * `web_search`、`search_notebook` 都被放了进来，而「`路径:行号:内容`」这个形状
 * **只有 grep / glob 的输出契约**才是。
 *
 * 这三条判据钉住：真报告走专用卡片（1）、grep 仍然走文件行卡片（2）、
 * 其它名字里带 search 的工具不被顺带误伤（3）。
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ToolCallGroup } from "../components/ToolCallGroup";
import type { ToolCallCardProps } from "../components/ToolCallCard";

/** DeepSeek Search 的真实报告形状（取自 docs/evidence 里的会话记录，日期行是触发点） */
const DEEPSEEK_SEARCH_REPORT = [
  "[Search source: DeepSeek Search]",
  "",
  'Found 2 results for "DeepSeek 官方文档 网页搜索与抓取":',
  "",
  "### 1. 网页搜索与抓取",
  "URL: https://api-docs.deepseek.com/zh-cn/guides/search/",
  "Snippet: Search / Fetch API 已上线，使用自研搜索引擎，支持网页搜索与抓取。",
  "Summary: 这一段是官方 summary（600~800 字，适合直接给模型阅读）。",
  "站点: api-docs.deepseek.com · 日期: 2026-10-17T09:12:12.122Z · 权威度: 4/4（极权威） · 相关度: 2.63（优质）",
  "",
  "### 2. 第三方转载（无站点信息）",
  "URL: https://e.test/third-party",
  "Snippet: 转载内容，元数据缺失。",
  "Summary: 无站点名的结果用于验证 null 字段的映射。",
  "权威度: -1/4（未知） · 相关度: 1.21",
].join("\n");

const webSearchItem: ToolCallCardProps = {
  toolName: "web_search",
  toolArgs: JSON.stringify({ query: "DeepSeek 官方文档 网页搜索与抓取" }),
  toolResult: DEEPSEEK_SEARCH_REPORT,
  status: "done",
  argsSummary: "DeepSeek 官方文档 网页搜索与抓取",
  metadata: { query: "DeepSeek 官方文档 网页搜索与抓取", resultCount: 2, source: "DeepSeek Search" },
};

/** grep 的输出契约就是 `路径:行号:内容` —— 它必须继续走文件行卡片 */
const grepItem: ToolCallCardProps = {
  toolName: "grep",
  toolArgs: JSON.stringify({ pattern: "websearch-head" }),
  toolResult: ["C:\\proj\\src\\a.tsx:12:  <div className=\"websearch-head\">", "C:\\proj\\src\\b.tsx:34:  </div>"].join("\n"),
  status: "done",
  argsSummary: "websearch-head",
};

/** 名字里带 search、但输出不是文件行的工具（曾经被同一个子串门禁误伤） */
const notebookItem: ToolCallCardProps = {
  toolName: "search_notebook",
  toolArgs: JSON.stringify({ query: "会议" }),
  toolResult: ["会议纪要 2026-10-17:1: 结论 A", "会议纪要 2026-10-17:2: 结论 B"].join("\n"),
  status: "done",
  argsSummary: "会议",
};

const renderGroup = (items: ToolCallCardProps[]) => {
  const { container } = render(<ToolCallGroup items={items} />);
  for (const pill of container.querySelectorAll(".tool-call-pill.expandable")) fireEvent.click(pill);
  return container;
};

describe("WEBSEARCH-CARD web_search 报告不被当成 grep 结果", () => {
  it("WEBSEARCH-CARD-1：web_search 报告里有 `日期: 2026-…T09:12:12.122Z` 也要走专用卡片", () => {
    const c = renderGroup([webSearchItem]);
    expect(c.querySelectorAll(".search-match-row").length, "web_search 的报告被渲染成了假的文件行匹配").toBe(0);
    expect(c.querySelectorAll(".search-block").length, "web_search 的报告不该走 SearchBlockCard").toBe(0);
    expect(c.querySelectorAll(".websearch-head").length, "专用卡片 WebSearchResultCard 没有被渲染（它被前面的分支吃掉了）").toBe(1);
    // 结果条目也要真的出来（标题 + 可点击的 URL），否则"专用卡片在"也可能是空壳
    const links = [...c.querySelectorAll<HTMLAnchorElement>(".websearch-title--link")];
    expect(links.map((a) => a.getAttribute("href")), "结果条目的 URL 没有渲染出来").toEqual([
      "https://api-docs.deepseek.com/zh-cn/guides/search/",
      "https://e.test/third-party",
    ]);
  });

  it("WEBSEARCH-CARD-2（反向）：grep 的 `路径:行号:内容` 仍然走文件行卡片", () => {
    const c = renderGroup([grepItem]);
    expect(c.querySelectorAll(".search-match-row").length, "grep 的命中行没有被渲染出来？").toBe(2);
    expect(c.querySelectorAll(".search-block").length).toBe(1);
  });

  it("WEBSEARCH-CARD-3（反向）：search_notebook 这种非文件检索工具不被顺带误伤", () => {
    const c = renderGroup([notebookItem]);
    expect(c.querySelectorAll(".search-match-row").length, "search_notebook 的输出不是文件行，却被解析成了文件匹配").toBe(0);
    expect(c.querySelectorAll(".search-block").length).toBe(0);
  });
});
