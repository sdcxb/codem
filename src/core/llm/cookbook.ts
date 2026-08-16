/**
 * Cookbook Extension Guide — 扩展指南
 *
 * 设计对标 DSH `docs/cookbook/` 机制。
 *
 * R3-4.3: 提供结构化的扩展指南，帮助开发者：
 * - 添加新工具
 * - 添加新事件类型
 * - 添加 post-execute 中间件
 * - 添加 pre-execute 中间件
 * - 添加 guard
 * - 添加持久化后端
 * - 添加输出契约
 *
 * 这不是运行时代码 — 它是文档化的扩展指南。
 * 但以 TypeScript 接口形式提供，让 IDE 可以帮助开发者。
 */

// ========== Extension Guide: Adding a New Tool ==========

export interface NewToolGuide {
  /** 步骤 1: 创建工具定义文件 */
  step1_createFile: {
    path: "src/core/llm/tools/my-tool.ts";
    template: `export function createMyTool(): ToolDef {
  return {
    id: "my_tool",
    description: "Description of what this tool does.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input parameter" },
      },
      required: ["input"],
    },
    async execute(args, ctx) {
      const input = args.input as string;
      return { title: "my_tool", output: \`Result: \${input}\` };
    },
  };
}`;
  };

  /** 步骤 2: 注册工具 */
  step2_register: {
    file: "src/core/llm/tools.ts";
    action: "Add import and registry.register(createMyTool())";
  };

  /** 步骤 3: (可选) 声明输出契约 */
  step3_outputContract?: {
    file: "src/core/llm/output-contract.ts";
    action: "Call registerOutputContract('my_tool', { schema, render })";
  };

  /** 步骤 4: (可选) 声明并发安全 */
  step4_concurrency?: {
    file: "src/core/llm/tool-pipeline.ts";
    action: "Call pipeline.registerConcurrency('my_tool', (args) => true/false)";
  };
}

// ========== Extension Guide: Adding a New Event Type ==========

export interface NewEventTypeGuide {
  step1_register: {
    action: "Call registerCustomEventType('my_custom_event', { description: '...' })";
    location: "At plugin/module initialization time";
  };
  step2_append: {
    action: "Call getEventLog().append(sessionId, 'my_custom_event', payload)";
  };
  step3_handle: {
    action: "In EventProjection.applyEvent(), add a case for 'my_custom_event'";
    note: "If the event should not produce messages, add it to the no-op default arm";
  };
}

// ========== Extension Guide: Adding Post-Execute Middleware ==========

export interface NewPostExecuteGuide {
  step1_createClass: {
    template: `export class MyMiddleware implements PostExecuteMiddleware {
  name = "my-middleware";
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
  ): Promise<PostExecuteResult> {
    // Your logic here
    return { action: "keep" }; // or "replace", "append", "deny"
  }
}`;
  };
  step2_register: {
    action: "pipeline.registerPostExecute(new MyMiddleware())";
    location: "In initDefaultPipeline()";
  };
}

// ========== Extension Guide: Adding a Persistence Backend ==========

export interface NewPersistenceBackendGuide {
  step1_implement: {
    action: "Implement the PersistenceProvider interface";
    interface: "See src/core/storage/persistence-provider.ts";
  };
  step2_register: {
    action: "Call setPersistenceProvider(new MyProvider())";
    location: "At application startup, before EventLog initialization";
  };
}

// ========== Extension Guide: Adding an Agent Preset ==========

export interface NewAgentPresetGuide {
  step1_createDir: {
    path: "~/.agent-presets/my-preset/";
  };
  step2_createComposition: {
    file: "~/.agent-presets/my-preset/agent.cordis.yml";
    template: `name: My Preset
description: A custom agent preset
prompt: |
  You are a specialized agent for...
tools:
  - read
  - grep
  - glob
model: gpt-4o
temperature: 0.3
maxSteps: 20
collaborationMode: default`;
  };
  step3_optionalMetadata: {
    file: "~/.agent-presets/my-preset/metadata.yml";
    template: `displayName: My Custom Preset
description: Description shown in the preset picker
order: 10`;
  };
}
