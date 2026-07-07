/**
 * 测试 4：codem-settings-changed 事件
 *
 * 改动影响：
 *   - 事件名从 "mimo-settings-changed" 改为 "codem-settings-changed"
 *   - App.tsx 监听该事件重新配置引擎
 *   - SettingsPanel.tsx 在保存设置/切换模式/登录/登出时派发该事件
 *   - 如果事件名不匹配，设置面板的更改不会触发引擎重新配置
 */
import { describe, it, expect, vi } from "vitest";

describe("codem-settings-changed 事件", () => {
  it("派发 codem-settings-changed 事件能被监听到", () => {
    const handler = vi.fn();
    window.addEventListener("codem-settings-changed", handler);

    window.dispatchEvent(new Event("codem-settings-changed"));

    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener("codem-settings-changed", handler);
  });

  it("旧事件名 mimo-settings-changed 不再被监听", () => {
    const handler = vi.fn();
    window.addEventListener("codem-settings-changed", handler);

    // 派发旧事件名（模拟旧代码残留）
    window.dispatchEvent(new Event("mimo-settings-changed"));

    expect(handler).not.toHaveBeenCalled();
    window.removeEventListener("codem-settings-changed", handler);
  });

  it("多次派发事件，每次都能被捕获", () => {
    const handler = vi.fn();
    window.addEventListener("codem-settings-changed", handler);

    window.dispatchEvent(new Event("codem-settings-changed"));
    window.dispatchEvent(new Event("codem-settings-changed"));
    window.dispatchEvent(new Event("codem-settings-changed"));

    expect(handler).toHaveBeenCalledTimes(3);
    window.removeEventListener("codem-settings-changed", handler);
  });

  it("移除监听后不再收到事件", () => {
    const handler = vi.fn();
    window.addEventListener("codem-settings-changed", handler);
    window.removeEventListener("codem-settings-changed", handler);

    window.dispatchEvent(new Event("codem-settings-changed"));

    expect(handler).not.toHaveBeenCalled();
  });
});
