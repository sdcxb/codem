/**
 * 第 41 波：`updateMessage` 的**成本账**必须可信 ✓（目标② 的"消息行的写"嫌疑 ✓，只记不判 ✓）。
 *
 * ## 为什么（**目标是"能归因"，不是"能修"** ✓）
 *
 * §13.216 已经把目标② 的嫌疑收敛到**"消息行的写"** ✓，并明确写下"**下一波直接在它上面打点**"✓。
 * 打点之前先量过**已有数据** ✓（`.preview-shot/_stream-vs-output.mjs` ✓）：`stream=` 与
 * **正文**字数的斜率只有 ~1.2~2.2 ms/字 ✓，而最贵的几轮**正文几乎是 0 字** ✗
 * （`repo-02` r290：`iter37=34.6s/233字`、`iter38=33.5s/0字` ✓）——
 * 那说明贵的部分是 **reasoning**（`text length` 数不到它 ✗）⇒ **已有数据分不开**
 * "模型真在生成"与"客户侧在写盘" ✗。⇒ 必须打点 ✓。
 *
 * ## 打点的口径（**极窄** ✓）
 *
 * 只在 `updateMessage` 里记三个数：**调用次数** ✓、**累计毫秒** ✓、**单次最大毫秒** ✓，
 * 由 `takeMessageWriteStats()` 取走并清零 ✓（取走即清零 ⇒ 每轮报的是"这一轮的账"✓）。
 * ★ **不判任何事** ✓、不改行为 ✓ —— 它是"留档" ✓（这一课的来源见交接 §6 第 8 条 ✓）。
 *
 * ## 判据
 *
 * | id | 钉什么 | 变异（应当红 ✗） |
 * |---|---|---|
 * | `MW-1` | 记账**忠实**：N 次 `updateMessage` ⇒ 取到的 `calls === N` ✓ | 把计数写在某个分支里（只数一部分 ✗） |
 * | `MW-2` | **取走即清零** ✓（两次 take 之间不再调用 ⇒ 第二次全 0 ✓） | 取走不清零 ⇒ 数字越滚越大 ✗ |
 * | `MW-3` | 时长**非负且 max ≤ 累计** ✓（形状约束 ✓） | 记成负数 / max 超过累计 ⇒ 红 |
 * | `MW-4` | 结构：`llm timing` 那行**带 `msgw=`** ✓（否则账只在内存里、真机看不到 ✗） | 删掉那一段 ⇒ 红 |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPersistFailures } from "../core/storage/persist-failure";
import { setStoragePort } from "../core/storage/port";
import { __resetDataRootCache } from "../core/storage/data-root";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { readFileWithCap, textWindowSlice } from "./helpers/tauri-fs-stub";
import { stripComments } from "./helpers/settings-key-scan";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../store";

const S = "sess-mw-1";
const APP_DIR = "C:/fake-appdata/";
const files = new Map<string, string>();

function installFakeFs(): void {
  files.clear();
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        const path = String(args?.path ?? "");
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") return readFileWithCap(files, args);
        if (cmd === "append_file") {
          files.set(path, (files.get(path) ?? "") + String(args?.content ?? "") + "\n");
          return null;
        }
        if (cmd === "write_file") {
          files.set(path, String(args?.content ?? ""));
          return null;
        }
        if (cmd === "list_directory") return [];
        if (cmd === "path_exists") return files.has(path);
        return null;
      },
    },
  };
}

let port: FakeStoragePort;

beforeEach(async () => {
  resetPersistFailures();
  installFakeFs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  port = createFakeStoragePort({
    seed: { sessions: [{ id: S, project_id: "p1", title: "MW", created_at: 1, last_message_at: 1, message_count: 0 }], messages: [] },
  });
  setStoragePort(port);
  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  msgMod.__resetSessionLogReadFailuresForTests();
  const jsonl = await import("../core/storage/session-jsonl");
  jsonl.__resetJsonlCache();
  __resetDataRootCache();
  msgMod.takeMessageWriteStats(); // 从零开始量
});

afterEach(async () => {
  const { flushSessionLogWrites } = await import("../core/storage/session-jsonl");
  await flushSessionLogWrites();
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
});

describe("第 41 波：updateMessage 的成本账（只记不判，目标② 归因用）", () => {
  it("MW-1: 记账忠实 —— N 次 updateMessage ⇒ calls === N（每一次都要数到 ✓）", async () => {
    const { createMessage, updateMessage, takeMessageWriteStats } = await import("../core/storage/message");
    createMessage({ id: "m1", role: "assistant", content: "v1", timestamp: 1 } as Message, S);
    takeMessageWriteStats();
    for (let i = 0; i < 7; i++) updateMessage("m1", { content: `v${i + 2}` });
    const stats = takeMessageWriteStats();
    expect(stats.calls, "7 次调用必须都数到（漏一次，真机读数就偏低 ✗）").toBe(7);
    expect(stats.ms, "累计毫秒非负").toBeGreaterThanOrEqual(0);
    expect(stats.ms, "累计毫秒是有限数（NaN 会让报告写成 NaN ✗）").toBeLessThan(60_000);
  });

  it("MW-2 反向对照: 取走即清零（两次 take 之间不再调用 ⇒ 第二次全 0）", async () => {
    const { createMessage, updateMessage, takeMessageWriteStats } = await import("../core/storage/message");
    createMessage({ id: "m2", role: "assistant", content: "v1", timestamp: 1 } as Message, S);
    takeMessageWriteStats();
    updateMessage("m2", { content: "v2" });
    const first = takeMessageWriteStats();
    expect(first.calls).toBe(1);
    const second = takeMessageWriteStats();
    expect(second, "取走不清零 ⇒ 数字越滚越大、每轮读数都会虚高 ✗").toEqual({ calls: 0, ms: 0, maxMs: 0 });
  });

  it("MW-3: 形状约束 —— maxMs ≤ ms 且两者都非负（单次最大不可能超过累计 ✓）", async () => {
    const { createMessage, updateMessage, takeMessageWriteStats } = await import("../core/storage/message");
    createMessage({ id: "m3", role: "assistant", content: "v1", timestamp: 1 } as Message, S);
    takeMessageWriteStats();
    for (let i = 0; i < 5; i++) updateMessage("m3", { reasoning: `r${i}` });
    const stats = takeMessageWriteStats();
    expect(stats.maxMs).toBeGreaterThanOrEqual(0);
    expect(stats.maxMs, "单次最大不能超过累计").toBeLessThanOrEqual(stats.ms);
  });

  it("MW-4 结构: `llm timing` 那行必须带 `msgw=`（否则账只在内存里、真机看不到 ✗）", () => {
    /**
     * ⚠️ 先剥注释 ✓（本仓库的注释里逐字引用被修掉的写法 ✗ —— 这条规矩吃过四次亏 ✓）。
     */
    const src = stripComments(readFileSync(join(process.cwd(), "src", "core", "llm", "agentic-loop.ts"), "utf8"));
    expect(src, "llm timing 行要带上这笔账").toContain("msgw=");
    expect(src, "账要从 message.ts 取（不许另记一份 ✗）").toContain("takeMessageWriteStats");
  });
});
