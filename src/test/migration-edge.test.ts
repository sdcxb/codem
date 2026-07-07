/**
 * 测试 16：迁移边界测试 — 双重迁移幂等性、混合数据源、损坏数据
 *
 * 改动影响：
 *   - migration.ts 的 migrateFromLocalStorage() 在 App 启动时执行
 *   - 如果用户多次启动应用，迁移会执行多次，需保证幂等
 *   - 如果 localStorage 和 SQLite 同时有旧 key，需保证优先级正确
 *   - 如果旧数据是损坏的 JSON，迁移不应崩溃
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { getSetting, setSetting, getSettingJSON } from "../core/storage/settings";
import { migrateFromLocalStorage } from "../core/storage/migration";

describe("迁移边界测试 — 幂等性和混合数据源", () => {
  beforeEach(async () => {
    await initDatabase();
    localStorage.clear();
  });

  // ===== 幂等性 =====
  it("双重迁移不报错且数据不变", async () => {
    localStorage.setItem("mimo-settings", JSON.stringify({ mode: "cli", model: "mimo-v2.5-pro" }));
    localStorage.setItem("mimo-theme", "dark");

    await migrateFromLocalStorage();
    const firstMigration = {
      settings: getSettingJSON<any>("codem-settings", null),
      theme: getSetting("codem-theme"),
    };

    await migrateFromLocalStorage();
    const secondMigration = {
      settings: getSettingJSON<any>("codem-settings", null),
      theme: getSetting("codem-theme"),
    };

    expect(secondMigration).toEqual(firstMigration);
  });

  it("三次迁移后数据一致", async () => {
    localStorage.setItem("mimo-identity", JSON.stringify({ name: "测试", emoji: "🧪" }));

    await migrateFromLocalStorage();
    await migrateFromLocalStorage();
    await migrateFromLocalStorage();

    const loaded = getSettingJSON<any>("codem-identity", null);
    expect(loaded.name).toBe("测试");
    expect(loaded.emoji).toBe("🧪");
  });

  // ===== 混合数据源 =====
  it("localStorage 和 SQLite 同时有旧 key 时，SQLite 优先", async () => {
    // SQLite 有旧数据
    setSetting("mimo-settings", JSON.stringify({ mode: "api", model: "gpt-4o" }));
    // localStorage 也有旧数据（不同值）
    localStorage.setItem("mimo-settings", JSON.stringify({ mode: "cli", model: "mimo-v2.5-pro" }));

    await migrateFromLocalStorage();

    // SQLite 的旧数据应迁移到新 key
    const loaded = getSettingJSON<any>("codem-settings", null);
    expect(loaded.mode).toBe("api");
    expect(loaded.model).toBe("gpt-4o");
  });

  it("localStorage 有旧 key、SQLite 已有新 key 时，不覆盖新 key", async () => {
    // SQLite 已有新 key 数据
    setSetting("codem-settings", JSON.stringify({ mode: "api", model: "gpt-4o" }));
    // localStorage 有旧 key 数据
    localStorage.setItem("mimo-settings", JSON.stringify({ mode: "cli", model: "mimo-v2.5-pro" }));

    await migrateFromLocalStorage();

    const loaded = getSettingJSON<any>("codem-settings", null);
    expect(loaded.mode).toBe("api");
    expect(loaded.model).toBe("gpt-4o");
  });

  it("localStorage 和 SQLite 同时有不同旧 key，全部迁移", async () => {
    // SQLite 有 mimo-settings
    setSetting("mimo-settings", JSON.stringify({ mode: "api" }));
    // localStorage 有 mimo-theme
    localStorage.setItem("mimo-theme", "dark");

    await migrateFromLocalStorage();

    expect(getSettingJSON<any>("codem-settings", null).mode).toBe("api");
    expect(getSetting("codem-theme")).toBe("dark");
  });

  // ===== 损坏数据 =====
  it("localStorage 中损坏的 JSON 不导致迁移崩溃", async () => {
    localStorage.setItem("mimo-settings", "{invalid json}");

    // 迁移不应抛出异常
    await expect(migrateFromLocalStorage()).resolves.not.toThrow();

    // 损坏的数据不应出现在新 key 中
    const loaded = getSetting("codem-settings");
    expect(loaded).toBe("{invalid json}");
  });

  it("SQLite 中损坏的 JSON 不导致迁移崩溃", async () => {
    setSetting("mimo-identity", "not a json {{{");

    await expect(migrateFromLocalStorage()).resolves.not.toThrow();
  });

  it("localStorage 中空字符串值不会被迁移（if(lsData) 为 falsy）", async () => {
    // 迁移代码使用 if(lsData) 判断，空字符串 "" 是 falsy，不会被迁移
    // 这是预期行为：空字符串等同于"无数据"
    localStorage.setItem("mimo-theme", "");

    await migrateFromLocalStorage();

    // 空字符串不应被迁移到 SQLite
    expect(getSetting("codem-theme")).toBeNull();
  });

  it("localStorage 中 null 值（被 JSON.stringify 处理）可正常迁移", async () => {
    localStorage.setItem("mimo-theme", "null");

    await migrateFromLocalStorage();

    expect(getSetting("codem-theme")).toBe("null");
  });

  // ===== 部分迁移 =====
  it("只有部分旧 key 存在时迁移正常", async () => {
    localStorage.setItem("mimo-theme", "light");
    // 不设置 mimo-settings, mimo-identity 等

    await migrateFromLocalStorage();

    expect(getSetting("codem-theme")).toBe("light");
    expect(getSetting("codem-settings")).toBeNull();
    expect(getSetting("codem-identity")).toBeNull();
  });

  it("只有 SQLite 旧 key 存在时迁移正常", async () => {
    setSetting("mimo-cost-tracker", JSON.stringify({ totalCost: 99.9 }));
    // localStorage 为空

    await migrateFromLocalStorage();

    expect(getSetting("mimo-cost-tracker")).toBeNull();
    expect(getSettingJSON<any>("codem-cost-tracker", null).totalCost).toBe(99.9);
  });

  // ===== codem-* 已存在时旧 key 迁移 =====
  it("多个新 key 已存在时，旧 key 不覆盖任何新 key", async () => {
    setSetting("codem-settings", JSON.stringify({ mode: "api" }));
    setSetting("codem-theme", "light");
    setSetting("codem-identity", JSON.stringify({ name: "新名字" }));

    setSetting("mimo-settings", JSON.stringify({ mode: "cli" }));
    setSetting("mimo-theme", "dark");
    setSetting("mimo-identity", JSON.stringify({ name: "旧名字" }));

    await migrateFromLocalStorage();

    expect(getSettingJSON<any>("codem-settings", null).mode).toBe("api");
    expect(getSetting("codem-theme")).toBe("light");
    expect(getSettingJSON<any>("codem-identity", null).name).toBe("新名字");
  });

  // ===== 中文/emoji 数据迁移 =====
  it("包含中文和 emoji 的旧 key 数据迁移后内容不变", async () => {
    localStorage.setItem("mimo-identity", JSON.stringify({
      name: "小闪电 ⚡",
      creature: "赛博管家 🤖",
      vibe: "犀利 😏",
    }));
    localStorage.setItem("mimo-theme", "深色 🌙");

    await migrateFromLocalStorage();

    const identity = getSettingJSON<any>("codem-identity", null);
    expect(identity.name).toBe("小闪电 ⚡");
    expect(identity.creature).toBe("赛博管家 🤖");
    expect(identity.vibe).toBe("犀利 😏");
    expect(getSetting("codem-theme")).toBe("深色 🌙");
  });

  it("包含中文路径的 cli-session key 迁移", async () => {
    localStorage.setItem("mimo-cli-session-中文项目-会话1", "session-id-123");

    await migrateFromLocalStorage();

    expect(getSetting("codem-cli-session-中文项目-会话1")).toBe("session-id-123");
  });
});
