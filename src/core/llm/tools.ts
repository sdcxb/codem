import type { ToolDefinition, ToolCallResult, LLMMessage } from "./types";
import { readFile, writeFile, executeCommand, globSearch, grepSearch } from "../file-api";

// ========== Tool Context ==========
export interface ToolContext {
  sessionId: string;
  messageId: string;
  cwd: string;
  abort: AbortSignal;
  messages: LLMMessage[];
  metadata(input: { title?: string; metadata?: Record<string, any> }): void;
}

export interface ToolExecuteResult {
  title: string;
  metadata?: Record<string, any>;
  output: string;
}

// ========== Tool Definition ==========
export interface ToolDef {
  id: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult>;
}

// ========== Tool Registry ==========
export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map();

  register(tool: ToolDef) {
    this.tools.set(tool.id, tool);
  }

  get(id: string): ToolDef | undefined {
    return this.tools.get(id);
  }

  getAll(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      name: t.id,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async execute(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        id: toolCallId,
        name: toolName,
        input: args,
        output: `Error: Tool "${toolName}" not found`,
        status: "error",
        error: `Tool "${toolName}" not found`,
      };
    }

    try {
      const result = await tool.execute(args, ctx);
      return {
        id: toolCallId,
        name: toolName,
        input: args,
        output: result.output,
        status: "completed",
      };
    } catch (error: any) {
      return {
        id: toolCallId,
        name: toolName,
        input: args,
        output: `Error: ${error.message}`,
        status: "error",
        error: error.message,
      };
    }
  }
}

// ========== Built-in Tools ==========

export function createBashTool(): ToolDef {
  return {
    id: "bash",
    description: "Execute a bash command in the terminal",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        workdir: { type: "string", description: "Working directory (optional)" },
      },
      required: ["command"],
    },
    async execute(args, ctx) {
      const command = args.command as string;
      const workdir = (args.workdir as string) || ctx.cwd;

      try {
        const data = await executeCommand(command, workdir);
        return {
          title: `bash: ${command.substring(0, 50)}`,
          output: data.stdout || data.stderr || "(no output)",
        };
      } catch (error: any) {
        return { title: `bash: ${command.substring(0, 50)}`, output: `Error: ${error.message}` };
      }
    },
  };
}

export function createReadFileTool(): ToolDef {
  return {
    id: "read",
    description: "Read a file from the filesystem",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to read" },
        offset: { type: "number", description: "Line number to start from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    async execute(args) {
      const path = args.path as string;
      const offset = (args.offset as number) || 1;
      const limit = (args.limit as number) || 2000;

      try {
        const content = await readFile(path);
        const lines = content.split("\n");
        const sliced = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = sliced.map((line, i) => `${offset + i}: ${line}`).join("\n");
        return {
          title: `read: ${path}`,
          output: numbered + (lines.length > offset - 1 + limit ? `\n... (${lines.length} total lines)` : ""),
        };
      } catch (error: any) {
        return { title: `read: ${path}`, output: `Error: ${error.message}` };
      }
    },
  };
}

export function createWriteFileTool(): ToolDef {
  return {
    id: "write",
    description: "Write content to a file (creates or overwrites)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      const path = args.path as string;
      const content = args.content as string;

      try {
        await writeFile(path, content);
        return { title: `write: ${path}`, output: `Successfully wrote ${content.length} bytes to ${path}` };
      } catch (error: any) {
        return { title: `write: ${path}`, output: `Error: ${error.message}` };
      }
    },
  };
}

export function createEditFileTool(): ToolDef {
  return {
    id: "edit",
    description: "Edit a file by replacing exact string matches",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to edit" },
        oldString: { type: "string", description: "The exact string to replace" },
        newString: { type: "string", description: "The replacement string" },
      },
      required: ["path", "oldString", "newString"],
    },
    async execute(args) {
      const path = args.path as string;
      const oldString = args.oldString as string;
      const newString = args.newString as string;

      try {
        const content = await readFile(path);

        if (!content.includes(oldString)) {
          return { title: `edit: ${path}`, output: `Error: oldString not found in ${path}` };
        }

        const newContent = content.replace(oldString, newString);
        await writeFile(path, newContent);

        return { title: `edit: ${path}`, output: `Successfully edited ${path}` };
      } catch (error: any) {
        return { title: `edit: ${path}`, output: `Error: ${error.message}` };
      }
    },
  };
}

export function createGlobTool(): ToolDef {
  return {
    id: "glob",
    description: "Find files matching a glob pattern",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match" },
        path: { type: "string", description: "Directory to search in" },
      },
      required: ["pattern"],
    },
    async execute(args) {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) || ".";

      try {
        const files = await globSearch(pattern, searchPath);
        return {
          title: `glob: ${pattern}`,
          output: files.join("\n") || "No files found",
        };
      } catch (error: any) {
        return { title: `glob: ${pattern}`, output: `Error: ${error.message}` };
      }
    },
  };
}

export function createGrepTool(): ToolDef {
  return {
    id: "grep",
    description: "Search file contents using regex",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory to search in" },
        include: { type: "string", description: "File pattern to include (e.g. *.ts)" },
      },
      required: ["pattern"],
    },
    async execute(args) {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) || ".";
      const include = args.include as string | undefined;

      try {
        const results = await grepSearch(pattern, searchPath, include);
        return {
          title: `grep: ${pattern}`,
          output: results.join("\n") || "No matches found",
        };
      } catch (error: any) {
        return { title: `grep: ${pattern}`, output: `Error: ${error.message}` };
      }
    },
  };
}

// ========== Create Default Tool Registry ==========
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createBashTool());
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());
  registry.register(createEditFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  return registry;
}

// ========== Sub-agent Tool ==========
let subagentManager: import("../subagent/subagent").SubagentManager | null = null;

export function setSubagentManager(manager: import("../subagent/subagent").SubagentManager) {
  subagentManager = manager;
}

export function createSpawnSubagentTool(): ToolDef {
  return {
    id: "spawn_subagent",
    description: "Spawn a sub-agent to work on a specific task in parallel. Use this when you need to delegate work to a specialized agent.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The agent type: 'explore' for code search, 'general' for general tasks, 'build' for implementation" },
        prompt: { type: "string", description: "The task prompt for the sub-agent" },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["agentId", "prompt"],
    },
    async execute(args, ctx) {
      if (!subagentManager) {
        return { title: "spawn_subagent", output: "Error: Sub-agent manager not initialized" };
      }

      const agentId = args.agentId as string;
      const prompt = args.prompt as string;
      const cwd = (args.cwd as string) || ctx.cwd;

      try {
        const task = await subagentManager.spawn(
          ctx.sessionId,
          agentId,
          prompt,
          cwd,
        );

        return {
          title: `spawn_subagent: ${agentId}`,
          output: `Sub-agent spawned with ID: ${task.id}\nStatus: ${task.status}\nTask: ${prompt.substring(0, 100)}`,
        };
      } catch (error: any) {
        return { title: "spawn_subagent", output: `Error: ${error.message}` };
      }
    },
  };
}
