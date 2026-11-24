import { useState, useEffect, useCallback } from "react";
import { getMCPRegistry, type MCPServerConfig, type MCPServerStatus } from "../core/mcp/mcp";
import { PanelIcons, ActionIcons, McpIcons, MarketIcons } from "../core/icons/icon-map";
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
import { McpMarketplace } from "./McpMarketplace";

interface McpManagerProps {
  onClose: () => void;
}

/** 空服务器配置模板 */
function emptyConfig(): MCPServerConfig {
  return { name: "", transport: "http", url: "", timeout: 5000 };
}

/**
 * 异常 → 一句可读原因。
 *
 * 本轮修的是一整类缺陷：**异步点击处理器只有 `try/finally`（或者没有 `try`）**，
 * promise 一旦 reject，用户要么看不到任何原因，要么看着「连接中...」永远不收尾。
 * 所有 catch 都按同一口径说话：**命令 + 原因**。
 */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function McpManager({ onClose }: McpManagerProps) {
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [statuses, setStatuses] = useState<Map<string, MCPServerStatus>>(new Map());
  const [showAdd, setShowAdd] = useState(false);
  const [editingServer, setEditingServer] = useState<{ originalName: string; config: MCPServerConfig } | null>(null);
  const [newServer, setNewServer] = useState<MCPServerConfig>(emptyConfig());
  /**
   * 正在连接中的服务器名。**单条「连接」与「全部连接」共用这一份状态** —— 于是
   * 「连接中…」的文案与"点不动"的语义只有一套，批量路径不会长出第二套说法。
   */
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  /** 「全部连接」是否正在进行（按钮的进行中态；也是重复点击的闸门） */
  const [connectingAll, setConnectingAll] = useState(false);
  /** 「全部连接」整批失败的原因 —— 单条失败进各自的状态行，整批失败没有"那一行"，得单独说 */
  const [connectAllError, setConnectAllError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [showMarketplace, setShowMarketplace] = useState(false);

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

  /** 把若干服务器标记为「连接中」/取消标记（单条与批量共用） */
  const markConnecting = useCallback((names: string[], on: boolean) => {
    setConnecting((prev) => {
      const next = new Set(prev);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });
  }, []);

  // 连接/断开
  const handleConnect = async (config: MCPServerConfig) => {
    markConnecting([config.name], true);
    setConnectAllError(null);
    try {
      const registry = getMCPRegistry();
      const status = await registry.connect(config);
      setStatuses((prev) => new Map(prev).set(config.name, status));
    } catch (e) {
      /*
       * 改前没有 try：`registry.connect` reject ⇒ `markConnecting(false)` 永远跑不到，
       * 这一行就永久停在「连接中...」且按钮点不动。
       * 失败写进 status（面板本来就用「错误 + 原因」这一行展示连接失败），
       * 但 connected 必须是 false —— 不许把失败演成"连上了"。
       */
      setStatuses((prev) => new Map(prev).set(config.name, {
        name: config.name,
        connected: false,
        tools: [],
        error: `连接「${config.name}」失败：${reasonOf(e)}`,
      }));
    } finally {
      markConnecting([config.name], false);
    }
  };

  const handleDisconnect = async (name: string) => {
    try {
      const registry = getMCPRegistry();
      await registry.disconnect(name);
      setStatuses((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
    } catch (e) {
      /*
       * 改前没有 try：断开失败静默，状态仍显示「已连接」——用户不知道到底断没断。
       * 这里**保留**原状态（connected 不变）并只加一行原因：断开没有成功，
       * 谎报「未连接」比不说更糟。
       */
      setStatuses((prev) => {
        const next = new Map(prev);
        const current = prev.get(name);
        next.set(name, {
          ...(current ?? { name, connected: true, tools: [] }),
          error: `断开「${name}」失败：${reasonOf(e)}`,
        });
        return next;
      });
    }
  };

  /**
   * 「全部连接」：**并发**发起，且**每一条一有结果就更新它自己**（第 184 波修 G8）。
   *
   * 改前是 `await registry.connectAll()` 把结果收齐，再一次性 `setStatuses`：
   * 期间不置「连接中」，已连上的条目也不更新 ⇒ 一台服务器卡住，用户就看到整块面板
   * 停在"未连接"上（连接本身还是串行的，见 `mcp.ts` 的 `connectAll`）。
   */
  const handleConnectAll = async () => {
    // 进行中直接忽略：真机上 DOM 会吞掉 disabled 按钮的点击，这层是兜底（判据 MCP-ALL-6）
    if (connectingAll) return;
    const registry = getMCPRegistry();
    const names = registry.getConfigs().map((c) => c.name);

    setConnectingAll(true);
    setConnectAllError(null);
    markConnecting(names, true);
    try {
      await registry.connectAll((status) => {
        // 逐条：这一条刚有结果就写它的状态，并把它从「连接中」里摘掉 —— 不等其余
        setStatuses((prev) => new Map(prev).set(status.name, status));
        markConnecting([status.name], false);
      });
    } catch (e) {
      /*
       * 改前只有 `finally`、**没有 catch**：进行中态会复位，但整批 reject 之后
       * 用户**一个字都看不到**（既没有错误行，也没有任何提示）。
       * 单条失败在 `connectAll` 内部已经各自成 status；能走到这里的只有整批级失败。
       */
      setConnectAllError(`全部连接失败：${reasonOf(e)}`);
    } finally {
      // 兜底：正常路径下每条都在回调里摘过了，这里只清"回调没跑到"的那些名字
      markConnecting(names, false);
      setConnectingAll(false);
    }
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
          <ServerIcon className="icon-lg mcp-manager-icon-svg" />
          <span>MCP 服务器管理</span>
        </div>
        {/* 第 61 轮：补可访问名（真机普查：该面板内唯一无名按钮就是它，且面板内没有任何"关闭/close"名字的按钮） */}
        <button className="mcp-manager-close" aria-label="关闭面板 / Close panel" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </div>

      {/* Actions */}
      <div className="mcp-manager-actions">
        <button className="mcp-action-btn marketplace-btn" onClick={() => setShowMarketplace(true)}>
          <MarketIcons.store size={14} aria-hidden style={{ marginRight: 4 }} />
          服务器目录
        </button>
        <button
          className={`mcp-action-btn connect-all-btn${connectingAll ? " busy" : ""}`}
          onClick={handleConnectAll}
          disabled={connectingAll}
          aria-busy={connectingAll}
        >
          <RefreshIcon size={14} />
          {connectingAll ? "全部连接中..." : "全部连接"}
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

      {/* 整批失败的原因（单条失败在各自的状态行里说） */}
      {connectAllError && (
        <div className="mcp-json-error" role="alert">{connectAllError}</div>
      )}

      {/* Server List */}
      <div className="mcp-server-list">
        {servers.length === 0 && (
          <div className="empty-hint">暂无 MCP 服务器</div>
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
                    disabled={connecting.has(server.name)}
                  >
                    <ConnectIcon size={14} />
                    {connecting.has(server.name) ? "连接中..." : "连接"}
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

      {/* MCP Marketplace */}
      {showMarketplace && (
        <McpMarketplace onClose={() => { setShowMarketplace(false); loadServers(); }} />
      )}
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
