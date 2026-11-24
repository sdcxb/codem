/** 恢复提示：默认只给一行结果，技术判据在折叠的 details 里。 */
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { PersistFailureBanner } from "../components/PersistFailureBanner";
import { useAppStore } from "../store";

afterEach(() => {
  act(() => useAppStore.setState({ persistAlerts: [] }));
});

describe("PersistFailureBanner 技术详情", () => {
  it("默认折叠，点开才看到 kind/reason；主文案不出现技术字段", () => {
    const { container } = render(<PersistFailureBanner />);
    act(() => {
      useAppStore.getState().addPersistAlert({
        area: "crash.renderer-process",
        kind: "action",
        message: "上次界面意外重启，已恢复；会话数据未丢失。",
        detail: "kind=GPU_PROCESS_EXITED(6) reason=CRASHED(3) exit_code=34",
      });
    });
    expect(screen.getByText("上次界面意外重启，已恢复；会话数据未丢失。")).toBeTruthy();
    const details = container.querySelector("details.persist-alert-details");
    expect(details, "技术详情必须有独立的 folds").toBeTruthy();
    expect(details!.open, "默认必须折叠").toBe(false);
    fireEvent.click(screen.getByText("详情"));
    expect(details!.open).toBe(true);
    expect(screen.getByText(/kind=GPU_PROCESS_EXITED/)).toBeTruthy();
  });
});
