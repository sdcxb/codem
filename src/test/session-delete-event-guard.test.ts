/**
 * 删除会话后的迟到事件必须被墓碑短路。
 *
 * 真机形态：删除运行中的会话时，agent loop / 工具回调还会 append 一条
 * tool_result/status 事件；行已删 ⇒ `session_events` 外键失败，界面弹
 * “操作没有生效（storage.bootstrap.events.append）：FOREIGN KEY constraint failed”。
 *
 * 判据不依赖端口：墓碑命中时 append 必须在**触达任何端口之前**返回 seq=0。
 */
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../core/storage/event-log";
import { clearSessionDeleted, markSessionDeleted } from "../core/storage/session-tombstones";

const SID = "deleted-session-event-guard";

afterEach(() => clearSessionDeleted(SID));

describe("DELETED-EVENT-GUARD", () => {
  it("DEL-1：墓碑命中时 append 返回 seq=0，不写 session_events", () => {
    markSessionDeleted(SID);
    const log = EventLog.getInstance();
    const ev = log.append(SID, "tool_result", { tool: "bash", output: "late" });
    expect(ev.seq).toBe(0);
    expect(ev.sessionId).toBe(SID);
  });

  it("DEL-2：墓碑命中时 appendBatch 整批返回 seq=0", () => {
    markSessionDeleted(SID);
    const log = EventLog.getInstance();
    const events = log.appendBatch(SID, [
      { type: "tool_result", payload: { n: 1 } },
      { type: "status", payload: { n: 2 } },
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 0]);
  });
});
