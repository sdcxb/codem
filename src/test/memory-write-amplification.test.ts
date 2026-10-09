/**
 * `MEM-IPC`：记忆「单字符串整份写」的**写放大**必须被量化并钉住（第 191 波 O-52）。
 *
 * ## 被量化的形态（O-52 的问题）
 *
 * `memory` 是配置域里的**一个字符串**：任何一条记忆变了，`serialize()` 都会把**全部**条目 +
 * 批次重新 `JSON.stringify`，整份过一遍 IPC（`memory.set` 是单行 UPDATE）并等一次确认。
 * 第 187 波做过「无变化不写」（内容逐字相同 ⇒ 直接返回），但**内容一变就是整份**。
 *
 * ## 本轮的决定（量化 + 决策，都写在这里）
 *
 * **不做**按条目增量（独立表 upsert）、也**不做**分批切块，理由（可复核）：
 * 1. **写放大的绝对值仍很小**：真实规模语料（400 条 × 300 字符 ≈ 150 KB 量级）下一次改动的
 *    落库字节 = 整份 payload ≈ **几十～一百多 KB**，而这一步本来就是**本地 SQLite 单行 UPDATE**
 *    （不是网络往返）——判据把它量出来（`MEM-IPC-1`），而不是凭感觉说「不大」；
 * 2. **增量路径要改契约**：`memory` 字段的读写两侧（渲染侧 `serialize()` / Rust 侧
 *    `memory.set` 单行 UPDATE / `config_warmup` 整域返回）都要换成「按条目 upsert + 读时拼装」，
 *    于是要么在 Rust 侧加表与迁移（动引擎 schema），要么在渲染侧维护「整份 vs 条目」两套真相 ——
 *    后者正是本仓明令禁止的形态（同一事实两套口径）；
 * 3. **失败语义会变复杂**：现在「整份写」是一个**原子**动作（成功 = 全部落库，失败 = 一个字节没动，
 *    由 `lastPersistError` + 迁移标记的 fail-closed 逻辑兜住）。增量写会引入「半份状态」
 *    （一部分条目落库、一部分没落），要有回滚/对账才敢用 —— 而收益（本地 UPDATE 次数的省下）
 *    与这份复杂度不相称；
 * 4. **真正该防的是「无上限变大」**：那件事由 `O-36` 的字节预算 + 可观测 + 棘轮兜住
 *    （`memory-payload-guards.test.ts` 的 `MEM-BYTES-*`）。所以 O-52 的结论是
 *    「写放大是**已知的、有界的、可观测的**结构性代价，不做增量；上限与可观测由 O-36 负责」。
 *
 * `MEM-IPC-2`（增量路径失败必须如实上报且不留半份状态）**刻意不写成判据**：
 * 增量路径**未实现** ⇒ 写一条它永远绿的断言就是**恒真判据**（本仓明令禁止）。
 * 这里如实登记这个留白。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { MemoryService, estimatePayloadBytes } from "../core/memory/memory";
import { resetPersistFailures } from "../core/storage/persist-failure";

/**
 * **写放大的棘轮**（只许降不许升）：400 条 × 300 字符（≈150 KB 量级）时，
 * 整份 payload 的保守字节估算必须 ≤ 这个登记值。
 * 第 191 波实测 = **392_216 字节**（约 383 KB，含每条目的 id/key/时间戳等字段开销；
 * 也就是"一次单条改动 = 落库约 383 KB 的本地单行 UPDATE"）。
 * 上调必须先说明理由（O-50 同款纪律）；下调了就把它改小。
 */
const PAYLOAD_RATCHET_BYTES_400 = 392_216;

let port: FakeStoragePort;

/** 造 N 条中等大小的平台级记忆（每条 key+content ≈ 300 字符） */
function seedModerate(svc: MemoryService, n: number, content: string): void {
  for (let i = 0; i < n; i++) {
    svc.add({ scope: "platform", key: `k-${i}`, content: `${content}-${i}`, source: "manual" });
  }
}

const memorySetWrites = (p: FakeStoragePort) => p.__writes().filter((w) => w.command === "memory.set");

beforeEach(() => {
  resetPersistFailures();
  port = createFakeStoragePort();
  setStoragePort(port);
});
afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("MEM-IPC：记忆整份写的放大倍数（O-52 的量化与决策）", () => {
  it("MEM-IPC-1: 一次单条改动 ⇒ 恰好一次 memory.set，且落库字节 = **整份** payload（放大随条数线性）", async () => {
    const svc = new MemoryService();
    const small = 50;
    seedModerate(svc, small, "甲".repeat(300));
    await svc.flushPendingPersist();

    const afterSeed = svc.getByteStats().payloadBytes;
    const before = memorySetWrites(port).length;

    // 单条改动
    const r = svc.add({ scope: "platform", key: "one-more", content: "乙".repeat(300), source: "manual" });
    expect(r.ok).toBe(true);
    await svc.flushPendingPersist();

    const newWrites = memorySetWrites(port).slice(before);
    expect(newWrites.length, "一次单条改动只许发一次 memory.set（不许按条发 N 次）").toBe(1);
    const written = String((newWrites[0].params as { content?: unknown } | undefined)?.content ?? "");
    expect(
      estimatePayloadBytes(written),
      "落库字节 = **整份** payload（这就是写放大：与总规模成正比，而不是与改动规模成正比）",
    ).toBe(svc.getByteStats().payloadBytes);
    expect(estimatePayloadBytes(written)).toBeGreaterThan(afterSeed * 0.9);

    // 放大倍数 ≈ 条目数（每条改动都要重发全部条目）
    const single = estimatePayloadBytes(JSON.stringify({ key: "one-more", content: "乙".repeat(300) }));
    expect(
      estimatePayloadBytes(written) / single,
      "50 条规模下的放大倍数至少要超过条目数的一半",
    ).toBeGreaterThan(small / 2);
  });

  it("MEM-IPC-1b: 400 条规模（≈150 KB 量级）的整份 payload 仍落在棘轮内 —— 放大是**有界的**", async () => {
    const svc = new MemoryService();
    seedModerate(svc, 400, "甲".repeat(300));
    await svc.flushPendingPersist();
    const stats = svc.getByteStats();
    expect(stats.entries).toBe(400);
    expect(
      stats.payloadBytes,
      `400 条的整份 payload 实测 ${stats.payloadBytes} 字节（棘轮 ${PAYLOAD_RATCHET_BYTES_400}）；` +
        `这正是 O-52 说的「代价随积累线性增长」—— 若它涨过棘轮，要么压条目大小、要么真的该做增量`,
    ).toBeLessThanOrEqual(PAYLOAD_RATCHET_BYTES_400);
    // 而同一次改动的落库次数仍然只有 1 次（与条数无关）
    const before = memorySetWrites(port).length;
    svc.add({ scope: "platform", key: "x", content: "y", source: "manual" });
    await svc.flushPendingPersist();
    expect(memorySetWrites(port).length - before, "落库次数与条目数无关（永远 1 次整份）").toBe(1);
  });

  it("MEM-IPC-1c: 无变化不写这条既有防线仍然生效（放大的前提是「内容真的变了」）", async () => {
    const svc = new MemoryService();
    seedModerate(svc, 10, "甲".repeat(50));
    await svc.flushPendingPersist();
    const before = memorySetWrites(port).length;
    // 触发一次 saveConfirmed()（内部 serialize 后逐字比较）但内容没有任何变化
    await svc.saveConfirmed();
    await svc.flushPendingPersist();
    expect(memorySetWrites(port).length, "内容逐字相同 ⇒ 一个字节都不许重发").toBe(before);

    /*
     * 这条规则有**两处**入口：同步 `save()`（`add`/`update`/`delete` 走）与确认式
     * `saveConfirmed()`（界面的新建/导入/回退走）。上面那条行为断言走的是后者，
     * 所以这里把**同步那一处**按函数体钉住（删掉它 ⇒ 红）。
     * ⚠️ 不能用"全仓出现几次"来判：`commitMigrationPayload()` 里有一模一样的一行
     * （迁移的整份写也要短路），计数会因为它的存在而恒真 —— 第一版就是这么漏的。
     */
    const code = readFileSync(path.join(process.cwd(), "src/core/memory/memory.ts"), "utf8");
    const saveBody = code.slice(code.indexOf("private save(): boolean {"), code.indexOf("private serialize(): string"));
    expect(saveBody.length, "夹具前提：取到了 save() 的函数体").toBeGreaterThan(100);
    expect(
      saveBody.includes("payload === this.lastPersistedPayload"),
      "同步 `save()` 里的「无变化不写」少了（两处入口都要在：少一处就会把整份 payload 白写一遍）",
    ).toBe(true);
  });
});
