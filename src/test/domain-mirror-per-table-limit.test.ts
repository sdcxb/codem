/**
 * 第 139 波：**每表上限必须由端口自己决定，不能靠调用方记得传** ✗✓（用户报"测试都是空转"）。
 *
 * ## 真机证据（用户第二次报障，装着 1.16.254/255 的构建）
 *
 * ```
 * [PersistFailure] storage.bootstrap.domain.messages.too-large 操作失败（第 1 次）：
 *   表 messages 超过镜像上限 5000 行
 * ```
 * —— **上限还是 5000** ✗，也就是说 1.16.253 的"给 messages 放宽到 50k"**没有被用上** ✗。
 *
 * ## 为什么没被用上（根因）
 *
 * 我把 `DOMAIN_MIRROR_LIMITS` 放在了 `bootstrap.ts` 的**预取**里 ✗，只在那一条路径上传了覆盖 ✓。
 * 而 `messages` / `telemetry_events` 根本不在 `HOT_DOMAIN_TABLES`（预取清单）里 ✓ ——
 * 它们是**别的调用点**加载的：`domainPort(table)` → `candidate.domains.ensureLoaded(table, cb)` ✗
 * （**不传 `maxRowsOverride`** ✗）⇒ 拿到的还是默认 5000 ✗。
 *
 * ## 本判据钉什么
 *
 * **不传任何覆盖**时，端口也必须对"主线表"用放宽后的上限 ✓：
 * 用 8000 行的假表（> 默认 5000 ✓）调用 `ensureLoaded(table)`（**一个参数都不多传** ✓）⇒
 * **必须被镜像** ✓。变异：把端口里的每表上限去掉（退回只看默认）⇒ 本判据红 ✓。
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

function portWithRows(table: string, count: number) {
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      if (command === "crud.list") {
        const p = params ?? {};
        const limit = Number(p.limit ?? 1000);
        const offset = Number(p.offset ?? 0);
        const all = Array.from({ length: count }, (_, i) => ({ id: `r-${i}`, body: "x" }));
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < count, next_cursor: null } } as never;
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
  void table;
  return new RustStoragePort(transport as never, (_s, _e, note) => failures.push(note));
}

afterEach(() => {
  failures.length = 0;
  vi.useRealTimers();
});

describe("第 139 波：每表上限必须由端口自己兜住（与调用路径无关）", () => {
  it("CAP-4: `messages` 8000 行、**不传覆盖** ⇒ 也必须被镜像（这正是真机上报的那条 ✗）", async () => {
    const port = portWithRows("messages", 8000);
    /** ⚠️ 关键：**只传表名** ✓ —— 真机上 `domainPort()` 就是这么调的 ✗。 */
    port.domains.ensureLoaded("messages");
    await settle();
    expect(
      port.domains.stats().refused,
      "不传覆盖时也必须用放宽后的上限（否则 domainPort 那条路径照旧拒绝 ✗）",
    ).not.toContain("messages");
    expect(port.domains.count("messages"), "8000 行都该在镜像里").toBe(8000);
  });

  it("CAP-5: `telemetry_events` 8000 行、不传覆盖 ⇒ 同样必须被镜像（用户报的第一条 ✗）", async () => {
    const port = portWithRows("telemetry_events", 8000);
    port.domains.ensureLoaded("telemetry_events");
    await settle();
    expect(port.domains.stats().refused).not.toContain("telemetry_events");
    expect(port.domains.count("telemetry_events")).toBe(8000);
  });

  it("CAP-6 反向对照: 不在放宽清单里的表、且超过默认上限 ⇒ **仍然拒绝**（护栏不许被放大 ✗）", async () => {
    const port = portWithRows("some_other_table", 8000);
    port.domains.ensureLoaded("some_other_table");
    await settle();
    expect(port.domains.stats().refused, "没被点名放宽的表必须继续受默认上限保护").toContain("some_other_table");
  });
});
