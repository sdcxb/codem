/**
 * EVENT-ARCHIVE：事件保留的 TS 半边（先归档、再让引擎按 keep_types 删除）。
 *
 * 钉住：
 * 1. 归档循环按批调用 `events.archive_before`，keep_types 必须原样传给引擎；
 * 2. 每批先写归档文件（appendFile），再进入下一批；
 * 3. 关闭开关 / 24h 节流时不跑；
 * 4. 引擎没有 `data.command` 时跳过（测试双/旧端口），不抛。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: Array<{ cmd: string; params: any }> = [];
  const batches: any[] = [];
  const settings = new Map<string, any>();
  const state = {
    hasPort: true,
    command: true,
    rows: [] as any[],
    queryItems: [{ id: "s1" }],
  };
  const data = {
    async command(cmd: string, params: any) {
      calls.push({ cmd, params });
      return batches.shift() ?? { removed: 0, rows: [] };
    },
    async query(cmd: string, params: any) {
      calls.push({ cmd, params });
      return { items: state.queryItems };
    },
  };
  return { calls, batches, settings, state, data };
});

vi.mock("../core/storage/port", () => ({
  hasStoragePort: () => h.state.hasPort,
  getStoragePort: () => ({ data: h.state.command ? h.data : { query: h.data.query } }),
}));
vi.mock("../core/storage/settings", () => ({
  getSettingJSON: (key: string, fallback: any) => (h.settings.has(key) ? h.settings.get(key) : fallback),
  setSettingJSON: (key: string, value: any) => h.settings.set(key, value),
  // 这些是同一模块的其它导出（sandbox-acl 等经 settings 传递导入时会查 mock 面）
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
  removeSetting: vi.fn(),
}));
vi.mock("../core/storage/data-root", () => ({
  resolveDataRoot: async () => ({ root: "C:/tmp/root" }),
}));
vi.mock("../core/file-api", () => ({
  appendFile: vi.fn(async () => {}),
}));

import { appendFile } from "../core/file-api";
import {
  archiveSessionEventsBefore,
  runEventArchiveMaintenance,
  DEFAULT_EVENT_KEEP_TYPES,
} from "../core/storage/event-archive";

describe("EVENT-ARCHIVE：事件归档", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.batches.length = 0;
    h.settings.clear();
    h.state.hasPort = true;
    h.state.command = true;
    vi.mocked(appendFile).mockClear();
  });

  it("EA-1: 分批归档，keep_types 原样传给引擎，每批都写文件", async () => {
    h.batches.push(
      { removed: 2, rows: [{ seq: 1, type: "user_message", payload: "{}", timestamp: 1 }, { seq: 2, type: "assistant_text", payload: "{}", timestamp: 2 }] },
      { removed: 1, rows: [{ seq: 3, type: "assistant_reasoning", payload: "{}", timestamp: 3 }] },
      { removed: 0, rows: [] },
    );
    const n = await archiveSessionEventsBefore("s1", 1000);
    expect(n).toBe(3);
    const cmds = h.calls.filter((c) => c.cmd === "events.archive_before");
    expect(cmds).toHaveLength(3);
    expect(cmds[0].params.keep_types).toEqual([...DEFAULT_EVENT_KEEP_TYPES]);
    expect(cmds[0].params.before_ts).toBe(1000);
    expect(vi.mocked(appendFile)).toHaveBeenCalledTimes(2);
    const first = String(vi.mocked(appendFile).mock.calls[0][1]);
    expect(first).toContain('"type":"user_message"');
    expect(first.endsWith("\n")).toBe(true);
  });

  it("EA-2: 开关关闭 / 24h 内已跑过 → 跳过", async () => {
    h.settings.set("codem-event-retention", { enabled: false });
    expect((await runEventArchiveMaintenance(10_000)).skipped).toBe("disabled");

    h.settings.set("codem-event-retention", { enabled: true, days: 90 });
    h.settings.set("codem-event-archive-last-run", 9_000);
    const r = await runEventArchiveMaintenance(10_000);
    expect(r.skipped).toBe("throttled");
    expect(h.calls.length).toBe(0);
  });

  it("EA-3: 端口没有 command 能力 → 跳过而不是抛", async () => {
    h.state.command = false;
    const r = await runEventArchiveMaintenance(10_000, { force: true });
    expect(r.skipped).toBe("no-command");
  });
});
