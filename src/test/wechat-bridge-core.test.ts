/**
 * 测试：@codem/wechat-bridge 核心（iLink 微信桥 — 引擎桥半层）
 *
 * 覆盖（纯逻辑，不触网/不驱动真实引擎）：
 *   - WB-001: peer → 会话 id 净化（DB/文件名安全）
 *   - WB-002: 命令解析（/help /new arg；未知 / 前缀当普通文本）
 *   - WB-003: classifyPeer（owner/白名单/黑名单/陌生）
 *   - WB-004: 白名单动作（批准/拉黑/待批准去重与上限）
 *   - WB-005: 回复截断（去 system-reminder + 上限）
 *   - WB-006: 设置/peer 映射存取（SQLite settings 表）
 *   - WB-007: 初始状态缓存 = disconnected
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  sanitizePeerId,
  parseCommand,
  truncateReply,
  classifyPeer,
  addPeerToAllow,
  blockPeer,
  pendPeer,
  getSettings,
  saveSettings,
  loadPeerMap,
  savePeerMap,
  loadAccess,
  saveAccess,
  getStateCache,
} from "../core/wechat-bridge/wechat-bridge";
import { initDatabase } from "../core/storage/database";

const OWNER = "wxid_abc@im.wechat";

function emptyAccess() {
  return { allow: [], block: [], pending: [] };
}

describe("wechat-bridge 核心 — 纯逻辑", () => {
  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("WB-001: sanitizePeerId 净化 + 长度上限", () => {
    expect(sanitizePeerId("foo@im.wechat")).toBe("foo-im-wechat");
    expect(sanitizePeerId("@abc def@im.wechat")).toBe("abc-def-im-wechat");
    expect(sanitizePeerId("@@@")).toBe("peer"); // 全符号 → 兜底
    const long = "a".repeat(120) + "@im.wechat";
    expect(sanitizePeerId(long).length).toBeLessThanOrEqual(72);
  });

  it("WB-002: parseCommand 命令识别", () => {
    expect(parseCommand("/help")).toEqual({ name: "help", arg: "" });
    expect(parseCommand("  /NEW   gpt-4o  ")).toEqual({ name: "new", arg: "gpt-4o" });
    expect(parseCommand("/status now")).toEqual({ name: "status", arg: "now" });
    // 未知 / 前缀 → 普通文本（agent 可自由对话）
    expect(parseCommand("/unknowncmd x")).toBeNull();
    // 普通文本
    expect(parseCommand("帮我看看代码")).toBeNull();
    expect(parseCommand("a/b 路径")).toBeNull();
  });

  it("WB-003: classifyPeer 权限分层（owner > blocked > allowed > unknown）", () => {
    const access = { allow: ["u1@im.wechat"], block: ["u2@im.wechat"], pending: [] };
    expect(classifyPeer(access, OWNER, OWNER)).toBe("owner");
    expect(classifyPeer(access, "u1@im.wechat", OWNER)).toBe("allowed");
    expect(classifyPeer(access, "u2@im.wechat", OWNER)).toBe("blocked");
    expect(classifyPeer(access, "u3@im.wechat", OWNER)).toBe("unknown");
    // 无 owner 信息时按白名单判定
    expect(classifyPeer(access, "u1@im.wechat", "")).toBe("allowed");
  });

  it("WB-004: 白名单动作（批准移除黑名单/待批准；拉黑反向；待批准去重+上限）", () => {
    let access = emptyAccess();
    access = pendPeer(access, "s1@im.wechat", "你好", 1);
    access = pendPeer(access, "s1@im.wechat", "你好2", 2); // 去重
    expect(access.pending).toHaveLength(1);

    access = blockPeer(access, "s1@im.wechat");
    expect(access.block).toContain("s1@im.wechat");
    expect(access.pending).toHaveLength(0);

    access = addPeerToAllow(access, "s1@im.wechat");
    expect(access.allow).toContain("s1@im.wechat");
    expect(access.block).not.toContain("s1@im.wechat");

    // 待批准上限 50
    let big = emptyAccess();
    for (let i = 0; i < 60; i++) big = pendPeer(big, `p${i}@im.wechat`, "x", i);
    expect(big.pending.length).toBeLessThanOrEqual(50);
  });

  it("WB-005: truncateReply 去 system-reminder + 上限", () => {
    const raw = 'ok<system-reminder>secret</system-reminder>done';
    expect(truncateReply(raw)).toBe("okdone");
    const long = "x".repeat(5000);
    const t = truncateReply(long);
    expect(t.length).toBeLessThanOrEqual(1900 + 30);
  });

  it("WB-006: 设置与 peer 映射经 SQLite 存取", () => {
    expect(getSettings()).toEqual({ enabled: true, model: "", workspacePath: "" });
    saveSettings({ model: "gpt-5", workspacePath: "D:/wx" });
    expect(getSettings()).toEqual({ enabled: true, model: "gpt-5", workspacePath: "D:/wx" });
    saveSettings({ enabled: false });
    expect(getSettings().enabled).toBe(false);

    savePeerMap({ "wxid_a@im.wechat": { sessionId: "wx-a", createdAt: 1 } });
    expect(loadPeerMap()["wxid_a@im.wechat"].sessionId).toBe("wx-a");

    saveAccess({ allow: ["x@im.wechat"], block: [], pending: [] });
    expect(loadAccess().allow).toContain("x@im.wechat");
  });

  it("WB-007: 初始状态缓存 = disconnected", () => {
    expect(getStateCache().state).toBe("disconnected");
    expect(getStateCache().peer_count).toBe(0);
  });
});
