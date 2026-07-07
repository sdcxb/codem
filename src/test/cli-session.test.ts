/**
 * 测试 5：CLI Session 映射 — codem-cli-session-* key
 *
 * 改动影响：
 *   - App.tsx 中 getCliSessionKey 返回 "codem-cli-session-{projectId}-{sessionId}"
 *   - loadCliSessionId/saveCliSessionId 使用 SQLite getSetting/setSetting
 *   - 原来用 localStorage，现在用 SQLite
 *   - 如果 key 格式错误或存储失败，CLI 模式的 WebSocket 会话映射会丢失
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { getSetting, setSetting } from "../core/storage/settings";

// 模拟 App.tsx 中的函数
function getCliSessionKey(projectId: string, sessionId: string) {
  return `codem-cli-session-${projectId}-${sessionId}`;
}

function loadCliSessionId(projectId: string, sessionId: string): string | null {
  try {
    return getSetting(getCliSessionKey(projectId, sessionId));
  } catch {
    return null;
  }
}

function saveCliSessionId(projectId: string, sessionId: string, mimoSessionId: string) {
  try {
    setSetting(getCliSessionKey(projectId, sessionId), mimoSessionId);
  } catch {}
}

describe("CLI Session 映射 — codem-cli-session-*", () => {
  beforeEach(async () => {
    await initDatabase();
  });

  it("getCliSessionKey 返回正确格式", () => {
    const key = getCliSessionKey("proj-1", "sess-1");
    expect(key).toBe("codem-cli-session-proj-1-sess-1");
  });

  it("saveCliSessionId → loadCliSessionId 往返", () => {
    saveCliSessionId("proj-1", "sess-1", "ws-session-abc");
    const loaded = loadCliSessionId("proj-1", "sess-1");
    expect(loaded).toBe("ws-session-abc");
  });

  it("loadCliSessionId 返回 null 当 key 不存在", () => {
    expect(loadCliSessionId("proj-nonexist", "sess-nonexist")).toBeNull();
  });

  it("不同 project/session 对应不同 key", () => {
    saveCliSessionId("proj-1", "sess-1", "id-1");
    saveCliSessionId("proj-1", "sess-2", "id-2");
    saveCliSessionId("proj-2", "sess-1", "id-3");

    expect(loadCliSessionId("proj-1", "sess-1")).toBe("id-1");
    expect(loadCliSessionId("proj-1", "sess-2")).toBe("id-2");
    expect(loadCliSessionId("proj-2", "sess-1")).toBe("id-3");
  });

  it("覆盖写入同一个 key", () => {
    saveCliSessionId("proj-1", "sess-1", "old-id");
    saveCliSessionId("proj-1", "sess-1", "new-id");
    expect(loadCliSessionId("proj-1", "sess-1")).toBe("new-id");
  });

  it("key 不包含旧前缀 mimo-", () => {
    const key = getCliSessionKey("proj", "sess");
    expect(key.startsWith("mimo-")).toBe(false);
    expect(key.startsWith("codem-")).toBe(true);
  });

  it("保存的数据在 SQLite settings 表中可查到", () => {
    saveCliSessionId("proj-x", "sess-y", "test-id");
    const raw = getSetting("codem-cli-session-proj-x-sess-y");
    expect(raw).toBe("test-id");
  });
});
