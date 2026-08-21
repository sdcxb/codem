/**
 * figma_fetch 工具 — 从 Figma 获取设计稿数据。
 *
 * 功能：获取 Figma 文件结构、节点数据、图片导出、组件变体。
 * 用途：将 Figma 设计稿转换为代码，获取设计上下文。
 *
 * 设计原则：**使用 Figma REST API，用户需配置 Figma access token。**
 * token 存储在 settings 中，零外部依赖。
 */

import type { ToolDef, ToolExecuteResult } from "../tools";
import { getSetting } from "../../storage/settings";
import { getLang } from "../../i18n/lang";

// ========== Figma API ==========

const FIGMA_API = "https://api.figma.com/v1";

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
}

/** Fetch Figma file structure */
async function fetchFileStructure(fileKey: string, token: string, depth = 3): Promise<any> {
  const url = `${FIGMA_API}/files/${fileKey}?depth=${depth}`;
  const resp = await fetch(url, {
    headers: { "X-Figma-Token": token },
  });
  if (!resp.ok) throw new Error(`Figma API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

/** Fetch specific node data */
async function fetchNode(fileKey: string, token: string, nodeIds: string[]): Promise<any> {
  const url = `${FIGMA_API}/files/${fileKey}/nodes?ids=${nodeIds.join(",")}`;
  const resp = await fetch(url, {
    headers: { "X-Figma-Token": token },
  });
  if (!resp.ok) throw new Error(`Figma API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

/** Export Figma nodes as images */
async function exportImages(fileKey: string, token: string, nodeIds: string[], format = "png", scale = 2): Promise<any> {
  const url = `${FIGMA_API}/images/${fileKey}?ids=${nodeIds.join(",")}&format=${format}&scale=${scale}`;
  const resp = await fetch(url, {
    headers: { "X-Figma-Token": token },
  });
  if (!resp.ok) throw new Error(`Figma API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

/** Get file components */
async function fetchComponents(fileKey: string, token: string): Promise<any> {
  const url = `${FIGMA_API}/files/${fileKey}/components`;
  const resp = await fetch(url, {
    headers: { "X-Figma-Token": token },
  });
  if (!resp.ok) throw new Error(`Figma API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

/** Get component styles */
async function fetchStyles(fileKey: string, token: string): Promise<any> {
  const url = `${FIGMA_API}/files/${fileKey}/styles`;
  const resp = await fetch(url, {
    headers: { "X-Figma-Token": token },
  });
  if (!resp.ok) throw new Error(`Figma API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

// ========== 工具实现 ==========

export function createFigmaFetchTool(): ToolDef {
  return {
    id: "figma_fetch",
    guidance: "Use figma_fetch to import design data from Figma. Provide a Figma URL or file key.",
    description:
      "Fetch design data from Figma files using the Figma REST API. " +
      "Actions: 'structure' (get file tree), 'node' (get specific node data), 'export' (export nodes as images), 'components' (list components), 'styles' (list styles). " +
      "Requires Figma personal access token configured in Settings. " +
      "Use for: converting Figma designs to code, extracting design context, getting visual references for UI implementation.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["structure", "node", "export", "components", "styles"],
          description: "The Figma API action to perform",
        },
        fileKey: {
          type: "string",
          description: "Figma file key (from the file URL, e.g. 'aBcDeFgHiJ' from figma.com/file/aBcDeFgHiJ/...)",
        },
        nodeIds: {
          type: "array",
          items: { type: "string" },
          description: "Figma node IDs (for 'node' and 'export' actions)",
        },
        depth: {
          type: "number",
          description: "Tree depth for 'structure' action (default 3)",
        },
        format: {
          type: "string",
          enum: ["png", "jpg", "svg", "pdf"],
          description: "Export format for 'export' action (default png)",
        },
        scale: {
          type: "number",
          description: "Export scale for 'export' action (default 2)",
        },
      },
      required: ["action", "fileKey"],
    },
    async execute(args, ctx) {
      const zh = getLang() === "zh";
      const action = args.action as string;
      const fileKey = args.fileKey as string;

      if (!fileKey) {
        return { title: "figma_fetch", output: "Error: fileKey is required" };
      }

      // Get Figma token from settings
      const token = getSetting("codem-figma-token") || "";
      if (!token) {
        return {
          title: "figma_fetch",
          output: zh
            ? "错误：未配置 Figma access token。请在设置面板中配置 Figma Personal Access Token。\n获取方式：Figma → Settings → Account → Personal access tokens"
            : "Error: Figma access token not configured. Please configure Figma Personal Access Token in Settings.\nGet it from: Figma → Settings → Account → Personal access tokens",
        };
      }

      try {
        let result: any;
        const label = `figma_fetch (${action})`;

        switch (action) {
          case "structure": {
            result = await fetchFileStructure(fileKey, token, (args.depth as number) || 3);
            const doc = result.document;
            const pages = doc?.children || [];
            const summary = pages.map((page: any) => {
              const frameCount = countFrames(page);
              return `📄 Page: ${page.name} (${frameCount} top-level frames)`;
            }).join("\n");
            const componentCount = result.components ? Object.keys(result.components).length : 0;
            const styleCount = result.styles ? Object.keys(result.styles).length : 0;
            return {
              title: label,
              output: `File: ${result.name}\nLast modified: ${result.lastModified}\n\nPages:\n${summary}\n\nComponents: ${componentCount}\nStyles: ${styleCount}\n\nFull JSON:\n${JSON.stringify(result, null, 2).substring(0, 8000)}`,
            };
          }

          case "node": {
            const nodeIds = args.nodeIds as string[];
            if (!nodeIds || nodeIds.length === 0) {
              return { title: label, output: "Error: nodeIds required for 'node' action" };
            }
            result = await fetchNode(fileKey, token, nodeIds);
            const nodes = result.nodes || {};
            const nodeSummaries = Object.entries(nodes).map(([id, data]: [string, any]) => {
              const n = data.document;
              return `Node ${id}: ${n?.name} (${n?.type}) — ${JSON.stringify(n).substring(0, 2000)}`;
            }).join("\n\n");
            return {
              title: label,
              output: nodeSummaries,
            };
          }

          case "export": {
            const nodeIds = args.nodeIds as string[];
            if (!nodeIds || nodeIds.length === 0) {
              return { title: label, output: "Error: nodeIds required for 'export' action" };
            }
            result = await exportImages(fileKey, token, nodeIds, (args.format as string) || "png", (args.scale as number) || 2);
            const images = result.images || {};
            const imageList = Object.entries(images).map(([id, url]: [string, any]) => {
              return `Node ${id}: ${url || "(failed to export)"}`;
            }).join("\n");
            return {
              title: label,
              output: `Exported ${nodeIds.length} nodes as ${(args.format as string) || "png"}:\n${imageList}`,
            };
          }

          case "components": {
            result = await fetchComponents(fileKey, token);
            const components = result.meta?.components || [];
            const compList = components.map((c: any) => {
              return `Component: ${c.name}\n  Key: ${c.key}\n  Description: ${c.description || "(none)"}\n`;
            }).join("\n");
            return {
              title: label,
              output: `${components.length} components found:\n\n${compList}`,
            };
          }

          case "styles": {
            result = await fetchStyles(fileKey, token);
            const styles = result.meta?.styles || [];
            const styleList = styles.map((s: any) => {
              return `Style: ${s.name}\n  Key: ${s.key}\n  Type: ${s.style_type}\n  Description: ${s.description || "(none)"}\n`;
            }).join("\n");
            return {
              title: label,
              output: `${styles.length} styles found:\n\n${styleList}`,
            };
          }

          default:
            return { title: label, output: `Unknown action: ${action}` };
        }
      } catch (error: any) {
        return {
          title: "figma_fetch",
          output: zh ? `Figma API 请求失败: ${error.message}` : `Figma API request failed: ${error.message}`,
        };
      }
    },
  };
}

/** Recursively count top-level frames in a page */
function countFrames(node: any): number {
  if (!node.children) return 0;
  return node.children.filter((c: any) => c.type === "FRAME" || c.type === "COMPONENT" || c.type === "INSTANCE").length;
}
