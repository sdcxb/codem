/**
 * 只读连接信息判据（INFO-1..2）：
 * - 显示 hostId / 能力 / 事件水位；
 * - 关闭按钮生效；不支持时明确报错。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InfoPanel } from "../../packages/ui/src/info-panel";

function transport(overrides: Record<string, unknown> = {}) {
  return {
    listPlugins: vi.fn(async () => ({ items: [{ id: "ext-a", name: "插件A", version: "1.2.3" }] })),
    hostInfo: vi.fn(async () => ({
      hostId: "host-abc",
      supported: ["session.list", "prompt.send", "workspace.list"],
      unsupported: ["terminal.open"],
      seq: 42,
      runs: 1,
      workspaceRoot: "/workspace",
    })),
    ...overrides,
  } as never;
}

describe("INFO-1 展示", () => {
  it("hostId、能力、水位都显示", async () => {
    render(<InfoPanel transport={transport()} onClose={() => undefined} />);
    expect(await screen.findByText("host-abc")).toBeTruthy();
    expect(screen.getByText("prompt.send")).toBeTruthy();
    expect(screen.getByText("事件水位")).toBeTruthy();
    expect(await screen.findByText("插件A")).toBeTruthy();
  });
});

describe("INFO-2 关闭 / 不支持", () => {
  it("关闭触发回调", async () => {
    const onClose = vi.fn();
    render(<InfoPanel transport={transport()} onClose={onClose} />);
    await screen.findByText("host-abc");
    fireEvent.click(screen.getByText("关闭"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("没有 hostInfo 时明确报错", async () => {
    render(<InfoPanel transport={{}} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/不提供连接信息/)).toBeTruthy());
  });
});

describe("INFO-4 Phase 1 C：只有 Host 明确上报才说「与桌面同一份」", () => {
  it("workspaceSharedWithDesktop=true ⇒ 显示标记 + 会话归属说明", async () => {
    render(
      <InfoPanel
        transport={transport({
          hostInfo: vi.fn(async () => ({
            hostId: "host-pc",
            supported: ["workspace.list"],
            unsupported: [],
            workspaceRoot: "C:\\work\\proj",
            workspaceSharedWithDesktop: true,
          })),
        })}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/C:\\work\\proj（与桌面同一份）/)).toBeTruthy();
    expect(screen.getByTestId("info-shared-note").textContent).toContain("会话是 Host 自己的会话");
    expect(screen.getByTestId("info-shared-note").textContent).toContain("不是桌面历史");
  });

  it("缺省 / false ⇒ 不出现「同一份」字样（Android 本机 Host 不能被说成桌面项目）", async () => {
    render(
      <InfoPanel
        transport={transport({
          hostInfo: vi.fn(async () => ({
            hostId: "host-android",
            supported: [],
            unsupported: [],
            workspaceRoot: "/opt/app/web",
          })),
        })}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("/opt/app/web")).toBeTruthy();
    expect(screen.queryByText(/与桌面同一份/)).toBeNull();
    expect(screen.queryByTestId("info-shared-note")).toBeNull();
  });
});

describe("INFO-3 认证身份（D-7）", () => {
  it("显示设备名/固定令牌，但不显示任何 token/hash", async () => {
    const device = render(
      <InfoPanel
        transport={transport({
          hostInfo: vi.fn(async () => ({
            hostId: "host-abc",
            supported: [],
            unsupported: [],
            auth: { kind: "device", deviceId: "dev-12345678", deviceName: "Pixel 8" },
          })),
        })}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("已配对：Pixel 8")).toBeTruthy();
    expect(device.container.textContent).not.toContain("token");
    expect(device.container.textContent).not.toContain("dev-12345678");
    device.unmount();

    render(
      <InfoPanel
        transport={transport({
          hostInfo: vi.fn(async () => ({
            hostId: "host-abc",
            supported: [],
            unsupported: [],
            auth: { kind: "static" },
          })),
        })}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("固定访问令牌")).toBeTruthy();
  });
});
