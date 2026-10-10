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
import { render, cleanup, fireEvent, act } from "@testing-library/react";

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
  MEMORY_SOURCE_KIND_LABEL,
  setLegacyPoolInjectionPaused,
  type MemorySourceKind,
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

/**
 * 夹具：把已写入条目的 `timestamp` 直接改成给定值。
 *
 * 为什么需要它（判据先行，第 190 波）：`add()` 写的是 `Date.now()`，于是"两次写入是否跨毫秒"
 * 是**运行时机**决定的 —— 而判据的颜色不许由运行时机决定。本仓有可注入时钟的先例，但那是
 * **提示词侧**的 `setPromptClock`（`core/prompt/prompt.ts`），记忆侧没有对应物；
 * 所以这里用夹具把两种毫秒情形都变成**可控输入**（`MEM-CHECK-2b` 钉"跨毫秒"这一形态）。
 */
function stamp(svc: MemoryService, id: string, timestamp: number): void {
  const entries = (svc as unknown as { entries: Map<string, { timestamp: number }> }).entries;
  const entry = entries.get(id);
  if (!entry) throw new Error(`夹具失效：找不到条目 ${id}（判据要因此失败，不许静默跳过）`);
  entry.timestamp = timestamp;
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
    const a = svc.add({ scope: "project", projectId: "c:\\work\\deleted", key: "已删项目的记忆", content: "D", source: "manual" });
    const b = svc.add({ scope: "conversation", sessionId: "sess-deleted", key: "已删对话的记忆", content: "E", source: "auto" });
    expect([a.ok, b.ok]).toEqual([true, true]);
    /*
     * 判据先行（第 190 波）：这一条原来直接吃 `add()` 的 `Date.now()` —— 两次写入**跨毫秒**时，
     * 当时 `listAll` 的排序键（`timestamp` 降序）会把后写入的「已删对话的记忆」排到前面，
     * 于是单跑 5 次 **4 绿 1 红**、全量跑恰好同毫秒才绿（表现为"偶发抖动"）。
     * 现在把时间戳**钉死成跨毫秒的形状**（先创建的更旧），这一条在两种毫秒情形下是同一个答案；
     * 而"顺序到底该是什么"由 `MEM-CHECK-2c` 钉（创建序倒序 = 后创建的在前，与注入/面板同口径）。
     */
    stamp(svc, a.entry!.id, 1_700_000_000_000);
    stamp(svc, b.entry!.id, 1_700_000_000_001);
    expect(
      svc.get(a.entry!.id)!.timestamp,
      "夹具必须真的造成跨毫秒，否则这一条又退回'靠运行时机'",
    ).toBeLessThan(svc.get(b.entry!.id)!.timestamp);

    const checkup = createMemoryCheckup({ projectId: PROJ_A_ID, sessionId: "sess-1" }, { index: index(), service: svc });

    const unknown = checkup.groups.find((g) => g.kind === "unknown")!;
    expect(unknown.entries.map((e) => e.key), "顺序 = 创建序倒序（后创建的在前），与毫秒无关").toEqual([
      "已删对话的记忆",
      "已删项目的记忆",
    ]);
    expect(checkup.groups.some((g) => g.kind === "project" && g.title.includes("deleted")), "解析不到的项目不许单列成'某项目'组").toBe(false);
  });

  it("MEM-CHECK-2c：列表/体检的顺序由**创建序**（`order`）决定，与 `timestamp` 无关（= 注入/面板同口径）", async () => {
    const memoryModule = await import("../core/memory/memory");
    const { MemoryManager } = await import("../components/MemoryManager");

    const svc = new MemoryService();
    /*
     * 造"`timestamp` 顺序与创建序**相反**"的两条：
     * - 「早创建」先 `add`（创建序更小），时间戳改成**最大**；
     * - 「晚创建」后 `add`（创建序更大），时间戳改成**最小**。
     * ⇒ 按 `timestamp` 降序 = [早创建, 晚创建]；按创建序（注入/面板口径）= [晚创建, 早创建]。
     * 两种口径在这组数据上**可分辨**，而且整个过程没有 `Date.now()` 参与 ⇒ 与运行时机无关。
     */
    const early = svc.add({ scope: "platform", key: "早创建", content: "EARLY_CREATED", source: "manual" });
    const late = svc.add({ scope: "platform", key: "晚创建", content: "LATE_CREATED", source: "manual" });
    expect([early.ok, late.ok]).toEqual([true, true]);
    stamp(svc, early.entry!.id, 9_999_999_999_999);
    stamp(svc, late.entry!.id, 1);

    const tsOf = (id: string) => svc.get(id)!.timestamp;
    expect(tsOf(early.entry!.id), "夹具必须真的造成'时间戳顺序与创建序相反'").toBeGreaterThan(tsOf(late.entry!.id));

    const ctx = { projectId: PROJ_A_ID, sessionId: "sess-1" };
    const checkup = createMemoryCheckup(ctx, { index: index(), service: svc });
    const checkupKeys = checkup.groups.find((g) => g.kind === "platform")!.entries.map((e) => e.key);
    expect(checkupKeys, "体检按创建序：后创建的在前（即使它的时间戳更小）").toEqual(["晚创建", "早创建"]);

    /*
     * 反证①：这条判据**真的**能分辨两种口径 —— 按 `timestamp` 降序排会得到**相反**的顺序。
     * 少了这一句，上面的断言可能因为"两种口径恰好同向"而恒真。
     */
    const idOf: Record<string, string> = { 早创建: early.entry!.id, 晚创建: late.entry!.id };
    const byTimestamp = [...checkupKeys].sort((x, y) => tsOf(idOf[y]) - tsOf(idOf[x]));
    expect(byTimestamp, "按 timestamp 降序会得到相反的顺序 ⇒ 两种口径可分辨（上面的断言不是恒真）").toEqual([
      "早创建",
      "晚创建",
    ]);

    /* 反证②（同口径）：体检消费的取数、面板入口必须是**同一条序**（同一处 `sortByCreationOrder`） */
    expect(svc.listAll(ctx).map((e) => e.key), "体检顺序 = listAll 顺序").toEqual(checkupKeys);
    expect(svc.listAllForPanel(ctx).map((e) => e.key), "面板入口同口径").toEqual(checkupKeys);

    /*
     * 反证③（渲染层）：把两组时间戳落进镜像，再让**真实面板**挂载一次
     * （面板挂载会 `reload()`，只改内存会被重读丢掉 ⇒ 用 `finalizeBatch` 触发一次 `save()`），
     * 断言 DOM 顺序 == 体检顺序。这样"体检与面板同口径"是被产品路径证过的，不是读码推定。
     */
    svc.finalizeBatch(svc.beginBatch("mem-check-2c"), 0);
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    const { container } = render(<MemoryManager onClose={() => {}} projectId={PROJ_A_ID} sessionId="sess-1" />);
    const panelKeys = Array.from(container.querySelectorAll(".memory-item-key")).map((n) => n.textContent ?? "");
    expect(panelKeys, "面板 DOM 顺序必须与体检同口径（创建序）").toEqual(checkupKeys);
    spy.mockRestore();
  });

  it("MEM-CHECK-2d：全部都有归属时，不出现「归属未知」组（空组不占位）", () => {
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
   *
   * O-44（第 191 波）补上了**这一条自己最缺的那半**：`ctx` 从哪来、是不是当前这一对，现在是行为判据 ——
   * `memory-checkup-ctx-behavior.test.tsx` 的 `MEM-CHECK-5a-行为`（最小桩渲染 `SettingsPanel`
   * + 点页签 + 断言「这条现在会不会生效」在 DOM 上的后果）与
   * `memory-checkup-ctx-props.test.tsx` 的 `MEM-CHECK-5a-ctx-props`（探针直接断言传下去的 props 值）。
   * 所以本条的定位回到它真正能守的东西：**页签还在、文案还在、复用的是同一个视图**。
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

  /**
   * 第 196 波：体检里的**批量同意选中**。
   *
   * 为什么这条判据落在体检而不是记忆面板：待批准条目在面板里按当前位置过滤
   * （`listPending(ctx)`），而「归属已失效」的那些（自动提取时的工作目录是临时目录、后来没了）
   * **只有体检看得到**（跨项目全量）—— 真机上就是这种形态（27 条待批准，归属全是已删的临时工作目录）。
   * 所以"批量同意"必须在这条视图上也能用。
   */
  it("MEM-CHECK-BATCH-1：勾选待批准条目 → 「批量同意选中」⇒ 它们变成已生效并落库", async () => {
    saveMemory("");
    const port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
    setStoragePort(port);
    const svc = new MemoryService();
    svc.add({
      scope: "project",
      projectId: PROJ_A_ID,
      key: "待审一",
      content: "PENDING_ONE 待批准的自动记忆",
      source: "auto",
      status: "pending",
    });
    svc.add({
      scope: "project",
      projectId: PROJ_A_ID,
      key: "待审二",
      content: "PENDING_TWO 待批准的自动记忆",
      source: "auto",
      status: "pending",
    });
    await svc.flushPendingPersist();

    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    const { container } = render(<MemoryCheckupView />);

    const checks = Array.from(container.querySelectorAll<HTMLInputElement>(".mc-entry-check input[type=checkbox]"));
    expect(checks, "两条待批准条目都要有勾选框").toHaveLength(2);
    for (const c of checks) {
      await act(async () => {
        fireEvent.click(c);
      });
    }

    const approveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".mc-header-actions button")).find((b) =>
      (b.textContent ?? "").includes("批量同意选中"),
    );
    expect(approveBtn, "体检必须有「批量同意选中」按钮（这一波新增）").toBeTruthy();
    expect(approveBtn!.textContent).toContain("（2）");

    await act(async () => {
      fireEvent.click(approveBtn!);
      await Promise.resolve();
    });

    expect(svc.listPending(undefined, { showAllProjects: true, includeUnscoped: true }), "批准后不该再有待批准").toHaveLength(0);
    expect(
      svc.buildMemoryPrompt("project", PROJ_A_ID),
      "批准之后必须真的进上下文（否则「批量同意」是假动作）",
    ).toContain("PENDING_ONE");
    expect(
      decodeURIComponent(encodeURIComponent(String(container.querySelector(".mc-notice")?.textContent ?? ""))),
      "回执要说清批准了几条且已落库",
    ).toContain("已落库");
    spy.mockRestore();
  });

  /**
   * 第 197 波：**找出相似重复 + 人工清理**（用户要求"加一个去重重复类似记忆的按钮功能"）。
   *
   * 为什么必须有这条判据：真机库里 23 对近似重复**跨桶**散着（每次评测的工作目录不同 ⇒
   * projectId 不同），自动流程按作用域隔离**不该**跨桶去猜 —— 所以"清一波"这件事
   * 只能由界面给出候选 + 证据、用户逐组确认。这里钉的就是这条链路：
   * 按钮存在 → 列出分组与相似度 → 「只留最早的一条」真的删掉其余（且落库）。
   */
  it("MEM-CHECK-DUP-1：找出相似重复 → 只留最早的一条 ⇒ 其余被删且落库", async () => {
    saveMemory("");
    const port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
    setStoragePort(port);
    const svc = new MemoryService();
    /* 真机形态：同一条事实被写进两个不同的 projectId（换了工作目录），一条 pending、一条已生效 */
    const first = svc.add({
      scope: "project",
      projectId: PROJ_A_ID,
      key: "Vitest 位置参数匹配语义",
      content: "vitest 的位置参数按**路径子串**匹配（不是 glob），多个参数之间是**或**关系。",
      source: "auto",
      status: "pending",
    });
    const second = svc.add({
      scope: "project",
      projectId: projectIdFromCwd(PROJECT_B.path)!,
      key: "vitest 路径参数按子串匹配、多参数为 OR",
      content: "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
      source: "auto",
      status: "pending",
    });
    expect(first.entry && second.entry).toBeTruthy();
    await svc.flushPendingPersist();

    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    const { container } = render(<MemoryCheckupView />);

    const findBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".mc-header-actions button")).find((b) =>
      (b.textContent ?? "").includes("找出相似重复"),
    );
    expect(findBtn, "体检必须有「找出相似重复」按钮（这一波新增）").toBeTruthy();

    await act(async () => {
      fireEvent.click(findBtn!);
      await Promise.resolve();
    });

    const groups = container.querySelectorAll(".mc-duplicate-group");
    expect(groups, "这一对必须被列出来").toHaveLength(1);
    expect(groups[0].querySelector(".mc-duplicate-similarity")?.textContent ?? "", "要给出可核对的相似度读数").toMatch(
      /相似度 \d+%/,
    );
    expect(groups[0].querySelectorAll(".mc-duplicate-entry"), "组内两条都要显示").toHaveLength(2);

    const keepOldest = Array.from(groups[0].querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      (b.textContent ?? "").includes("只留最早的一条"),
    );
    expect(keepOldest, "必须有「只留最早的一条」").toBeTruthy();

    await act(async () => {
      fireEvent.click(keepOldest!);
      await Promise.resolve();
    });

    expect(svc.get(second.entry!.id), "较晚的那条必须被删掉").toBeUndefined();
    expect(svc.get(first.entry!.id), "最早的那条必须留下").toBeTruthy();
    expect(
      container.querySelector(".mc-notice")?.textContent ?? "",
      "回执要说清删了几条且是否落库",
    ).toContain("已落库");
    spy.mockRestore();
  });

  /**
   * 第 200 波：「已拒绝」记录的可审阅 + 可清空（用户要求"拒过的不再自动写入、也不再问我"，
   * 但一次误点不该永久锁死 ⇒ 界面必须给退路）。
   */
  it("MEM-CHECK-REJ-1：体检里显示已拒绝记录，且「清空已拒绝记录」真的清掉（之后同类又能被写入）", async () => {
    saveMemory("");
    const port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
    setStoragePort(port);
    const svc = new MemoryService();
    const pending = svc.add({
      scope: "project",
      projectId: PROJ_A_ID,
      key: "拒绝过的提议",
      content: "这条提议被用户拒绝过（内容足够长以便入库）",
      source: "auto",
      status: "pending",
    });
    expect(pending.ok).toBe(true);
    expect(svc.reject(pending.entry!.id)).toBe(true);
    await svc.flushPendingPersist();

    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    const { container } = render(<MemoryCheckupView />);

    expect(container.textContent ?? "", "摘要里要能看出有几条已拒绝").toContain("已拒绝 1 条");
    const section = container.querySelector(".mc-rejections");
    expect(section, "要有「已拒绝」那一节（否则用户不知道它为什么不再问）").toBeTruthy();
    expect(section!.textContent ?? "", "要列出被拒的标题").toContain("拒绝过的提议");

    const clearBtn = Array.from(section!.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      (b.textContent ?? "").includes("清空已拒绝记录"),
    );
    expect(clearBtn, "必须有清空入口（误点拒绝的退路）").toBeTruthy();

    await act(async () => {
      fireEvent.click(clearBtn!);
      await Promise.resolve();
    });

    expect(svc.listRejections(), "点完必须真的清空").toHaveLength(0);
    expect(container.querySelector(".mc-rejections"), "清空后那一节应当消失").toBeNull();
    expect(
      container.querySelector(".mc-notice")?.textContent ?? "",
      "回执要说清后果（同类以后可以再被自动提取）",
    ).toContain("已清空 1 条");
    spy.mockRestore();
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

/**
 * MEM-PLACE-22（面板顺序 / 标签如实）与 MEM-PLACE-23（三态文案唯一表）。
 *
 * ## 为什么必须是**渲染**判据
 *
 * 复审报的两条都是"呈现层"的缺陷：
 * - `MEM-PLACE-23`：三态文案表的声明是"四处共用的**唯一**表，不许任何一处自己再写一份字面量"，
 *   而 `MemoryCheckupView.tsx` 一行里把三态全写成字面量（且「自动」≠ 表里的「自动提取」）、
 *   `MemoryManager.tsx` 另有两处自写 —— 判据 `MEM-PLACE-12` 只断言了注入文本/导出/`bySource`，
 *   没有"视图不许自写字面量"这一面；
 * - `MEM-PLACE-22`：面板按 `timestamp` 排序却把该字段标成「创建时间」，而注入按创建序
 *   ⇒ 编辑之后两侧顺序分叉、用户无从自知。
 *
 * ## 判据怎么做到"不靠复述字面量"
 *
 * ① **改表即改呈现**：渲染时把唯一表的三态值临时换成哨兵（`SENT_*`）。任何自写字面量的地方
 *    都不会跟着变 ⇒ 断言哨兵出现在**该处**（体检摘要、面板分组头/徽标）即可，而不用把
 *    "手动/自动提取/未知（旧数据）"再抄一遍进测试（抄一遍就等于把文案冻在测试里）。
 * ② **顺序用行为区分**：造一条"时间戳最旧、创建序最新"的条目 —— 按 `timestamp` 排序会把它排到
 *    最后、按创建序排序会排到最前 ⇒ 两种口径在 DOM 里可分辨；再断言"编辑它只改显示的时间、
 *    不改变它的位置与入选集合"。
 */
describe("MEM-PLACE-22/23：面板顺序与标签如实；三态文案只有唯一表", () => {
  const LABEL_KEYS: readonly MemorySourceKind[] = ["manual", "auto", "unknown"];

  /** 临时把唯一表的三态值换成哨兵（`fn` 结束后逐字恢复）；返回哨兵供断言 */
  function withSentinelLabels<T>(fn: (sentinel: Record<MemorySourceKind, string>) => T): T {
    const sentinel: Record<MemorySourceKind, string> = {
      manual: "SENT_MANUAL",
      auto: "SENT_AUTO",
      unknown: "SENT_UNKNOWN",
    };
    const backup = { ...MEMORY_SOURCE_KIND_LABEL };
    Object.assign(MEMORY_SOURCE_KIND_LABEL, sentinel);
    try {
      return fn(sentinel);
    } finally {
      Object.assign(MEMORY_SOURCE_KIND_LABEL, backup);
    }
  }

  it("MEM-PLACE-23①（渲染）：体检摘要的三态计数一律取自唯一表（改表即改呈现）", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "手写", content: "SRC_MANUAL", source: "manual" });
    svc.add({ scope: "platform", key: "自动", content: "SRC_AUTO", source: "auto" });
    // 来源未知（旧数据）：直接放进内部表（新写入从来都有来源）
    (svc as unknown as { entries: Map<string, unknown> }).entries.set("src-unknown", {
      id: "src-unknown",
      scope: "platform",
      key: "旧数据",
      content: "SRC_UNKNOWN",
      timestamp: 1_700_000_000_000,
      status: "active",
    });
    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    withSentinelLabels((sentinel) => {
      const { container } = render(<MemoryCheckupView />);
      const summary = container.querySelector(".mc-summary")?.textContent ?? "";
      expect(summary, "体检摘要必须渲染出来（否则这条判据空转）").toContain("总计");
      for (const k of LABEL_KEYS) {
        expect(
          summary,
          `体检摘要的三态计数必须引用唯一表（${k}）：自写字面量不会跟着表变 ⇒ 哨兵不会出现`,
        ).toContain(sentinel[k]);
      }
      // 三态各自出现一次（不是"同一句话重复三次"）
      expect(new Set(LABEL_KEYS.map((k) => summary.split(sentinel[k]).length - 1))).toEqual(new Set([1]));
    });
    spy.mockRestore();
  });

  it("MEM-PLACE-23②（渲染）：面板的三态分组头/徽标一律取自唯一表（改表即改呈现）", async () => {
    /*
     * ⚠️ 来源未知（旧数据）这条必须走**落库路径**：面板挂载时会 `reload()` 一次，
     * 只塞进内存的条目会被重读丢掉（`MEM-CHECK-5f` 踩过同一个坑）。
     */
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          "panel-unknown": {
            id: "panel-unknown",
            scope: "platform",
            key: "旧数据",
            content: "PANEL_UNKNOWN",
            timestamp: 1_700_000_000_000,
            status: "active",
          },
        },
      }),
    );
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "手写", content: "PANEL_MANUAL", source: "manual" });
    svc.add({ scope: "platform", key: "自动", content: "PANEL_AUTO", source: "auto" });
    const memoryModule = await import("../core/memory/memory");
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    const { MemoryManager } = await import("../components/MemoryManager");

    withSentinelLabels((sentinel) => {
      const { container } = render(<MemoryManager onClose={() => {}} projectId={PROJ_A_ID} sessionId="sess-1" />);
      const groupSubs = Array.from(container.querySelectorAll(".memory-group-sub"))
        .map((n) => n.textContent ?? "")
        .join("\n");
      expect(groupSubs, "分组头必须渲染出来（否则这条判据空转）").not.toBe("");
      for (const k of LABEL_KEYS) {
        expect(groupSubs, `面板分组头必须引用唯一表（${k}）`).toContain(sentinel[k]);
      }
      const badges = Array.from(container.querySelectorAll(".memory-source-badge")).map((n) => n.textContent ?? "");
      for (const k of LABEL_KEYS) {
        expect(badges, `面板徽标必须引用唯一表（${k}）`).toContain(sentinel[k]);
      }
    });
    spy.mockRestore();
  });

  it("MEM-PLACE-22①②（渲染）：面板默认按**注入顺序**排列；`timestamp` 字段如实标成「最后修改时间」", async () => {
    const memoryModule = await import("../core/memory/memory");
    const { MemoryManager } = await import("../components/MemoryManager");
    const { fireEvent } = await import("@testing-library/react");

    const total = MEMORY_INJECT_MAX_PER_BLOCK + 3;
    const svc = new MemoryService({ maxEntries: 400 });
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const r = svc.add({ scope: "project", projectId: PROJ_A_ID, key: `K${i}`, content: `P22R_${i}`, source: "manual" });
      expect(r.ok).toBe(true);
      ids.push(r.entry!.id);
    }
    /*
     * 造出"两种排序口径可分辨"的形态：
     * - 创建序**最后**的一条（K{total-1}）把时间戳改成**最旧**（1）⇒ 按 timestamp 排序会垫底；
     * - 创建序**最先**的一条（K0）把时间戳改成**最新**⇒ 按 timestamp 排序会排头。
     */
    const entriesMap = (svc as unknown as { entries: Map<string, { timestamp: number }> }).entries;
    entriesMap.get(ids[total - 1])!.timestamp = 1;
    entriesMap.get(ids[0])!.timestamp = 9_999_999_999_999;
    /*
     * 让这两处时间戳**落进镜像**：面板挂载时会 `reload()`（真实读入口），只改内存会被重读丢掉
     * ⇒ 下面"两种口径必须不同"的前提就不成立了（`finalizeBatch` 会走一次 `save()`）。
     */
    svc.finalizeBatch(svc.beginBatch("panel-order"), 0);

    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    const first = render(<MemoryManager onClose={() => {}} projectId={PROJ_A_ID} sessionId="sess-1" />);
    const domKeys = (c: HTMLElement) =>
      Array.from(c.querySelectorAll(".memory-item-key")).map((n) => n.textContent ?? "");

    const rendered = domKeys(first.container);
    expect(rendered.length, "面板必须把所有条目渲染出来（否则这条判据空转）").toBe(total);
    // 注入顺序（服务侧口径）
    const injectedOrder = svc
      .listAllForPanel({ projectId: PROJ_A_ID, sessionId: "sess-1" })
      .map((e) => e.key);
    expect(rendered, "① 面板默认顺序必须 == 注入顺序（同一个创建序）").toEqual(injectedOrder);
    // 与"按 timestamp 倒序"确实不同 ⇒ 这条判据能分辨两种口径（不是恒真）
    const byTimestamp = [...rendered].sort(
      (a, b) =>
        (svc.listAllForPanel({ projectId: PROJ_A_ID }).find((e) => e.key === b)?.timestamp ?? 0) -
        (svc.listAllForPanel({ projectId: PROJ_A_ID }).find((e) => e.key === a)?.timestamp ?? 0),
    );
    expect(rendered[0], "创建序最新的排最前（即使它的时间戳最旧）").toBe(`K${total - 1}`);
    expect(rendered[total - 1], "创建序最早的排最后").toBe("K0");
    expect(rendered, "两种口径必须真的不同，否则上面的断言测不出任何东西").not.toEqual(byTimestamp);

    // ② 标签如实：点开那条 ⇒ 该字段的名字来自产品常量，且不许再叫「创建时间」
    fireEvent.click(
      Array.from(first.container.querySelectorAll(".memory-item")).find((i) =>
        i.textContent?.includes(`K${total - 1}`),
      )!,
    );
    const detail = first.container.querySelector(".memory-detail")?.textContent ?? "";
    expect(detail, "详情必须渲染出来").toContain(`K${total - 1}`);
    expect(detail, "`timestamp` 字段必须如实标成产品常量里的名字（它是 update() 刷新的字段）").toContain(
      MemoryService.PANEL_TIMESTAMP_LABEL,
    );
    expect(detail, "不许再把这个字段标成「创建时间」").not.toContain("创建时间");

    // ② 行为一致性：编辑它 ⇒ **显示的时间**变（最后修改时间）、**位置**不变（顺序 = 创建序）
    const timeOf = (c: HTMLElement, key: string) =>
      Array.from(c.querySelectorAll(".memory-item"))
        .find((i) => i.querySelector(".memory-item-key")?.textContent === key)!
        .querySelector(".memory-item-meta")!.textContent ?? "";
    const timeBefore = timeOf(first.container, `K${total - 1}`);
    expect(svc.update(ids[total - 1], { content: "P22R_EDITED" }, { actor: "user" })).toBe(true);
    cleanup();
    const again = render(<MemoryManager onClose={() => {}} projectId={PROJ_A_ID} sessionId="sess-1" />);
    expect(timeOf(again.container, `K${total - 1}`), "编辑后「最后修改时间」必须跟着变").not.toBe(timeBefore);
    expect(domKeys(again.container), "编辑**不许**因此挪位（面板顺序 = 创建序）").toEqual(rendered);
    spy.mockRestore();
  });
});
