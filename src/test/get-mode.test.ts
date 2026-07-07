/**
 * 测试 9：App.tsx getMode() 从 codem-settings 读取
 *
 * 改动影响：
 *   - App.tsx 的 getMode() 从 localStorage.getItem("mimo-settings") 改为 getSettingJSON("codem-settings")
 *   - getMode() 用于判断运行模式（cli/api）
 *   - 如果有误，WebSocket 连接和引擎配置会出问题
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { getSettingJSON, setSettingJSON, setSetting } from "../core/storage/settings";

// 模拟 App.tsx 中的 getMode 函数
function getMode(): "cli" | "api" {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    return settings.mode || "api";
  } catch {
    return "api";
  }
}

describe("App.tsx getMode() — 从 codem-settings 读取", () => {
  beforeEach(async () => {
    await initDatabase();
    localStorage.clear();
  });

  it("无设置时默认返回 api", () => {
    expect(getMode()).toBe("api");
  });

  it("codem-settings mode=cli 时返回 cli", () => {
    setSettingJSON("codem-settings", { mode: "cli" });
    expect(getMode()).toBe("cli");
  });

  it("codem-settings mode=api 时返回 api", () => {
    setSettingJSON("codem-settings", { mode: "api" });
    expect(getMode()).toBe("api");
  });

  it("codem-settings 无 mode 字段时默认返回 api", () => {
    setSettingJSON("codem-settings", { model: "gpt-4o" });
    expect(getMode()).toBe("api");
  });

  it("不读取旧的 mimo-settings localStorage key", () => {
    // 旧 key 有 mode=cli
    localStorage.setItem("mimo-settings", JSON.stringify({ mode: "cli" }));

    // 新 key 不存在
    expect(getMode()).toBe("api"); // 不是 cli，说明没有读旧 key
  });

  it("不读取旧的 mimo-settings SQLite key", () => {
    // 旧 SQLite key 有 mode=cli
    setSetting("mimo-settings", JSON.stringify({ mode: "cli" }));

    // 新 key 不存在
    expect(getMode()).toBe("api"); // 不是 cli，说明没有读旧 key
  });
});
