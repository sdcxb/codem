/**
 * browser_automate 工具 — 使用 Playwright 进行浏览器自动化。
 *
 * 功能：导航、截图、点击、输入文本、提取内容、对比 UI。
 * 用途：QA 测试、前端设计对比、网页游戏测试、表单验证。
 *
 * 设计原则：**通过 npx @playwright/mcp 启动 MCP server，自动管理生命周期。**
 * 用户零配置 — 工具内部自动连接 Playwright MCP server。
 */

import type { ToolDef, ToolExecuteResult } from "../tools";
import { getSetting } from "../../storage/settings";
import { getLang } from "../../i18n/lang";

// ========== 类型定义 ==========

interface BrowserAction {
  action: "navigate" | "screenshot" | "click" | "fill" | "evaluate" | "get_text" | "wait" | "hover" | "select";
  selector?: string;
  url?: string;
  text?: string;
  value?: string;
  timeout?: number;
  fullPage?: boolean;
  script?: string;
}

// ========== Playwright MCP 连接 ==========

let playwrightMcpClient: any = null;
let connecting: Promise<any> | null = null;

async function getPlaywrightClient(): Promise<any> {
  if (playwrightMcpClient) return playwrightMcpClient;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const { invoke } = (window as any).__TAURI__.core;
      // Start Playwright MCP server via stdio
      await invoke("mcp_stdio_connect", {
        name: "playwright",
        command: "npx",
        args: ["-y", "@anthropic/mcp-playwright@latest", "--headless"],
        env: {},
      });

      // Initialize
      const initResp = await invoke("mcp_stdio_request", {
        name: "playwright",
        message: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "codem", version: "0.91.0" },
          },
        }),
      });
      const initData = JSON.parse(initResp);
      if (initData.error) throw new Error(initData.error.message);

      // List tools
      const listResp = await invoke("mcp_stdio_request", {
        name: "playwright",
        message: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      const listData = JSON.parse(listResp);

      playwrightMcpClient = {
        name: "playwright",
        tools: listData.result?.tools || [],
      };
      return playwrightMcpClient;
    } catch (error: any) {
      throw new Error(`Playwright MCP connection failed: ${error.message}`);
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

async function callPlaywrightTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const client = await getPlaywrightClient();
  const { invoke } = (window as any).__TAURI__.core;

  const resp = await invoke("mcp_stdio_request", {
    name: client.name,
    message: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const data = JSON.parse(resp);
  if (data.error) throw new Error(data.error.message);

  // Extract text from content
  const content = data.result?.content || [];
  return content.map((c: any) => c.text || "").join("\n");
}

// ========== 工具实现 ==========

export function createBrowserAutomateTool(): ToolDef {
  return {
    id: "browser_automate",
    description:
      "Control a headless browser using Playwright. Actions: navigate to a URL, take screenshots, click elements, fill inputs, extract text, execute JavaScript, wait for elements, hover, and select options. " +
      "Use for: QA testing, visual comparison of UI implementations against references, browser game testing, and form validation. " +
      "Selectors use CSS or Playwright locators (text=, role=, etc.).",
    parameters: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["navigate", "screenshot", "click", "fill", "evaluate", "get_text", "wait", "hover", "select"],
                description: "The browser action to perform",
              },
              url: { type: "string", description: "URL to navigate to (for 'navigate' action)" },
              selector: { type: "string", description: "CSS selector or Playwright locator (e.g. 'text=Submit', 'button.primary')" },
              text: { type: "string", description: "Text to type into input (for 'fill' action)" },
              value: { type: "string", description: "Value to select (for 'select' action)" },
              timeout: { type: "number", description: "Timeout in ms (default 30000)" },
              fullPage: { type: "boolean", description: "Capture full page screenshot (default false)" },
              script: { type: "string", description: "JavaScript to evaluate (for 'evaluate' action)" },
            },
            required: ["action"],
          },
          description: "Array of browser actions to execute in sequence",
        },
      },
      required: ["actions"],
    },
    async execute(args, ctx) {
      const actions = args.actions as BrowserAction[];
      if (!actions || !Array.isArray(actions) || actions.length === 0) {
        return { title: "browser_automate", output: "Error: actions array is required" };
      }

      const zh = getLang() === "zh";
      const results: string[] = [];

      try {
        for (let i = 0; i < actions.length; i++) {
          const act = actions[i];
          const label = `[${i + 1}/${actions.length}] ${act.action}`;

          try {
            switch (act.action) {
              case "navigate": {
                const result = await callPlaywrightTool("navigate", { url: act.url });
                results.push(`${label}: Navigated to ${act.url}`);
                break;
              }
              case "screenshot": {
                const result = await callPlaywrightTool("screenshot", {
                  fullPage: act.fullPage || false,
                });
                results.push(`${label}: Screenshot captured${act.fullPage ? " (full page)" : ""}\n${result}`);
                break;
              }
              case "click": {
                const result = await callPlaywrightTool("click", { selector: act.selector });
                results.push(`${label}: Clicked ${act.selector}`);
                break;
              }
              case "fill": {
                const result = await callPlaywrightTool("fill", { selector: act.selector, text: act.text });
                results.push(`${label}: Filled ${act.selector} with "${act.text}"`);
                break;
              }
              case "evaluate": {
                const result = await callPlaywrightTool("evaluate", { script: act.script });
                results.push(`${label}: JS result:\n${result}`);
                break;
              }
              case "get_text": {
                const result = await callPlaywrightTool("get_text", { selector: act.selector });
                results.push(`${label}: Text from ${act.selector}:\n${result}`);
                break;
              }
              case "wait": {
                const result = await callPlaywrightTool("wait", { selector: act.selector, timeout: act.timeout || 30000 });
                results.push(`${label}: Waited for ${act.selector}`);
                break;
              }
              case "hover": {
                const result = await callPlaywrightTool("hover", { selector: act.selector });
                results.push(`${label}: Hovered ${act.selector}`);
                break;
              }
              case "select": {
                const result = await callPlaywrightTool("select", { selector: act.selector, value: act.value });
                results.push(`${label}: Selected "${act.value}" in ${act.selector}`);
                break;
              }
              default:
                results.push(`${label}: Unknown action "${act.action}"`);
            }
          } catch (e: any) {
            results.push(`${label}: ERROR - ${e.message}`);
          }
        }

        return {
          title: `browser_automate (${actions.length} actions)`,
          output: results.join("\n\n"),
        };
      } catch (error: any) {
        return {
          title: "browser_automate",
          output: zh
            ? `浏览器自动化失败: ${error.message}\n提示: Playwright MCP 需要安装 @anthropic/mcp-playwright，会自动通过 npx 运行。`
            : `Browser automation failed: ${error.message}\nNote: Playwright MCP requires @anthropic/mcp-playwright, auto-started via npx.`,
        };
      }
    },
  };
}
