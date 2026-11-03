/**
 * B1：手机「新建会话」面板的行为判据。
 *
 * 为什么单独挂这个组件（而不是整页 `MobileApp`）：整页一挂载就连 Host（hello + SSE），
 * 在判据里只能靠 mock 网络碰运气；这个面板只依赖 `SessionTransport` + 能力位，
 * 注入假 transport 就能把三条产品约束钉死：
 *
 * 1. **不画假按钮**：`caps.projects` 为假 ⇒ 没有项目区；`createProject` 缺失 ⇒ 没有「新建项目」。
 * 2. **失败原因可见**：桌面拒因经 `onError` 走横幅，表单内容保留（改一下路径就能重试）。
 * 3. **创建即打开**：`onCreated` 拿到会话（外层负责插入列表 + 打开），并带上所选 projectId。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CreateSessionSheet } from "../../packages/ui/src/create-session-sheet";
import { capabilitiesFromMethods, type SessionTransport, type TransportProjectSummary } from "../../packages/ui/src/transport";

const PROJECTS: TransportProjectSummary[] = [
  { id: "p1", name: "demo", path: "D:\\work\\demo" },
  { id: "p2", name: "other", path: "D:\\work\\other" },
];

function transport(overrides: Partial<SessionTransport> = {}): SessionTransport {
  return {
    hello: async () => ({ hostId: "gw", capabilities: { supported: [], unsupported: [] } }),
    listSessions: async () => [],
    getSession: async () => ({ title: "", messages: [] }),
    send: async () => ({ runId: "r" }),
    subscribe: () => () => undefined,
    listProjects: vi.fn(async () => PROJECTS),
    createSession: vi.fn(async (title?: string, projectId?: string) => ({
      id: "sess-new",
      title: title ?? "新会话",
      messageCount: 0,
      lastMessageAt: 1,
      projectId,
    })) as never,
    createProject: vi.fn(async (input: { name: string; path: string }) => ({ id: "p3", name: input.name, path: input.path })),
    ...overrides,
  };
}

const CAPS = capabilitiesFromMethods([
  "session.create",
  "project.list",
  "project.create",
]);

function mount(overrides: {
  t?: SessionTransport;
  caps?: typeof CAPS;
  onCreated?: (s: { id: string }) => void;
  onError?: (e: unknown) => void;
} = {}) {
  const onCreated = overrides.onCreated ?? vi.fn();
  const onError = overrides.onError ?? vi.fn();
  const t = overrides.t ?? transport();
  render(
    <CreateSessionSheet
      transport={t}
      caps={overrides.caps ?? CAPS}
      onCreated={onCreated}
      onClose={() => undefined}
      onError={onError}
    />,
  );
  return { t, onCreated, onError };
}

describe("B1-UI-1 项目选择与创建会话", () => {
  it("打开就拉项目列表；选项目 + 填标题 → createSession(title, projectId)", async () => {
    const { t, onCreated } = mount();
    await waitFor(() => expect(screen.getByLabelText(/demo/)).toBeTruthy());
    expect(t.listProjects).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText(/demo/));
    fireEvent.change(screen.getByTestId("session-title-input"), { target: { value: "修 bug" } });
    fireEvent.click(screen.getByTestId("confirm-create-session"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(t.createSession).toHaveBeenCalledWith("修 bug", "p1");
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "sess-new" }));
  });

  it("默认选「全局」⇒ createSession(title, undefined)（不是空串）", async () => {
    const { t, onCreated } = mount();
    await waitFor(() => expect(screen.getByLabelText(/demo/)).toBeTruthy());
    fireEvent.click(screen.getByTestId("confirm-create-session"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(t.createSession).toHaveBeenCalledWith(undefined, undefined);
  });
});

describe("B1-UI-2 新建项目", () => {
  it("建项目成功 ⇒ 追加进列表并选中它；随后建会话用它", async () => {
    const { t, onCreated } = mount();
    await waitFor(() => expect(screen.getByLabelText(/demo/)).toBeTruthy());
    fireEvent.click(screen.getByTestId("toggle-new-project"));
    fireEvent.change(screen.getByLabelText("项目名"), { target: { value: "新项目" } });
    fireEvent.change(screen.getByLabelText("项目路径"), { target: { value: "D:\\work\\new" } });
    fireEvent.click(screen.getByTestId("create-project"));

    await waitFor(() => expect(screen.getByLabelText(/新项目/)).toBeTruthy());
    expect(t.createProject).toHaveBeenCalledWith({ name: "新项目", path: "D:\\work\\new" });
    // 新建后自动选中 → 直接建会话就是它
    fireEvent.click(screen.getByTestId("confirm-create-session"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(t.createSession).toHaveBeenCalledWith(undefined, "p3");
  });

  it("建项目失败 ⇒ onError 收到原因，表单内容保留（改路径可重试）", async () => {
    const createProject = vi.fn(async () => {
      throw new Error("该路径不在允许的沙箱目录内");
    });
    const { onError } = mount({ t: transport({ createProject: createProject as never }) });
    await waitFor(() => expect(screen.getByLabelText(/demo/)).toBeTruthy());
    fireEvent.click(screen.getByTestId("toggle-new-project"));
    fireEvent.change(screen.getByLabelText("项目名"), { target: { value: "n" } });
    fireEvent.change(screen.getByLabelText("项目路径"), { target: { value: "C:\\windows" } });
    fireEvent.click(screen.getByTestId("create-project"));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(String((onError.mock.calls[0][0] as Error).message)).toContain("沙箱");
    expect((screen.getByLabelText("项目路径") as HTMLInputElement).value).toBe("C:\\windows");
  });
});

describe("B1-UI-3 能力位：不画假按钮", () => {
  it("没有项目能力 ⇒ 不显示项目区（只有标题 + 创建会话）", async () => {
    mount({ caps: capabilitiesFromMethods(["session.create"]), t: transport({ listProjects: undefined }) });
    expect(screen.queryByTestId("project-picker")).toBeNull();
    expect(screen.getByTestId("confirm-create-session")).toBeTruthy();
  });

  it("有项目列表但没有 createProject ⇒ 不显示「新建项目」", async () => {
    mount({ t: transport({ createProject: undefined }) });
    await waitFor(() => expect(screen.getByLabelText(/demo/)).toBeTruthy());
    expect(screen.queryByTestId("toggle-new-project")).toBeNull();
  });

  it("没有 createSession 方法 ⇒ 创建按钮禁用（账号只有只读能力时也不假装能建）", () => {
    mount({ t: transport({ createSession: undefined }) });
    expect((screen.getByTestId("confirm-create-session") as HTMLButtonElement).disabled).toBe(true);
  });
});
