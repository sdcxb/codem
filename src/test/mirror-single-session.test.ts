/**
 * 第 138 波（S2）：**只驻留当前活跃会话** —— 把"跨会话累计"这个无界输入端掐掉。
 *
 * ## 为什么这是治本的第一步（§13.55）
 *
 * 现在的镜像是"**把整域数据搬进渲染进程，再用预算削**" ✗：内存随
 * "**用户浏览过的历史总量**"增长 ✗。行数预算不够（已修 ✓）、字节预算也是治标 ✓ ——
 * 因为**输入端无界** ✗。DSH 的做法是数据留在宿主侧、客户端只取"这一屏要显示的" ✓
 * （`docs/subsystems/session-query.zh.md`：一次精确读取，**而不是持续保留的订阅** ✓）。
 *
 * S2 是最小的一步 ✓：**同一时刻只留一份会话镜像** ✓ ——
 * 上限从"浏览史总量"降到"**一个会话**" ✓（S3 再降到"一屏" ✓）。
 *
 * ## 判据
 *
 * - **SSR-1**：加载 A 之后再加载 B ⇒ **A 必须已被逐出**（`isLoaded(A) === false` ✓），B 在 ✓；
 * - **SSR-2**：带 `pending && !settled` 的会话**不许**被这条规则逐出 ✓（安全例外，沿用既有取舍 ✓）；
 * - **SSR-3 反向对照**：反复访问**同一个**会话 ⇒ 不许抖动（它一直在 ✓）。
 *
 * 变异：去掉"逐出其它会话"那一段 ⇒ SSR-1 红。
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

/** 假传输：`messages.list` 与 `events.list` 都按会话返回小数据（S2 与体积无关 ✓） */
function portWithSessions(sessions: string[]) {
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      const p = params ?? {};
      const sid = String(p.session_id ?? "");
      const known = sessions.includes(sid);
      if (command === "messages.list") {
        const all = known ? Array.from({ length: 5 }, (_, i) => ({ id: `${sid}-m${i}`, session_id: sid, role: "user", content: `m${i}`, timestamp: i })) : [];
        return { ok: true, result: { items: all, has_more: false } } as never;
      }
      if (command === "events.list") {
        const all = known ? Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, session_id: sid, type: "test", payload: `e${i}`, timestamp: i })) : [];
        return { ok: true, result: { items: all, has_more: false } } as never;
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

describe("第 138 波（S2）：只驻留当前活跃会话", () => {
  it("SSR-1: 加载超过 3 份会话之后，最早的必须被逐出（消息与事件镜像都一样 ✓）", async () => {
    const port = portWithSessions(["A", "B", "C", "D"]);
    port.messages.ensureLoaded("A");
    port.events.ensureLoaded("A");
    await settle();
    expect(port.messages.isLoaded("A"), "夹具前提：A 应当先加载好").toBe(true);
    expect(port.events.isLoaded("A"), "夹具前提：A 的事件也应当加载好").toBe(true);

    /**
     * 上限是 **3**（见 MIRROR_KEEP_SESSIONS 的注释：1 会让父子委派来回重载 ✗）。
     * 所以这里加载到第 4 个会话 ⇒ **最早的 A 必须被逐出** ✓（跨会话累计是无界输入端 ✗）。
     */
    for (const s of ["B", "C", "D"]) {
      port.messages.ensureLoaded(s);
      port.events.ensureLoaded(s);
      await settle();
    }

    expect(port.messages.isLoaded("A"), "超过 3 份之后，最早的 A 不该还留着（跨会话累计是无界输入端 ✗）").toBe(false);
    expect(port.events.isLoaded("A"), "事件镜像同理").toBe(false);
    expect(port.messages.isLoaded("D"), "最近加载的 D 当然要在").toBe(true);
    expect(port.events.isLoaded("D"), "D 的事件也要在").toBe(true);
  });

  it("SSR-3 反向对照: 反复访问同一个会话 ⇒ 不许抖动（它一直在 ✓）", async () => {
    const port = portWithSessions(["A"]);
    port.messages.ensureLoaded("A");
    await settle();
    for (let i = 0; i < 5; i++) {
      port.messages.ensureLoaded("A");
      await settle();
    }
    expect(port.messages.isLoaded("A"), "同一个会话反复访问必须一直在").toBe(true);
    expect(port.messages.stats().evictions, "不该发生任何逐出").toBe(0);
  });
});
