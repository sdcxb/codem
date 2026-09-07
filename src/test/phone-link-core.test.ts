/**
 * 测试：@codem/phone-link 核心（①手机连接 — 引擎半层纯逻辑）
 *
 * 覆盖：
 *   - PL-001: parsePhonePath 路由解析
 *   - PL-002: cleanContent 去 system-reminder
 *   - PL-003: mapMessages 视图映射（role 归并 + 清理）
 *   - PL-004: flattenSessions 真实拍平倒序（DB 内存库）
 *   - PL-005: 设置默认值/持久化
 *   - PL-006: 状态缓存初始值
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  parsePhonePath,
  cleanContent,
  mapMessages,
  flattenSessions,
  getPhoneSettings,
  savePhoneSettings,
  getPhoneStateCache,
} from "../core/phone-link/phone-link";
import { initDatabase } from "../core/storage/database";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";

describe("phone-link 核心 — 纯逻辑", () => {
  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("PL-001: parsePhonePath 路由解析", () => {
    expect(parsePhonePath("/api/status")).toEqual({ type: "status" });
    expect(parsePhonePath("/api/sessions")).toEqual({ type: "sessions" });
    expect(parsePhonePath("/api/chat")).toEqual({ type: "chat" });
    expect(parsePhonePath("/api/chat/new")).toEqual({ type: "chat_new" });
    expect(parsePhonePath("/api/sessions/wx-a%40b/messages")).toEqual({
      type: "messages",
      sessionId: "wx-a%40b", // 原始 path（解码由 Rust 侧完成前）
    });
    expect(parsePhonePath("/api/nope")).toBeNull();
    expect(parsePhonePath("/")).toBeNull();
    expect(parsePhonePath("/pair")).toBeNull();
  });

  it("PL-002: cleanContent 去 system-reminder", () => {
    expect(cleanContent('a<system-reminder>secret</system-reminder>b')).toBe("ab");
    expect(cleanContent("  你好  ")).toBe("你好");
  });

  it("PL-003: mapMessages 视图映射", () => {
    const msgs: any[] = [
      { id: "m1", role: "user", content: "hi", timestamp: 1 },
      { id: "m2", role: "assistant", content: 'ok<system-reminder>x</system-reminder>', timestamp: 2 },
      { id: "m3", role: "tool", content: "ignored role", timestamp: 3 },
    ];
    const view = mapMessages(msgs);
    expect(view).toHaveLength(3);
    expect(view[0].role).toBe("user");
    expect(view[1].content).toBe("ok");
    // 非 user/assistant/system 归并为 assistant（防手机端渲染异常）
    expect(view[2].role).toBe("assistant");
    expect(view[2].timestamp).toBe(3);
  });

  it("PL-004: flattenSessions 真实拍平倒序", () => {
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

  it("PL-005: 设置默认 autoStart 与持久化", () => {
    expect(getPhoneSettings()).toEqual({ autoStart: true });
    savePhoneSettings({ autoStart: false });
    expect(getPhoneSettings().autoStart).toBe(false);
  });

  it("PL-006: 状态缓存初始值", () => {
    expect(getPhoneStateCache().running).toBe(false);
    expect(getPhoneStateCache().devices).toEqual([]);
  });
});
