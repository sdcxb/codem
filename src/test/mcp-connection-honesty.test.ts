/**
 * 第 84 波审计修正：MCP 客户端的"假连接"。
 *
 * 修复前：
 *   · `connect()` 只要 spawn 成功（stdio 连 initialize 都不发）就写
 *     `status: "connected"`，再调 `listTools()`；
 *   · `listTools()` 把**所有**异常吞成 `[]` —— 与"服务器确实没有工具"无法区分；
 *   · `autoDetectCodeGraph()` 无脑 `return true`，即使 connect 明确失败。
 * 结果：命令写错/进程秒退/协议不符时，界面显示"已连接 · 0 个工具"，用户毫无线索。
 *
 * 修复后：连接 = 握手成功 + 工具清单真的是数组；失败时 status="error" + 原因，
 * `autoDetectCodeGraph` 只在真的连上时返回 true。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MCPClient, MCPRegistry, autoDetectCodeGraph } from "../core/mcp/mcp";

type InvokeHandler = (cmd: string, args: any) => any;

function installTauri(handler: InvokeHandler) {
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => handler(cmd, args),
    },
  };
}

const INIT_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: "2024-11-05", serverInfo: { name: "demo", version: "1.0.0" }, capabilities: {} },
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  delete (window as any).__TAURI__;
});

describe("MCP 连接诚实性", () => {
  it("MCP-H1: stdio 服务器只 spawn 成功（initialize 无响应）→ 不能算 connected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installTauri(async (cmd) => {
      if (cmd === "mcp_stdio_connect") return undefined;
      if (cmd === "mcp_stdio_request") throw new Error("process exited immediately");
      throw new Error(`unexpected ${cmd}`);
    });

    const client = new MCPClient();
    const conn = await client.connect({ name: "bad", transport: "stdio", command: "nope" });

    expect(conn.status, "握手失败必须报 error").toBe("error");
    expect(conn.error).toMatch(/process exited immediately|Stdio request failed/);
    expect(conn.tools).toEqual([]);
    expect(client.getAllTools(), "失败的服务器不能贡献任何工具").toHaveLength(0);
    warn.mockRestore();
  });

  it("MCP-H2: 握手成功但 tools/list 返回非数组 → error，而不是 0 个工具", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // initialize 与 tools/list 走同一个命令 —— 用调用次数区分
    let n = 0;
    installTauri(async (cmd) => {
      if (cmd === "mcp_stdio_connect") return undefined;
      if (cmd === "mcp_stdio_request") {
        n++;
        if (n === 1) return INIT_OK;
        return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { notaTools: true } });
      }
      throw new Error("nope");
    });

    const client = new MCPClient();
    const conn = await client.connect({ name: "weird", transport: "stdio", command: "demo" });

    expect(conn.status).toBe("error");
    expect(conn.error).toMatch(/tools\/list/);
    warn.mockRestore();
  });

  it("MCP-H3: 握手 + 工具清单都正常 → connected 并带工具", async () => {
    let n = 0;
    installTauri(async (cmd) => {
      if (cmd === "mcp_stdio_connect") return undefined;
      if (cmd === "mcp_stdio_request") {
        n++;
        if (n === 1) return INIT_OK;
        return JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: "codegraph_explore", description: "d", inputSchema: {} }] },
        });
      }
      throw new Error("nope");
    });

    const client = new MCPClient();
    const conn = await client.connect({ name: "ok", transport: "stdio", command: "demo" });
    expect(conn.status).toBe("connected");
    expect(conn.tools.map((t) => t.name)).toEqual(["codegraph_explore"]);
    expect(client.getAllTools()).toHaveLength(1);
  });

  it("MCP-H4: 连上之后 tools/list 失败 → 状态上留下原因（不再静默返回空）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    installTauri(async (cmd) => {
      if (cmd === "mcp_stdio_connect") return undefined;
      if (cmd === "mcp_stdio_request") {
        n++;
        if (n === 1) return INIT_OK;
        if (n === 2) return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
        throw new Error("server died");
      }
      throw new Error("nope");
    });

    const client = new MCPClient();
    const conn = await client.connect({ name: "flaky", transport: "stdio", command: "demo" });
    expect(conn.status).toBe("connected");

    const tools = await client.listTools("flaky");
    expect(tools).toEqual([]);
    const after = client.getStatus("flaky")!;
    expect(after.error, "失败原因必须被记录").toMatch(/tools\/list 失败/);
    warn.mockRestore();
  });

  it("MCP-H5（修复点）: autoDetectCodeGraph 只在真的连上时返回 true", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installTauri(async (cmd) => {
      if (cmd === "path_exists") return true;
      if (cmd === "mcp_stdio_connect") return undefined;
      if (cmd === "mcp_stdio_request") throw new Error("handshake refused");
      throw new Error("nope");
    });

    const registry = new MCPRegistry();
    const ok = await autoDetectCodeGraph(registry, "C:/proj");
    expect(ok, "连接失败时不能声称 CodeGraph 可用").toBe(false);
    expect(registry.getClient().getStatus("codegraph")?.status).toBe("error");
    warn.mockRestore();
  });

  it("MCP-H6: autoDetectCodeGraph 成功时返回 true，且工具可被枚举", async () => {
    let n = 0;
    installTauri(async (cmd) => {
      if (cmd === "path_exists") return true;
      if (cmd === "mcp_stdio_connect") return undefined;
      if (cmd === "mcp_stdio_request") {
        n++;
        if (n === 1) return INIT_OK;
        return JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: "codegraph_explore", description: "d", inputSchema: {} }] },
        });
      }
      throw new Error("nope");
    });

    const registry = new MCPRegistry();
    expect(await autoDetectCodeGraph(registry, "C:/proj")).toBe(true);
    expect(registry.getAllTools().some((t) => t.name === "codegraph_explore")).toBe(true);
  });
});
