import { useState, useEffect } from "react";
import { PanelIcons, ActionIcons } from "../core/icons/icon-map";
import {
  getMemoryService,
  getWriteApprovalSetting,
  setWriteApprovalSetting,
  MEMORY_INJECT_KEY_MAX,
  type ApprovalScopeSetting,
  type MemoryBatch,
  type MemoryEntry,
  type MemoryScope,
  type MemorySearchResult,
  type MemorySource,
} from "../core/memory/memory";
import { formatMemoryImportReceipt } from "../core/memory/checkup";
import { getLLMEngine } from "../core/llm";
import { alertDialog } from "../core/ui/native-dialog";

interface MemoryManagerProps {
  onClose: () => void;
  /** 当前对话 id（对话级记忆的归属键）。缺省 ⇒ 对话级记忆显示"未归属，不进上下文" */
  sessionId?: string;
  /** 当前项目 id（项目级记忆的归属键，由工作目录推出）。缺省 ⇒ 项目级记忆显示"未归属" */
  projectId?: string;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN");
}

const SCOPE_ORDER: MemoryScope[] = ["platform", "project", "conversation"];

function getScopeLabel(scope: MemoryScope): string {
  switch (scope) {
    case "project": return "项目";
    case "conversation": return "对话";
    case "platform": return "平台";
    default: return scope;
  }
}

function getScopeColor(scope: MemoryScope): string {
  switch (scope) {
    case "project": return "var(--accent)";
    case "conversation": return "var(--success)";
    case "platform": return "var(--warning)";
    default: return "var(--text-muted)";
  }
}

/** 作用域 → 生效范围的一句话说明（界面要能自证"这条会/不会被注入"） */
function getScopeHint(scope: MemoryScope, entry?: MemoryEntry): string {
  switch (scope) {
    case "platform": return "所有项目、所有对话";
    case "project":
      return entry && !entry.projectId ? "无归属项目（不进任何上下文）" : "仅本项目内的所有对话";
    default:
      return entry && !entry.sessionId ? "无归属对话（不进任何上下文）" : "仅当前对话";
  }
}

function sourceLabel(source: MemorySource | undefined): string {
  return (source ?? "manual") === "manual" ? "手动" : "自动提取";
}

interface EditForm {
  key: string;
  content: string;
  scope: MemoryScope;
  source: MemorySource;
  tags: string;
  filePath: string;
}

const EMPTY_FORM: EditForm = {
  key: "",
  content: "",
  scope: "project",
  source: "manual",
  tags: "",
  filePath: "",
};

const MemoryIcon = PanelIcons.memory;
const CloseIcon = ActionIcons.close;
const SearchIcon = ActionIcons.search;
const EditIcon = ActionIcons.edit;
const DeleteIcon = ActionIcons.delete;

export function MemoryManager({ onClose, sessionId, projectId }: MemoryManagerProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [pending, setPending] = useState<MemoryEntry[]>([]);
  const [batches, setBatches] = useState<MemoryBatch[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [filterScope, setFilterScope] = useState<MemoryScope | "all" | "pending">("all");
  const [selectedEntry, setSelectedEntry] = useState<MemoryEntry | null>(null);
  const [approval, setApproval] = useState<ApprovalScopeSetting>(() => getWriteApprovalSetting());
  const [notice, setNotice] = useState("");
  const [stats, setStats] = useState({
    totalEntries: 0,
    byScope: { platform: 0, project: 0, conversation: 0 } as Record<MemoryScope, number>,
    bySource: { manual: 0, auto: 0 } as Record<MemorySource, number>,
    pendingEntries: 0,
    notInjected: 0,
    unknownScope: 0,
    legacyPool: 0,
  });
  /** F5：面板的「进不进上下文」判定（与注入侧同一处口径） */
  const [injection, setInjection] = useState<{
    injected: Set<string>;
    reasons: Map<string, string>;
    truncated: number;
    chars: number;
    budget: number;
  }>(() => ({ injected: new Set(), reasons: new Map(), truncated: 0, chars: 0, budget: 0 }));

  // F1.1: Edit/Create state
  const [editMode, setEditMode] = useState<"none" | "create" | "edit">("none");
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_FORM);
  const [editError, setEditError] = useState("");

  useEffect(() => {
    // Reload from DB in case singleton was created before DB was ready
    getMemoryService().reload();
    setApproval(getWriteApprovalSetting());
    loadEntries();
  }, []);

  const loadEntries = () => {
    const service = getMemoryService();
    /*
     * 界面视图：**含 pending 与未归属条目**（未归属的旧 session 记忆仍可见/可编辑，只是不进上下文）。
     *
     * ⚠️ `ctx` 必须传（A2 / F7）：`listAll`/`listPending`/`getStats`/`search` 全靠它按项目/会话过滤，
     * 漏传就会跨项目展示别项目的内容（含未批准条目）。
     */
    const ctx = { projectId, sessionId };
    setEntries(service.listAll(ctx));
    // 待批准列表**同样按当前位置过滤**（旧实现全量返回 ⇒ 项目 A 能看到项目 B 的待批准内容）
    setPending(service.listPending(undefined, ctx));
    setBatches(service.listBatches().filter((b) => !b.undone));
    /*
     * B7：统计与列表**同一个 ctx**。旧实现 `getStats()` 遍历全库，而列表是按项目过滤的，
     * 于是出现「项目 37 / 列表 2 条」的错位（本仓库同类先例被定性为 P1）。
     */
    setStats(service.getStats(ctx));
    /*
     * F5：**面板 / 体检 / 注入三处共用同一套注入判定**（含每块 20 条上限、总字符预算、
     * 「暂停注入旧版跨项目记忆」开关）。旧实现只看 status/scope/归属 ⇒ 第 21 条起
     * 面板仍显示「已生效（参与上下文）」而实际不进上下文，用户按面板取舍就会删错条目。
     */
    setInjection(service.injectionExplanations(ctx));
  };

  /** 条目是否会进入上下文（界面必须能一眼看出"未归属 = 不进"，不能假装它在生效） */
  const isInjected = (entry: MemoryEntry): boolean => injection.injected.has(entry.id);

  /** 不进上下文的**真实原因**（F5：不许只给一个徽标让用户猜） */
  const notInjectedReason = (entry: MemoryEntry): string | undefined =>
    injection.injected.has(entry.id) ? undefined : injection.reasons.get(entry.id);

  const handleSearch = () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const service = getMemoryService();
    const scope = filterScope === "all" || filterScope === "pending" ? undefined : filterScope;
    /*
     * A2 / F7：**必须传 ctx**（第 4 个参数）。
     * 旧写法 `service.search(query, scope)` 让 `visibleIn` 的守卫整体短路 ⇒ 只按 scope 过滤，
     * 在项目 A 里能搜出项目 B 的记忆（含未批准条目），而结果可直接编辑/删除。
     * `search` 现在缺 ctx 时 fail-closed（返回空），这里显式给出当前位置。
     */
    const results = service.search(searchQuery, scope, 10, { projectId, sessionId });
    setSearchResults(results);
  };

  const handleDelete = (id: string) => {
    const service = getMemoryService();
    service.delete(id);
    loadEntries();
    if (selectedEntry?.id === id) {
      setSelectedEntry(null);
    }
  };

  const handleApprove = (id: string) => {
    const result = getMemoryService().approve(id);
    setNotice(result.ok ? `已批准 ${id}：该自动记忆从现在起参与上下文。` : `批准失败：${result.message ?? "未知原因"}`);
    loadEntries();
  };

  const handleReject = (id: string) => {
    const removed = getMemoryService().reject(id);
    setNotice(removed ? `已拒绝并删除 ${id}。` : `拒绝失败：未找到或不在待批准状态。`);
    loadEntries();
  };

  const handleUndoBatch = (batchId: string) => {
    const result = getMemoryService().undoBatch(batchId);
    setNotice(result.message);
    loadEntries();
  };

  const handleToggleApproval = (scope: keyof ApprovalScopeSetting) => {
    const next = setWriteApprovalSetting({ [scope]: !approval[scope] });
    setApproval(next);
    setNotice(
      `写入审批已更新：平台=${next.platform ? "开" : "关"}, 项目=${next.project ? "开" : "关"}, 对话=${next.conversation ? "开" : "关"}。` +
      `开启时自动提取只写入待批准区，未批准不进上下文。`,
    );
  };

  // F1.1: Create new entry
  const handleStartCreate = () => {
    setEditMode("create");
    setEditForm(EMPTY_FORM);
    setEditError("");
    setSelectedEntry(null);
  };

  // F1.1: Edit existing entry
  const handleStartEdit = (entry: MemoryEntry) => {
    setEditMode("edit");
    setEditForm({
      key: entry.key,
      content: entry.content,
      scope: entry.scope,
      source: entry.source ?? "manual",
      tags: entry.tags?.join(", ") || "",
      filePath: entry.filePath || "",
    });
    setEditError("");
  };

  // F1.1: Save (create or update)
  const handleSave = async () => {
    if (!editForm.key.trim()) {
      setEditError("请填写键名");
      return;
    }
    if (!editForm.content.trim()) {
      setEditError("请填写内容");
      return;
    }

    const service = getMemoryService();
    const tags = editForm.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // 归属键由**当前上下文**给出：新增时按作用域自动带上，避免造出"未归属 ⇒ 永不生效"的条目
    const ownership = {
      projectId: editForm.scope === "project" ? (projectId ?? "") : undefined,
      sessionId: editForm.scope === "conversation" ? (sessionId ?? "") : undefined,
    };

    /*
     * I6：写入走**确认式**通道（`addConfirmed` 等引擎确认落库）。
     * `add` 的写穿是 fire-and-forget（失败只上报一条全局横幅），于是条目级契约永远宣称成功、
     * 界面永远显示"保存成功"；`addConfirmed` 把"落库失败"变成 `ok:false` 让这里显示出来。
     */
    let writeMessage: string | undefined;
    if (editMode === "create") {
      const result = await service.addConfirmed({
        key: editForm.key.trim(),
        content: editForm.content,
        scope: editForm.scope,
        source: editForm.source,
        tags: tags.length > 0 ? tags : undefined,
        filePath: editForm.filePath.trim() || undefined,
        projectId: ownership.projectId || undefined,
        sessionId: ownership.sessionId || undefined,
      });
      if (!result.ok) {
        // 容量超限 / 落库失败都必须**如实失败**（不静默驱逐已有条目、不谎报已保存）
        setEditError(result.message ?? "写入失败");
        loadEntries();
        return;
      }
      writeMessage = result.message;
    } else if (editMode === "edit" && selectedEntry) {
      // 用户动作必须显式声明来源（`update` 的来源守卫已收紧为 fail-closed）
      const ok = service.update(
        selectedEntry.id,
        {
          key: editForm.key.trim(),
          content: editForm.content,
          scope: editForm.scope,
          tags: tags.length > 0 ? tags : undefined,
          filePath: editForm.filePath.trim() || undefined,
          projectId: ownership.projectId || undefined,
          sessionId: ownership.sessionId || undefined,
        },
        { actor: "user" },
      );
      if (!ok) {
        setEditError(`保存失败：${service.getLastWriteError() ?? "未知原因"}`);
        loadEntries();
        return;
      }
      writeMessage = service.getLastWriteError() ?? undefined;
      if (!(await service.flushPendingPersist())) {
        setEditError(`保存到数据库失败：${service.getLastPersistError()}（该记忆本次运行内可用，但重启后会丢失）`);
        loadEntries();
        return;
      }
    }

    /*
     * 第 84 波：写入失败不能静默 —— 条目只存在于内存，重启就没了，必须当场告诉用户。
     * B5：内容被截断也要如实说（旧实现静默截到 10000 字符）。
     */
    const persistError = service.getLastPersistError();
    if (persistError) {
      setEditError(`保存到数据库失败：${persistError}（该记忆本次运行内可用，但重启后会丢失）`);
      loadEntries();
      return;
    }
    if (writeMessage) setNotice(writeMessage);

    setEditMode("none");
    setEditForm(EMPTY_FORM);
    setEditError("");
    loadEntries();
  };

  const handleCancelEdit = () => {
    setEditMode("none");
    setEditForm(EMPTY_FORM);
    setEditError("");
  };

  // F2.4: Export / Import handlers
  const handleExportJSON = () => {
    const json = getMemoryService().exportAsJSON();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codem-memory-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportMarkdown = () => {
    const md = getMemoryService().exportAsMarkdown();
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codem-memory-${new Date().toISOString().split("T")[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    /*
     * F3（第 188 波复审）：导入的回执必须等**确认落库**，不能在同一个 tick 里读
     * `getLastPersistError()`。`importFromJSON` 只把写入交给**异步确认链**
     * （`save()` → `chainPersist`），所以原来两个方向都失真：
     *   (a) 落库失败时该字段还是 null ⇒ 弹「成功导入 N 条记忆」，重启后全丢；
     *   (b) 上一次写失败留下的**粘性**错误未清 ⇒ 明明导入成功却弹「写入数据库失败」。
     *
     * 回执文案由 `formatMemoryImportReceipt()` 这个**纯函数**给出（判据直接钉它，
     * 不必去 render 一个 FileReader 流程）。
     */
    reader.onload = async () => {
      const jsonStr = reader.result as string;
      const service = getMemoryService();
      // B5：导入回执要**如实**（容量拒绝、非法条目、截断都报出来，不许只说"成功导入 N 条"）
      const result = service.importFromJSON(jsonStr, false);
      const landed = await service.flushPendingPersist();
      if (result.imported > 0 && landed) {
        // F3：本次确认成功 ⇒ 清掉上一次失败留下的粘性残迹（否则下面会把成功报成失败）
        service.clearLastPersistErrorIfLanded();
      }
      const receipt = formatMemoryImportReceipt(result, landed, service.getLastPersistError());
      void alertDialog(receipt);
      loadEntries();
    };
    reader.readAsText(file);
    // Reset input so the same file can be selected again
    e.target.value = "";
  };

  const filteredEntries = filterScope === "all"
    ? entries
    : filterScope === "pending"
      ? pending
      : entries.filter((e) => e.scope === filterScope);

  const displayEntries = searchResults.length > 0
    ? searchResults.map((r) => r.entry)
    : filteredEntries;

  /** 三级分组：手动在前、自动在后（与注入形态一致，界面不会与上下文说的不一样） */
  const grouped = SCOPE_ORDER.map((scope) => {
    const scoped = displayEntries.filter((e) => e.scope === scope);
    return {
      scope,
      manual: scoped.filter((e) => (e.source ?? "manual") === "manual"),
      auto: scoped.filter((e) => (e.source ?? "manual") === "auto"),
    };
  }).filter((g) => g.manual.length + g.auto.length > 0);

  const renderItem = (entry: MemoryEntry) => (
    <div
      key={entry.id}
      className={`memory-item ${selectedEntry?.id === entry.id ? "selected" : ""}`}
      onClick={() => setSelectedEntry(selectedEntry?.id === entry.id ? null : entry)}
    >
      <div className="memory-item-header">
        <span className="memory-item-key">{entry.key}</span>
        <span className="memory-item-badges">
          <span className="memory-item-scope" style={{ color: getScopeColor(entry.scope) }}>
            {getScopeLabel(entry.scope)}
          </span>
          <span className={`memory-source-badge ${(entry.source ?? "manual") === "manual" ? "manual" : "auto"}`}>
            {sourceLabel(entry.source)}
          </span>
          {(entry.status ?? "active") === "pending" && (
            <span className="memory-source-badge pending">待批准</span>
          )}
          {!isInjected(entry) && <span className="memory-source-badge orphan">不进上下文</span>}
        </span>
      </div>
      <div className="memory-item-preview">
        {entry.content.substring(0, 100)}...
      </div>
      <div className="memory-item-meta">
        <span>{formatTime(entry.timestamp)}</span>
        {entry.tags && entry.tags.length > 0 && (
          <span className="memory-item-tags">
            {entry.tags.slice(0, 3).join(", ")}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="memory-manager">
      <div className="memory-manager-header">
        <div className="memory-manager-title">
          <span className="memory-manager-icon"><MemoryIcon size={16} /></span>
          <span>记忆系统</span>
        </div>
        <div className="memory-manager-actions">
          {editMode === "none" && (
            <>
              <button className="memory-action-btn" onClick={handleStartCreate}>
                + 新增
              </button>
              {/* F2.4: Export / Import */}
              <button className="memory-action-btn" onClick={handleExportJSON} title="导出为 JSON">
                JSON
              </button>
              <button className="memory-action-btn" onClick={handleExportMarkdown} title="导出为 Markdown">
                MD
              </button>
              <label className="memory-action-btn memory-action-label" title="导入 JSON">
                导入
                <input
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={handleImportJSON}
                />
              </label>
              {/* F3.1: Memory consolidation button */}
              <button
                className="memory-action-btn"
                title="整合记忆（手动触发）：合并自动条目的重复、清理超过 90 天的自动条目；手动/对话级/待批准条目永不动"
                onClick={() => {
                  const result = getLLMEngine().consolidateMemories();
                  const msg =
                    `整合完成：合并 ${result.duplicatesMerged} 条重复（正文已并入保留的那条），` +
                    `清理 ${result.staleRemoved} 条超过 90 天未写入的自动条目，裁剪 ${result.capacityTrimmed} 条超额。\n` +
                    `手动条目、对话级条目与待批准条目一条未动；容量裁剪被拒绝的桶：${result.capacityBlocked} 个。\n` +
                    `说明：自动提取流程**不再**自动跑整合（以前每回合跑一次且静默删除），清理只在你点这个按钮或调用 /memory consolidate 时发生。`;
                  void alertDialog(msg);
                  loadEntries();
                }}
              >
                整合
              </button>
            </>
          )}
          {/* 纯图标按钮 ⇒ 必须有可访问名（只加属性，不动布局与样式） */}
          <button
            className="memory-manager-close"
            aria-label="关闭记忆管理 / Close memory manager"
            onClick={onClose}
          ><CloseIcon size={16} /></button>
        </div>
      </div>

      <div className="memory-stats">
        <div className="memory-stat">
          <span className="memory-stat-value">{stats.totalEntries}</span>
          <span className="memory-stat-label">总计</span>
        </div>
        <div className="memory-stat">
          <span className="memory-stat-value platform">{stats.byScope.platform}</span>
          <span className="memory-stat-label">平台</span>
        </div>
        <div className="memory-stat">
          <span className="memory-stat-value project">{stats.byScope.project}</span>
          <span className="memory-stat-label">项目</span>
        </div>
        <div className="memory-stat">
          <span className="memory-stat-value conversation">{stats.byScope.conversation}</span>
          <span className="memory-stat-label">对话</span>
        </div>
        <div className="memory-stat">
          <span className="memory-stat-value pending">{stats.pendingEntries}</span>
          <span className="memory-stat-label">待批准</span>
        </div>
        {/* M-5：作用域不是三者之一的条目 —— 过去在所有界面都看不见，现在至少数得出来 */}
        {stats.unknownScope > 0 && (
          <div className="memory-stat">
            <span className="memory-stat-value other">{stats.unknownScope}</span>
            <span className="memory-stat-label">其它（作用域无法识别）</span>
          </div>
        )}
        {/* M-2：旧版跨项目池的条数（它们仍默认注入，但用户要能看出有多少） */}
        {stats.legacyPool > 0 && (
          <div className="memory-stat">
            <span className="memory-stat-value other">{stats.legacyPool}</span>
            <span className="memory-stat-label">旧版跨项目池</span>
          </div>
        )}
      </div>

      {/*
        S4：默认审批开启 ⇒ 自动记忆先进待批准区、**不进上下文**。
        旧实现只有「待批准」数字，没有一句解释 ⇒ 用户以为自动记忆坏了。
        这里给一条常驻说明（有 pending 时强调并给出条数）。
      */}
      <div className={`memory-pending-hint ${pending.length > 0 ? "active" : ""}`}>
        {pending.length > 0
          ? `有 ${pending.length} 条自动记忆等待批准：它们**现在不会进上下文**，批准后才生效（手动条目不受影响）。`
          : `自动提取的记忆按上面「写入审批」的开关处理：开启的作用域会先进待批准区、批准后才进上下文。`}
      </div>

      {/* 写入审批开关（对标 Hermes write approval）：开启 ⇒ 自动提取只进待批准区 */}
      <div className="memory-approval-bar">
        <span className="memory-approval-label">写入审批：</span>
        {(["platform", "project", "conversation"] as Array<keyof ApprovalScopeSetting>).map((scope) => (
          <button
            key={scope}
            className={`memory-approval-toggle ${approval[scope] ? "on" : "off"}`}
            aria-pressed={approval[scope]}
            title={`自动提取写入「${getScopeLabel(scope as MemoryScope)}」作用域时是否需要先批准`}
            onClick={() => handleToggleApproval(scope)}
          >
            {getScopeLabel(scope as MemoryScope)}：{approval[scope] ? "需批准" : "直接生效"}
          </button>
        ))}
        <span className="memory-approval-hint">
          未批准的自动记忆不进上下文；手动条目永不被自动流程改写。
        </span>
      </div>

      {notice && <div className="memory-notice">{notice}</div>}

      {/* 待批准区 */}
      {pending.length > 0 && (
        <div className="memory-pending-section">
          <div className="memory-pending-title">待批准的自动记忆（{pending.length} 条，未批准不进上下文）</div>
          {pending.map((entry) => (
            <div key={entry.id} className="memory-pending-item">
              <span className="memory-pending-key">{entry.key}</span>
              <span className="memory-pending-content">{entry.content.substring(0, 80)}</span>
              <div className="memory-pending-actions">
                <button className="memory-approve-btn" onClick={() => handleApprove(entry.id)}>批准</button>
                <button className="memory-reject-btn" onClick={() => handleReject(entry.id)}>拒绝</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 自动提取批次（整批撤销） */}
      {batches.length > 0 && (
        <div className="memory-batch-section">
          <div className="memory-batch-title">自动提取批次（可整批撤销）</div>
          {/*
            附带要求：**旧条目没有 batchId** ⇒「撤销批次」对它们结构性无意义。
            这里如实说明，而不是给一个点了没反应的按钮（旧批次也不会出现在这份列表里）。
          */}
          <div className="memory-batch-note">
            只有本版本之后自动提取写入的条目带批次号。**升级前的旧记忆没有批次信息**，
            无法用「撤销该批」回滚 —— 请到「设置 → 记忆体检」里用批量删除或归位处置。
          </div>
          {batches.slice(0, 10).map((batch) => (
            <div key={batch.id} className="memory-batch-item">
              <span className="memory-batch-id">{batch.id}</span>
              <span className="memory-batch-meta">
                {batch.count} 条 · {formatTime(batch.createdAt)}
                {batch.sessionId ? ` · 会话 ${batch.sessionId}` : ""}
              </span>
              <button className="memory-undo-btn" onClick={() => handleUndoBatch(batch.id)}>
                撤销该批
              </button>
            </div>
          ))}
        </div>
      )}

      {/* F1.1: Edit/Create Form */}
      {editMode !== "none" && (
        <div className="memory-edit-form">
          <div className="memory-edit-form-title">
            {editMode === "create" ? "新增记忆" : "编辑记忆"}
          </div>
          {editError && <div className="memory-edit-error">{editError}</div>}
          <div className="memory-edit-field">
            <label>键名</label>
            <input
              type="text"
              value={editForm.key}
              onChange={(e) => setEditForm({ ...editForm, key: e.target.value })}
              placeholder="记忆的唯一标识"
              /* S1：key 会**原样**进每轮系统提示（只按 MEMORY_INJECT_KEY_MAX 截断）⇒ 输入侧也限长 */
              maxLength={MEMORY_INJECT_KEY_MAX}
            />
          </div>
          <div className="memory-edit-field">
            <label>作用域</label>
            <select
              value={editForm.scope}
              onChange={(e) => setEditForm({ ...editForm, scope: e.target.value as MemoryScope })}
            >
              <option value="platform">平台（所有项目、所有对话）</option>
              <option value="project">项目（仅本项目内的所有对话）</option>
              <option value="conversation">对话（仅当前对话）</option>
            </select>
          </div>
          <div className="memory-edit-field">
            <label>来源</label>
            <select
              value={editForm.source}
              onChange={(e) => setEditForm({ ...editForm, source: e.target.value as MemorySource })}
            >
              <option value="manual">手动（自动流程不得改写）</option>
              <option value="auto">自动提取（注入时单独标注）</option>
            </select>
          </div>
          <div className="memory-edit-field">
            <label>内容</label>
            <textarea
              value={editForm.content}
              onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
              placeholder="记忆内容"
              rows={6}
            />
          </div>
          <div className="memory-edit-field">
            <label>标签 (逗号分隔)</label>
            <input
              type="text"
              value={editForm.tags}
              onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
              placeholder="标签1, 标签2"
            />
          </div>
          <div className="memory-edit-field">
            <label>文件路径 (可选)</label>
            <input
              type="text"
              value={editForm.filePath}
              onChange={(e) => setEditForm({ ...editForm, filePath: e.target.value })}
              placeholder="/path/to/file"
            />
          </div>
          <div className="memory-edit-actions">
            <button className="memory-save-btn" onClick={handleSave}>💾 保存</button>
            <button className="memory-cancel-btn" onClick={handleCancelEdit}>取消</button>
          </div>
        </div>
      )}

      {editMode === "none" && (
        <>
          <div className="memory-search">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="搜索记忆..."
            />
            {/* 纯图标按钮 ⇒ 必须有可访问名（只加属性，不动布局与样式） */}
            <button
              aria-label="搜索记忆 / Search memory"
              onClick={handleSearch}
            ><SearchIcon size={16} /></button>
          </div>

          <div className="memory-filters">
            {(["all", "platform", "project", "conversation", "pending"] as const).map((scope) => (
              <button
                key={scope}
                className={`memory-filter-btn ${filterScope === scope ? "active" : ""}`}
                onClick={() => { setFilterScope(scope); setSearchResults([]); }}
              >
                {scope === "all" ? "全部" : scope === "pending" ? "待批准" : getScopeLabel(scope)}
              </button>
            ))}
          </div>
        </>
      )}

      {editMode === "none" && (
        <div className="memory-content">
          <div className="memory-list">
            {displayEntries.length === 0 && (
              <div className="empty-hint">暂无记忆条目</div>
            )}
            {filterScope === "all" || searchResults.length > 0
              ? grouped.map((group) => (
                  <div key={group.scope} className="memory-group">
                    <div className="memory-group-title">
                      {getScopeLabel(group.scope)}记忆 · {getScopeHint(group.scope)}
                    </div>
                    {/* 手动块在前、自动块在后 —— 与注入到系统提示里的分块顺序一致 */}
                    {group.manual.length > 0 && (
                      <div className="memory-group-sub">手动维护（{group.manual.length}）</div>
                    )}
                    {group.manual.map(renderItem)}
                    {group.auto.length > 0 && (
                      <div className="memory-group-sub auto">自动提取（可能不准，可删）（{group.auto.length}）</div>
                    )}
                    {group.auto.map(renderItem)}
                  </div>
                ))
              : displayEntries.map(renderItem)}
          </div>

          {selectedEntry && (
            <div className="memory-detail">
              <div className="memory-detail-header">
                <h3>{selectedEntry.key}</h3>
                <span
                  className="memory-detail-scope"
                  style={{ color: getScopeColor(selectedEntry.scope) }}
                >
                  {getScopeLabel(selectedEntry.scope)}
                </span>
              </div>

              <div className="memory-detail-section">
                <label>ID</label>
                <span className="memory-detail-mono">{selectedEntry.id}</span>
              </div>

              <div className="memory-detail-section">
                <label>生效范围</label>
                <span>{getScopeHint(selectedEntry.scope, selectedEntry)}</span>
              </div>

              <div className="memory-detail-section">
                <label>来源</label>
                <span>{sourceLabel(selectedEntry.source)}（{(selectedEntry.source ?? "manual") === "manual" ? "自动流程不得改写" : "注入时单独标注"}）</span>
              </div>

              <div className="memory-detail-section">
                <label>状态</label>
                <span>
                  {(selectedEntry.status ?? "active") === "pending"
                    ? "待批准（未进上下文）"
                    : isInjected(selectedEntry)
                      ? "已生效（参与上下文）"
                      : `不进上下文${notInjectedReason(selectedEntry) ? `：${notInjectedReason(selectedEntry)}` : ""}`}
                </span>
              </div>

              {selectedEntry.batchId && (
                <div className="memory-detail-section">
                  <label>批次</label>
                  <span className="memory-detail-mono">{selectedEntry.batchId}</span>
                </div>
              )}

              <div className="memory-detail-section">
                <label>创建时间</label>
                <span>{formatTime(selectedEntry.timestamp)}</span>
              </div>

              {selectedEntry.filePath && (
                <div className="memory-detail-section">
                  <label>文件路径</label>
                  <span className="memory-detail-mono">{selectedEntry.filePath}</span>
                </div>
              )}

              {selectedEntry.tags && selectedEntry.tags.length > 0 && (
                <div className="memory-detail-section">
                  <label>标签</label>
                  <div className="memory-detail-tags">
                    {selectedEntry.tags.map((tag) => (
                      <span key={tag} className="memory-detail-tag">{tag}</span>
                    ))}
                  </div>
                </div>
              )}

              <div className="memory-detail-section">
                <label>内容</label>
                <pre className="memory-detail-content">{selectedEntry.content}</pre>
              </div>

              <div className="memory-detail-actions">
                <button
                  className="memory-edit-btn"
                  onClick={() => handleStartEdit(selectedEntry)}
                >
                  <EditIcon size={14} /> 编辑
                </button>
                <button
                  className="memory-delete-btn"
                  onClick={() => handleDelete(selectedEntry.id)}
                >
                  <DeleteIcon size={14} /> 删除
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
