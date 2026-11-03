/**
 * 测试：桌面引擎桥纯逻辑（AA 远程用）
 *
 * 覆盖：
 *   - RE-001: parseRemotePath 路由解析（不再有 events/presence）
 *   - RE-002: cleanContent 去 system-reminder
 *   - RE-003: mapMessages 视图映射（role 归并 + 清理）
 *   - RE-004: flattenSessions 真实拍平倒序
 *   - RE-005: 工具/正文上限常量存在且为有限值
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseRemotePath,
  cleanContent,
  mapMessages,
  flattenSessions,
  REMOTE_TOOL_BRIEF_MAX_CHARS,
  REMOTE_TOOL_CALLS_MAX,
  REMOTE_CONTENT_MAX_CHARS,
} from "../core/remote/desktop-engine";

import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";

describe("桌面引擎桥 — 纯逻辑", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("RE-001: parseRemotePath 路由解析", () => {
    expect(parseRemotePath("/api/status")).toEqual({ type: "status" });
    expect(parseRemotePath("/api/sessions")).toEqual({ type: "sessions" });
    expect(parseRemotePath("/api/chat")).toEqual({ type: "chat" });
    expect(parseRemotePath("/api/chat/new")).toEqual({ type: "chat_new" });
    expect(parseRemotePath("/api/chat/cancel")).toEqual({ type: "chat_cancel" });
    expect(parseRemotePath("/api/approvals")).toEqual({ type: "approvals" });
    expect(parseRemotePath("/api/approvals/perm-1")).toEqual({
      type: "approval_answer",
      requestId: "perm-1",
    });
    expect(parseRemotePath("/api/notices")).toEqual({ type: "notices" });
    expect(parseRemotePath("/api/catalog")).toEqual({ type: "catalog" });
    expect(parseRemotePath("/api/selections")).toEqual({ type: "selections" });
    expect(parseRemotePath("/api/sessions/wx-a%40b/messages")).toEqual({
      type: "messages",
      sessionId: "wx-a%40b",
    });
    expect(parseRemotePath("/api/sessions/s1/run")).toEqual({ type: "run", sessionId: "s1" });
    // 旧 LAN 页面/配对/事件流路由必须不再存在
    expect(parseRemotePath("/api/events")).toBeNull();
    expect(parseRemotePath("/api/presence")).toBeNull();
    expect(parseRemotePath("/api/nope")).toBeNull();
    expect(parseRemotePath("/")).toBeNull();
    expect(parseRemotePath("/pair")).toBeNull();
  });

  it("RE-002: cleanContent 去 system-reminder", () => {
    expect(cleanContent('a<system-reminder>secret</system-reminder>b')).toBe("ab");
    expect(cleanContent("  你好  ")).toBe("你好");
  });

  it("RE-003: mapMessages 视图映射", () => {
    const msgs: any[] = [
      { id: "m1", role: "user", content: "hi", timestamp: 1 },
      { id: "m2", role: "assistant", content: 'ok<system-reminder>x</system-reminder>', timestamp: 2 },
      { id: "m3", role: "tool", content: "ignored role", timestamp: 3 },
    ];
    const view = mapMessages(msgs);
    expect(view).toHaveLength(3);
    expect(view[0].role).toBe("user");
    expect(view[1].content).toBe("ok");
    // 非 user/assistant/system 归并为 assistant（防远端渲染异常）
    expect(view[2].role).toBe("assistant");
    expect(view[2].timestamp).toBe(3);
  });

  it("RE-004: flattenSessions 真实拍平倒序", () => {
    const now = Date.now();
    ProjectStorage.createProject({ id: "p1", name: "甲", path: "C:/p1", createdAt: now, lastAccessedAt: now });
    ProjectStorage.createProject({ id: "p2", name: "乙", path: "C:/p2", createdAt: now, lastAccessedAt: now });
    SessionStorage.createSession({ id: "s1", projectId: "p1", title: "旧", createdAt: now, lastMessageAt: now - 1000, messageCount: 1 });
    SessionStorage.createSession({ id: "s2", projectId: "p1", title: "新", createdAt: now, lastMessageAt: now, messageCount: 5 });
    SessionStorage.createSession({ id: "s3", projectId: "p2", title: "另", createdAt: now, lastMessageAt: now - 500, messageCount: 0 });
    const list = flattenSessions();
    // 倒序：s2 最新在前
    expect(list[0].id).toBe("s2");
    expect(list[0].projectName).toBe("甲");
    expect(list.some((s) => s.id === "s3" && s.projectName === "乙")).toBe(true);
    const sorted = list.every((s, i) => i === 0 || list[i - 1].updatedAt >= s.updatedAt);
    expect(sorted).toBe(true);
  });

  it("RE-005: 工具/正文上限是有限值", () => {
    expect(REMOTE_TOOL_BRIEF_MAX_CHARS).toBeGreaterThan(0);
    expect(REMOTE_TOOL_CALLS_MAX).toBeGreaterThan(0);
    expect(REMOTE_CONTENT_MAX_CHARS).toBeGreaterThan(0);
  });
});
