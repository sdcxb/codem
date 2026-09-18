/**
 * 不变量审计的**加载窗口**契约（第 60 轮真机取证后的修复）
 *
 * ## 被修复的缺陷：把"读不到事件"当成了"没有事件"
 *
 * `EventLog.readAll(sid)` 有一条硬路由规则：**该会话的事件镜像没加载完 → 返回空数组**
 * （`event-log.ts` 的"端口没接手 → 该域的合理空结果"）。而维护触发的审计**往往就是
 * 第一次访问这些会话的事件** —— `rustEventPort()` 顺手发起加载后**同步返回 null**
 * （真实现是异步 IPC），紧接着的 `readAll` 读到的是空。
 *
 * 后果不是"少报"，是**多报**：不变量把"事件读成空"理解成"这些消息都没有事件记录"，
 * 于是把该会话的**每一条消息**都报成缺口。真机实测（同一份数据、两次维护相隔 36 秒）：
 *
 * | 那次维护 | 报出的历史缺口 | 与会话消息行数的关系 |
 * | --- | --- | --- |
 * | 事件镜像没加载完 | **934** | = 657 + 277（两个会话的全部消息行） |
 * | 镜像已加载 | **749** | = 505 + 244（与 DB 真值逐条相等） |
 *
 * 这一组用例用假端口的 `asyncLoad`（真端口异步加载的同形）把这件事钉死：
 * **加载时机不许改变审计报出来的数字**；等不到就如实说"没检查"，
 * 既不冒充"通过"，也不把"读不到"折算成缺口。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { auditInvariantsForSessions, runDatabaseMaintenance } from "../core/storage/maintenance";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

type SpyInstance = MockInstance<(...args: unknown[]) => void>;

const SID = "s-load-window";

function installTauriStub(): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "read_file") throw new Error("no such file");
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

/**
 * 一份**数字上故意可分辨**的数据：
 * - 违规定额：**1 条**（`a-orphan`：有正文、没有任何事件）；
 * - 结构异常：**1 处**（`tool_result` 指向一个从未出现的 `toolCallId`）；
 * - 消息行数：**4 行** —— "读不到事件"时，不变量会把 4 行全报成缺口（1 ≠ 4 就是判据）。
 */
function seedScenario(port: FakeStoragePort): void {
  const seed = (table: string, row: Record<string, unknown>) => {
    void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
  };
  seed("sessions", {
    id: SID,
    project_id: "",
    title: "加载窗口",
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 4,
    pinned: 0,
  });

  let ts = 0;
  const message = (id: string, role: string, content: string) =>
    seed("messages", {
      id,
      session_id: SID,
      role,
      content,
      reasoning: null,
      timestamp: ++ts,
      model: null,
      status: "done",
      hidden: 0,
      trimmed: 0,
    });
  message("u-1", "user", "问题");
  message("a-1", "assistant", "回答");
  message("a-tool", "assistant", ""); // 纯工具轮：正文为空，靠 tool 事件合法
  message("a-orphan", "assistant", "这条没有任何事件 → 唯一真缺口");

  const event = (eventType: string, payload: unknown, seq: number) =>
    seed("session_events", {
      seq,
      session_id: SID,
      event_type: eventType,
      payload: JSON.stringify(payload),
      timestamp: 100 + seq,
    });
  event("user_message", { messageId: "u-1", content: "问题" }, 1);
  event("assistant_text", { messageId: "a-1", content: "回答" }, 2);
  event("tool_call", { messageId: "a-tool", toolCallId: "tc-real", tool: "bash", args: {} }, 3);
  // 结构异常：这个 toolCallId 从来没被 tool_call 声明过
  event("tool_result", { toolCallId: "tc-ghost", status: "completed", result: "x" }, 4);
}

/** 建端口（可选择"异步就绪"= 真端口同形）并播种 */
async function install(asyncLoad: boolean): Promise<FakeStoragePort> {
  const port = createFakeStoragePort({ asyncLoad });
  setStoragePort(port);
  seedScenario(port);
  return port;
}

/** 汇总行（`formatInvariantAudit` 的输出一定在里面） */
function summaryLine(log: SpyInstance): string {
  return String(
    log.mock.calls.map((c) => String(c[0] ?? "")).find((s) => s.includes("维护完成")) ?? "",
  );
}

let logSpy: SpyInstance;
let warnSpy: SpyInstance;

beforeEach(() => {
  installTauriStub();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RVL-W：审计必须在读侧镜像就绪之后判定", () => {
  it("RVL-W1: 同步就绪（对照）→ 2 条真缺口、1 处结构异常、0 个未就绪会话", async () => {
    /*
     * 两个方向的真缺口各一条（都是真实存在、**应该**被报出来的）：
     * - `VISIBLE_BUT_NOT_RECORDED`：`a-orphan` 有正文、没有任何事件；
     * - `UNPAIRED_TOOL_CALL`：`tc-real` 没有对应的 `tool_result`。
     * 判据的强度在于：这两条在"镜像没就绪"时会被**别的东西**替换掉
     * （消息读成空 → 4 条消息全报缺口；事件读成空 → 工具配对反过来报）。
     */
    await install(false);
    const out = await auditInvariantsForSessions([SID]);

    expect(out.checked).toBe(1);
    expect(out.unreadableSessions, "镜像同步就绪 → 没有会话被跳过").toBe(0);
    expect(out.violations, "真缺口恰好 2 条（不是'全部消息行数'）").toBe(2);
    expect(out.structuralErrors, "孤儿 tool_result 必须被报出来").toBe(1);
  });

  it("RVL-W2: 异步就绪（真端口同形）→ 数字必须与对照组**逐字相同**", async () => {
    /*
     * 这条就是修复的判据本身：**加载时机不许改变审计的数字**。
     *
     * 修之前它是红的，而且是"多报"：消息或事件任一读成空，两条判据都会换一种方式造假 ——
     * 消息读成空 → `RECORDED_BUT_NOT_VISIBLE`（事件有、消息"没有"）；
     * 事件读成空 → 4 条消息全被判成缺口（真机同形：934 = 657 + 277）、
     * 结构自检同时报 0 处异常（读的是同一份空数组）。
     */
    await install(true);
    const out = await auditInvariantsForSessions([SID]);

    expect(out.checked, "等到了就绪 → 这个会话真的被检查了").toBe(1);
    expect(out.unreadableSessions).toBe(0);
    expect(out.violations, "与同步模式逐字相同 = 加载时机没有参与判定").toBe(2);
    expect(out.structuralErrors, "读空数组时结构自检会报 0 —— 那正是'印出来的不是真的'").toBe(1);
  });

  it("RVL-W3: 读侧镜像**永远不就绪** → 不许冒充「检查过」，也不许把读不到折算成缺口", async () => {
    /*
     * 真机对应形态：加载失败（IPC 出错 / 引擎忙 / 镜像被拒）。此时
     * `isLoaded` 恒 false 且回调永不触发 —— 审计必须**如实说"没检查"**：
     * checked 不含它、缺口不虚增、结构异常不许报"通过"。
     *
     * 用假定时器驱动等待预算（默认 4 秒），测试不必真的等 4 秒。
     * ⚠️ 两侧镜像（消息 + 事件）都要钉成"不就绪"：只钉事件的话，消息那侧
     * 仍会把事件判成 `RECORDED_BUT_NOT_VISIBLE`，测不到"跳过"这条路径。
     */
    const port = await install(false);
    // 让这个会话的读侧镜像"永远加载不完"：回调不触发、isLoaded 恒 false
    for (const mirror of [port.events, port.messages] as Array<{
      ensureLoaded: (s: string, cb?: () => void) => void;
      isLoaded: (s: string) => boolean;
      isLoading?: (s: string) => boolean;
    }>) {
      mirror.isLoaded = () => false;
      mirror.ensureLoaded = () => {};
    }

    vi.useFakeTimers();
    const pending = auditInvariantsForSessions([SID]);
    await vi.advanceTimersByTimeAsync(5000);
    const out = await pending;
    vi.useRealTimers();

    expect(out.checked, "没读到就不算检查过（'没跑'不许冒充'通过'）").toBe(0);
    expect(out.unreadableSessions, "必须单独报出'这个会话没检查'").toBe(1);
    expect(out.violations, "读不到 ≠ 全部都是缺口").toBe(0);
    expect(out.structuralErrors, "读不到 ≠ 结构没问题").toBe(0);
  });

  it("RVL-W4: 维护汇总行把「未就绪」与「检查过没问题」分开写", async () => {
    /*
     * 这一条走**真维护**（不是只调审计函数），因为要守的是"这个数字有没有进汇总行"。
     * 用真定时器等满等待预算（4 秒）—— 维护内部有大量真实的异步等待，
     * 假定时器驱动不了它（试过：会挂住）。所以这条用例单独给 20 秒预算。
     */
    const port = await install(false);
    for (const mirror of [port.events, port.messages] as Array<{
      ensureLoaded: (s: string, cb?: () => void) => void;
      isLoaded: (s: string) => boolean;
    }>) {
      mirror.isLoaded = () => false;
      mirror.ensureLoaded = () => {};
    }

    const res = await runDatabaseMaintenance({});

    expect(res.invariantUnreadableSessions).toBe(1);
    const line = summaryLine(logSpy);
    expect(line, "汇总行必须带上这个数字（否则'没检查'与'检查了没事'在日志上分不开）").toContain("未就绪");
    expect(line).toContain("本次未检查");
  }, 20000);
});
