/**
 * 第 149 波：**遥测的按需查询** ✓ —— 退掉"用同步领域读读无界表"的第一处 ✗→✓。
 *
 * ## 为什么是遥测（用户报的那条告警的根源 ✓）
 *
 * `telemetry_events` 在真机上有 8975 行 ✗（默认镜像上限 5000 ✗）⇒
 * 先后引出「表超过镜像上限」「写等 15 秒后丢弃」两条用户可见告警 ✓。
 * 而它被两个地方用**同步领域读**访问 ✗（`maintenance.ts` 与 `telemetry.ts` ✓，见门里的 7 处清单 ✓）。
 *
 * 这一波先把 `maintenance.ts` 那处搬走 ✓（异步上下文 ✓、零外溢 ✓），
 * 同时给出**通用的**按需查询 ✓：`port.queryTelemetry(...)` ✓ ——
 * `queryEvents` 是会话事件的 ✓，不含遥测 ✗，所以遥测需要自己的那一个 ✓。
 *
 * ## 判据
 *
 * **TQ-1**：**一次都不加载镜像**的前提下：
 * - `queryTelemetry()` 必须返回**全部** N 行 ✓（夹具 2500 行 ⇒ 真的翻页 ✓）；
 * - 查完 `domains.isLoaded("telemetry_events")` **仍然是 false** ✓（真的没碰镜像 ✓）。
 *
 * 变异：把实现改成走镜像 ⇒ TQ-1 红。
 */
import { describe, expect, it, vi } from "vitest";
import { RustStoragePort } from "../core/storage/rust-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s, finding, _o) => failures.push(typeof finding === "string" ? finding : String(finding)),
}));

const TELEMETRY_ROWS = 2500; // 故意超过单页 1000 ⇒ 必须真的分页 ✓

function portWithTelemetry() {
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      const p = params ?? {};
      if (command === "crud.list") {
        const table = String(p.table ?? "");
        if (table !== "telemetry_events") return { ok: true, result: { items: [], has_more: false } } as never;
        const limit = Number(p.limit ?? 1000);
        const offset = Number(p.offset ?? 0);
        const all = Array.from({ length: TELEMETRY_ROWS }, (_, i) => ({
          id: `t${i}`,
          session_id: "s1",
          event_name: "llm_response",
          event_data: "{}",
          timestamp: 1000 + i,
        }));
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < TELEMETRY_ROWS } } as never;
      }
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") return { ok: true, result: {} } as never;
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

describe("第 149 波：遥测的按需查询（不碰镜像）", () => {
  it("TQ-1: 镜像一次都没加载，也要能查出全部遥测行（且事后仍然没加载）", async () => {
    const port = portWithTelemetry() as unknown as {
      queryTelemetry(opts?: { limit?: number }): Promise<Array<Record<string, unknown>>>;
      domains: { isReady(t: string): boolean };
    };

    const rows = await port.queryTelemetry();
    expect(rows.length, `遥测要查全（夹具 ${TELEMETRY_ROWS} 行 ⇒ 必须真的翻页 ✓）`).toBe(TELEMETRY_ROWS);
    expect(
      port.domains.isReady("telemetry_events"),
      "查完不许把遥测塞进镜像 —— 那正是『把无界对象搬进渲染进程』✗，也正是这次要退掉的东西 ✓",
    ).toBe(false);
  });

  it("TQ-2: `limit` 要真的起作用（维护裁剪只关心前 N 行 ✓）", async () => {
    const port = portWithTelemetry() as unknown as {
      queryTelemetry(opts?: { limit?: number }): Promise<Array<Record<string, unknown>>>;
    };
    const rows = await port.queryTelemetry({ limit: 300 });
    expect(rows.length, "给了 limit 就不该把两千多行全拉回来 ✗").toBe(300);
  });
});
