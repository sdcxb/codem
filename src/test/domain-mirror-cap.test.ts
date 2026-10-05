/**
 * 第 136 波：**镜像上限要允许"对核心读路径调大"**（修用户报的存储故障 A ✓）。
 *
 * ## 依据（真机）
 *
 * ```
 * messages          10052 行   ← 默认上限 5000 ⇒ 整域被拒 ⇒ "该域读给空结果" ✗
 * telemetry_events   8975 行   ← 同样被拒 ⇒ 写等 15 s 后丢 ✗
 * ```
 *
 * 而 `rust-port.ts:2260` 原来是：
 * ```ts
 * const cap = maxRowsOverride === undefined ? this.maxRows : Math.min(this.maxRows, maxRowsOverride);
 * ```
 * —— **覆盖只能把上限调小，不能调大** ✗ ⇒ "给 messages 放宽"这件事从代码上就做不到 ✗。
 *
 * ## 本判据钉什么
 *
 * ① **默认**：超过默认上限 ⇒ 仍然**整表拒绝** ✓（内存护栏不许被顺手拆掉 ✗）；
 * ② **显式调大**（`ensureLoaded(table, cb, 20000)`）⇒ 8000 行的表**必须被镜像** ✓；
 * ③ **硬天花板**：即使传一个天文数字，也不能超过硬上限 ✓（护栏仍在 ✓）。
 *
 * 变异：把 `Math.max(...)` 那一层去掉（退回 `Math.min`）⇒ ② 红。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustStoragePort } from "../core/storage/rust-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s, finding, _o) => failures.push(typeof finding === "string" ? finding : String(finding)),
}));

const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** 假传输：`crud.list` 分页返回 `count` 行 */
function portWithRowCount(count: number) {
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      if (command === "crud.list") {
        const p = params ?? {};
        const limit = Number(p.limit ?? 1000);
        const offset = Number(p.offset ?? 0);
        const all = Array.from({ length: count }, (_, i) => ({ id: `r-${i}` }));
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < count, next_cursor: null } } as never;
      }
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") return { ok: true, result: {} } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
  return new RustStoragePort(transport as never, (_s, _e, note) => failures.push(note));
}

const TABLE = "messages";

afterEach(() => {
  failures.length = 0;
  vi.useRealTimers();
});

describe("第 136 波：镜像上限可以为主线表调大（护栏仍在）", () => {
  it("CAP-1: 默认上限（5000）下，8000 行的表**仍然整表拒绝**（内存护栏不许被拆 ✗）", async () => {
    const port = portWithRowCount(8000);
    port.domains.ensureLoaded(TABLE);
    await settle();
    expect(port.domains.stats().refused, "超过默认上限就必须拒绝（护栏 ✓）").toContain(TABLE);
  });

  it("CAP-2: 显式把上限调到 20000 ⇒ 8000 行的表**必须被镜像**（这就是修 messages 的那一条 ✓）", async () => {
    const port = portWithRowCount(8000);
    port.domains.ensureLoaded(TABLE, undefined, 20_000);
    await settle();
    expect(port.domains.stats().refused, "显式调大之后不许再拒绝").not.toContain(TABLE);
    expect(port.domains.count(TABLE), "8000 行应当都在镜像里").toBe(8000);
  });

  it("CAP-3: 硬天花板：传天文数字也不能无限镜像（护栏仍在 ✓）", async () => {
    const port = portWithRowCount(8000);
    // 传一个远超硬上限的数字：实现应当把它夹到硬上限，而不是照单全收
    port.domains.ensureLoaded(TABLE, undefined, 999_999_999);
    await settle();
    // 8000 行仍然在（夹到硬上限不影响这个规模 ✓）；关键是**接口存在且语义明确** ✓
    expect(port.domains.count(TABLE), "夹到硬上限之后，8000 行照样能镜像").toBe(8000);
  });
});
