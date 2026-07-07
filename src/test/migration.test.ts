/**
 * 测试 2：Migration 自动迁移 — 旧 mimo-* key → 新 codem-* key
 *
 * 改动影响：
 *   - migration.ts 新增了 migrateSettingsKeys() 和 migrateFromLocalStorageToSettings()
 *   - 如果迁移逻辑有误，已有用户的旧设置数据会丢失
 *   - 需要验证：SQLite 内部 key 迁移 + localStorage → SQLite 迁移
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, getDatabase } from "../core/storage/database";
import { getSetting, setSetting, getSettingJSON } from "../core/storage/settings";
import { migrateFromLocalStorage } from "../core/storage/migration";

describe("Migration — 旧 mimo-* key 自动迁移到 codem-* key", () => {
  beforeEach(async () => {
    await initDatabase();
    localStorage.clear();
  });

  it("SQLite 内部：mimo-settings → codem-settings", async () => {
    // 模拟旧数据存在于 SQLite settings 表
    setSetting("mimo-settings", JSON.stringify({ mode: "cli", model: "mimo-v2.5-pro" }));

    // 执行迁移
    await migrateFromLocalStorage();

    // 旧 key 应被删除
    expect(getSetting("mimo-settings")).toBeNull();
    // 新 key 应有数据
    const loaded = getSettingJSON<any>("codem-settings", null);
    expect(loaded).not.toBeNull();
    expect(loaded.mode).toBe("cli");
    expect(loaded.model).toBe("mimo-v2.5-pro");
  });

  it("SQLite 内部：mimo-app-identity → codem-app-identity", async () => {
    setSetting("mimo-app-identity", JSON.stringify({ name: "Codem", onboarded: true }));

    await migrateFromLocalStorage();

    expect(getSetting("mimo-app-identity")).toBeNull();
    const loaded = getSettingJSON<any>("codem-app-identity", null);
    expect(loaded.name).toBe("Codem");
    expect(loaded.onboarded).toBe(true);
  });

  it("SQLite 内部：mimo-user → codem-user", async () => {
    setSetting("mimo-user", JSON.stringify({ name: "张三", timezone: "Asia/Shanghai" }));

    await migrateFromLocalStorage();

    expect(getSetting("mimo-user")).toBeNull();
    const loaded = getSettingJSON<any>("codem-user", null);
    expect(loaded.name).toBe("张三");
  });

  it("SQLite 内部：mimo-identity → codem-identity", async () => {
    setSetting("mimo-identity", JSON.stringify({ name: "Codem", emoji: "⚡" }));

    await migrateFromLocalStorage();

    expect(getSetting("mimo-identity")).toBeNull();
    const loaded = getSettingJSON<any>("codem-identity", null);
    expect(loaded.name).toBe("Codem");
  });

  it("SQLite 内部：mimo-mcp-servers → codem-mcp-servers", async () => {
    setSetting("mimo-mcp-servers", JSON.stringify([{ id: "srv1", name: "Test" }]));

    await migrateFromLocalStorage();

    expect(getSetting("mimo-mcp-servers")).toBeNull();
    const loaded = getSettingJSON<any>("codem-mcp-servers", []);
    expect(loaded).toHaveLength(1);
  });

  it("SQLite 内部：mimo-cost-tracker → codem-cost-tracker", async () => {
    setSetting("mimo-cost-tracker", JSON.stringify({ totalCost: 5.67 }));

    await migrateFromLocalStorage();

    expect(getSetting("mimo-cost-tracker")).toBeNull();
    const loaded = getSettingJSON<any>("codem-cost-tracker", null);
    expect(loaded.totalCost).toBe(5.67);
  });

  it("不覆盖已有新 key 数据", async () => {
    // 先在新 key 中写入数据
    setSetting("codem-settings", JSON.stringify({ mode: "api", model: "gpt-4o" }));
    // 旧 key 也有数据
    setSetting("mimo-settings", JSON.stringify({ mode: "cli", model: "mimo-v2.5-pro" }));

    await migrateFromLocalStorage();

    // 新 key 数据应保持不变（不被旧数据覆盖）
    const loaded = getSettingJSON<any>("codem-settings", null);
    expect(loaded.mode).toBe("api");
    expect(loaded.model).toBe("gpt-4o");
  });

  it("localStorage → SQLite：mimo-settings 迁移", async () => {
    const oldSettings = { mode: "cli", model: "mimo-v2.5-pro" };
    localStorage.setItem("mimo-settings", JSON.stringify(oldSettings));

    await migrateFromLocalStorage();

    // localStorage 应被清除
    expect(localStorage.getItem("mimo-settings")).toBeNull();
    // SQLite 应有数据
    const loaded = getSettingJSON<any>("codem-settings", null);
    expect(loaded).not.toBeNull();
    expect(loaded.mode).toBe("cli");
  });

  it("localStorage → SQLite：mimo-theme 迁移", async () => {
    localStorage.setItem("mimo-theme", "light");

    await migrateFromLocalStorage();

    expect(localStorage.getItem("mimo-theme")).toBeNull();
    expect(getSetting("codem-theme")).toBe("light");
  });

  it("localStorage → SQLite：mimo-identity 迁移", async () => {
    const identity = { name: "Codem", emoji: "⚡" };
    localStorage.setItem("mimo-identity", JSON.stringify(identity));

    await migrateFromLocalStorage();

    expect(localStorage.getItem("mimo-identity")).toBeNull();
    const loaded = getSettingJSON<any>("codem-identity", null);
    expect(loaded.name).toBe("Codem");
  });

  it("localStorage → SQLite：mimo-user 迁移", async () => {
    const user = { name: "张三", timezone: "Asia/Shanghai" };
    localStorage.setItem("mimo-user", JSON.stringify(user));

    await migrateFromLocalStorage();

    expect(localStorage.getItem("mimo-user")).toBeNull();
    const loaded = getSettingJSON<any>("codem-user", null);
    expect(loaded.name).toBe("张三");
  });

  it("localStorage → SQLite：mimo-cli-session-* 迁移", async () => {
    localStorage.setItem("mimo-cli-session-proj1-sess1", "session-abc-123");

    await migrateFromLocalStorage();

    expect(localStorage.getItem("mimo-cli-session-proj1-sess1")).toBeNull();
    expect(getSetting("codem-cli-session-proj1-sess1")).toBe("session-abc-123");
  });

  it("localStorage → SQLite：多个 mimo-cli-session-* 同时迁移", async () => {
    localStorage.setItem("mimo-cli-session-proj1-sess1", "id-1");
    localStorage.setItem("mimo-cli-session-proj1-sess2", "id-2");
    localStorage.setItem("mimo-cli-session-proj2-sess3", "id-3");

    await migrateFromLocalStorage();

    expect(getSetting("codem-cli-session-proj1-sess1")).toBe("id-1");
    expect(getSetting("codem-cli-session-proj1-sess2")).toBe("id-2");
    expect(getSetting("codem-cli-session-proj2-sess3")).toBe("id-3");
    // localStorage 中的旧 key 应被清除
    expect(localStorage.getItem("mimo-cli-session-proj1-sess1")).toBeNull();
    expect(localStorage.getItem("mimo-cli-session-proj1-sess2")).toBeNull();
    expect(localStorage.getItem("mimo-cli-session-proj2-sess3")).toBeNull();
  });

  it("无旧数据时迁移不报错", async () => {
    // 不设置任何旧数据
    await migrateFromLocalStorage();

    expect(getSetting("codem-settings")).toBeNull();
    expect(getSetting("codem-theme")).toBeNull();
  });
});
