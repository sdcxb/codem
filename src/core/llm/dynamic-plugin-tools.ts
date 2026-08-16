/**
 * D3: Dynamic Plugin Tools — cordis_define/inspect/run/stop/undefine
 *
 * 设计对标 DSH dynamicCordisRunner 的工具化封装。
 *
 * 允许 LLM 在运行时动态定义和执行 Cordis 插件：
 * - cordis_define: 定义一个新插件（编译代码字符串）
 * - cordis_inspect: 查看已定义的插件和可用服务
 * - cordis_run: 运行一个已定义的插件
 * - cordis_stop: 停止一个正在运行的插件
 * - cordis_undefine: 移除一个已定义的插件
 *
 * 安全：这些工具是 deferred（shouldDefer=true），LLM 需要先 tool_search
 * 获取完整 schema 才能使用。代码执行使用 new Function() 编译，
 * 后续计划使用 Worker 隔离增强安全性。
 */

import type { ToolDef } from "./tools";

// ========== Tool Definitions ==========

export function createCordisDefineTool(): ToolDef {
  return {
    id: "cordis_define",
    description: "Define a dynamic Cordis plugin at runtime. The plugin code is compiled and registered in the runtime. Use this when you need to create custom functionality that doesn't exist as a built-in tool.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Unique name for the plugin (e.g. 'my-custom-tool')",
        },
        code: {
          type: "string",
          description: "JavaScript code for the plugin. The code receives 'ctx' (Cordis Context) and should export via module.exports. Example: `module.exports = (ctx) => { ctx.provide('myService', { hello: () => 'world' }) }`",
        },
      },
      required: ["name", "code"],
    },
    shouldDefer: true,
    searchHint: "Define a dynamic Cordis plugin at runtime — compile and register custom code as a Cordis plugin",
    async execute(args, ctx) {
      try {
        const { getToolContext } = require("./tools");
        const toolCtx = getToolContext();
        if (!toolCtx) {
          return { output: "Error: Tool context not available. Dynamic plugins require a Cordis context." };
        }
        const runner = (toolCtx as any).get?.("dynamicCordisRunner");
        if (!runner) {
          return { output: "Error: dynamicCordisRunner service not available." };
        }
        const result = await runner.define(args.name as string, args.code as string);
        if (!result.success) {
          return { output: `Failed to define plugin: ${result.error}` };
        }
        return { output: `Plugin "${args.name}" defined successfully.` };
      } catch (err: any) {
        return { output: `Error defining plugin: ${err.message}` };
      }
    },
  };
}

export function createCordisInspectTool(): ToolDef {
  return {
    id: "cordis_inspect",
    description: "Inspect all registered dynamic plugins and available Cordis services. Returns a list of plugins and services.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional filter to search for specific plugins or services by name.",
        },
      },
    },
    shouldDefer: true,
    searchHint: "Inspect registered dynamic Cordis plugins and available services",
    async execute(args, ctx) {
      try {
        const { getToolContext } = require("./tools");
        const toolCtx = getToolContext();
        if (!toolCtx) {
          return { output: "Error: Tool context not available." };
        }
        const runner = (toolCtx as any).get?.("dynamicCordisRunner");
        if (!runner) {
          return { output: "Error: dynamicCordisRunner service not available." };
        }
        const inspection = runner.inspect();
        let output = `Dynamic Plugins (${inspection.plugins.length}):\n`;
        for (const p of inspection.plugins) {
          output += `  - ${p.name} (provides: ${p.provides?.join(", ") || "none"})\n`;
        }
        output += `\nAvailable Services (${inspection.services.length}):\n`;
        const filter = args.filter as string | undefined;
        const services = filter
          ? inspection.services.filter((s: string) => s.toLowerCase().includes(filter.toLowerCase()))
          : inspection.services;
        for (const s of services) {
          output += `  - ${s}\n`;
        }
        return { output };
      } catch (err: any) {
        return { output: `Error inspecting plugins: ${err.message}` };
      }
    },
  };
}

export function createCordisRunTool(): ToolDef {
  return {
    id: "cordis_run",
    description: "Run a previously defined dynamic Cordis plugin by name.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the plugin to run.",
        },
        args: {
          type: "object",
          description: "Optional arguments to pass to the plugin.",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
    shouldDefer: true,
    searchHint: "Run a defined dynamic Cordis plugin by name",
    async execute(args, ctx) {
      try {
        const { getToolContext } = require("./tools");
        const toolCtx = getToolContext();
        if (!toolCtx) {
          return { output: "Error: Tool context not available." };
        }
        const runner = (toolCtx as any).get?.("dynamicCordisRunner");
        if (!runner) {
          return { output: "Error: dynamicCordisRunner service not available." };
        }
        const result = await runner.run(args.name as string, args.args);
        if (!result.success) {
          return { output: `Failed to run plugin: ${result.error}` };
        }
        return { output: `Plugin "${args.name}" ran successfully. Result: ${JSON.stringify(result.result, null, 2)}` };
      } catch (err: any) {
        return { output: `Error running plugin: ${err.message}` };
      }
    },
  };
}

export function createCordisStopTool(): ToolDef {
  return {
    id: "cordis_stop",
    description: "Stop a running dynamic Cordis plugin. The plugin's dispose function is called if available.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the plugin to stop.",
        },
      },
      required: ["name"],
    },
    shouldDefer: true,
    searchHint: "Stop a running dynamic Cordis plugin",
    async execute(args, ctx) {
      try {
        const { getToolContext } = require("./tools");
        const toolCtx = getToolContext();
        if (!toolCtx) {
          return { output: "Error: Tool context not available." };
        }
        const runner = (toolCtx as any).get?.("dynamicCordisRunner");
        if (!runner) {
          return { output: "Error: dynamicCordisRunner service not available." };
        }
        // Stop is similar to undefine but calls dispose first
        const result = runner.retract(args.name as string);
        if (!result.success) {
          return { output: `Failed to stop plugin: ${result.error}` };
        }
        return { output: `Plugin "${args.name}" stopped successfully.` };
      } catch (err: any) {
        return { output: `Error stopping plugin: ${err.message}` };
      }
    },
  };
}

export function createCordisUndefineTool(): ToolDef {
  return {
    id: "cordis_undefine",
    description: "Remove a defined dynamic Cordis plugin from the runtime.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the plugin to remove.",
        },
      },
      required: ["name"],
    },
    shouldDefer: true,
    searchHint: "Remove a defined dynamic Cordis plugin from the runtime",
    async execute(args, ctx) {
      try {
        const { getToolContext } = require("./tools");
        const toolCtx = getToolContext();
        if (!toolCtx) {
          return { output: "Error: Tool context not available." };
        }
        const runner = (toolCtx as any).get?.("dynamicCordisRunner");
        if (!runner) {
          return { output: "Error: dynamicCordisRunner service not available." };
        }
        const result = runner.retract(args.name as string);
        if (!result.success) {
          return { output: `Failed to undefine plugin: ${result.error}` };
        }
        return { output: `Plugin "${args.name}" undefined successfully.` };
      } catch (err: any) {
        return { output: `Error undefining plugin: ${err.message}` };
      }
    },
  };
}

/** D3: Create all dynamic plugin tools */
export function createDynamicPluginTools(): ToolDef[] {
  return [
    createCordisDefineTool(),
    createCordisInspectTool(),
    createCordisRunTool(),
    createCordisStopTool(),
    createCordisUndefineTool(),
  ];
}
