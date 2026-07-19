import type { ToolCallResult } from "./types";

// ========== Tool Render Types ==========
export interface ToolRenderConfig {
  /** Maximum output length to display */
  maxOutputLength: number;
  /** Whether to show full output */
  showFullOutput: boolean;
  /** Whether to show tool arguments */
  showArgs: boolean;
  /** Whether to show timing */
  showTiming: boolean;
  /** Theme */
  theme: "light" | "dark" | "auto";
}

const DEFAULT_RENDER_CONFIG: ToolRenderConfig = {
  maxOutputLength: 500,
  showFullOutput: false,
  showArgs: true,
  showTiming: true,
  theme: "dark",
};

export interface ToolRenderResult {
  /** Main display text */
  title: string;
  /** Detailed content */
  content: string;
  /** Icon/emoji */
  icon: string;
  /** Status color */
  statusColor: "default" | "success" | "error" | "warning" | "info";
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Whether output is truncated */
  truncated?: boolean;
}

// ========== Tool Renderer Interface ==========
export interface ToolRenderer {
  renderToolUse(name: string, args: Record<string, unknown>, toolCallId: string): ToolRenderResult;
  renderToolResult(result: ToolCallResult): ToolRenderResult;
  renderToolError(error: string, toolCallId: string): ToolRenderResult;
  renderToolGrouped(toolCalls: ToolCallResult[]): ToolRenderResult;
  renderToolProgress(name: string, args: Record<string, unknown>): ToolRenderResult;
  renderToolPending(name: string, args: Record<string, unknown>): ToolRenderResult;
  renderToolTimeout(name: string, timeout: number): ToolRenderResult;
  renderToolAborted(name: string): ToolRenderResult;
}

// ========== Default Tool Renderer ==========
export class DefaultToolRenderer implements ToolRenderer {
  private config: ToolRenderConfig;

  constructor(config?: Partial<ToolRenderConfig>) {
    this.config = { ...DEFAULT_RENDER_CONFIG, ...config };
  }

  /** Render tool use (when tool is called) */
  renderToolUse(name: string, args: Record<string, unknown>, toolCallId: string): ToolRenderResult {
    const icon = this.getToolIcon(name);
    const argsSummary = this.summarizeArgs(name, args);

    return {
      title: `${icon} ${name}`,
      content: argsSummary,
      icon,
      statusColor: "info",
      metadata: { toolCallId, args },
    };
  }

  /** Render tool result (when tool completes) */
  renderToolResult(result: ToolCallResult): ToolRenderResult {
    const icon = this.getToolIcon(result.name);
    const output = result.output || "";
    const isTruncated = output.length > this.config.maxOutputLength;
    const displayOutput = isTruncated
      ? output.substring(0, this.config.maxOutputLength) + "..."
      : output;

    return {
      title: `${icon} ${result.name}`,
      content: displayOutput,
      icon,
      statusColor: result.status === "completed" ? "success" : "error",
      truncated: isTruncated || undefined,
      metadata: {
        toolCallId: result.id,
        status: result.status,
        outputLength: output.length,
      },
    };
  }

  /** Render tool error */
  renderToolError(error: string, toolCallId: string): ToolRenderResult {
    return {
      title: "❌ Error",
      content: error,
      icon: "❌",
      statusColor: "error",
      metadata: { toolCallId },
    };
  }

  /** Render grouped tool calls */
  renderToolGrouped(toolCalls: ToolCallResult[]): ToolRenderResult {
    const completed = toolCalls.filter((t) => t.status === "completed").length;
    const failed = toolCalls.filter((t) => t.status === "error").length;
    const total = toolCalls.length;

    const summary = toolCalls.map((t) => {
      const icon = this.getToolIcon(t.name);
      return `${icon} ${t.name}: ${t.status === "completed" ? "✓" : "✗"}`;
    }).join("\n");

    return {
      title: `🔧 ${total} tools (${completed}✓ ${failed}✗)`,
      content: summary,
      icon: "🔧",
      statusColor: failed > 0 ? "error" : "success",
      metadata: { completed, failed, total },
    };
  }

  /** Render tool progress (while running) */
  renderToolProgress(name: string, args: Record<string, unknown>): ToolRenderResult {
    const argsSummary = this.summarizeArgs(name, args);

    return {
      title: `⏳ ${name}`,
      content: argsSummary,
      icon: "⏳",
      statusColor: "warning",
      metadata: { running: true },
    };
  }

  /** Render tool pending (queued) */
  renderToolPending(name: string, _args: Record<string, unknown>): ToolRenderResult {
    return {
      title: `⏸ ${name}`,
      content: "Waiting to execute...",
      icon: "⏸",
      statusColor: "default",
      metadata: { pending: true },
    };
  }

  /** Render tool timeout */
  renderToolTimeout(name: string, timeout: number): ToolRenderResult {
    return {
      title: `⏰ ${name}`,
      content: `Timed out after ${timeout}ms`,
      icon: "⏰",
      statusColor: "error",
      metadata: { timeout },
    };
  }

  /** Render tool aborted */
  renderToolAborted(name: string): ToolRenderResult {
    return {
      title: `🚫 ${name}`,
      content: "Execution aborted",
      icon: "🚫",
      statusColor: "warning",
      metadata: { aborted: true },
    };
  }

  // ========== Helper Methods ==========

  private getToolIcon(name: string): string {
    const icons: Record<string, string> = {
      bash: "💻",
      read: "📖",
      write: "📝",
      edit: "✏️",
      glob: "🔍",
      grep: "🔎",
      webfetch: "🌐",
      websearch: "🔍",
      notebook: "📓",
      plan: "📋",
      question: "❓",
      actor: "🤖",
      task: "📋",
      memory: "🧠",
      skill: "🛠️",
      load_skill: "🛠️",
      web_search: "🔎",
      read_attachment: "📎",
      workflow: "🔄",
      lsp: "📡",
    };
    return icons[name] || "🔧";
  }

  private summarizeArgs(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case "bash":
        return `$ ${args.command || ""}`;
      case "read":
        return `${args.path || ""}`;
      case "write":
        return `${args.path || ""} (${(args.content as string)?.length || 0} chars)`;
      case "edit":
        return `${args.path || ""}`;
      case "glob":
        return `${args.pattern || ""}`;
      case "grep":
        return `${args.pattern || ""} in ${args.path || "."}`;
      case "webfetch":
        return `${args.url || ""}`;
      case "websearch":
        return `${args.query || ""}`;
      case "load_skill":
        return `skill: ${args.skill_name || ""}`;
      case "web_search":
        return `query: ${args.query || ""}`;
      case "read_attachment":
        return `attachment: ${args.attachment_id || args.name || ""}`;
      default:
        if (this.config.showArgs) {
          const argStr = JSON.stringify(args);
          return argStr.length > 100 ? argStr.substring(0, 100) + "..." : argStr;
        }
        return "";
    }
  }

  /** Update config */
  updateConfig(config: Partial<ToolRenderConfig>) {
    this.config = { ...this.config, ...config };
  }
}

// ========== Tool Render Registry ==========
export class ToolRenderRegistry {
  private renderers: Map<string, ToolRenderer> = new Map();
  private defaultRenderer: ToolRenderer;

  constructor(defaultRenderer?: ToolRenderer) {
    this.defaultRenderer = defaultRenderer || new DefaultToolRenderer();
  }

  /** Register a custom renderer for a tool */
  register(toolName: string, renderer: ToolRenderer) {
    this.renderers.set(toolName, renderer);
  }

  /** Get renderer for a tool */
  get(toolName: string): ToolRenderer {
    return this.renderers.get(toolName) || this.defaultRenderer;
  }

  /** Get default renderer */
  getDefault(): ToolRenderer {
    return this.defaultRenderer;
  }

  /** Set default renderer */
  setDefault(renderer: ToolRenderer) {
    this.defaultRenderer = renderer;
  }
}

// ========== Singleton ==========
let registryInstance: ToolRenderRegistry | null = null;

export function getToolRenderRegistry(): ToolRenderRegistry {
  if (!registryInstance) {
    registryInstance = new ToolRenderRegistry();
  }
  return registryInstance;
}
