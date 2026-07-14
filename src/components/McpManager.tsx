import { useState, useEffect } from "react";
import { getMCPRegistry, type MCPServerConfig, type MCPServerStatus } from "../core/mcp/mcp";

interface McpManagerProps {
  onClose: () => void;
}

export function McpManager({ onClose }: McpManagerProps) {
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [statuses, setStatuses] = useState<Map<string, MCPServerStatus>>(new Map());
  const [showAdd, setShowAdd] = useState(false);
  const [newServer, setNewServer] = useState<MCPServerConfig>({
    name: "",
    transport: "http",
    url: "",
    timeout: 5000,
  });
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    loadServers();
  }, []);

  const loadServers = () => {
    const registry = getMCPRegistry();
    setServers(registry.getConfigs());
  };

  const handleAdd = () => {
    if (!newServer.name) return;
    const registry = getMCPRegistry();
    registry.addServer(newServer);
    setNewServer({ name: "", transport: "http", url: "", timeout: 5000 });
    setShowAdd(false);
    loadServers();
  };

  const handleRemove = (name: string) => {
    const registry = getMCPRegistry();
    registry.removeServer(name);
    loadServers();
  };

  const handleConnect = async (config: MCPServerConfig) => {
    setConnecting(config.name);
    const registry = getMCPRegistry();
    const status = await registry.connect(config);
    setStatuses((prev) => new Map(prev).set(config.name, status));
    setConnecting(null);
  };

  const handleDisconnect = async (name: string) => {
    const registry = getMCPRegistry();
    await registry.disconnect(name);
    setStatuses((prev) => {
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  };

  const handleConnectAll = async () => {
    const registry = getMCPRegistry();
    const results = await registry.connectAll();
    const map = new Map<string, MCPServerStatus>();
    for (const r of results) map.set(r.name, r);
    setStatuses(map);
  };

  return (
    <div className="mcp-manager">
      <div className="mcp-manager-header">
        <div className="mcp-manager-title">
          <span className="mcp-manager-icon">🔌</span>
          <span>MCP 服务器管理</span>
        </div>
        <button className="mcp-manager-close" onClick={onClose}>✕</button>
      </div>

      <div className="mcp-manager-actions">
        <button className="mcp-action-btn" onClick={handleConnectAll}>
          🔄 全部连接
        </button>
        <button className="mcp-action-btn" onClick={() => setShowAdd(true)}>
          + 添加服务器
        </button>
      </div>

      {showAdd && (
        <div className="mcp-add-form">
          <div className="mcp-form-row">
            <label>名称</label>
            <input
              type="text"
              value={newServer.name}
              onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
              placeholder="my-mcp-server"
            />
          </div>
          <div className="mcp-form-row">
            <label>传输方式</label>
            <select
              value={newServer.transport}
              onChange={(e) => setNewServer({ ...newServer, transport: e.target.value as "stdio" | "http" | "sse" })}
            >
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
              <option value="stdio">Stdio</option>
            </select>
          </div>
          {newServer.transport !== "stdio" ? (
            <div className="mcp-form-row">
              <label>URL</label>
              <input
                type="text"
                value={newServer.url || ""}
                onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
                placeholder="http://localhost:3000"
              />
            </div>
          ) : (
            <>
              <div className="mcp-form-row">
                <label>命令</label>
                <input
                  type="text"
                  value={newServer.command || ""}
                  onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                  placeholder="npx"
                />
              </div>
              <div className="mcp-form-row">
                <label>参数</label>
                <input
                  type="text"
                  value={(newServer.args || []).join(" ")}
                  onChange={(e) => setNewServer({ ...newServer, args: e.target.value.split(" ").filter(Boolean) })}
                  placeholder="-y @modelcontextprotocol/server-filesystem"
                />
              </div>
            </>
          )}
          <div className="mcp-form-row">
            <label>超时 (ms)</label>
            <input
              type="number"
              value={newServer.timeout || 5000}
              onChange={(e) => setNewServer({ ...newServer, timeout: parseInt(e.target.value) || 5000 })}
            />
          </div>
          <div className="mcp-form-actions">
            <button className="mcp-form-btn cancel" onClick={() => setShowAdd(false)}>取消</button>
            <button className="mcp-form-btn confirm" onClick={handleAdd} disabled={!newServer.name}>添加</button>
          </div>
        </div>
      )}

      <div className="mcp-server-list">
        {servers.length === 0 && (
          <div className="mcp-empty">暂无 MCP 服务器</div>
        )}
        {servers.map((server) => {
          const status = statuses.get(server.name);
          return (
            <div key={server.name} className={`mcp-server-item ${status?.connected ? "connected" : ""}`}>
              <div className="mcp-server-header">
                <div className="mcp-server-info">
                  <span className="mcp-server-name">{server.name}</span>
                  <span className="mcp-server-transport">{server.transport}</span>
                </div>
                <div className="mcp-server-status">
                  {status?.connected ? (
                    <span className="mcp-status-dot connected">● 已连接</span>
                  ) : status?.error ? (
                    <span className="mcp-status-dot error">● 错误</span>
                  ) : (
                    <span className="mcp-status-dot disconnected">○ 未连接</span>
                  )}
                </div>
              </div>

              <div className="mcp-server-url">
                {server.transport === "stdio"
                  ? `${server.command} ${(server.args || []).join(" ")}`
                  : server.url || "-"}
              </div>

              {status?.tools && status.tools.length > 0 && (
                <div className="mcp-server-tools">
                  <span className="mcp-tools-label">工具:</span>
                  {status.tools.map((tool) => (
                    <span key={tool.name} className="mcp-tool-tag">{tool.name}</span>
                  ))}
                </div>
              )}

              {status?.error && (
                <div className="mcp-server-error">{status.error}</div>
              )}

              <div className="mcp-server-actions">
                {status?.connected ? (
                  <button
                    className="mcp-server-btn disconnect"
                    onClick={() => handleDisconnect(server.name)}
                  >
                    断开
                  </button>
                ) : (
                  <button
                    className="mcp-server-btn connect"
                    onClick={() => handleConnect(server)}
                    disabled={connecting === server.name}
                  >
                    {connecting === server.name ? "连接中..." : "连接"}
                  </button>
                )}
                <button
                  className="mcp-server-btn remove"
                  onClick={() => handleRemove(server.name)}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
