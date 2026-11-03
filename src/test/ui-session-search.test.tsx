/**
 * 会话搜索判据（SEARCH-1..2）：
 * - 输入关键词只显示标题匹配的会话；
 * - 没有匹配时显示明确空态（不把"列表空"和"搜索无结果"混为一谈）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionList } from "../../packages/ui/src/components";

const sessions = [
  { id: "1", title: "修复登录 bug", messageCount: 3, lastMessageAt: 1 },
  { id: "2", title: "复盘 Android 验证", messageCount: 5, lastMessageAt: 2 },
  { id: "3", title: "写文档", messageCount: 1, lastMessageAt: 3 },
];

function Harness({ query }: { query: string }) {
  const [q, setQ] = [query, () => undefined] as const;
  return <SessionList sessions={sessions} onOpen={() => undefined} query={q} onQueryChange={() => undefined} />;
}

describe("SEARCH-1 过滤", () => {
  it("只显示标题匹配项", () => {
    render(<Harness query="复盘" />);
    expect(screen.getByText("复盘 Android 验证")).toBeTruthy();
    expect(screen.queryByText("修复登录 bug")).toBeNull();
    expect(screen.queryByText("写文档")).toBeNull();
  });

  it("空关键词显示全部", () => {
    render(<Harness query="  " />);
    expect(screen.getByText("修复登录 bug")).toBeTruthy();
    expect(screen.getByText("复盘 Android 验证")).toBeTruthy();
    expect(screen.getByText("写文档")).toBeTruthy();
  });
});

describe("SEARCH-2 空态", () => {
  it("无匹配时给出专门提示", () => {
    render(<Harness query="不存在的标题" />);
    expect(screen.getByText("没有匹配的会话")).toBeTruthy();
  });
});

describe("SEARCH-3 输入回调", () => {
  it("输入触发 onQueryChange", () => {
    let got = "";
    render(<SessionList sessions={sessions} onOpen={() => undefined} query="" onQueryChange={(v) => (got = v)} />);
    fireEvent.change(screen.getByPlaceholderText("搜索会话"), { target: { value: "文档" } });
    expect(got).toBe("文档");
  });
});
