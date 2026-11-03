/**
 * M4 窄屏「变更」入口判据。
 *
 * 背景：第三列 `.detail-pane` 在 <1000px 被隐藏，手机上原本没有任何「变更」入口，
 * 导致 M3 的变更面在手机上实际不可达（安装包验收发现的 P1）。
 * 修复方式是 Header 增加「变更」按钮，打开整屏 `SessionChangesPane`。
 *
 * 这里钉两件事：
 * 1) 传了 `onOpenChanges` 才渲染按钮，点击触发；没传就不渲染；
 * 2) `MobileApp` 的接线必须同时带 `caps.changes` 与 `sessionId`，不能画一个没有会话的入口。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { Header } from "../../packages/ui/src/components";

describe("MC-1 窄屏「变更」入口", () => {
  it("传 handler 才出现，点击会触发", () => {
    const onOpenChanges = vi.fn();
    render(
      <Header title="t" state={null} connected onOpenChanges={onOpenChanges} />,
    );
    fireEvent.click(screen.getByText("变更"));
    expect(onOpenChanges).toHaveBeenCalledTimes(1);
  });

  it("没传 handler 不渲染（能力不支持时不画死按钮）", () => {
    render(<Header title="t" state={null} connected />);
    expect(screen.queryByText("变更")).toBeNull();
  });

  it("MobileApp 的接线：只在有会话且 caps.changes 时给入口，并挂整屏面板", () => {
    const src = readFileSync(
      resolve(process.cwd(), "packages/ui/src/mobile-app.tsx"),
      "utf8",
    );
    expect(src).toContain(
      'onOpenChanges={sessionId && caps.changes ? () => setChangesOpen(true) : undefined}',
    );
    expect(src).toContain("changesOpen && sessionId && caps.changes && transport");
    expect(src).toContain("<SessionChangesPane");
  });

  it("≥1000px 隐藏 Header 入口，避免与第三列「变更」页签重复", () => {
    const css = readFileSync(resolve(process.cwd(), "packages/ui/src/ui.css"), "utf8");
    const start = css.indexOf("@media (min-width: 1000px)");
    expect(start).toBeGreaterThan(-1);
    const next = css.indexOf("@media", start + 1);
    const block = css.slice(start, next > 0 ? next : undefined);
    expect(block).toContain(".changes-button");
    expect(block).toMatch(/\.changes-button\s*\{\s*display:\s*none;?\s*\}/);

    render(<Header title="t" state={null} connected onOpenChanges={vi.fn()} />);
    expect(screen.getByText("变更").className).toContain("changes-button");
  });
});
