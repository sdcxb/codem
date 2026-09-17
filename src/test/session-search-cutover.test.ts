/**
 * 会话搜索分流契约（P3 第 9 段）。
 *
 * ## 这一段修的是"中文搜不到"这个真实缺陷
 *
 * 旧实现把查询原样加引号交给 FTS4/unicode61，而 unicode61 把**整串 CJK 当作一个 token**，
 * 所以查"存储"永远匹配不到；另外它还算了 `matchExpr` 却**从未用于 SQL**（死代码），
 * 于是"全局搜索"也从没生效过。这里钉住修复后的行为：
 *
 * 1. 端口是 rust → 走引擎（含 CJK 切分），并**跨会话**（不传 session_id）；
 * 2. 端口未注册 / 是 wasm → 完全走原路径（回滚开关的前提）；
 * 3. 片段在**真实正文**上生成（索引里存的是切分后的文本，不能直接展示）；
 * 4. 引擎报错时如实返回错误文本，不假装"没有结果"。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";

vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
}));

function rustPortWith(rows: Array<Record<string, unknown>>, opts: { fail?: boolean } = {}) {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  const port = {
    kind: "rust" as const,
    engine: {} as never,
    config: {} as never,
    append: {} as never,
    events: {} as never,
    configDomain: {} as never,
    messages: {} as never,
    data: {
      async query(cmd: string, params: Record<string, unknown> = {}) {
        calls.push({ cmd, params });
        if (opts.fail) throw new Error("引擎检索失败（模拟）");
        return { items: rows, hasMore: false };
      },
      async execute() {
        return { written: 1 };
      },
      async write() {
        return { written: 0 };
      },
    },
  };
  return { port, calls };
}

async function runSearch(query: string, extra: Record<string, unknown> = {}) {
  const { createSessionSearchTool } = await import("../core/llm/tools/session-search");
  const tool = createSessionSearchTool();
  return tool.execute({ query, ...extra }, {} as never);
}

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("会话搜索分流", () => {
  it("SEARCH-1: 走引擎并做**跨会话**搜索（不传 session_id）", async () => {
    const { port, calls } = rustPortWith([
      { message_id: "m1", role: "user", timestamp: 1000, session_id: "s1", content: "关于存储迁移的讨论", session_title: "会话一" },
      { message_id: "m2", role: "assistant", timestamp: 2000, session_id: "s2", content: "另一会话也提到存储迁移", session_title: "会话二" },
    ]);
    setStoragePort(port);

    const res = await runSearch("存储");
    const call = calls.find((c) => c.cmd === "fts.search");
    expect(call, "必须调用引擎的 fts.search").toBeTruthy();
    expect(call?.params).not.toHaveProperty("session_id", expect.anything());
    expect(call?.params.session_id, "全局搜索不得限定会话（旧实现的死代码 bug）").toBeUndefined();
    expect(res.output).toContain("Found 2 result(s)");
    expect(res.output).toContain("会话一");
    expect(res.output).toContain("会话二");
  });

  it("SEARCH-2: 给 session_id 时限定会话", async () => {
    const { port, calls } = rustPortWith([
      { message_id: "m1", role: "user", timestamp: 1000, session_id: "s1", content: "内容", session_title: "会话一" },
    ]);
    setStoragePort(port);
    await runSearch("内容", { session_id: "s1" });
    expect(calls.find((c) => c.cmd === "fts.search")?.params.session_id).toBe("s1");
  });

  it("SEARCH-3: 片段在**真实正文**上生成并高亮查询词", async () => {
    const content = "前面的内容 " + "无关".repeat(30) + " 关于存储迁移的讨论 " + "尾".repeat(30);
    const { port } = rustPortWith([
      { message_id: "m1", role: "user", timestamp: 1, session_id: "s1", content, session_title: "T" },
    ]);
    setStoragePort(port);
    const res = await runSearch("存储迁移");
    expect(res.output, "应高亮命中的查询词").toContain("[存储迁移]");
    expect(res.output, "片段前后应有省略号说明被截断").toContain("…");
    // 片段长度应受控（radius*2 + 高亮），而不是把正文整段塞进结果
    expect(res.output.length, "片段长度应有界（约 2×radius + 高亮）").toBeLessThan(240);
  });

  it("SEARCH-4: 查询词只在正文里以双字片段出现时，片段定位仍可用", async () => {
    const { port } = rustPortWith([
      { message_id: "m1", role: "user", timestamp: 1, session_id: "s1", content: "这里谈到了上下文压缩的问题", session_title: "T" },
    ]);
    setStoragePort(port);
    // 查询"上下文压缩"会被切成 bigram 参与匹配；正文里存在完整形态 → 应高亮完整的四字词
    const res = await runSearch("上下文压缩");
    expect(res.output, `片段应高亮命中的词：${res.output}`).toContain("[上下文压缩]");

    // 反过来：正文只有其中一段（没有"上下文问题"这个连续串）时，
    // 应退化成高亮命中的 bigram，而不是"看不到关键词"
    const res2 = await runSearch("上下文问题");
    expect(res2.output, `退化后仍应高亮某个 CJK 双字片段：${res2.output}`).toMatch(/\[[\u3400-\u9fff]{2}\]/);
  });

  it("SEARCH-5: 端口未注册 → 完全走原路径（不调用引擎）", async () => {
    setStoragePort(null);
    const res = await runSearch("任意");
    // 原路径会去拿旧库（被 mock 成抛错）→ 工具把错误如实返回，而不是假装无结果
    expect(res.output).toContain("Error");
  });

  it("SEARCH-6: 端口是 wasm → 同样走原路径（回滚开关生效）", async () => {
    setStoragePort({
      kind: "wasm",
      engine: {} as never,
      data: {} as never,
      config: {} as never,
      append: {} as never,
    });
    const res = await runSearch("任意");
    expect(res.output).toContain("Error");
  });

  it("SEARCH-7: 引擎报错时如实返回错误文本（不谎报「没有结果」）", async () => {
    const { port } = rustPortWith([], { fail: true });
    setStoragePort(port);
    const res = await runSearch("存储");
    // 引擎抛错 → 被 catch 捕获 → 返回 Error: …（绝不能显示 "No results found"）
    expect(res.output, `出错时不能显示「没有结果」：${res.output}`).not.toContain("No results found");
  });

  it("SEARCH-8: 空结果如实报告", async () => {
    const { port } = rustPortWith([]);
    setStoragePort(port);
    const res = await runSearch("不存在的词");
    expect(res.output).toContain("No results found");
  });
});
