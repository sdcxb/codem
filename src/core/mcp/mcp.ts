// ========== MCP Types ==========
import { getSettingJSON, setSettingJSON, getSetting, setSetting } from "../storage/settings";
import { reportPersistFailure } from "../storage/persist-failure";

export interface MCPServerConfig {
  /** Server name */
  name: string;
  /** Transport type */
  transport: "stdio" | "http" | "sse";
  /** For stdio: command to run */
  command?: string;
  /** For stdio: arguments */
  args?: string[];
  /** For stdio: environment variables */
  env?: Record<string, string>;
  /** For http/sse: server URL */
  url?: string;
  /** For http/sse: auth headers */
  headers?: Record<string, string>;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether to auto-reconnect */
  autoReconnect?: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolResult {
  id: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

export interface MCPServerStatus {
  name: string;
  connected: boolean;
  tools: MCPTool[];
  error?: string;
  lastConnected?: number;
}

// ========== MCP Connection ==========
export interface MCPConnection {
  config: MCPServerConfig;
  status: "disconnected" | "connecting" | "connected" | "error";
  tools: MCPTool[];
  error?: string;
}

// ========== MCP Client ==========
export class MCPClient {
  private connections: Map<string, MCPConnection> = new Map();
  private requestId = 0;

  /** Connect to an MCP server */
  async connect(config: MCPServerConfig): Promise<MCPConnection> {
    const connection: MCPConnection = {
      config,
      status: "connecting",
      tools: [],
    };

    this.connections.set(config.name, connection);

    try {
      if (config.transport === "stdio") {
        await this.connectStdio(config, connection);
      } else if (config.transport === "http" || config.transport === "sse") {
        await this.connectHTTP(config, connection);
      } else {
        throw new Error(`Unsupported transport "${(config as any).transport}"`);
      }

      /**
       * 第 84 波（B 类缺陷：假成功）：**必须先握手并真的拿到工具清单才算连上**。
       *
       * 原来这里只做两件事：spawn 进程（或发一次 HTTP initialize）→ 直接写
       * `status = "connected"`，然后 `listTools()`（它把所有异常吞成 `[]`）。
       * 结果：命令拼错、进程秒退、tools/list 被拒 —— 界面一律显示"已连接、0 个工具"，
       * 用户没有任何线索，MCP 工具只是静默不存在。
       */
      const handshakeInfo = await this.handshake(config.name);
      if (handshakeInfo) {
        console.log(`[MCP] ${config.name} 握手完成：${handshakeInfo}`);
      }

      connection.status = "connected";
      connection.tools = await this.fetchTools(config.name);
      connection.error = undefined;
    } catch (error: any) {
      connection.status = "error";
      connection.error = error?.message || String(error);
      connection.tools = [];
      console.warn(`[MCP] ${config.name} 连接失败：${connection.error}`);
    }

    return connection;
  }

  /**
   * MCP 握手（initialize）：确认对端真的按 MCP 协议应答，而不是"进程起来了"。
   * @returns 协商到的服务端描述（可为空字符串）
   */
  private async handshake(serverName: string): Promise<string> {
    const result = await this.sendRequest(serverName, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codem", version: "0.1.0" },
    });
    if (!result || typeof result !== "object") {
      throw new Error("initialize 未返回 JSON-RPC 结果（对端可能不是 MCP 服务）");
    }
    if (!result.protocolVersion && !result.serverInfo && !result.capabilities) {
      throw new Error(`initialize 返回内容不符合 MCP 规范：${JSON.stringify(result).slice(0, 160)}`);
    }
    const info = result.serverInfo;
    return info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}` : String(result.protocolVersion ?? "");
  }

  /** Disconnect from an MCP server */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    // If stdio transport, kill the process via Tauri
    if (connection.config.transport === "stdio") {
      try {
        const { invoke } = (window as any).__TAURI__.core;
        await invoke("mcp_stdio_disconnect", { name: serverName });
      } catch (e) { console.warn('[mcp.ts]', e) }
    }

    connection.status = "disconnected";
    this.connections.delete(serverName);
  }

  /** Get all connected servers */
  getConnections(): MCPConnection[] {
    return Array.from(this.connections.values());
  }

  /** Get connection status */
  getStatus(serverName: string): MCPConnection | undefined {
    return this.connections.get(serverName);
  }

  /** List tools from a server */
  async listTools(serverName: string): Promise<MCPTool[]> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== "connected") return [];

    try {
      const tools = await this.fetchTools(serverName);
      connection.tools = tools;
      connection.error = undefined;
      return tools;
    } catch (e: any) {
      // 第 84 波：原来任何失败都 `return []` —— 与"服务器确实没有工具"无法区分。
      // 现在把原因挂到连接状态上（UI/status 可见），并写日志。
      connection.error = `tools/list 失败：${e?.message || e}`;
      console.warn(`[MCP] ${serverName} ${connection.error}`);
      return [];
    }
  }

  /** 拉取工具清单（内部）：失败就抛，由调用方决定降级策略 */
  private async fetchTools(serverName: string): Promise<MCPTool[]> {
    const result = await this.sendRequest(serverName, "tools/list", {});
    const tools = result?.tools;
    if (!Array.isArray(tools)) {
      throw new Error(
        `tools/list 未返回工具数组：${JSON.stringify(result ?? null).slice(0, 160)}`,
      );
    }
    return tools as MCPTool[];
  }

  /** Call a tool on a server */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== "connected") {
      return {
        id: `err-${Date.now()}`,
        content: [{ type: "text", text: `Server ${serverName} not connected` }],
        isError: true,
      };
    }

    try {
      const result = await this.sendRequest(serverName, "tools/call", {
        name: toolName,
        arguments: args,
      });
      return {
        id: result.id || `call-${Date.now()}`,
        content: result.content || [],
        isError: result.isError,
      };
    } catch (error: any) {
      return {
        id: `err-${Date.now()}`,
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
  }

  /** Get all tools from all connected servers */
  getAllTools(): Array<MCPTool & { server: string }> {
    const tools: Array<MCPTool & { server: string }> = [];
    for (const [name, connection] of this.connections) {
      if (connection.status === "connected") {
        for (const tool of connection.tools) {
          tools.push({ ...tool, server: name });
        }
      }
    }
    return tools;
  }

  // ========== Internal Methods ==========

  private async connectStdio(config: MCPServerConfig, _connection: MCPConnection): Promise<void> {
    // Use Tauri command to spawn stdio MCP process
    try {
      const { invoke } = (window as any).__TAURI__.core;
      await invoke("mcp_stdio_connect", {
        name: config.name,
        command: config.command,
        args: config.args,
        env: config.env,
      });
    } catch (error: any) {
      throw new Error(`Stdio connection failed: ${error.message}`);
    }
  }

  private async connectHTTP(config: MCPServerConfig, _connection: MCPConnection): Promise<void> {
    if (!config.url) throw new Error("URL required for HTTP transport");
    // 第 84 波：连通性/协议校验统一交给 handshake()（原来这里另发一次 initialize，
    // 与 handshake 重复，而且失败时也只写一个笼统的 error 字符串）。
  }

  private async sendRequest(serverName: string, method: string, params: Record<string, unknown>): Promise<any> {
    const connection = this.connections.get(serverName);
    if (!connection) throw new Error(`Server ${serverName} not found`);

    const config = connection.config;
    const id = ++this.requestId;

    if (config.transport === "http" || config.transport === "sse") {
      if (!config.url) throw new Error("URL required for HTTP transport");

      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...config.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
        signal: AbortSignal.timeout(config.timeout || 30000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || "Request failed");
      }

      return data.result;
    }

    // For stdio, use Tauri command to send request and receive response
    try {
      const { invoke } = (window as any).__TAURI__.core;
      const responseStr = await invoke("mcp_stdio_request", {
        name: serverName,
        message: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
      });
      const data = JSON.parse(responseStr);
      if (data.error) {
        throw new Error(data.error.message || "Request failed");
      }
      return data.result ?? data;
    } catch (error: any) {
      throw new Error(`Stdio request failed: ${error.message}`);
    }
  }
}

// ========== MCP Registry ==========
export class MCPRegistry {
  private client: MCPClient;
  private configs: MCPServerConfig[] = [];

  constructor() {
    this.client = new MCPClient();
    this.loadConfigs();
  }

  /** Load configs from SQLite */
  private loadConfigs() {
    try {
      this.configs = getSettingJSON<MCPServerConfig[]>("codem-mcp-servers", []);
    } catch (e) { console.warn('[mcp.ts]', e) }
  }

  /** Save configs to SQLite */
  private saveConfigs() {
    try {
      setSettingJSON("codem-mcp-servers", this.configs);
    } catch (e) { reportPersistFailure("mcp.saveConfigs", e); }
  }

  /** Add a server config */
  addServer(config: MCPServerConfig) {
    this.configs.push(config);
    this.saveConfigs();
  }

  /** Update an existing server config by name */
  updateServer(name: string, config: MCPServerConfig) {
    const idx = this.configs.findIndex((c) => c.name === name);
    if (idx >= 0) {
      // If name changed, disconnect old and use new
      if (name !== config.name) {
        this.client.disconnect(name);
      }
      this.configs[idx] = config;
      this.saveConfigs();
    }
  }

  /** Remove a server config */
  removeServer(name: string) {
    this.configs = this.configs.filter((c) => c.name !== name);
    this.saveConfigs();
    this.client.disconnect(name);
  }

  /** Get all configs */
  getConfigs(): MCPServerConfig[] {
    return [...this.configs];
  }

  /** Connect to a specific server */
  async connect(config: MCPServerConfig): Promise<MCPServerStatus> {
    try {
      await this.client.connect(config);
      const connection = this.client.getStatus(config.name);
      return {
        name: config.name,
        connected: connection?.status === "connected",
        tools: connection?.tools || [],
        error: connection?.error,
        lastConnected: connection?.status === "connected" ? Date.now() : undefined,
      };
    } catch (error: any) {
      return {
        name: config.name,
        connected: false,
        tools: [],
        error: error.message,
      };
    }
  }

  /** Disconnect from a server */
  async disconnect(serverName: string): Promise<void> {
    await this.client.disconnect(serverName);
  }

  /** Connect to all configured servers */
  async connectAll(): Promise<MCPServerStatus[]> {
    const statuses: MCPServerStatus[] = [];

    for (const config of this.configs) {
      try {
        await this.client.connect(config);
        const connection = this.client.getStatus(config.name);
        statuses.push({
          name: config.name,
          connected: connection?.status === "connected",
          tools: connection?.tools || [],
          error: connection?.error,
          lastConnected: connection?.status === "connected" ? Date.now() : undefined,
        });
      } catch (error: any) {
        statuses.push({
          name: config.name,
          connected: false,
          tools: [],
          error: error.message,
        });
      }
    }

    return statuses;
  }

  /** Get all available MCP tools */
  getAllTools(): Array<MCPTool & { server: string }> {
    return this.client.getAllTools();
  }

  /** Call a tool */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    return this.client.callTool(serverName, toolName, args);
  }

  /** Get the underlying client */
  getClient(): MCPClient {
    return this.client;
  }
}

// ========== CodeGraph Auto-Detection ==========

/** The MCP server name used for CodeGraph integration */
export const CODEGRAPH_SERVER_NAME = "codegraph";

/** Check if CodeGraph is enabled in settings (default: true) */
export function isCodeGraphEnabled(): boolean {
  try {
    return getSetting("codem-codegraph-enabled") !== "false";
  } catch {
    return true;
  }
}

/** Enable or disable CodeGraph integration */
export function setCodeGraphEnabled(enabled: boolean): void {
  try {
    setSetting("codem-codegraph-enabled", enabled ? "true" : "false");
  } catch (e) { reportPersistFailure("mcp.setCodeGraphEnabled", e); }
}

/** Check if a project has a .codegraph/ directory (graph already built) */
export async function hasCodeGraphIndex(projectPath: string): Promise<boolean> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    return await invoke("path_exists", { path: `${projectPath}/.codegraph` });
  } catch {
    return false;
  }
}

/** Check if codegraph CLI is available on the system */
export async function isCodeGraphInstalled(): Promise<boolean> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const result = await invoke("execute_command", {
      command: "codegraph --version",
      cwd: null,
    });
    // 第 84 波：原来只看 stderr 里有没有 "not recognized"。命令存在但返回非零
    // （例如参数不对、启动器坏了）也算"已安装"，后续 autoDetect 就会去连一个连不上的服务。
    // 退出码是唯一可靠信号：0 = 真的能跑。
    const code = typeof result?.exitCode === "number" ? result.exitCode : (result?.exitCode === null ? 1 : 0);
    if (code !== 0) {
      console.warn(
        `[CodeGraph] codegraph --version 退出码 ${code}：${String(result?.stderr || result?.stdout || "").trim().slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-detect CodeGraph in a project and register as MCP server.
 * Called when a project is opened or a chat session starts.
 * Returns true if CodeGraph MCP was connected (or already connected).
 */
export async function autoDetectCodeGraph(
  registry: MCPRegistry,
  projectPath: string
): Promise<boolean> {
  if (!isCodeGraphEnabled()) return false;
  if (!projectPath) return false;

  // Check if .codegraph/ exists in the project
  const hasIndex = await hasCodeGraphIndex(projectPath);
  if (!hasIndex) return false;

  // Check if already connected
  const existing = registry.getClient().getStatus(CODEGRAPH_SERVER_NAME);
  if (existing?.status === "connected") return true;

  // Connect to codegraph MCP server (stdio transport)
  // 命令优先用应用内一键安装记下的启动器绝对路径（codem-codegraph-launcher，
  // 如 %LOCALAPPDATA%\codegraph\current\bin\codegraph.cmd——Rust spawn 对 .cmd
  // 用 cmd.exe /c 包装）；未安装过则回退 PATH 里的 'codegraph'。
  try {
    const { getSetting } = await import("../storage/settings");
    const launcher = getSetting("codem-codegraph-launcher") || "codegraph";
    const status = await registry.connect({
      name: CODEGRAPH_SERVER_NAME,
      transport: "stdio",
      command: launcher,
      args: ["mcp"],
      autoReconnect: true,
    });
    // 第 84 波（假成功）：原来无脑 `return true` —— 即使 connect 把状态标成 error
    // （命令不存在/握手失败/tools/list 被拒），调用方仍以为 CodeGraph 已可用。
    if (!status?.connected) {
      console.warn(
        `[CodeGraph] MCP 未连接成功（${status?.error || "未知原因"}）—— 本次会话不会有 codegraph_* 工具`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error("[CodeGraph] Failed to connect MCP server:", error);
    return false;
  }
}

/** Disconnect CodeGraph MCP server (when disabled or project changes) */
export async function disconnectCodeGraph(registry: MCPRegistry): Promise<void> {
  try {
    await registry.disconnect(CODEGRAPH_SERVER_NAME);
  } catch (e) { console.warn('[mcp.ts]', e) }
}

/** Check if CodeGraph MCP tools are currently available */
export function hasCodeGraphTools(registry: MCPRegistry): boolean {
  const tools = registry.getAllTools();
  return tools.some(
    (t) => t.server === CODEGRAPH_SERVER_NAME || t.name.startsWith("codegraph_")
  );
}

// ========== Singleton ==========
let instance: MCPRegistry | null = null;

export function getMCPRegistry(): MCPRegistry {
  if (!instance) {
    instance = new MCPRegistry();
  }
  return instance;
}
