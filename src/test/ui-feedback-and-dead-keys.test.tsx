/**
 * 「异步失败要说话 / 死键不许装成可点」判据（第 1 批）。
 *
 * 两类真 bug 各一组：
 *
 * A. **rejection 被吞掉**：修前多处 async handler 只有 try/finally（或裸 await），
 *    失败时忙态不复位、界面一个字都不说（项目管理弹窗不动、限额按钮永远「保存中…」、
 *    去重结果区空白、配对/同步/插件动作静默）。
 * B. **死键**：设置里嵌的 ToolManager / AgentManager 关闭按钮是 `() => {}`；
 *    笔记本把 `onModeChange` 传成空函数，于是「切换到计划模式」看起来可点、点了没反应。
 *
 * 本文件全部走**真渲染 + DOM 后果**：失败后必须能在 DOM 里读到具体原因、忙态必须解除；
 * 关闭必须真的回到设置列表；宿主没给模式切换回调时按钮必须**不存在**。
 *
 * 服务模块用 `vi.mock` 钉住（这里判的是界面反馈，不是文件系统/网络实现）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { createElement } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";

/* ==========================================================================
 * 服务模块桩（全部走 `vi.hoisted`：mock 工厂会被提升到 import 之前）
 * ========================================================================== */

const projectFilesMock = vi.hoisted(() => ({
  createProjectFiles: vi.fn(),
  loadProjectInstructions: vi.fn(),
  loadProjectSkills: vi.fn(),
  loadProjectMemory: vi.fn(),
}));
vi.mock("../core/project/files", () => projectFilesMock);

const dialogMock = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock("../core/ui/native-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/ui/native-dialog")>();
  return { ...actual, confirmDialog: dialogMock.confirmDialog };
});

const settingsMock = vi.hoisted(() => ({
  beginSettingsWriteProbe: vi.fn(() => ({ at: Date.now() })),
  flushSettingsWrites: vi.fn(),
}));
vi.mock("../core/storage/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/storage/settings")>();
  return {
    ...actual,
    beginSettingsWriteProbe: settingsMock.beginSettingsWriteProbe,
    flushSettingsWrites: settingsMock.flushSettingsWrites,
  };
});

const costMock = vi.hoisted(() => ({ getCostTracker: vi.fn() }));
vi.mock("../core/llm/cost-tracker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm/cost-tracker")>();
  return { ...actual, getCostTracker: costMock.getCostTracker };
});

const syncMock = vi.hoisted(() => ({
  pairGateway: vi.fn(),
  syncNow: vi.fn(),
}));
vi.mock("../core/storage/sync-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/storage/sync-engine")>();
  return { ...actual, pairGateway: syncMock.pairGateway, syncNow: syncMock.syncNow };
});

const pluginMock = vi.hoisted(() => ({
  status: vi.fn(),
  installNode: vi.fn(),
  enable: vi.fn(),
  pause: vi.fn(),
  remove: vi.fn(),
  recoverAndRestart: vi.fn(),
  modelsList: vi.fn(async () => [] as Array<{ id: string; name: string }>),
  modelsRefresh: vi.fn(async () => {}),
  modelsProbe: vi.fn(),
  logTail: vi.fn(async () => ""),
  readSetting: vi.fn(() => ({}) as Record<string, unknown>),
  dismissNodePrompt: vi.fn(),
}));
vi.mock("../core/free-model-plugin/service", () => ({
  freeModelPlugin: {
    name: "免费模型插件",
    status: pluginMock.status,
    installNode: pluginMock.installNode,
    enable: pluginMock.enable,
    pause: pluginMock.pause,
    remove: pluginMock.remove,
    recoverAndRestart: pluginMock.recoverAndRestart,
    models: {
      list: pluginMock.modelsList,
      refresh: pluginMock.modelsRefresh,
      probe: pluginMock.modelsProbe,
    },
    diagnostics: { logTail: pluginMock.logTail },
    readSetting: pluginMock.readSetting,
    dismissNodePrompt: pluginMock.dismissNodePrompt,
  },
}));

/**
 * 设置里嵌入的两个面板换成**探针**：只渲染一个「关闭」按钮，点它转调 `onClose`。
 * 这样判据落在"设置面板怎么响应 onClose"上，不会把两个大面板的内部实现拖进来。
 */
vi.mock("../components/ToolManager", async () => {
  const React = await import("react");
  return {
    ToolManager: ({ onClose }: { onClose: () => void }) =>
      React.createElement(
        "div",
        { "data-testid": "tool-manager-probe" },
        React.createElement("button", { type: "button", onClick: onClose }, "关闭工具管理"),
      ),
  };
});
vi.mock("../components/AgentManager", async () => {
  const React = await import("react");
  return {
    AgentManager: ({ onClose }: { onClose: () => void }) =>
      React.createElement(
        "div",
        { "data-testid": "agent-manager-probe" },
        React.createElement("button", { type: "button", onClick: onClose }, "关闭智能体管理"),
      ),
  };
});

/* ==========================================================================
 * 组件（在 mock 之后 import）
 * ========================================================================== */

import { ProjectManager } from "../components/ProjectManager";
import { UsageStats } from "../components/UsageStats";
import { MemoryCheckupView } from "../components/MemoryCheckupView";
import { DeviceSyncSettings } from "../components/DeviceSyncSettings";
import { FreeModelPluginCard } from "../components/FreeModelPluginCard";
import { FreeModelNodePrompt } from "../components/FreeModelNodePrompt";
import { SettingsPanel } from "../components/SettingsPanel";
import { InputArea } from "../components/InputArea";
import { NbChatPanel } from "../components/NbChatPanel";
import * as memoryModule from "../core/memory/memory";
import { MemoryService } from "../core/memory/memory";

/* ==========================================================================
 * 公共夹具
 * ========================================================================== */

function makeTracker(overrides: Record<string, unknown> = {}) {
  return {
    getStats: () => ({
      totalCost: 0,
      todayCost: 0,
      totalRecords: 0,
      totalSessions: 0,
      cacheReported: false,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      averageDuration: 0,
      averageCostPerCall: 0,
      uncostedCalls: 0,
      ...overrides,
    }),
    getCostByModel: () => ({}),
    getCacheByModel: () => ({}),
    getLimits: () => ({ perSession: 5, perDay: 20, total: 0 }),
    getRecordsInRange: () => [],
    setLimits: vi.fn(),
  };
}

function pluginStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    codePresent: true,
    nodeExe: "C:\\Program Files\\nodejs\\node.exe",
    nodeVia: "system",
    health: null,
    running: false,
    port: 47831,
    modelCount: 0,
    adopted: false,
    lastError: null,
    dataDir: "C:\\data\\ofm",
    pid: null,
    ...overrides,
  };
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort());
  useProjectStore.setState({
    projects: [],
    sessions: [],
    currentProject: null,
    currentSession: null,
    projectsReadUnavailable: false,
  } as never);
  useAppStore.setState({
    messages: [],
    loadedSessionId: null,
    messagesLoading: false,
    messagesReadUnavailable: false,
    activeSessions: new Set<string>(),
  } as never);

  projectFilesMock.createProjectFiles.mockReset().mockResolvedValue(undefined);
  projectFilesMock.loadProjectInstructions.mockReset().mockResolvedValue("");
  projectFilesMock.loadProjectSkills.mockReset().mockResolvedValue([]);
  projectFilesMock.loadProjectMemory.mockReset().mockResolvedValue([]);
  dialogMock.confirmDialog.mockReset().mockResolvedValue(true);

  settingsMock.beginSettingsWriteProbe.mockReset().mockReturnValue({ at: Date.now() });
  settingsMock.flushSettingsWrites.mockReset();
  costMock.getCostTracker.mockReset().mockReturnValue(makeTracker());

  syncMock.pairGateway.mockReset();
  syncMock.syncNow.mockReset();

  pluginMock.status.mockReset().mockResolvedValue(pluginStatus());
  pluginMock.installNode.mockReset();
  pluginMock.enable.mockReset();
  pluginMock.pause.mockReset();
  pluginMock.remove.mockReset();
  pluginMock.recoverAndRestart.mockReset();
  pluginMock.modelsList.mockReset().mockResolvedValue([]);
  pluginMock.modelsRefresh.mockReset().mockResolvedValue(undefined);
  pluginMock.modelsProbe.mockReset();
  pluginMock.logTail.mockReset().mockResolvedValue("");
  pluginMock.readSetting.mockReset().mockReturnValue({});
  pluginMock.dismissNodePrompt.mockReset();
});

afterEach(() => {
  cleanup();
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

/* ==========================================================================
 * A1：项目管理 —— 新建 / 打开 / 选目录失败必须留在弹窗里说清楚
 * ========================================================================== */

describe("A1 项目管理：失败不再静默、弹窗不再卡住", () => {
  it("A1-a 新建失败：显示具体原因，创建按钮解除忙态，弹窗不关闭", async () => {
    projectFilesMock.createProjectFiles.mockRejectedValueOnce(new Error("EACCES: 拒绝访问"));
    const onClose = vi.fn();
    render(<ProjectManager onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    fireEvent.change(screen.getByPlaceholderText("My Project"), { target: { value: "新项目" } });
    fireEvent.change(screen.getByPlaceholderText("点击右边按钮选择文件夹"), {
      target: { value: "C:\\work\\new-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    const error = await screen.findByTestId("project-action-error");
    expect(error.textContent, "必须带上失败原因（不是一句「失败了」）").toContain("EACCES");
    expect(error.textContent, "必须告诉用户下一步能做什么").toContain("重试");
    expect(onClose, "失败还关窗 = 用户不知道项目到底建没建").not.toHaveBeenCalled();

    const createBtn = screen.getByRole("button", { name: "创建项目" }) as HTMLButtonElement;
    await waitFor(() => expect(createBtn.disabled, "忙态必须解除，否则再也点不了").toBe(false));
  });

  it("A1-b 打开失败：显示原因、不关闭面板", async () => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "演示项目", path: "C:\\work\\demo", createdAt: 1, lastAccessedAt: 1 }],
      projectsReadUnavailable: false,
    } as never);
    projectFilesMock.loadProjectInstructions.mockRejectedValueOnce(new Error("ENOENT: 目录不存在"));
    const onClose = vi.fn();
    render(<ProjectManager onClose={onClose} />);

    fireEvent.click(screen.getByText("演示项目"));

    const error = await screen.findByTestId("project-action-error");
    expect(error.textContent).toContain("打开项目失败");
    expect(error.textContent).toContain("ENOENT");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("A1-c 文件夹选择器抛错：显示原因（修前 helper 自己吞掉、与「取消」同形）", async () => {
    (window as any).__TAURI__ = {
      core: { invoke: vi.fn().mockRejectedValue(new Error("dialog 插件不可用")) },
    };
    render(<ProjectManager onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    fireEvent.click(screen.getByTitle("选择文件夹"));

    const error = await screen.findByTestId("project-action-error");
    expect(error.textContent).toContain("dialog 插件不可用");
    expect(error.textContent, "要给替代出路").toContain("输入框");
  });
});

/* ==========================================================================
 * A2：设置 → 限额保存
 * ========================================================================== */

describe("A2 保存限额：reject 后解除「保存中…」并说明原因", () => {
  it("A2 保存失败：按钮回到「保存限额」，错误文案在 DOM 里", async () => {
    settingsMock.flushSettingsWrites.mockRejectedValueOnce(new Error("写队列不可用"));
    render(<UsageStats onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "限额" }));
    const save = await screen.findByRole("button", { name: "保存限额" });
    fireEvent.click(save);

    const error = await screen.findByTestId("usage-limits-error");
    expect(error.textContent).toContain("保存限额失败");
    expect(error.textContent).toContain("写队列不可用");

    const saveAfter = screen.getByRole("button", { name: "保存限额" }) as HTMLButtonElement;
    expect(saveAfter.textContent, "修前一直停在「保存中…」").not.toContain("保存中");
    expect(saveAfter.disabled, "按钮必须能再点一次").toBe(false);
  });
});

/* ==========================================================================
 * A3：记忆体检 → 找出相似重复
 * ========================================================================== */

describe("A3 找出相似重复：reject 时结果区不再空白", () => {
  it("A3 扫描失败：显示原因 + 说明记忆未被修改 + 忙态解除", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "一条记忆", content: "内容", source: "manual" });
    const serviceSpy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    vi.spyOn(svc, "findDuplicateGroupsAsync").mockRejectedValueOnce(new Error("worker 崩了"));

    const { container } = render(<MemoryCheckupView />);
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("找出相似重复"),
    ) as HTMLButtonElement;
    expect(btn, "前置：必须有「找出相似重复」按钮").toBeTruthy();
    fireEvent.click(btn);

    await waitFor(() => {
      const notice = container.querySelector(".mc-notice")?.textContent ?? "";
      expect(notice, "修前这里空白，用户只会以为按钮没反应").toContain("找出相似重复失败");
      expect(notice).toContain("worker 崩了");
      expect(notice, "只读扫描，要明确说没改数据").toContain("没有被修改");
    });
    expect(btn.textContent, "失败后必须能再点").toBe("找出相似重复");
    expect(btn.disabled).toBe(false);
    serviceSpy.mockRestore();
  });
});

/* ==========================================================================
 * A4：设备同步 → 配对 / 立即同步
 * ========================================================================== */

describe("A4 设备同步：配对 / 同步的 rejection 必须写在卡片里", () => {
  it("A4-a 配对 reject：错误可见、按钮解除忙态", async () => {
    syncMock.pairGateway.mockRejectedValueOnce(new Error("网络断开"));
    render(<DeviceSyncSettings zh />);

    fireEvent.change(screen.getByTestId("device-sync-host-url"), { target: { value: "http://host.test" } });
    fireEvent.change(screen.getByTestId("device-sync-pair-code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("device-sync-pair"));

    const notice = await screen.findByTestId("device-sync-notice");
    expect(notice.textContent).toContain("配对失败");
    expect(notice.textContent).toContain("网络断开");
    expect((screen.getByTestId("device-sync-pair") as HTMLButtonElement).disabled, "忙态必须解除").toBe(false);
  });

  it("A4-b 同步 reject：错误可见、按钮解除忙态", async () => {
    syncMock.syncNow.mockRejectedValueOnce(new Error("网关 502"));
    render(<DeviceSyncSettings zh />);

    fireEvent.click(screen.getByTestId("device-sync-now"));

    const notice = await screen.findByTestId("device-sync-notice");
    expect(notice.textContent).toContain("同步失败");
    expect(notice.textContent).toContain("网关 502");
    expect((screen.getByTestId("device-sync-now") as HTMLButtonElement).disabled, "忙态必须解除").toBe(false);
  });
});

/* ==========================================================================
 * A5：免费模型插件卡片的动作
 * ========================================================================== */

describe("A5 免费模型插件：启用 / 一键装 Node 的 rejection 不再只重置按钮", () => {
  it("A5-a 启用 reject：显示动作名与原因，按钮回到「开启」", async () => {
    pluginMock.status.mockResolvedValue(pluginStatus({ enabled: false, health: null, running: false }));
    pluginMock.enable.mockRejectedValueOnce(new Error("端口被占用"));
    const { container } = render(<FreeModelPluginCard />);

    const enable = await screen.findByRole("button", { name: "开启" });
    fireEvent.click(enable);

    await waitFor(() => {
      expect(container.querySelector(".ofm-card-notice")?.textContent ?? "").toContain("启用插件失败");
      expect(container.querySelector(".ofm-card-notice")?.textContent ?? "").toContain("端口被占用");
    });
    const after = screen.getByRole("button", { name: "开启" }) as HTMLButtonElement;
    expect(after.disabled).toBe(false);
  });

  it("A5-b 一键装 Node reject：显示原因，按钮恢复为「自动安装 Node（约 30MB）」", async () => {
    pluginMock.status.mockResolvedValue(
      pluginStatus({ enabled: true, codePresent: true, nodeExe: null, health: null, running: false }),
    );
    pluginMock.installNode.mockRejectedValueOnce(new Error("下载中断"));
    const { container } = render(<FreeModelPluginCard />);

    const install = await screen.findByRole("button", { name: /自动安装 Node/ });
    fireEvent.click(install);

    await waitFor(() => {
      expect(container.querySelector(".ofm-card-notice")?.textContent ?? "").toContain("自动安装 Node 失败");
      expect(container.querySelector(".ofm-card-notice")?.textContent ?? "").toContain("下载中断");
    });
    const after = screen.getByRole("button", { name: /自动安装 Node/ }) as HTMLButtonElement;
    expect(after.disabled).toBe(false);
  });
});

/* ==========================================================================
 * A6：免费模型 Node 提示框
 * ========================================================================== */

describe("A6 免费模型 Node 提示框：安装 rejection 必须可见", () => {
  it("A6 安装失败：提示区有原因，按钮解除「正在安装…」", async () => {
    pluginMock.status.mockResolvedValue(
      pluginStatus({ enabled: true, codePresent: true, nodeExe: null, health: null, running: false }),
    );
    pluginMock.installNode.mockRejectedValueOnce(new Error("磁盘已满"));
    render(<FreeModelNodePrompt />);

    const install = await screen.findByRole("button", { name: "现在安装" });
    fireEvent.click(install);

    await waitFor(() => {
      expect(document.querySelector(".ofm-node-prompt-notice")?.textContent ?? "").toContain("安装 Node 失败");
      expect(document.querySelector(".ofm-node-prompt-notice")?.textContent ?? "").toContain("磁盘已满");
    });
    const after = screen.getByRole("button", { name: "现在安装" }) as HTMLButtonElement;
    expect(after.disabled).toBe(false);
  });
});

/* ==========================================================================
 * B7：设置里嵌的面板，X 必须回到设置列表（不是空函数）
 * ========================================================================== */

function clickSidebar(container: HTMLElement, label: string) {
  const btn = Array.from(container.querySelectorAll<HTMLButtonElement>(".settings-sidebar-item")).find(
    (b) => (b.textContent || "").trim() === label,
  );
  expect(btn, `设置侧栏必须有「${label}」`).toBeTruthy();
  fireEvent.click(btn!);
}

function activeTabLabel(container: HTMLElement): string {
  return (
    container.querySelector<HTMLButtonElement>('.settings-sidebar-item[aria-current="page"]')?.textContent?.trim() ?? ""
  );
}

describe("B7 设置内嵌面板的关闭按钮不是死键", () => {
  it("B7-a 工具管理：点 X 回到「通用」", async () => {
    const { container } = render(createElement(SettingsPanel, { onClose: () => {} }));
    await act(async () => {});

    clickSidebar(container, "工具");
    await act(async () => {});
    expect(screen.getByTestId("tool-manager-probe"), "前置：工具页签要渲染工具管理").toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "关闭工具管理" }));
    await act(async () => {});

    expect(screen.queryByTestId("tool-manager-probe"), "点 X 后工具管理必须消失").toBeNull();
    expect(activeTabLabel(container), "必须回到设置列表（通用），而不是原地不动").toBe("通用");
  });

  it("B7-b 智能体管理：点 X 回到「通用」", async () => {
    const { container } = render(createElement(SettingsPanel, { onClose: () => {} }));
    await act(async () => {});

    clickSidebar(container, "高级");
    await act(async () => {});
    expect(screen.getByTestId("agent-manager-probe"), "前置：高级→智能体要渲染 AgentManager").toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "关闭智能体管理" }));
    await act(async () => {});

    expect(screen.queryByTestId("agent-manager-probe"), "点 X 后智能体管理必须消失").toBeNull();
    expect(activeTabLabel(container)).toBe("通用");
  });
});

/* ==========================================================================
 * B8：宿主不支持计划模式时，按钮必须不存在（不是可点但没反应）
 * ========================================================================== */

describe("B8 计划模式按钮：宿主没给回调就不渲染", () => {
  it("B8-a InputArea：没有 onModeChange ⇒ 没有「切换到计划模式」按钮", () => {
    render(
      <InputArea
        onSend={() => {}}
        onCancel={() => {}}
        disabled={false}
        isStreaming={false}
        collaborationMode="default"
        connected
      />,
    );
    expect(screen.queryByTitle(/计划模式/), "死键不许装成可点").toBeNull();
  });

  it("B8-b InputArea：给了 onModeChange ⇒ 按钮存在（反向对照，证明不是恒不渲染）", () => {
    render(
      <InputArea
        onSend={() => {}}
        onCancel={() => {}}
        disabled={false}
        isStreaming={false}
        collaborationMode="default"
        onModeChange={() => {}}
        connected
      />,
    );
    expect(screen.getByTitle(/计划模式/)).toBeTruthy();
  });

  it("B8-c 笔记本面板：宿主不传 onModeChange ⇒ 输入区没有计划模式按钮", () => {
    render(
      <NbChatPanel
        onSend={() => {}}
        onCancel={() => {}}
        connected
        model="m"
        onModelChange={() => {}}
        currentSessionId="sess-notebook"
        guidedQuestions={[]}
        loadingQuestions={false}
        hasSources
      />,
    );
    expect(screen.queryByTitle(/计划模式/), "笔记本不能提供模式切换，就不许显示这个按钮").toBeNull();
  });
});
