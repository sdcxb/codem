/**
 * 测试 11：MCP servers 和 Cost tracker — codem-* key
 *
 * 改动影响：
 *   - mcp.ts 从 "mimo-mcp-servers" 改为 "codem-mcp-servers"
 *   - cost-tracker.ts 从 "mimo-cost-tracker" 改为 "codem-cost-tracker"
 *   - 如果有误，MCP 服务器配置丢失，费用跟踪数据丢失
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { setSettingJSON, getSettingJSON } from "../core/storage/settings";

describe("MCP servers — codem-mcp-servers key", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("默认返回空数组", () => {
    const data = getSettingJSON<any[]>("codem-mcp-servers", []);
    expect(data).toEqual([]);
  });

  it("保存 MCP 配置后能从 codem-mcp-servers 读取", () => {
    const configs = [
      { name: "Test Server", transport: "stdio", command: "node" },
    ];
    setSettingJSON("codem-mcp-servers", configs);

    const loaded = getSettingJSON<any[]>("codem-mcp-servers", []);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Test Server");
    expect(loaded[0].transport).toBe("stdio");
  });

  it("数据存储在 codem-mcp-servers（非 mimo-mcp-servers）", () => {
    const configs = [{ name: "Test", transport: "stdio", command: "node" }];
    setSettingJSON("codem-mcp-servers", configs);

    // 新 key 应有数据
    expect(getSettingJSON<any[]>("codem-mcp-servers", [])).toHaveLength(1);

    // 旧 key 应无数据
    expect(getSettingJSON<any[]>("mimo-mcp-servers", [])).toEqual([]);
  });

  it("多个 MCP 服务器配置", () => {
    const configs = [
      { name: "Server A", transport: "stdio", command: "node" },
      { name: "Server B", transport: "http", url: "http://localhost:3000" },
      { name: "Server C", transport: "sse", url: "http://localhost:3001" },
    ];
    setSettingJSON("codem-mcp-servers", configs);

    const loaded = getSettingJSON<any[]>("codem-mcp-servers", []);
    expect(loaded).toHaveLength(3);
    expect(loaded[1].transport).toBe("http");
  });
});

describe("Cost tracker — codem-cost-tracker key", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("数据存储在 codem-cost-tracker（非 mimo-cost-tracker）", () => {
    const costData = { totalCost: 9.99, records: [{ model: "gpt-4o", cost: 0.01 }] };
    setSettingJSON("codem-cost-tracker", costData);

    const loaded = getSettingJSON<any>("codem-cost-tracker", null);
    expect(loaded.totalCost).toBe(9.99);

    // 旧 key 应无数据
    const oldData = getSettingJSON<any>("mimo-cost-tracker", null);
    expect(oldData).toBeNull();
  });

  it("空数据时返回默认值", () => {
    const loaded = getSettingJSON<any>("codem-cost-tracker", { totalCost: 0 });
    expect(loaded.totalCost).toBe(0);
  });

  it("cost-tracker getCostTracker 能从 codem-cost-tracker 读取", async () => {
    // 先写入数据
    setSettingJSON("codem-cost-tracker", {
      totalCost: 5.55,
      todayCost: 1.11,
      totalSessions: 10,
      totalTokens: 50000,
    });

    // 旧 key 不应有数据
    expect(getSettingJSON<any>("mimo-cost-tracker", null)).toBeNull();
    // 新 key 应有数据
    const loaded = getSettingJSON<any>("codem-cost-tracker", null);
    expect(loaded).not.toBeNull();
    expect(loaded.totalCost).toBe(5.55);
  });
});
