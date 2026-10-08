/**
 * 记忆体检视图判据（MEM-CHECK-1 ~ MEM-CHECK-5）。
 *
 * ## 这组判据针对的缺陷/风险
 * 1. 三级作用域重构之后，用户需要一个"我的记忆到底在哪儿生效、是谁写的"的视图；
 * 2. 老数据（升级前就存在）**归属不明**：旧 `session` 条目迁移后没有 `sessionId`，
 *    必须单列成「归属未知」并写明原因 —— 最危险的做法是**静默塞进平台级**（等于替用户编造归属）；
 * 3. 老数据**来源不明**：历史里没有任何字段能区分手写/自动，界面必须显示"未知（旧数据）"，
 *    **不许**被标成 manual 或 auto；
 * 4. 批量删除必须只删勾选的（"看起来像自动提取就删掉"是禁止的）。
 *
 * ## 判据风格
 * 行为断言为主：造数据 → 跑 `createMemoryCheckup` → 断言分组/组头/来源三态；
 * 组件层再断言"勾选删除只影响勾选项、清空全部要二次确认"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

/**
 * 二次确认一律走原生 helper（NC-1 禁止裸 `window.confirm`：Tauri dialog 下它返回 Promise ⇒ 闸门静默失效）。
 * 这里把 helper 换成可控 spy，用它控制"取消 / 确认"两条答案。
 */
const confirmSpy = vi.hoisted(() => vi.fn());
vi.mock("../core/ui/native-dialog", () => ({
  confirmDialog: confirmSpy,
  alertDialog: vi.fn().mockResolvedValue(undefined),
}));
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting } from "../core/storage/settings";
import {
  MemoryService,
  projectIdFromCwd,
  MEMORY_PRE_MIGRATION_KEY,
  MEMORY_PAUSE_LEGACY_POOL_KEY,
  MEMORY_INJECT_MAX_PER_BLOCK,
  setLegacyPoolInjectionPaused,
} from "../core/memory/memory";
import {
  buildOwnershipIndexFrom,
  checkupSourceOf,
  createMemoryCheckup,
  retargetEntry,
  UNRESOLVED_REASON,
} from "../core/memory/checkup";
import { MemoryCheckupView } from "../components/MemoryCheckupView";
import type { Project } from "../core/types";

const PROJECT_A: Project = { id: "proj-a", name: "阿尔法项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 };
const PROJECT_B: Project = { id: "proj-b", name: "贝塔项目", path: "C:\\work\\beta", createdAt: 1, lastAccessedAt: 1 };
const PROJ_A_ID = projectIdFromCwd(PROJECT_A.path)!;

const SESSIONS = new Map<string, Array<{ id: string; title: string }>>([
  [PROJECT_A.id, [{ id: "sess-1", title: "对话一（重构）" }]],
  [PROJECT_B.id, [{ id: "sess-2", title: "对话二（发布）" }]],
]);

function index() {
  return buildOwnershipIndexFrom([PROJECT_A, PROJECT_B], SESSIONS);
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort());
  saveMemory("");
});

afterEach(() => {
  cleanup();
  setStoragePort(null);
});

describe("MEM-CHECK-1：三级分组正确，且项目名/对话标题被解析出来", () => {
  it("MEM-CHECK-1：platform / project / conversation 各进正确的组，组头带解析出的名字", () => {
    const svc = new MemoryService();
    const p1 = svc.add({ scope: "platform", key: "平台约定", content: "P", source: "manual" });
    const j1 = svc.add({ scope: "project", projectId: PROJ_A_ID, key: "项目约定", content: "J", source: "manual" });
    const c1 = svc.add({ scope: "conversation", sessionId: "sess-1", key: "对话约定", content: "C", source: "auto" });
    expect([p1.ok, j1.ok, c1.ok]).toEqual([true, true, true]);

    const checkup = createMemoryCheckup({ projectId: PROJ_A_ID, sessionId: "sess-1" }, { index: index(), service: svc });

    expect(checkup.total).toBe(3);
    expect(checkup.groupCount, "三组：平台 / 项目 / 对话").toBe(3);

    const platform = checkup.groups.find((g) => g.kind === "platform")!;
    const project = checkup.groups.find((g) => g.kind === "project")!;
    const conversation = checkup.groups.find((g) => g.kind === "conversation")!;

    expect(platform.title, "平台级组头").toBe("平台级");
    expect(platform.entries.map((e) => e.key)).toEqual(["平台约定"]);

    expect(project.title, "项目级组头必须解析出项目名").toBe("项目级 · 阿尔法项目");
    expect(project.projectId).toBe(PROJ_A_ID);
    expect(project.entries.map((e) => e.key)).toEqual(["项目约定"]);

    expect(conversation.title, "对话级组头必须是「项目名 / 对话标题」").toBe("对话级 · 阿尔法项目 / 对话一（重构）");
    expect(conversation.sessionId).toBe("sess-1");
    expect(conversation.entries.map((e) => e.key)).toEqual(["对话约定"]);

    // 生效判定也要对：当前就在项目 A / 对话一 ⇒ 三条都生效
    expect(checkup.groups.flatMap((g) => g.entries).every((e) => e.injected)).toBe(true);
  });

  it("MEM-CHECK-1b：另一个项目的记忆进另一个项目组，且在当前上下文里标为「不进上下文」", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: projectIdFromCwd(PROJECT_B.path)!, key: "B 的约定", content: "JB", source: "manual" });

    const checkup = createMemoryCheckup({ projectId: PROJ_A_ID, sessionId: "sess-1" }, { index: index(), service: svc });

    const project = checkup.groups.find((g) => g.kind === "project")!;
    expect(project.title).toBe("项目级 · 贝塔项目");
    expect(project.entries[0].injected, "项目 B 的记忆在当前（项目 A）上下文里不生效").toBe(false);
  });
});

describe("MEM-CHECK-2：归属未知单列且写明原因（不许静默塞进平台级）", () => {
  /** 旧数据：迁移后的旧 session 条目 —— conversation 作用域但没有 sessionId */
  function withLegacyOrphan(): MemoryService {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "正常平台条目", content: "NORMAL", source: "manual" });
    // 直接写一条"迁移后"的形态：作用域已改名但没有归属键（这正是旧 session 条目的落点）
    (svc as unknown as { entries: Map<string, unknown> }).entries.set("legacy-1", {
      id: "legacy-1",
      scope: "conversation",
      key: "老会话条目",
      content: "LEGACY_ORPHAN",
      timestamp: 1_600_000_000_000,
    });
    return svc;
  }

  it("MEM-CHECK-2：无 sessionId 的旧数据进「归属未知」组，组头写明原因", () => {
    const checkup = createMemoryCheckup({ projectId: PROJ_A_ID, sessionId: "sess-1" }, { index: index(), service: withLegacyOrphan() });

    const unknown = checkup.groups.find((g) => g.kind === "unknown");
    expect(unknown, "必须有「归属未知」这一组").toBeDefined();
    expect(unknown!.title).toBe("归属未知（旧数据）");
    expect(unknown!.note, "组头必须写明原因").toBe(UNRESOLVED_REASON);
    expect(unknown!.unresolved).toBe(true);
    expect(unknown!.entries.map((e) => e.key)).toEqual(["老会话条目"]);
    expect(checkup.unresolvedCount).toBe(1);

    // 变异防线：平台级组里**不许**出现它（静默塞进平台级 = 替用户编造归属）
    const platform = checkup.groups.find((g) => g.kind === "platform")!;
    expect(platform.entries.map((e) => e.key)).toEqual(["正常平台条目"]);
    expect(
      checkup.groups.filter((g) => g.kind === "platform").flatMap((g) => g.entries).some((e) => e.key === "老会话条目"),
      "归属未知的条目绝不许出现在平台级组",
    ).toBe(false);
  });

  it("MEM-CHECK-2b：归属解析失败（项目/对话已删除）也进「归属未知」，且不假装能跳过去", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: "c:\\work\\deleted", key: "已删项目的记忆", content: "D", source: "manual" });
    svc.add({ scope: "conversation", sessionId: "sess-deleted", key: "已删对话的记忆", content: "E", source: "auto" });

    const checkup = createMemoryCheckup({ projectId: PROJ_A_ID, sessionId: "sess-1" }, { index: index(), service: svc });

    const unknown = checkup.groups.find((g) => g.kind === "unknown")!;
    expect(unknown.entries.map((e) => e.key)).toEqual(["已删项目的记忆", "已删对话的记忆"]);
    expect(checkup.groups.some((g) => g.kind === "project" && g.title.includes("deleted")), "解析不到的项目不许单列成'某项目'组").toBe(false);
  });

  it("MEM-CHECK-2c：全部都有归属时，不出现「归属未知」组（空组不占位）", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "P", content: "P", source: "manual" });
    const checkup = createMemoryCheckup({}, { index: index(), service: svc });
    expect(checkup.groups.some((g) => g.kind === "unknown")).toBe(false);
    expect(checkup.unresolvedCount).toBe(0);
  });
});

describe("MEM-CHECK-4：来源三态（旧数据不许被标成 manual/auto）", () => {
  it("MEM-CHECK-4：没有 source 字段的旧数据 = 「未知（旧数据）」", () => {
    const svc = new MemoryService();
    (svc as unknown as { entries: Map<string, unknown> }).entries.set("legacy-global", {
      id: "legacy-global",
      scope: "platform",
      key: "迁移降级的旧 project 条目",
      content: "LEGACY_PROJECT",
      timestamp: 1_600_000_000_000,
    });

    const entry = svc.get("legacy-global")!;
    expect(checkupSourceOf(entry), "旧数据没有来源字段 ⇒ 未知").toBe("unknown");

    const checkup = createMemoryCheckup({}, { index: index(), service: svc });
    const item = checkup.groups.flatMap((g) => g.entries)[0];
    expect(item.source).toBe("unknown");
    expect(checkup.sourceCounts.unknown).toBe(1);
    expect(checkup.sourceCounts.manual, "绝不许把旧数据算成手动").toBe(0);
    expect(checkup.sourceCounts.auto, "绝不许把旧数据算成自动").toBe(0);
  });

  it("MEM-CHECK-4b：明确记过来源的条目才显示 manual / auto", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "手写", content: "M", source: "manual" });
    svc.add({ scope: "platform", key: "自动", content: "A", source: "auto" });

    const checkup = createMemoryCheckup({}, { index: index(), service: svc });
    expect(checkup.sourceCounts).toEqual({ manual: 1, auto: 1, unknown: 0 });
    const sources = checkup.groups.flatMap((g) => g.entries).map((e) => `${e.key}:${e.source}`);
    expect(sources.sort()).toEqual(["手写:manual", "自动:auto"].sort());
  });
});

describe("MEM-CHECK-3：批量删除只删勾选的；清空全部要二次确认", () => {
  it("MEM-CHECK-3：removeMany 只删传进来的 id（其它条目逐字不动）", () => {
    const svc = new MemoryService();
    const keep = svc.add({ scope: "platform", key: "保留", content: "KEEP_ME", source: "manual" });
    const del1 = svc.add({ scope: "platform", key: "删1", content: "DELETE_1", source: "auto" });
    const del2 = svc.add({ scope: "platform", key: "删2", content: "DELETE_2", source: "auto" });

    const result = svc.removeMany([del1.entry!.id, del2.entry!.id]);

    expect(result.requested).toBe(2);
    expect(result.removed).toBe(2);
    expect(svc.get(keep.entry!.id)!.content, "没勾的条目逐字不动").toBe("KEEP_ME");
    expect(svc.get(del1.entry!.id)).toBeUndefined();
    expect(svc.get(del2.entry!.id)).toBeUndefined();
    expect(svc.listAll()).toHaveLength(1);
  });

  it("MEM-CHECK-3b：removeMany 对不存在的 id 如实回报，不误删别的条目", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "唯一", content: "ONLY", source: "manual" });
    const result = svc.removeMany(["not-a-real-id"]);
    expect(result.removed).toBe(0);
    expect(result.notFound).toEqual(["not-a-real-id"]);
    expect(svc.listAll()).toHaveLength(1);
  });

  it("MEM-CHECK-3c：视图里勾选一条 → 批量删除 → 只删勾选的那条", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "要删", content: "DELETE_ME", source: "manual" });
    svc.add({ scope: "platform", key: "要留", content: "KEEP_ME", source: "manual" });
    // 视图的数据层走单例 ⇒ 判据里把它替换成这个可控实例
    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    const { container } = render(<MemoryCheckupView />);
    const box = container.querySelector('input[aria-label="勾选记忆 要删"]') as HTMLInputElement;
    expect(box, "应渲染出「要删」的勾选框").toBeTruthy();
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(box);

    const removeMany = vi.spyOn(svc, "removeMany");
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("批量删除选中"))!);
    expect(removeMany).toHaveBeenCalledWith([expect.any(String)]);

    const remaining = svc.listAll();
    expect(remaining.map((e) => e.key)).toEqual(["要留"]);
    spy.mockRestore();
  });

  it("MEM-CHECK-3d：清空全部必须先二次确认，取消后一条都不删", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "A", content: "A", source: "manual" });
    svc.add({ scope: "platform", key: "B", content: "B", source: "manual" });
    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    /*
     * 二次确认走 `confirmDialog()`（原生对话框 helper）—— 它不是 `window.confirm`：
     * Tauri dialog 插件下 `window.confirm` 返回 Promise（恒真），所以那条路会被 NC-1 判据拦下。
     * 文件头已经 mock 了这个 helper，这里控制"取消 / 确认"两条答案。
     */
    confirmSpy.mockReset();
    confirmSpy.mockResolvedValue(false);

    const { container } = render(<MemoryCheckupView />);
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const clearBtn = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("清空全部"))!;
    fireEvent.click(clearBtn());

    await waitFor(() => expect(confirmSpy, "清空全部必须弹二次确认").toHaveBeenCalled());
    expect(svc.listAll(), "取消后一条都不许删").toHaveLength(2);

    confirmSpy.mockResolvedValue(true);
    fireEvent.click(clearBtn());
    await waitFor(() => expect(svc.listAll()).toHaveLength(0));
    spy.mockRestore();
  });
});

describe("MEM-CHECK-5：入口、归位与渲染", () => {
  /**
   * ⚠️ D1 的如实说明：这一条**仍是源码级接线检查**（页签 id / 文案 / 渲染哪个组件），
   * 它只能挡"改名/删行"，**挡不住"传错值"**。
   * 与"传错值"有关的两条（归位写入的归一化、cwd 归一化）已经改成行为判据：
   * 见下面的 `MEM-CHECK-5c（行为）` 与 `memory-scope-trust.test.ts::MEM-INJECT-3（行为）`。
   */
  it("MEM-CHECK-5a（接线）：设置面板里有「记忆体检」页签，且复用同一套数据层的视图", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "SettingsPanel.tsx"), "utf8");

    const anchor = src.indexOf('activeTab === "memory-checkup"');
    expect(anchor, "设置里必须有 memory-checkup 页签").toBeGreaterThan(0);
    const buttonSegment = src.slice(anchor - 200, anchor + 400);
    expect(buttonSegment, "页签按钮要能被点开").toContain('setActiveTab("memory-checkup")');
    expect(buttonSegment, "页签文案").toContain("记忆体检");

    const renderAnchor = src.lastIndexOf('activeTab === "memory-checkup"');
    const renderSegment = src.slice(renderAnchor, renderAnchor + 900);
    expect(renderSegment, "页签必须复用同一套数据层的体检视图").toContain("MemoryCheckupView");
    expect(renderSegment.includes("new MemoryService"), "不许另写第二套记忆读写").toBe(false);
  });

  it("MEM-CHECK-5b：渲染出分组标题与来源标签，且不抛错", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "平台条目", content: "PLATFORM_ITEM", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_A_ID, key: "项目条目", content: "PROJECT_ITEM", source: "auto" });
    svc.add({ scope: "conversation", sessionId: "sess-1", key: "对话条目", content: "CONV_ITEM", source: "manual" });
    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    const { container } = render(<MemoryCheckupView />);
    const text = container.textContent ?? "";
    expect(text).toContain("平台级");
    expect(text).toContain("平台条目");
    expect(text).toContain("手动");
    expect(text).toContain("自动");
    expect(text, "体检视图要如实写明'标注只用于展示'").toContain("只用于展示");
    spy.mockRestore();
  });

  /**
   * D2 重写 + B3 判据：**判据输入必须用产品真实产生的形态**。
   *
   * 旧判据传的是 `PROJ_A_ID`（`projectIdFromCwd` 归一化后的值），而界面下拉传的是
   * **项目原始路径**（`p.path`，Windows 上必带大写）⇒ 数据层绿、产品路径坏。
   * 这里两种形态都测，并且断言的是**行为**："归位后在自己的项目里真的被注入"。
   */
  it("MEM-CHECK-5c（行为 / B3）：用**原始项目路径**归位 ⇒ 归一化后在自己的项目里确实被注入", async () => {
    const svc = new MemoryService();
    const added = svc.add({ scope: "conversation", sessionId: "sess-1", key: "要归位", content: "RETARGET_CONTENT", source: "auto", batchId: "batch-1" });
    const id = added.entry!.id;

    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    // 产品真实形态：下拉框 value 是项目的**原始路径**（`C:\work\alpha`，界面 MemoryCheckupView 用 p.path）
    const result = await retargetEntry(id, { scope: "project", projectId: PROJECT_A.path });
    expect(result.ok).toBe(true);

    const after = svc.get(id)!;
    expect(after.scope).toBe("project");
    expect(after.projectId, "写入的归属键必须与注入侧**同一个归一化口径**").toBe(PROJ_A_ID);
    expect(after.sessionId, "改成项目级后不该再挂着对话归属").toBeUndefined();
    expect(after.source, "来源是历史事实，不因归位被重写").toBe("auto");
    expect(after.batchId, "批次归属不因归位被重写").toBe("batch-1");

    // 行为判据：注入侧拿 cwd 推出的 id 去比对 —— 修好之前这里是**空**（归位 = 永久失效）
    expect(svc.buildMemoryPrompt("project", projectIdFromCwd("C:/Work/Alpha")), "归位后必须在自己项目里被注入").toContain("RETARGET_CONTENT");
    expect(svc.buildMemoryPrompt("project", PROJ_A_ID)).toContain("RETARGET_CONTENT");
    expect(svc.buildMemoryPrompt("project", projectIdFromCwd("C:\\work\\beta")), "别的项目看不到").not.toContain("RETARGET_CONTENT");

    // 体检视图的显示也必须自洽：不再出现"组头说生效、徽标说不进上下文"
    const checkup = createMemoryCheckup({ projectId: PROJ_A_ID }, { index: index(), service: svc });
    const entryItem = checkup.groups.flatMap((g) => g.entries).find((e) => e.id === id)!;
    expect(entryItem.injected, "归位到当前项目 ⇒ 必须显示'会进上下文'").toBe(true);
    spy.mockRestore();
  });

  it("MEM-CHECK-5d（M-2 视图）：旧版跨项目池单列一组、写明原因、提供批量处置与暂停开关", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "手写平台", content: "HAND_WRITTEN", source: "manual" });
    // 迁移后的旧 project 池形态（带 legacyPool 标记）
    (svc as unknown as { entries: Map<string, unknown> }).entries.set("legacy-pool-1", {
      id: "legacy-pool-1",
      scope: "platform",
      key: "旧池条目",
      content: "LEGACY_POOL_CONTENT",
      timestamp: 1_600_000_000_000,
      source: "manual",
      status: "active",
      legacyPool: true,
    });
    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    const { container } = render(<MemoryCheckupView />);
    const text = container.textContent ?? "";
    expect(text, "必须有独立的旧池组").toContain("旧版跨项目记忆");
    expect(text, "组头要写明原因").toContain("可能被污染");
    expect(text, "要如实说明旧数据没有批次信息").toContain("批次");
    expect(text, "旧池条目上要有可展示的标记").toContain("旧版跨项目池");
    expect(text, "提供批量保留入口").toContain("整组保留为平台级");
    expect(text, "平台级组仍然存在（两者分开）").toContain("手写平台");

    // 暂停开关：默认关；点一下 ⇒ 这些条目变成"不进上下文"（并且写入开关设置）
    const toggle = container.querySelector('input[aria-label="暂停注入旧版跨项目记忆"]') as HTMLInputElement;
    expect(toggle, "必须有「暂停注入旧版跨项目记忆」开关").toBeTruthy();
    expect(toggle.checked, "默认必须是**关**（不偷偷改变既有可见范围）").toBe(false);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(toggle);
    expect(svc.buildMemoryPrompt(undefined, PROJ_A_ID, "sess-1"), "打开开关后旧池条目停止注入").not.toContain("LEGACY_POOL_CONTENT");
    expect(svc.buildMemoryPrompt(undefined, PROJ_A_ID, "sess-1"), "其它记忆不受影响").toContain("HAND_WRITTEN");
    expect(container.textContent ?? "", "界面要如实说明开关的后果").toContain("停止进上下文");
    // 复位，避免影响其它用例（设置是进程级的内存镜像）
    setSetting(MEMORY_PAUSE_LEGACY_POOL_KEY, "0");
    spy.mockRestore();
  });

  it("MEM-CHECK-5f（F5 面板）：记忆管理面板的「进不进上下文」与注入侧**同口径**（注入上限 / 暂停开关）", async () => {
    const memoryModule = await import("../core/memory/memory");
    const { fireEvent } = await import("@testing-library/react");
    const { MemoryManager } = await import("../components/MemoryManager");

    // ① 注入上限：21 条平台手动条目 ⇒ 第 21 条其实不进上下文，面板必须如实显示
    const svc = new MemoryService({ maxEntries: 400 });
    for (let i = 0; i < MEMORY_INJECT_MAX_PER_BLOCK + 1; i++) {
      svc.add({ scope: "platform", key: `p${i}`, content: `CAP_${i}`, source: "manual" });
    }
    let spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    const first = render(<MemoryManager onClose={() => {}} projectId={PROJ_A_ID} sessionId="sess-1" />);
    expect(
      first.container.querySelectorAll(".memory-source-badge.orphan").length,
      `面板必须与注入侧同口径：${MEMORY_INJECT_MAX_PER_BLOCK + 1} 条里恰有 1 条不进上下文`,
    ).toBe(1);
    /*
     * 找**带「不进上下文」徽标**的那一条（21 条的写入时间彼此相同，排序并列 ⇒ 谁是第 21 条不确定；
     * 判据要钉的是"面板与注入侧同口径"，所以按徽标定位，而不是按 key 猜）。
     */
    const truncatedItem = Array.from(first.container.querySelectorAll(".memory-item")).find((i) =>
      i.querySelector(".memory-source-badge.orphan"),
    )!;
    expect(truncatedItem, "必须有一条被判定为不进上下文").toBeTruthy();
    fireEvent.click(truncatedItem);
    expect(first.container.textContent ?? "", "详情要给出**真实原因**（不是只给一个徽标）").toMatch(/超出注入上限/);
    spy.mockRestore();
    cleanup();

    // ② 「暂停注入旧版跨项目记忆」：打开后旧池条目不进上下文，普通平台条目不受影响
    /* 换一个干净的数据面（否则上面那 21 条还在同一端口的内存镜像里，判据会串味）；
     * 旧池条目走**落库路径**（面板挂载时会 `reload()` 一次，只塞进内存的条目会被重读丢掉）。 */
    setStoragePort(createFakeStoragePort());
    setLegacyPoolInjectionPaused(true);
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          "legacy-pool-1": {
            id: "legacy-pool-1",
            scope: "platform",
            key: "旧池条目",
            content: "LEGACY_POOL_CONTENT",
            timestamp: 1_600_000_000_000,
            source: "manual",
            status: "active",
            legacyPool: true,
          },
          normal: { id: "normal", scope: "platform", key: "普通平台", content: "NORMAL_PLATFORM", timestamp: 1_700_000_000_000, source: "manual", status: "active" },
        },
      }),
    );
    const svc2 = new MemoryService();
    spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc2);
    const second = render(<MemoryManager onClose={() => {}} projectId={PROJ_A_ID} sessionId="sess-1" />);
    expect(second.container.querySelectorAll(".memory-source-badge.orphan").length, "暂停开关打开 ⇒ 只该有旧池那一条不进上下文").toBe(1);
    const legacyItem = Array.from(second.container.querySelectorAll(".memory-item")).find((i) =>
      i.textContent?.includes("旧池条目"),
    )!;
    expect(legacyItem.textContent ?? "", "被暂停的那条才该带徽标").toContain("不进上下文");
    fireEvent.click(legacyItem);
    expect(second.container.textContent ?? "", "原因要写明是暂停注入").toMatch(/暂停注入/);
    setLegacyPoolInjectionPaused(false);
    spy.mockRestore();
  });

  it("MEM-CHECK-5e（M-6 视图）：有迁移前快照 ⇒ 显示「回退到迁移前」与「导出这份快照」", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "现有", content: "CURRENT_CONTENT", source: "manual" });
    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    // 没有快照 ⇒ 不显示回退入口（不许给一个点了没反应的按钮）
    const first = render(<MemoryCheckupView />);
    expect(first.container.textContent ?? "").not.toContain("回退到迁移前");
    cleanup();

    setSetting(MEMORY_PRE_MIGRATION_KEY, JSON.stringify({ takenAt: 1_700_000_000_000, entries: 2, raw: "{\"version\":1,\"entries\":{}}" }));
    const second = render(<MemoryCheckupView />);
    const text2 = second.container.textContent ?? "";
    expect(text2, "有快照才出现回退入口").toContain("回退到迁移前");
    expect(text2, "必须给导出入口").toContain("导出这份快照");
    expect(text2, "回退要写明不可撤销").toContain("不可撤销");
    setSetting(MEMORY_PRE_MIGRATION_KEY, "");
    spy.mockRestore();
  });
});
