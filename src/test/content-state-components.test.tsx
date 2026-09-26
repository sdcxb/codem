/**
 * 内容态三组件的用例（第 175 轮 P2-1）。
 *
 * 判据都盯着"读屏能不能知道发生了什么"，而不只是"渲染出来了"：
 *   CS-1 Spinner 带 role=status 与可访问名（加载指示器是状态变化，读屏要能念）
 *   CS-2 Spinner 的尺寸走 --icon-* 刻度（不是各写一套 px）
 *   CS-3 Skeleton 是 aria-hidden 的视觉占位（不该被读屏逐行念"灰条"）
 *   CS-4 Skeleton 多行时最后一行收窄（模仿真实文本收尾）
 *   CS-5 StatusBanner 恒有 role=alert；error 档 aria-live=assertive，其余 polite
 *   CS-6 StatusBanner 只有给了 onRetry 才渲染重试按钮
 */
import { describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { Spinner } from "../components/ui/Spinner";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusBanner } from "../components/ui/StatusBanner";

describe("内容态共享组件", () => {
  it("CS-1：Spinner 带 role=status 与可访问名", () => {
    const { container } = render(<Spinner label="正在读取文件" />);
    const el = container.querySelector(".spinner")!;
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-label")).toBe("正在读取文件");
    cleanup();
    /* 父容器已经有等价文字时传空串：不要重复念，也不该留一个空名 */
    const { container: c2 } = render(<Spinner label="" />);
    const el2 = c2.querySelector(".spinner")!;
    expect(el2.getAttribute("aria-label")).toBeNull();
    expect(el2.getAttribute("aria-hidden")).toBe("true");
  });

  it("CS-2：Spinner 尺寸走 --icon-* 刻度", () => {
    for (const [size, token] of [["sm", "--icon-xs"], ["md", "--icon-sm"], ["lg", "--icon-lg"]] as const) {
      const { container } = render(<Spinner size={size} />);
      const style = container.querySelector(".spinner")!.getAttribute("style") ?? "";
      expect(style, `${size} 档应使用 ${token}`).toContain(`--spinner-size: var(${token})`);
      cleanup();
    }
  });

  it("CS-3/CS-4：Skeleton 对读屏隐藏，且多行时最后一行收窄", () => {
    const { container } = render(<Skeleton lines={3} height={14} />);
    const group = container.querySelector(".skeleton-group")!;
    expect(group.getAttribute("aria-hidden")).toBe("true");
    const rows = [...container.querySelectorAll(".skeleton")];
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute("style")).toContain("height: 14px");
    expect(rows[0].getAttribute("style")).toContain("width: 100%");
    expect(rows[2].getAttribute("style"), "最后一行应收窄成 60%").toContain("width: 60%");
    cleanup();
    /* 单行时不该收窄（那不是"文本收尾"，是唯一的占位） */
    const { container: c2 } = render(<Skeleton />);
    expect(c2.querySelector(".skeleton")!.getAttribute("style")).toContain("width: 100%");
  });

  it("CS-5：StatusBanner 恒有 role=alert，error 档 assertive、其余 polite", () => {
    const { container } = render(<StatusBanner tone="error">保存失败</StatusBanner>);
    const el = container.querySelector(".status-banner")!;
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.getAttribute("aria-live")).toBe("assertive");
    expect(el.className).toContain("is-error");
    cleanup();
    for (const tone of ["info", "success", "warning"] as const) {
      const { container: c } = render(<StatusBanner tone={tone}>提示</StatusBanner>);
      const b = c.querySelector(".status-banner")!;
      expect(b.getAttribute("aria-live"), `${tone} 档应为 polite`).toBe("polite");
      expect(b.className).toContain(`is-${tone}`);
      cleanup();
    }
  });

  it("CS-6：只有给了 onRetry 才出现重试按钮", () => {
    const { container } = render(<StatusBanner tone="error">出错了</StatusBanner>);
    expect(container.querySelector(".status-banner-retry")).toBeNull();
    cleanup();
    const onRetry = vi.fn();
    const { container: c2 } = render(<StatusBanner tone="error" onRetry={onRetry} retryLabel="重试一次">出错了</StatusBanner>);
    const btn = c2.querySelector(".status-banner-retry")!;
    expect(btn.textContent).toContain("重试一次");
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
