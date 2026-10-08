/**
 * 第 183 波：MCP **resources 三件套**（对标 Pi，命名对齐 Codex / opencode）。
 *
 * ## 这组判据守什么
 *
 * 1. **按能力门控**（我们与 Pi 的有意差异）：只有已连接且 `initialize` 声明了
 *    `resources` 的服务器存在时才注册；一个都没有时必须**不注册**并且**清理残留**
 *    —— 理由是性能：工具定义会进入每一轮请求的 schema 与提示清单。
 * 2. **协议调用正确**：走 `resources/list` / `resources/templates/list` / `resources/read`。
 * 3. **二进制资源不许内联**（base64 是 token 黑洞）：只描述类型与大小。
 * 4. **失败要说清**（延续第 84 波"假成功"那条纪律）：拿不到清单/读不到资源 ⇒ 显式失败。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ server: string; method: string; params: any }> = [];
let capsByServer: Record<string, any> = {};
let resourceList: any[] = [];
let templateList: any[] = [];
let readResult: any = { contents: [] };
let throwOn: string | null = null;

vi.mock("../core/mcp/mcp", () => ({
  getMCPRegistry: () => ({
    serversWithResources: () =>
      Object.entries(capsByServer)
        .filter(([, caps]) => caps && caps.resources)
        .map(([name]) => name),
    listResources: async (server: string) => {
      calls.push({ server, method: "resources/list", params: {} });
      if (throwOn === "list") throw new Error("boom");
      return resourceList;
    },
    listResourceTemplates: async (server: string) => {
      calls.push({ server, method: "resources/templates/list", params: {} });
      if (throwOn === "templates") throw new Error("boom");
      return templateList;
    },
    readResource: async (server: string, uri: string) => {
      calls.push({ server, method: "resources/read", params: { uri } });
      if (throwOn === "read") throw new Error("boom");
      return readResult;
    },
  }),
}));

import {
  createListMcpResourceTemplatesTool,
  createListMcpResourcesTool,
  createReadMcpResourceTool,
} from "../core/llm/tools/mcp-resources-tool";
import { MCP_RESOURCE_TOOL_IDS, mcpResourceToolsRegistered, syncMcpResourceTools } from "../core/llm/tools/mcp-resources-sync";
import type { ToolRegistry } from "../core/llm/tools";

/** 最小可用的注册表桩（只实现 sync 用到的四个方法） */
function fakeRegistry(initial: string[] = []): ToolRegistry {
  const m = new Map<string, any>(initial.map((id) => [id, { id }]));
  return {
    get: (id: string) => m.get(id),
    register: (def: any) => m.set(def.id, def),
    remove: (id: string) => m.delete(id),
    getAll: () => [...m.values()],
  } as unknown as ToolRegistry;
}

beforeEach(() => {
  calls.length = 0;
  capsByServer = {};
  resourceList = [];
  templateList = [];
  readResult = { contents: [] };
  throwOn = null;
});

describe("第 183 波 · MCP resources（MCPR）", () => {
  it("MCPR-1: 没有任何服务器声明 resources ⇒ **不注册**（每一轮都不为用不上的工具付 token）", () => {
    const reg = fakeRegistry();
    syncMcpResourceTools(reg, []);
    expect(mcpResourceToolsRegistered(reg)).toEqual([]);
  });

  it("MCPR-2: 有能力时三个工具都注册，且都是**只读**（访问范围 workspace）", () => {
    const reg = fakeRegistry();
    syncMcpResourceTools(reg, ["docs-server"]);
    expect(mcpResourceToolsRegistered(reg).sort()).toEqual([...MCP_RESOURCE_TOOL_IDS].sort());
    for (const id of MCP_RESOURCE_TOOL_IDS) {
      const def: any = reg.get(id);
      expect(def.contract.readOnly, `${id} 必须只读`).toBe(true);
      expect(def.contract.accessScope).toBe("workspace");
      expect(def.contract.persistResult).toBe(false);
    }
  });

  it("MCPR-3: 能力消失（断连）⇒ **清理残留**（提示与可调用集合严格一致）", () => {
    const reg = fakeRegistry();
    syncMcpResourceTools(reg, ["docs-server"]);
    expect(mcpResourceToolsRegistered(reg)).toHaveLength(3);
    syncMcpResourceTools(reg, []);
    expect(mcpResourceToolsRegistered(reg)).toEqual([]);
  });

  it("MCPR-4: list_mcp_resources 走 `resources/list`，把 uri / name / mimeType 呈现给模型", async () => {
    capsByServer = { "docs-server": { resources: {} } };
    resourceList = [{ uri: "docs://a.md", name: "A", mimeType: "text/markdown" }];
    const res: any = await createListMcpResourcesTool().execute!({}, {} as any);
    expect(calls).toEqual([{ server: "docs-server", method: "resources/list", params: {} }]);
    expect(res.isError).toBe(false);
    expect(res.output).toContain("docs://a.md");
    expect(res.output).toContain("A");
    expect(res.output).toContain("text/markdown");
  });

  it("MCPR-5: 模板工具走 `resources/templates/list`", async () => {
    capsByServer = { "docs-server": { resources: {} } };
    templateList = [{ uriTemplate: "docs://{path}", name: "any doc" }];
    const res: any = await createListMcpResourceTemplatesTool().execute!({}, {} as any);
    expect(calls[0].method).toBe("resources/templates/list");
    expect(res.output).toContain("docs://{path}");
  });

  it("MCPR-6: read_mcp_resource 走 `resources/read`；**二进制资源只描述、不内联**（base64 是 token 黑洞）", async () => {
    readResult = {
      contents: [
        { uri: "docs://a.md", text: "hello" },
        { uri: "docs://b.png", mimeType: "image/png", blob: "A".repeat(5000) },
      ],
    };
    const res: any = await createReadMcpResourceTool().execute!({ server: "s", uri: "docs://a.md" }, {} as any);
    expect(calls).toEqual([{ server: "s", method: "resources/read", params: { uri: "docs://a.md" } }]);
    expect(res.isError).toBe(false);
    expect(res.output).toContain("hello");
    // 关键：不能把 5000 个 base64 字符灌进上下文
    expect(res.output).not.toContain("A".repeat(100));
    expect(res.output).toContain("not inlined");
  });

  it("MCPR-7: 失败**必须说清**（不许假成功）：协议抛错与 isError 两条路径都显式失败", async () => {
    throwOn = "read";
    const a: any = await createReadMcpResourceTool().execute!({ server: "s", uri: "docs://x" }, {} as any);
    expect(a.isError).toBe(true);
    expect(a.output).toContain("boom");

    throwOn = null;
    readResult = { contents: [{ text: "denied" }], isError: true };
    const b: any = await createReadMcpResourceTool().execute!({ server: "s", uri: "docs://x" }, {} as any);
    expect(b.isError).toBe(true);
    expect(b.output).toContain("denied");

    // 参数缺失也是失败，不是"空成功"
    const c: any = await createReadMcpResourceTool().execute!({ server: "s" }, {} as any);
    expect(c.isError).toBe(true);
    expect(c.output).toContain("required");
  });

  it("MCPR-8: 没有服务器时给出**明确说明**而不是空串（模型要知道为什么没结果）", async () => {
    const res: any = await createListMcpResourcesTool().execute!({}, {} as any);
    expect(res.isError).toBe(false);
    expect(res.output).toBe("No connected MCP server exposes resources.");
    expect(calls).toEqual([]);
  });

  it("MCPR-9: **接线**在真实链路上（防『判据长在没人走的链路』的老毛病）", async () => {
    const fs = await import("node:fs");
    const index = fs.readFileSync("src/core/llm/index.ts", "utf8");
    // ① 服务方法存在，且它把能力名单交给 sync（而不是自己瞎注册）
    expect(index).toMatch(/syncMcpResourceTools\(\)\s*:\s*void\s*\{/);
    expect(index).toMatch(/syncMcpResourceTools\(this\.tools,\s*servers\)/);
    // ② 能力来自 MCP 侧的 serversWithResources（不是写死的常量）
    expect(index).toMatch(/serversWithResources/);
    // ③ 真的在构建系统提示时被调用（与 codegraph / zvec 的 sync 并列 —— 那是同一处时机）
    expect(index).toMatch(/this\.syncMcpResourceTools\(\);/);
    const buildIdx = index.indexOf("this.syncCodeGraphTools();");
    const mcpIdx = index.indexOf("this.syncMcpResourceTools();");
    expect(buildIdx, "codegraph sync 应当仍在").toBeGreaterThan(-1);
    expect(mcpIdx, "MCP resources sync 必须在同一处时机被调用").toBeGreaterThan(buildIdx);
  });
});
