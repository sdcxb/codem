/**
 * 第 143 波（B1）：**不碰镜像的按需查询** ✓ —— 治本路线的第一块砖。
 *
 * ## 为什么要它（用户的原话）
 *
 * > 之前不是说对标看 DSH 怎么做的，我看你回答 DSH 没用镜像啊？为什么我们还不修复，还在走镜像？
 *
 * 对 ✓。DSH 把数据留在宿主侧、按需查询 ✓（`session-query.zh.md`：**一次精确读取，而不是持续保留的订阅** ✓），
 * 而我们的读接口是**同步**的 ⇒ 当初用镜像换"同步读不跨 IPC" ✓，
 * 于是"内存随浏览史增长"✗ 只能靠一行行加预算去压 ✗（行数 → 字节 → 每表下限 → 等待预算 ✗）。
 *
 * **B1 是走出这个模型的第一步** ✓：给端口加**镜像之外的**异步查询 ✓ ——
 * 只查引擎、**不往渲染进程里放任何驻留** ✓。有了它，消费方才能一个一个搬过去 ✓，
 * 搬完之后消息/事件镜像就可以删掉 ✗→✓。
 *
 * ## 判据
 *
 * **B1-Q1**：**一次都不加载镜像**的前提下：
 * - `queryEvents(sid)` 必须返回**全部** N 条事件 ✓；
 * - `queryMessages(sid)` 必须返回**全部** M 条消息 ✓；
 * - 并且调用之后 `events.isLoaded(sid)` / `messages.isLoaded(sid)` **仍然是 false** ✓
 *   —— 这是"真的没碰镜像"的证据 ✓（否则就是换了名字的镜像读 ✗）。
 *
 * 变异：把实现改成走镜像 ⇒ B1-Q1 红。
 */
import { describe, expect, it, vi } from "vitest";
import { RustStoragePort } from "../core/storage/rust-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s, finding, _o) => failures.push(typeof finding === "string" ? finding : String(finding)),
}));

const SID = "s-queried";
const EVENT_COUNT = 2500; // 故意超过单页 1000 ⇒ 必须真的分页 ✓
const MESSAGE_COUNT = 1740;

function portWithSession() {
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      const p = params ?? {};
      const sid = String(p.session_id ?? "");
      const limit = Number(p.limit ?? 1000);
      if (command === "events.list") {
        if (sid !== SID) return { ok: true, result: { items: [], has_more: false } } as never;
        const fromSeq = p.from_seq === undefined ? 1 : Number(p.from_seq);
        const all = Array.from({ length: EVENT_COUNT }, (_, i) => ({
          seq: i + 1,
          session_id: SID,
          type: "assistant_text",
          payload: `e${i + 1}`,
          timestamp: i,
        }));
        const items = all.filter((e) => e.seq >= fromSeq).slice(0, limit);
        return { ok: true, result: { items, has_more: items.length === limit && items[items.length - 1].seq < EVENT_COUNT } } as never;
      }
      if (command === "messages.list") {
        if (sid !== SID) return { ok: true, result: { items: [], has_more: false } } as never;
        const offset = Number(p.offset ?? 0);
        const all = Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
          id: `m${i}`,
          session_id: SID,
          role: "assistant",
          content: `c${i}`,
          timestamp: i,
          hidden: 0,
        }));
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < MESSAGE_COUNT } } as never;
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

describe("第 143 波（B1）：不碰镜像的按需查询", () => {
  it("B1-Q1: 镜像一次都没加载，也要能查出全部事件与消息（且事后仍然没加载）", async () => {
    const port = portWithSession() as unknown as {
      queryEvents(sid: string): Promise<Array<{ seq: number }>>;
      queryMessages(sid: string): Promise<Array<{ id: string }>>;
      events: { isLoaded(sid: string): boolean };
      messages: { isLoaded(sid: string): boolean };
    };

    const events = await port.queryEvents(SID);
    const messages = await port.queryMessages(SID);

    expect(events.length, `事件要查全（夹具 ${EVENT_COUNT} 条 ⇒ 必须真的翻页 ✓）`).toBe(EVENT_COUNT);
    expect(messages.length, `消息要查全（夹具 ${MESSAGE_COUNT} 条）`).toBe(MESSAGE_COUNT);
    expect(
      port.events.isLoaded(SID),
      "查完不许把事件塞进镜像 —— 否则这就只是'换了名字的镜像读' ✗",
    ).toBe(false);
    expect(
      port.messages.isLoaded(SID),
      "查完不许把消息塞进镜像 —— 这正是要摆脱的模型 ✗",
    ).toBe(false);
  });
});
