/**
 * 测试：新增设置键不冲突 — SKEY-001 ~ SKEY-015
 *
 * 验证 codem-custom-agents、codem-heartbeat-config、codem-retry-config 等新键
 * 不与现有设置键冲突。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import {
  getSetting,
  setSetting,
  removeSetting,
  getSettingJSON,
  setSettingJSON,
} from "../core/storage/settings";

describe("新增设置键不冲突", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
  });

  // ===== SKEY-001 ~ SKEY-006: 默认值与独立性 =====
  it("SKEY-001: codem-custom-agents 不影响 codem-settings", () => {
    setSettingJSON("codem-settings", { mode: "api", model: "gpt-4o" });
    setSettingJSON("codem-custom-agents", [{ id: "test" }]);
    const settings = getSettingJSON("codem-settings", null);
    expect((settings as any).mode).toBe("api");
    expect((settings as any).model).toBe("gpt-4o");
  });

  it("SKEY-002: codem-heartbeat-config 不影响 codem-settings", () => {
    setSettingJSON("codem-settings", { mode: "cli" });
    setSettingJSON("codem-heartbeat-config", { interval: 10000 });
    const settings = getSettingJSON("codem-settings", null);
    expect((settings as any).mode).toBe("cli");
  });

  it("SKEY-003: codem-retry-config 不影响 codem-context-config", () => {
    setSettingJSON("codem-context-config", { maxContextWindow: 128000 });
    setSettingJSON("codem-retry-config", { maxAttempts: 5 });
    const ctxConfig = getSettingJSON("codem-context-config", null);
    expect((ctxConfig as any).maxContextWindow).toBe(128000);
  });

  it("SKEY-004: codem-custom-agents 默认值为空数组", () => {
    const val = getSettingJSON("codem-custom-agents", []);
    expect(Array.isArray(val)).toBe(true);
    expect(val).toHaveLength(0);
  });

  it("SKEY-005: codem-heartbeat-config 默认值为 null", () => {
    const val = getSettingJSON("codem-heartbeat-config", null);
    expect(val).toBeNull();
  });

  it("SKEY-006: codem-retry-config 默认值为 null", () => {
    const val = getSettingJSON("codem-retry-config", null);
    expect(val).toBeNull();
  });

  // ===== SKEY-007 ~ SKEY-008: 批量操作与交叉读写 =====
  it("SKEY-007: 批量写入 5 个新键不损坏 DB", () => {
    setSettingJSON("codem-custom-agents", [{ id: "a" }]);
    setSettingJSON("codem-heartbeat-config", { interval: 5000 });
    setSettingJSON("codem-retry-config", { maxAttempts: 3 });
    setSettingJSON("codem-cost-limits", { perSession: 1.0 });
    setSettingJSON("codem-context-config", { compactionThreshold: 0.7 });

    expect(getSettingJSON("codem-custom-agents", [])).toHaveLength(1);
    expect((getSettingJSON("codem-heartbeat-config", null) as any).interval).toBe(5000);
    expect((getSettingJSON("codem-retry-config", null) as any).maxAttempts).toBe(3);
    expect((getSettingJSON("codem-cost-limits", null) as any).perSession).toBe(1.0);
    expect((getSettingJSON("codem-context-config", null) as any).compactionThreshold).toBe(0.7);
  });

  it("SKEY-008: codem-settings 保存后新键仍存在", () => {
    setSettingJSON("codem-custom-agents", [{ id: "test" }]);
    setSettingJSON("codem-settings", { mode: "api", model: "gpt-4o" });
    expect(getSettingJSON("codem-custom-agents", [])).toHaveLength(1);
  });

  // ===== SKEY-009: removeSetting 隔离 =====
  it("SKEY-009: removeSetting 不影响其他键", () => {
    setSettingJSON("codem-custom-agents", [{ id: "a" }]);
    setSettingJSON("codem-heartbeat-config", { interval: 5000 });
    removeSetting("codem-custom-agents");
    expect(getSettingJSON("codem-custom-agents", null)).toBeNull();
    expect(getSettingJSON("codem-heartbeat-config", null)).toBeTruthy();
  });

  // ===== SKEY-010 ~ SKEY-015: 与现有键的隔离 =====
  it("SKEY-010: codem-retry-config 与 codem-git-config 不冲突", () => {
    setSettingJSON("codem-git-config", { branchPrefix: "feature/" });
    setSettingJSON("codem-retry-config", { maxAttempts: 5 });
    expect((getSettingJSON("codem-git-config", null) as any).branchPrefix).toBe("feature/");
    expect((getSettingJSON("codem-retry-config", null) as any).maxAttempts).toBe(5);
  });

  it("SKEY-011: codem-heartbeat-config 与 codem-env-config 不冲突", () => {
    setSettingJSON("codem-env-config", { setupScript: "install.sh" });
    setSettingJSON("codem-heartbeat-config", { interval: 5000 });
    expect((getSettingJSON("codem-env-config", null) as any).setupScript).toBe("install.sh");
    expect((getSettingJSON("codem-heartbeat-config", null) as any).interval).toBe(5000);
  });

  it("SKEY-012: codem-retry-config 与 codem-cost-limits 不冲突", () => {
    setSettingJSON("codem-cost-limits", { perSession: 2.0, perDay: 10.0 });
    setSettingJSON("codem-retry-config", { baseDelay: 1000 });
    expect((getSettingJSON("codem-cost-limits", null) as any).perSession).toBe(2.0);
    expect((getSettingJSON("codem-retry-config", null) as any).baseDelay).toBe(1000);
  });

  it("SKEY-013: codem-custom-agents 与 codem-disabled-tools 不冲突", () => {
    setSettingJSON("codem-disabled-tools", ["bash", "write"]);
    setSettingJSON("codem-custom-agents", [{ id: "x" }]);
    expect(getSettingJSON("codem-disabled-tools", [])).toHaveLength(2);
    expect(getSettingJSON("codem-custom-agents", [])).toHaveLength(1);
  });

  it("SKEY-014: codem-heartbeat-config 与 codem-notebook-config 不冲突", () => {
    setSettingJSON("codem-notebook-config", { maxChunkSize: 2000 });
    setSettingJSON("codem-heartbeat-config", { maxFailures: 5 });
    expect((getSettingJSON("codem-notebook-config", null) as any).maxChunkSize).toBe(2000);
    expect((getSettingJSON("codem-heartbeat-config", null) as any).maxFailures).toBe(5);
  });

  it("SKEY-015: codem-retry-config 与 codem-model-profiles 不冲突", () => {
    setSettingJSON("codem-model-profiles", { profiles: [], activeProfileId: "default" });
    setSettingJSON("codem-retry-config", { backoffMultiplier: 3 });
    expect((getSettingJSON("codem-model-profiles", null) as any).activeProfileId).toBe("default");
    expect((getSettingJSON("codem-retry-config", null) as any).backoffMultiplier).toBe(3);
  });
});
