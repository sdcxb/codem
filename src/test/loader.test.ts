/**
 * 测试 10：loader.ts — codem-app-identity / codem-user key
 *
 * 改动影响：
 *   - loader.ts 中 loadAppIdentity() 从 "mimo-app-identity" 改为 "codem-app-identity"
 *   - loadUserConfig() 从 "mimo-user" 改为 "codem-user"
 *   - saveAppIdentity() 从 "mimo-app-identity" 改为 "codem-app-identity"
 *   - 如果有误，Bootstrap 向导完成后身份信息不持久化，下次启动仍需重新配置
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { setSettingJSON, getSettingJSON } from "../core/storage/settings";

describe("loader.ts — codem-app-identity / codem-user key", () => {
  beforeEach(async () => {
    await initDatabase();
  });

  it("loadAppIdentity 默认值", async () => {
    const { loadAppIdentity } = await import("../core/config/loader");
    const identity = loadAppIdentity();
    expect(identity.name).toBe("");
    expect(identity.onboarded).toBe(false);
  });

  it("saveAppIdentity → loadAppIdentity 往返", async () => {
    const { saveAppIdentity, loadAppIdentity } = await import("../core/config/loader");

    const identity = {
      name: "Codem",
      creature: "AI 助手",
      vibe: "靠谱",
      emoji: "⚡",
      avatar: "",
      onboarded: true,
    };
    saveAppIdentity(identity);

    const loaded = loadAppIdentity();
    expect(loaded.name).toBe("Codem");
    expect(loaded.onboarded).toBe(true);
    expect(loaded.emoji).toBe("⚡");
  });

  it("loadAppIdentity 从 codem-app-identity 读取（非 mimo-app-identity）", async () => {
    // 旧 key 不应被读取
    setSettingJSON("mimo-app-identity", { name: "OldName", onboarded: true });

    // 新 key
    setSettingJSON("codem-app-identity", { name: "NewName", onboarded: true });

    const { loadAppIdentity } = await import("../core/config/loader");
    const identity = loadAppIdentity();
    expect(identity.name).toBe("NewName");
  });

  it("loadUserConfig 从 codem-user 读取（非 mimo-user）", async () => {
    // 旧 key
    setSettingJSON("mimo-user", { name: "OldUser", timezone: "UTC" });

    // 新 key
    setSettingJSON("codem-user", { name: "NewUser", timezone: "Asia/Shanghai" });

    const { loadUserConfig } = await import("../core/config/loader");
    const user = loadUserConfig();
    expect(user?.name).toBe("NewUser");
    expect(user?.timezone).toBe("Asia/Shanghai");
  });

  it("loadUserConfig 返回 undefined 当 key 不存在", async () => {
    const { loadUserConfig } = await import("../core/config/loader");
    const user = loadUserConfig();
    expect(user).toBeUndefined();
  });
});
