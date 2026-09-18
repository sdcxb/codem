/**
 * 完整性检查的**节流策略**（第 51 轮：按实测定窗口，原来一条用例都没有）
 *
 * ## 为什么改
 *
 * 旧策略是"12 小时内不重复跑"，理由是注释里那句
 * "`quick_check` 真机实测：901 ms @10k 行 / 4,469 ms @100k 行，而维护是启动时 await 的一步，
 * 这一条直接加了 1–4.5 秒"。第 51 轮把两件事都核了：
 *
 * 1. **成本**（同 harness，`health` 作基线只算差值）：
 *    10,000 行 / 14.1 MB → **32 ms**；100,000 行 / 137.2 MB → **325 ms**；
 *    用户真实库 16.24 MB → **75–77 ms**。比注释里的小一个数量级。
 * 2. **"阻塞启动"不成立**：启动维护在 `App.tsx` 里是 `void (async …)` ——
 *    **后台任务**，首屏不等它。所以那次检查根本不延迟启动。
 *
 * 于是窗口按库大小分档：小/中库 **1 小时**（把发现延迟从 ≤12 小时压到 ≤1 小时），
 * 大库（≥ 256 MB，**没有实测数据**）保守保留 12 小时。
 *
 * ## 判据（每条都对应一种会被改坏的方式）
 *
 * | 情形 | 期望 |
 * | --- | --- |
 * | 小库 + 上次检查 2 小时前 | **要检查**（新窗口生效） |
 * | 小库 + 上次检查 30 分钟前 | 跳过（1 小时内不重复跑） |
 * | 大库 + 上次检查 2 小时前 | 跳过（大库仍走 12 小时，不许被这次改动顺手放宽） |
 * | 大库 + 上次检查 13 小时前 | 要检查 |
 * | 读不到库大小 | 按**小库**处理（读不到不该退化成"永远 12 小时"） |
 * | 时间戳读不到 | 要检查（"从没查过"不等于"刚查过"） |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const MB = 1024 * 1024;

let port: FakeStoragePort;

/**
 * 装一个能回答"库多大"和"上次什么时候查的"的假端口。
 *
 * `integrity_check` 走 `structuredCommand` → `data.command`，所以假端口必须有
 * `command` 能力，否则这条链路会走"没有该能力"的分支而测不到本轮的判据。
 */
async function installPort(opts: { sizeBytes: number | null; lastCheckMs: number | null }) {
  const seed: Record<string, Array<Record<string, unknown>>> = { settings: [] };
  if (opts.lastCheckMs !== null) {
    seed.settings.push({ key: "codem-storage-integrity-checked-at", value: String(opts.lastCheckMs) });
  }
  port = createFakeStoragePort({ seed });
  if (opts.sizeBytes !== null) {
    (port.engine as unknown as { health: () => Promise<unknown> }).health = async () => ({
      ready: true,
      engine: "rust",
      sizeBytes: opts.sizeBytes,
    });
  }
  (port.data as unknown as { command?: unknown }).command = async (cmd: string) => {
    if (cmd === "integrity_check") return { ok: true, detail: "ok" };
    return {};
  };
  await port.config.warmup();
  setStoragePort(port);
  return port;
}

/** 该次维护之后，marker 被写成了什么 */
function markerValue(): number | null {
  const row = port.__table("settings").find((r) => r.key === "codem-storage-integrity-checked-at");
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

const HOUR = 3600 * 1000;

beforeEach(() => {
  resetPersistFailures();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
});

describe("INTEG：完整性检查的节流窗口按库大小分档", () => {
  it("INTEG-1: 小库 + 上次 2 小时前 → **要检查**（1 小时窗口生效，旧策略会跳过）", async () => {
    const now = Date.now();
    await installPort({ sizeBytes: 16 * MB, lastCheckMs: now - 2 * HOUR });
    const { verifyIntegrityThrottled } = await import("../core/storage/maintenance");

    const res = await verifyIntegrityThrottled(now);

    expect(res.status, "2 小时前查过、库只有 16 MB → 该查了（旧策略要等 12 小时）").toBe("ok");
    expect(markerValue(), "查过之后必须更新时间戳").toBe(now);
  });

  it("INTEG-2: 小库 + 上次 30 分钟前 → 跳过（1 小时内不重复跑）", async () => {
    const now = Date.now();
    await installPort({ sizeBytes: 16 * MB, lastCheckMs: now - 0.5 * HOUR });
    const { verifyIntegrityThrottled } = await import("../core/storage/maintenance");

    const res = await verifyIntegrityThrottled(now);

    expect(res.status).toBe("skipped");
    expect(res.reason, "理由里要说清窗口与库大小，便于真机排查").toMatch(/小时/);
    expect(markerValue(), "跳过时不改动时间戳").toBe(now - 0.5 * HOUR);
  });

  it("INTEG-3: 大库（≥256 MB）+ 上次 2 小时前 → 跳过（不许被这次改动顺手放宽）", async () => {
    const now = Date.now();
    await installPort({ sizeBytes: 300 * MB, lastCheckMs: now - 2 * HOUR });
    const { verifyIntegrityThrottled } = await import("../core/storage/maintenance");

    const res = await verifyIntegrityThrottled(now);

    expect(
      res.status,
      "256 MB 以上没有实测数据 —— 保守沿用 12 小时，不许因为小库放宽就一起放宽",
    ).toBe("skipped");
    expect(res.reason, "跳过理由要能看出是「大库」这一档").toContain("300.0 MB");
  });

  it("INTEG-4: 大库 + 上次 13 小时前 → 要检查（大库窗口也会到期）", async () => {
    const now = Date.now();
    await installPort({ sizeBytes: 300 * MB, lastCheckMs: now - 13 * HOUR });
    const { verifyIntegrityThrottled } = await import("../core/storage/maintenance");

    const res = await verifyIntegrityThrottled(now);

    expect(res.status).toBe("ok");
    expect(markerValue()).toBe(now);
  });

  it("INTEG-5: 读不到库大小 → 按**小库**处理（不许退化成永远 12 小时）", async () => {
    const now = Date.now();
    await installPort({ sizeBytes: null, lastCheckMs: now - 2 * HOUR });
    const { verifyIntegrityThrottled } = await import("../core/storage/maintenance");

    const res = await verifyIntegrityThrottled(now);

    expect(
      res.status,
      "读不到大小就当成小库：实测最大量级也只有几百毫秒，且不阻塞首屏 —— 保守该保守在「别漏检」这边",
    ).toBe("ok");
  });

  it("INTEG-6: 时间戳读不到（从没查过）→ 要检查，且不把「读不到」当成「刚查过」", async () => {
    const now = Date.now();
    await installPort({ sizeBytes: 16 * MB, lastCheckMs: null });
    const { verifyIntegrityThrottled } = await import("../core/storage/maintenance");

    const res = await verifyIntegrityThrottled(now);

    expect(res.status, "从没查过 → 必须查").toBe("ok");
    expect(markerValue()).toBe(now);
  });

  it("INTEG-7: 检查失败 → 写重建标记 + 如实上报（这条链路是第 49 轮补的，不许回归）", async () => {
    const now = Date.now();
    await installPort({ sizeBytes: 16 * MB, lastCheckMs: now - 2 * HOUR });
    // 让引擎回"失败"
    (port.data as unknown as { command: unknown }).command = async (cmd: string) => {
      if (cmd === "integrity_check") return { ok: false, detail: "*** in database main *** page 1839 损坏" };
      return {};
    };
    // 标记文件走文件 IPC
    const files = new Map<string, string>();
    (globalThis as any).window = globalThis.window ?? ({} as any);
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "get_app_data_dir") return "C:/fake-appdata/";
          if (cmd === "write_file") {
            files.set(String(args?.path), String(args?.content ?? ""));
            return null;
          }
          if (cmd === "read_file") {
            const p = String(args?.path);
            if (!files.has(p)) throw new Error("not found");
            return files.get(p);
          }
          return null;
        },
      },
    };

    const { verifyIntegrityThrottled } = await import("../core/storage/maintenance");
    const res = await verifyIntegrityThrottled(now);

    expect(res.status).toBe("failed");
    expect(res.detail).toContain("1839");
    const marker = [...files.keys()].find((k) => k.includes("codem-index-rebuild-needed"));
    expect(marker, "失败必须写「索引需要重建」标记（否则没人会去重建）").toBeTruthy();
    expect(files.get(marker!)).toContain("完整性检查失败");
    delete (window as any).__TAURI__;
  });
});
