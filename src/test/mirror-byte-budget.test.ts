/**
 * 第 137 波：**消息镜像的预算必须包含"字节"，不能只看行数**（用户报的 3.5GB OOM ✓）。
 *
 * ## 依据（用户另一台机器、v1.16.210 的崩溃判据）
 *
 * ```
 * kind=RENDER_PROCESS_EXITED(1) reason=OUT_OF_MEMORY(5) exit_code=-536870904
 * host=67MB webview_total=4093MB webview_procs=6 [2800:48MB, 12372:160MB, 19512:25MB,
 *   20056:3508MB, 22132:326MB, 22972:23MB] total=4160MB
 * ```
 * —— **单个渲染进程 3508MB** ✗。
 *
 * 而镜像代码里的预算是**行数**（`totalBudgetRows = 20_000` ✓），注释自己写着
 * 「5000 条大消息就是几十上百 MB」✓ —— 20k 行大消息/事件**可以到 GB 级** ✗✓。
 *
 * ## 本判据钉什么
 *
 * **行数很少、但每行很大**时也必须逐出 ✓：
 * 夹具放 10 行（远低于行数预算 20000 ✓）但每行 2.5M 字符（≈5MB ✓）
 * ⇒ 总字节远超字节预算 ⇒ **必须发生逐出** ✓，并且逐出后总字节 ≤ 预算 ✓。
 *
 * 变异：把字节条件从 `enforceBudget` 里去掉 ⇒ 本判据红 ✓（只有行数条件时不会逐出 ✗）。
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

/** 假传输：`messages.list` 按会话返回 `rowsPerSession` 行，每行 content 长 `charsPerRow` */
function portWithBigMessages(sessions: string[], rowsPerSession: number, charsPerRow: number) {
  const content = "x".repeat(charsPerRow);
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      if (command === "messages.list") {
        const p = params ?? {};
        const sid = String(p.session_id ?? "");
        const limit = Number(p.limit ?? 1000);
        const offset = Number(p.from_seq ?? p.offset ?? 0);
        if (!sessions.includes(sid)) return { ok: true, result: { items: [], has_more: false } } as never;
        const all = Array.from({ length: rowsPerSession }, (_, i) => ({
          id: `${sid}-m${i}`,
          session_id: sid,
          role: "user",
          content,
          timestamp: 1000 + i,
        }));
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < all.length } } as never;
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

afterEach(() => {
  failures.length = 0;
  vi.useRealTimers();
});

describe("第 137 波：镜像预算必须含字节口径（防渲染进程 OOM）", () => {
  it("MB-1: 行数很少但每行很大 ⇒ 必须逐出，且逐出后总字节不超过预算", async () => {
    /** 6 个会话 × 10 行 × 2.5M 字符 ≈ 每个会话 25M 字符（≈50MB）⇒ 合计约 300MB ✓（行数只有 60 ✗） */
    const sessions = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const port = portWithBigMessages(sessions, 10, 2_500_000);
    for (const s of sessions) {
      port.messages.ensureLoaded(s);
      await settle();
    }
    const stats = port.messages.stats() as unknown as { bytes?: number; budgetBytes?: number; evictions: number; rows: number };
    expect(stats.rows, "夹具前提：行数远低于行数预算（所以只靠行数是不会逐出的）").toBeLessThanOrEqual(60);
    expect(stats.evictions, "总字节远超字节预算 ⇒ 必须发生逐出（只看行数的话这里会是 0 ✗）").toBeGreaterThan(0);
    expect(typeof stats.bytes, "stats 必须暴露字节用量（否则这条预算无法观测）").toBe("number");
    expect(stats.bytes!, "逐出之后总字节必须落在预算内").toBeLessThanOrEqual(stats.budgetBytes ?? 0);
  });

  it("MB-2 反向对照: 行数少、字节也小 ⇒ 不许逐出（别把该留的也逐掉）", async () => {
    const sessions = ["s1", "s2"];
    const port = portWithBigMessages(sessions, 10, 100);
    for (const s of sessions) {
      port.messages.ensureLoaded(s);
      await settle();
    }
    expect(port.messages.stats().evictions, "小数据不该触发逐出").toBe(0);
    expect(port.messages.stats().rows).toBe(20);
  });
});
