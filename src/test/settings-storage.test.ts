/**
 * 测试 1：Settings 存储 — codem-* key 读写一致性
 *
 * 改动影响：
 *   - 所有 mimo-* SQLite settings key 改为 codem-*
 *   - 涉及 loader.ts, mcp.ts, cost-tracker.ts, SettingsPanel.tsx, App.tsx 等
 *   - 如果 key 不一致，设置保存后读取不到，导致配置丢失
 */
import { describe, it, expect } from "vitest";
import { getSetting, setSetting, getSettingJSON, setSettingJSON, removeSetting } from "../core/storage/settings";

describe("Settings 存储 — codem-* key 读写", () => {
  it("setSetting/getSetting 基本读写", () => {
    setSetting("codem-test-key", "hello");
    expect(getSetting("codem-test-key")).toBe("hello");
  });

  it("getSetting 返回 null 当 key 不存在", () => {
    expect(getSetting("codem-nonexistent")).toBeNull();
  });

  it("setSettingJSON/getSettingJSON 读写对象", () => {
    const data = { mode: "api", model: "gpt-4o", providers: [{ id: "openai", apiKey: "sk-xxx" }] };
    setSettingJSON("codem-settings", data);
    const result = getSettingJSON("codem-settings", null as any);
    expect(result).toEqual(data);
  });

  it("getSettingJSON 返回默认值当 key 不存在", () => {
    const def = { mode: "cli" };
    expect(getSettingJSON("codem-missing", def)).toEqual(def);
  });

  it("removeSetting 删除后 getSetting 返回 null", () => {
    setSetting("codem-temp", "value");
    removeSetting("codem-temp");
    expect(getSetting("codem-temp")).toBeNull();
  });

  it("setSetting 覆盖旧值", () => {
    setSetting("codem-overwrite", "old");
    setSetting("codem-overwrite", "new");
    expect(getSetting("codem-overwrite")).toBe("new");
  });

  // ===== 关键 key 验证 =====
  it("codem-settings key 可正确存储和读取完整设置对象", () => {
    const settings = {
      mode: "cli",
      mimoPath: "D:\\mimo\\mimo.exe",
      model: "mimo-v2.5-pro",
      theme: "dark",
      fontSize: 14,
      autoApprove: false,
      providers: [
        { id: "mimo", name: "MiMo", apiKey: "", baseUrl: "https://api.mimo.ai/v1" },
        { id: "openai", name: "OpenAI", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" },
      ],
    };
    setSettingJSON("codem-settings", settings);
    const loaded = getSettingJSON("codem-settings", null as any);
    expect(loaded).not.toBeNull();
    expect(loaded!.mode).toBe("cli");
    expect(loaded!.model).toBe("mimo-v2.5-pro");
    expect(loaded!.providers).toHaveLength(2);
    expect(loaded!.providers[1].apiKey).toBe("sk-test");
  });

  it("codem-theme key 可存储主题", () => {
    setSetting("codem-theme", "light");
    expect(getSetting("codem-theme")).toBe("light");
  });

  it("codem-identity key 可存储身份配置", () => {
    const identity = { name: "Codem", creature: "AI 助手", vibe: "靠谱", emoji: "⚡", avatar: "", raw: "" };
    setSettingJSON("codem-identity", identity);
    const loaded = getSettingJSON("codem-identity", null as any);
    expect(loaded!.name).toBe("Codem");
    expect(loaded!.emoji).toBe("⚡");
  });

  it("codem-user key 可存储用户配置", () => {
    const user = { name: "张三", callBy: "老张", pronouns: "", timezone: "Asia/Shanghai", notes: "", context: "", raw: "" };
    setSettingJSON("codem-user", user);
    const loaded = getSettingJSON("codem-user", null as any);
    expect(loaded!.name).toBe("张三");
    expect(loaded!.callBy).toBe("老张");
  });

  it("codem-app-identity key 可存储 AppIdentity", () => {
    const identity = { name: "Codem", creature: "AI 助手", vibe: "靠谱", emoji: "⚡", avatar: "", onboarded: true };
    setSettingJSON("codem-app-identity", identity);
    const loaded = getSettingJSON("codem-app-identity", null as any);
    expect(loaded!.onboarded).toBe(true);
  });

  it("codem-mcp-servers key 可存储 MCP 服务器配置数组", () => {
    const servers = [
      { id: "srv1", name: "Test Server", config: "{}", enabled: true },
    ];
    setSettingJSON("codem-mcp-servers", servers);
    const loaded = getSettingJSON<any[]>("codem-mcp-servers", []);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Test Server");
  });

  it("codem-cost-tracker key 可存储成本跟踪数据", () => {
    const costData = { totalCost: 1.23, records: [] };
    setSettingJSON("codem-cost-tracker", costData);
    const loaded = getSettingJSON("codem-cost-tracker", null as any);
    expect(loaded!.totalCost).toBe(1.23);
  });

  it("codem-recovery key 可存储恢复数据", () => {
    const recovery = { version: 1, lastSaved: Date.now(), sessions: {} };
    setSettingJSON("codem-recovery", recovery);
    const loaded = getSettingJSON("codem-recovery", null as any);
    expect(loaded!.version).toBe(1);
  });
});
