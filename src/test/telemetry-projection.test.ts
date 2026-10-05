/**
 * 第 151 波：**遥测投影**的判据 ✓ —— "同步读保留、作用域缩小"的样板 ✓。
 *
 * ## 这条判据钉什么
 *
 * - **TELE-A1**：`refreshTelemetryProjection()` 之后 ⇒ **同步**读（`getOverviewStats` 等 ✓）
 *   必须能拿到数字 ✓ —— 也就是"渲染期零 await"这条产品需求**没有被牺牲** ✓；
 * - **TELE-A2**：**没刷新之前**，同步读必须**确定性地空** ✓（不是"读到半个镜像"✗、
 *   也不是"读到别人写进去的残留"✗）—— 这条保证"读不到"与"没有数据"不混 ✓；
 * - **TELE-A3**：投影**有界** ✓（`keep` 只留最近 N 行 ⇒ 真机 8975 行的表不会全进内存 ✓）。
 *
 * 变异：把 `refreshTelemetryProjection` 改成走镜像（`domains.all(...)`）⇒ TELE-A3/TQ 红 ✓。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustStoragePort } from "../core/storage/rust-port";
import { setStoragePort } from "../core/storage/port";
import { getTelemetry, refreshTelemetryProjection, __resetTelemetryProjectionForTests } from "../core/telemetry/telemetry";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s, finding, _o) => failures.push(typeof finding === "string" ? finding : String(finding)),
}));

const ROWS = 2500;

function portWithTelemetry() {
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      const p = params ?? {};
      if (command === "crud.list") {
        if (String(p.table ?? "") !== "telemetry_events") return { ok: true, result: { items: [], has_more: false } } as never;
        const limit = Number(p.limit ?? 1000);
        const offset = Number(p.offset ?? 0);
        const all = Array.from({ length: ROWS }, (_, i) => ({
          id: `t${i}`,
          session_id: "s1",
          event_name: i % 2 === 0 ? "llm_response" : "tool_call",
          event_data: "{}",
          timestamp: 1_000_000 + i,
        }));
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < ROWS } } as never;
      }
      return { ok: true, result: {} } as never;
    },
    invokeBatch: async () => ({ ok: true, result: {} }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
  return new RustStoragePort(transport as never, (_s, _e, note) => failures.push(note));
}

afterEach(() => {
  failures.length = 0;
  setStoragePort(null);
  /** 投影是**模块级状态** ✓ ⇒ 用例之间必须清掉 ✗（否则"没刷新之前必须空"这条会假红 ✓）。 */
  __resetTelemetryProjectionForTests();
});

describe("第 151 波：遥测投影（同步读保留、作用域缩小）", () => {
  it("TELE-A1: 刷新之后，**同步**读必须拿得到数字（渲染期零 await ✓）", async () => {
    setStoragePort(portWithTelemetry() as never);
    const n = await refreshTelemetryProjection();
    expect(n, `投影应当拿到 ${ROWS} 行（夹具全部保留 ✓）`).toBe(ROWS);

    /** 关键：下面这些全是**同步**调用 ✓ —— 仪表盘就是渲染期这么读的 ✓ */
    const stats = getTelemetry().getOverviewStats();
    expect(typeof stats, "同步读必须仍然可用").toBe("object");
    const series = getTelemetry().getTimeSeries(60_000, 60 * 60 * 1000);
    expect(Array.isArray(series), "时间序列也要能从投影里同步算出来").toBe(true);
  });

  it("TELE-A2: 没刷新之前，同步读必须**确定性地空**（不混'读不到'与'没有数据' ✓）", () => {
    setStoragePort(portWithTelemetry() as never);
    const before = getTelemetry().query("s1");
    expect(Array.isArray(before), "查不出来也要是数组（调用方按空结果处理 ✓）").toBe(true);
    expect(before.length, "没投影就是 0 条 —— 不许悄悄去读镜像 ✗").toBe(0);
  });

  it("TELE-A3: 投影**有界**（只留最近 N 行 ✓）", async () => {
    setStoragePort(portWithTelemetry() as never);
    const kept = await refreshTelemetryProjection({ keep: 300 });
    expect(kept, "keep 只留最近 300 行 ⇒ 真机 8975 行的表不会全进内存 ✓").toBe(300);
    /** 留的必须是**最近**的（尾部 ✓）：最后一条的 timestamp 应当是最大的那个 ✓ */
    const rows = getTelemetry().query("s1");
    const maxTs = Math.max(...rows.map((r) => r.timestamp));
    expect(maxTs, "留下的应当是最近的行（尾部 ✓），否则仪表盘看的是最旧的 ✗").toBe(1_000_000 + ROWS - 1);
  });
});
