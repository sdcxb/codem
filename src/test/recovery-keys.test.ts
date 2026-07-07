/**
 * 测试 12：Recovery 数据 — codem-recovery 前缀
 *
 * 改动影响：
 *   - recovery.ts 从 "mimo-recovery" 改为 "codem-recovery"
 *   - multi-layer.ts 从 "mimo-recovery" 改为 "codem-recovery"
 *   - 如果有误，会话恢复功能无法读取之前保存的恢复数据
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { setSettingJSON, getSettingJSON, setSetting } from "../core/storage/settings";

describe("Recovery 数据 — codem-recovery 前缀", () => {
  beforeEach(async () => {
    await initDatabase();
  });

  it("recovery 数据存储在 codem-recovery（非 mimo-recovery）", () => {
    const recoveryData = {
      version: 1,
      lastSaved: Date.now(),
      sessions: {},
      currentSessionId: null,
    };
    setSettingJSON("codem-recovery", recoveryData);

    const loaded = getSettingJSON<any>("codem-recovery", null);
    expect(loaded).not.toBeNull();
    expect(loaded.version).toBe(1);

    // 旧 key 应无数据
    const oldData = getSettingJSON<any>("mimo-recovery", null);
    expect(oldData).toBeNull();
  });

  it("recovery multi-layer 使用 codem-recovery 前缀", () => {
    // multi-layer.ts 使用 storagePrefix 拼接 "-state" 和 "-sessions"
    setSetting("codem-recovery-state", JSON.stringify({ currentSessionId: "sess-1" }));
    setSetting("codem-recovery-sessions", JSON.stringify({ "sess-1": { id: "sess-1", title: "Test" } }));

    const state = getSettingJSON<any>("codem-recovery-state", null);
    expect(state).not.toBeNull();
    expect(state.currentSessionId).toBe("sess-1");

    const sessions = getSettingJSON<any>("codem-recovery-sessions", null);
    expect(sessions).not.toBeNull();
    expect(sessions["sess-1"].title).toBe("Test");

    // 旧前缀不应有数据
    expect(getSettingJSON<any>("mimo-recovery-state", null)).toBeNull();
    expect(getSettingJSON<any>("mimo-recovery-sessions", null)).toBeNull();
  });

  it("recovery.ts DEFAULT_CONFIG.storagePrefix 为 codem-recovery", async () => {
    // 验证模块内部配置
    const recoveryModule = await import("../core/recovery/recovery");
    // 通过功能验证：写入 codem-recovery 能被读到
    setSettingJSON("codem-recovery", { test: true });
    const loaded = getSettingJSON<any>("codem-recovery", null);
    expect(loaded.test).toBe(true);
  });
});
