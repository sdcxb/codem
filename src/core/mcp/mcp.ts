// ========== MCP Types ==========
import { getSettingJSON, setSettingJSON } from "../storage/settings";

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
      }

      connection.status = "connected";
      connection.tools = await this.listTools(config.name);
    } catch (error: any) {
      connection.status = "error";
      connection.error = error.message;
    }

    return connection;
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
      } catch {}
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
      const result = await this.sendRequest(serverName, "tools/list", {});
      return result.tools || [];
    } catch {
      return [];
    }
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

    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...config.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.requestId,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
              name: "codem",
              version: "0.1.0",
            },
          },
        }),
        signal: AbortSignal.timeout(config.timeout || 5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || "Connection failed");
      }
    } catch (error: any) {
      throw new Error(`Failed to connect to ${config.url}: ${error.message}`);
    }
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
    } catch {}
  }

  /** Save configs to SQLite */
  private saveConfigs() {
    try {
      setSettingJSON("codem-mcp-servers", this.configs);
    } catch {}
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

// ========== Singleton ==========
let instance: MCPRegistry | null = null;

export function getMCPRegistry(): MCPRegistry {
  if (!instance) {
    instance = new MCPRegistry();
  }
  return instance;
}
