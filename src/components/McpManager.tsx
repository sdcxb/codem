import { useState, useEffect, useCallback } from "react";
import { getMCPRegistry, type MCPServerConfig, type MCPServerStatus } from "../core/mcp/mcp";
import { PanelIcons, ActionIcons, McpIcons } from "../core/icons/icon-map";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Badge } from "./ui/badge";

interface McpManagerProps {
  onClose: () => void;
}

/** 空服务器配置模板 */
function emptyConfig(): MCPServerConfig {
  return { name: "", transport: "http", url: "", timeout: 5000 };
}

export function McpManager({ onClose }: McpManagerProps) {
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [statuses, setStatuses] = useState<Map<string, MCPServerStatus>>(new Map());
  const [showAdd, setShowAdd] = useState(false);
  const [editingServer, setEditingServer] = useState<{ originalName: string; config: MCPServerConfig } | null>(null);
  const [newServer, setNewServer] = useState<MCPServerConfig>(emptyConfig());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const loadServers = useCallback(() => {
    const registry = getMCPRegistry();
    setServers(registry.getConfigs());
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  // 添加服务器
  const handleAdd = () => {
    if (!newServer.name) return;
    const registry = getMCPRegistry();
    registry.addServer(newServer);
    setNewServer(emptyConfig());
    setShowAdd(false);
    loadServers();
  };

  // 编辑服务器
  const handleEdit = (server: MCPServerConfig) => {
    setEditingServer({ originalName: server.name, config: { ...server } });
  };

  const handleSaveEdit = () => {
    if (!editingServer) return;
    const registry = getMCPRegistry();
    registry.updateServer(editingServer.originalName, editingServer.config);
    setEditingServer(null);
    loadServers();
  };

  // 删除服务器
  const handleDelete = () => {
    if (!deleteTarget) return;
    const registry = getMCPRegistry();
    registry.removeServer(deleteTarget);
    setDeleteTarget(null);
    loadServers();
  };

  // 连接/断开
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

  // JSON 导入
  const handleJsonImport = () => {
    setJsonError(null);
    try {
      const parsed = JSON.parse(jsonInput);
      const registry = getMCPRegistry();

      // 支持单个对象或数组
      const configs: MCPServerConfig[] = Array.isArray(parsed) ? parsed : [parsed];
      let imported = 0;

      for (const cfg of configs) {
        if (!cfg.name || !cfg.transport) continue;
        // 验证 transport
        if (!["stdio", "http", "sse"].includes(cfg.transport)) continue;
        registry.addServer(cfg);
        imported++;
      }

      if (imported === 0) {
        setJsonError("未找到有效的服务器配置。请检查 JSON 格式。");
        return;
      }

      setShowJsonImport(false);
      setJsonInput("");
      loadServers();
    } catch (err: any) {
      setJsonError(`JSON 解析失败: ${err.message}`);
    }
  };

  const ServerIcon = PanelIcons.mcp;
  const CloseIcon = ActionIcons.close;
  const AddIcon = ActionIcons.add;
  const EditIcon = ActionIcons.edit;
  const DeleteIcon = ActionIcons.delete;
  const RefreshIcon = ActionIcons.refresh;
  const ConnectIcon = McpIcons.connect;
  const ConnectedIcon = McpIcons.connected;
  const DisconnectIcon = McpIcons.disconnect;
  const JsonImportIcon = McpIcons.jsonImport;

  return (
    <div className="mcp-manager">
      {/* Header */}
      <div className="mcp-manager-header">
        <div className="mcp-manager-title">
          <ServerIcon size={20} className="mcp-manager-icon-svg" />
          <span>MCP 服务器管理</span>
        </div>
        <button className="mcp-manager-close" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </div>

      {/* Actions */}
      <div className="mcp-manager-actions">
        <button className="mcp-action-btn" onClick={handleConnectAll}>
          <RefreshIcon size={14} />
          全部连接
        </button>
        <button className="mcp-action-btn" onClick={() => setShowAdd(true)}>
          <AddIcon size={14} />
          添加服务器
        </button>
        <button className="mcp-action-btn" onClick={() => { setShowJsonImport(true); setJsonError(null); }}>
          <JsonImportIcon size={14} />
          JSON 导入
        </button>
      </div>

      {/* Add Form */}
      {showAdd && (
        <McpServerForm
          config={newServer}
          onChange={setNewServer}
          onSave={handleAdd}
          onCancel={() => { setShowAdd(false); setNewServer(emptyConfig()); }}
        />
      )}

      {/* Server List */}
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
                  {status?.connected ? (
                    <ConnectedIcon size={14} className="mcp-server-status-icon connected" />
                  ) : (
                    <ConnectIcon size={14} className="mcp-server-status-icon" />
                  )}
                  <span className="mcp-server-name">{server.name}</span>
                  <Badge variant="muted">{server.transport}</Badge>
                </div>
                <div className="mcp-server-status">
                  {status?.connected ? (
                    <span className="mcp-status-dot connected">已连接</span>
                  ) : status?.error ? (
                    <span className="mcp-status-dot error">错误</span>
                  ) : (
                    <span className="mcp-status-dot disconnected">未连接</span>
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
                    <Badge key={tool.name} variant="info">{tool.name}</Badge>
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
                    <DisconnectIcon size={14} />
                    断开
                  </button>
                ) : (
                  <button
                    className="mcp-server-btn connect"
                    onClick={() => handleConnect(server)}
                    disabled={connecting === server.name}
                  >
                    <ConnectIcon size={14} />
                    {connecting === server.name ? "连接中..." : "连接"}
                  </button>
                )}
                <button
                  className="mcp-server-btn edit"
                  onClick={() => handleEdit(server)}
                >
                  <EditIcon size={14} />
                  编辑
                </button>
                <button
                  className="mcp-server-btn remove"
                  onClick={() => setDeleteTarget(server.name)}
                >
                  <DeleteIcon size={14} />
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editingServer} onOpenChange={(open) => !open && setEditingServer(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑 MCP 服务器</DialogTitle>
            <DialogDescription>修改服务器配置，保存后生效。</DialogDescription>
          </DialogHeader>
          {editingServer && (
            <McpServerForm
              config={editingServer.config}
              onChange={(cfg) => setEditingServer({ ...editingServer, config: cfg })}
              onSave={handleSaveEdit}
              onCancel={() => setEditingServer(null)}
              isEdit
            />
          )}
        </DialogContent>
      </Dialog>

      {/* JSON Import Dialog */}
      <Dialog open={showJsonImport} onOpenChange={(open) => !open && setShowJsonImport(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>JSON 导入 MCP 服务器</DialogTitle>
            <DialogDescription>
              粘贴 MCP 服务器 JSON 配置。支持单个对象或数组格式。
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="mcp-json-input"
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            placeholder={`{\n  "name": "my-server",\n  "transport": "http",\n  "url": "http://localhost:3000",\n  "timeout": 5000\n}`}
            rows={10}
          />
          {jsonError && <div className="mcp-json-error">{jsonError}</div>}
          <DialogFooter>
            <button className="mcp-form-btn cancel" onClick={() => setShowJsonImport(false)}>取消</button>
            <button className="mcp-form-btn confirm" onClick={handleJsonImport} disabled={!jsonInput.trim()}>
              导入
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除 MCP 服务器 "{deleteTarget}" 吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ========== Server Form Component ==========

interface McpServerFormProps {
  config: MCPServerConfig;
  onChange: (config: MCPServerConfig) => void;
  onSave: () => void;
  onCancel: () => void;
  isEdit?: boolean;
}

function McpServerForm({ config, onChange, onSave, onCancel, isEdit }: McpServerFormProps) {
  return (
    <div className="mcp-add-form">
      <div className="mcp-form-row">
        <label>名称</label>
        <input
          type="text"
          value={config.name}
          onChange={(e) => onChange({ ...config, name: e.target.value })}
          placeholder="my-mcp-server"
          disabled={isEdit}
        />
      </div>
      <div className="mcp-form-row">
        <label>传输方式</label>
        <select
          value={config.transport}
          onChange={(e) => onChange({ ...config, transport: e.target.value as "stdio" | "http" | "sse" })}
        >
          <option value="http">HTTP</option>
          <option value="sse">SSE</option>
          <option value="stdio">Stdio</option>
        </select>
      </div>
      {config.transport !== "stdio" ? (
        <div className="mcp-form-row">
          <label>URL</label>
          <input
            type="text"
            value={config.url || ""}
            onChange={(e) => onChange({ ...config, url: e.target.value })}
            placeholder="http://localhost:3000"
          />
        </div>
      ) : (
        <>
          <div className="mcp-form-row">
            <label>命令</label>
            <input
              type="text"
              value={config.command || ""}
              onChange={(e) => onChange({ ...config, command: e.target.value })}
              placeholder="npx"
            />
          </div>
          <div className="mcp-form-row">
            <label>参数</label>
            <input
              type="text"
              value={(config.args || []).join(" ")}
              onChange={(e) => onChange({ ...config, args: e.target.value.split(" ").filter(Boolean) })}
              placeholder="-y @modelcontextprotocol/server-filesystem"
            />
          </div>
        </>
      )}
      <div className="mcp-form-row">
        <label>超时 (ms)</label>
        <input
          type="number"
          value={config.timeout || 5000}
          onChange={(e) => onChange({ ...config, timeout: parseInt(e.target.value) || 5000 })}
        />
      </div>
      <div className="mcp-form-actions">
        <button className="mcp-form-btn cancel" onClick={onCancel}>取消</button>
        <button className="mcp-form-btn confirm" onClick={onSave} disabled={!config.name}>
          {isEdit ? "保存" : "添加"}
        </button>
      </div>
    </div>
  );
}
