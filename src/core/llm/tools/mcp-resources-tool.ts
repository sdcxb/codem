/**
 * 第 183 波：MCP **resources** 三件套（对标 Pi 的同名工具，命名对齐 Codex / opencode）。
 *
 * ## 与 Pi 的差异（有意）
 *
 * Pi 把这三个工具**无条件**注册（它没有"能力门控"这一步）；我们**按服务端能力门控** ——
 * 只有至少一个已连接服务器在 `initialize` 里声明了 `resources` 才注册。
 *
 * 理由（以平台稳定性与性能为前提）：工具定义会进入**每一轮**请求的 function-calling
 * schema 与系统提示里的 MCP 清单。绝大多数服务器（含我们自己的 codegraph / zvec）不提供
 * resources —— 为它们注册三个永远用不上的工具，是在**每一轮**都付 token 与选择噪声的代价。
 *
 * ## 契约
 *
 * 三个都是**只读**（`readOnly: true`）：读服务器暴露的资源不会改工作区。
 * 访问范围按 `workspace` 声明（资源内容可能含仓库内容），但**内容一律当数据**看 ——
 * 与 `read` 一样裹数据边界由各自的输出形状决定（这里直接返回文本，不上边框：
 * 资源的正文通常不是文件内容，而是服务器生成的说明/记录）。
 */
import type { ToolDef, ToolExecuteResult } from "../tools";
import { getMCPRegistry } from "../../mcp/mcp";

/** 把资源内容整理成模型可读文本（容错：不同服务器返回的形状差异很大） */
function formatResourceContents(contents: unknown): string {
  if (!Array.isArray(contents) || contents.length === 0) return "(empty resource)";
  return contents
    .map((c: any) => {
      if (c == null) return "(null)";
      if (typeof c === "string") return c;
      if (typeof c.text === "string") return c.text;
      // 二进制资源：只说清是什么，不回灌 base64（那是 token 黑洞）
      if (typeof c.blob === "string") {
        return `[binary resource: ${c.mimeType ?? "unknown type"}, ${c.blob.length} base64 chars — not inlined]`;
      }
      return JSON.stringify(c);
    })
    .join("\n\n");
}

/** 已连接且在 initialize 里声明了 `resources` 的服务器名 */
export function serversWithResources(): string[] {
  try {
    return getMCPRegistry().serversWithResources();
  } catch {
    return [];
  }
}

export function createListMcpResourcesTool(): ToolDef {
  return {
    id: "list_mcp_resources",
    description:
      "List the read-only resources exposed by a connected MCP server (documents, records, reference data). " +
      "The result contains URIs you can pass to read_mcp_resource.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name (see the MCP section of the system prompt)" },
      },
      required: [],
    },
    contract: { readOnly: true, accessScope: "workspace", persistResult: false },
    execute: async (args): Promise<ToolExecuteResult> => {
      try {
        const registry = getMCPRegistry();
        const server = typeof args.server === "string" && args.server ? args.server : undefined;
        const targets = server ? [server] : registry.serversWithResources();
        if (targets.length === 0) {
          return {
            title: "list_mcp_resources",
            output: "No connected MCP server exposes resources.",
            isError: false,
          };
        }
        const chunks: string[] = [];
        for (const name of targets) {
          const list = await registry.listResources(name);
          if (list.length === 0) {
            chunks.push(`${name}: (no resources)`);
            continue;
          }
          chunks.push(
            `${name}:\n` +
              list
                .map((r: any) => `  - ${r.uri}${r.name ? ` — ${r.name}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}`)
                .join("\n"),
          );
        }
        return { title: "list_mcp_resources", output: chunks.join("\n\n"), isError: false };
      } catch (e: any) {
        return { title: "list_mcp_resources", output: `Error listing MCP resources: ${e?.message || e}`, isError: true };
      }
    },
  };
}

export function createListMcpResourceTemplatesTool(): ToolDef {
  return {
    id: "list_mcp_resource_templates",
    description:
      "List the parameterised resource templates (URI templates) exposed by a connected MCP server. " +
      "Fill in the template variables and pass the resulting URI to read_mcp_resource.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name" },
      },
      required: [],
    },
    contract: { readOnly: true, accessScope: "workspace", persistResult: false },
    execute: async (args): Promise<ToolExecuteResult> => {
      try {
        const registry = getMCPRegistry();
        const server = typeof args.server === "string" && args.server ? args.server : undefined;
        const targets = server ? [server] : registry.serversWithResources();
        if (targets.length === 0) {
          return {
            title: "list_mcp_resource_templates",
            output: "No connected MCP server exposes resources.",
            isError: false,
          };
        }
        const chunks: string[] = [];
        for (const name of targets) {
          const tpl = await registry.listResourceTemplates(name);
          if (tpl.length === 0) {
            chunks.push(`${name}: (no templates)`);
            continue;
          }
          chunks.push(
            `${name}:\n` +
              tpl.map((t: any) => `  - ${t.uriTemplate}${t.name ? ` — ${t.name}` : ""}`).join("\n"),
          );
        }
        return { title: "list_mcp_resource_templates", output: chunks.join("\n\n"), isError: false };
      } catch (e: any) {
        return {
          title: "list_mcp_resource_templates",
          output: `Error listing MCP resource templates: ${e?.message || e}`,
          isError: true,
        };
      }
    },
  };
}

export function createReadMcpResourceTool(): ToolDef {
  return {
    id: "read_mcp_resource",
    description:
      "Read one resource from a connected MCP server by URI (get the URI from list_mcp_resources " +
      "or list_mcp_resource_templates). Binary resources are described rather than inlined.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name" },
        uri: { type: "string", description: "Resource URI to read" },
      },
      required: ["server", "uri"],
    },
    contract: { readOnly: true, accessScope: "workspace", persistResult: false },
    execute: async (args): Promise<ToolExecuteResult> => {
      const server = typeof args.server === "string" ? args.server : "";
      const uri = typeof args.uri === "string" ? args.uri : "";
      if (!server || !uri) {
        return { title: "read_mcp_resource", output: "Error: both `server` and `uri` are required.", isError: true };
      }
      try {
        const result = await getMCPRegistry().readResource(server, uri);
        // MCP 规定读资源失败用 isError 汇报（协议层失败则在上面 catch 里）
        if (result && (result as any).isError) {
          return {
            title: `read_mcp_resource: ${uri}`,
            output: `[MCP resource error] ${formatResourceContents((result as any).contents)}`,
            isError: true,
          };
        }
        return {
          title: `read_mcp_resource: ${uri}`,
          output: formatResourceContents((result as any)?.contents),
          isError: false,
        };
      } catch (e: any) {
        return { title: `read_mcp_resource: ${uri}`, output: `Error reading MCP resource: ${e?.message || e}`, isError: true };
      }
    },
  };
}

/** 三个工具（按同一顺序注册，便于判据断言） */
export function createMcpResourceTools(): ToolDef[] {
  return [createListMcpResourcesTool(), createListMcpResourceTemplatesTool(), createReadMcpResourceTool()];
}
