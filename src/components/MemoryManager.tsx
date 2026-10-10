import { useState, useEffect } from "react";
import { PanelIcons, ActionIcons } from "../core/icons/icon-map";
import {
  getMemoryService,
  getWriteApprovalSetting,
  setWriteApprovalSetting,
  MEMORY_AUTO_GROUP_HINT,
  MEMORY_INJECT_KEY_MAX,
  MemoryService,
  type ApprovalScopeSetting,
  type MemoryBatch,
  type MemoryEntry,
  type MemoryScope,
  type MemorySearchResult,
  type MemorySource,
  type MemorySourceKind,
  MEMORY_SOURCE_KIND_LABEL,
  memorySourceOf,
  // S4 / O-45：待批准判据**全仓唯一一处**（本文件原来也在两处各写了一遍）
  isPendingMemoryEntry,
  injectionScopeContext,
  // 第 199 波：作用域徽标文案的唯一来源（与三态表同一条纪律）
  MEMORY_SCOPE_BADGE_LABEL,
  type MemoryPayloadByteStats,
} from "../core/memory/memory";
import { formatMemoryImportReceipt } from "../core/memory/checkup";
import { localDateString } from "../core/time/local-time";
// O-36：体积读数的人读形态走**唯一**实现（第 191 波把 4 份字节格式化副本收敛成一份）
import { formatBytes } from "../core/utils/bytes";
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

/**
 * 待批准条目的**作用域徽标文案**（第 199 波）。
 *
 * 三态取自唯一一份表；认不出来的旧作用域**原样显示**并加「作用域：」前缀 ——
 * 不许默认成三者之一（那是"把不确定当成确定"，本仓在归属上是明确禁止的）。
 */
function pendingScopeLabel(entry: MemoryEntry): string {
  const known = MEMORY_SCOPE_BADGE_LABEL[entry.scope as MemoryScope];
  if (known) return known;
  return `作用域：${entry.scope ? String(entry.scope) : "（空）"}`;
}

/** 徽标上那句"批准之后会怎样"（用户判断的依据就在这句话里） */
function pendingScopeTitle(entry: MemoryEntry): string {
  switch (entry.scope) {
    case "platform": return "平台级：批准后对**所有项目、所有对话**生效";
    case "project": return "项目级：批准后对**这个项目以后的每个对话**生效";
    case "conversation": return "对话级：批准后只对**当前这个对话**生效";
    default: return "作用域无法识别：批准后也不会进上下文（可先归位或删除）";
  }
}

/** 这条待批准条目有没有归属键（没有 ⇒ 任何上下文都不注入，批准也没用） */
function hasPendingOwner(entry: MemoryEntry): boolean {
  if (entry.scope === "platform") return true;
  if (entry.scope === "project") return Boolean(entry.projectId);
  return Boolean(entry.sessionId);
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

/**
 * 来源三态文案 —— 与注入文本 / 记忆体检 / 导出**同一张表**
 * （`memory.ts` 的 `MEMORY_SOURCE_KIND_LABEL`；判据 `MEM-PLACE-12`）。
 * 旧写法 `source ?? "manual"` 会把旧数据显示成「手动」，而注入侧把它说成「自动提取」——
 * 同一条目两套真相，用户据此取舍会删错条目。
 */
function sourceLabel(source: MemorySource | undefined): string {
  return MEMORY_SOURCE_KIND_LABEL[memorySourceOf({ source })];
}

/** 来源徽标的 CSS 类（三态各一个；`unknown` 见 styles.css） */
function sourceBadgeClass(source: MemorySource | undefined): string {
  return memorySourceOf({ source });
}

/** 详情页「来源」那一栏的括注（保护口径与 `isProtectedMemoryEntry` 一致） */
function sourceHint(source: MemorySource | undefined): string {
  const kind = memorySourceOf({ source });
  if (kind === "manual") return "自动流程不得改写";
  if (kind === "unknown") return "来源未知（旧数据）· 按手动条目保护，自动流程不得改写或删除";
  return "注入时单独标注（由自动流程从对话中提取，未经人工确认）";
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
  /**
   * 待批准区里**被勾选**的条目 id（第 196 波新增的批量同意/拒绝）。
   *
   * 为什么不放在 `pending` 数组里当字段：勾选是**界面瞬态**（不是记忆数据），
   * 不该进 payload、也不该在刷新时被"读回来"。
   * 它必须跟着 `pending` 一起收敛（见下面的 `useEffect`）—— 否则批处理完/条目被别处删掉后，
   * 一个已经不存在的 id 留在选中集合里，下一次点「批量拒绝」就会带着它去算数（"幽灵选中"）。
   */
  const [selectedPending, setSelectedPending] = useState<Set<string>>(new Set());
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
    bySource: { manual: 0, auto: 0, unknown: 0 } as Record<MemorySourceKind, number>,
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
  /**
   * O-36：记忆 payload 的**体积读数**（可观测的那一半）。
   *
   * 它是「记忆镜像字节预算」的唯一用户可见出口：超预算时给一条**可操作**的说明
   * （删条目 / 导出后清理），而不是让用户只感觉到卡。
   */
  const [bytes, setBytes] = useState<MemoryPayloadByteStats | null>(null);

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
    /*
     * R3：列表默认用**注入顺序**（创建序倒序，与 `computeInjection` 同一个键）——
     * 旧写法是 `listAll(ctx)`（按 `timestamp` 倒序），于是"编辑一条"之后面板顺序与注入顺序分叉，
     * 而面板又把 `timestamp` 标成「创建时间」⇒ 用户无从自知。
     */
    setEntries(service.listAllForPanel(ctx));
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
     *
     * R6：注入判定走的是**注入侧窄 ctx**（`injectionScopeContext`）——面板的宽 ctx
     * （将来若带上 `includeUnscoped` 之类）**赋不进去**，于是"把视图开关传进注入路径"编译不过。
     */
    setInjection(service.injectionExplanations(injectionScopeContext(projectId, sessionId)));
    // O-36：体积读数与上面的统计**同一次刷新**（用户删掉条目后要立刻看到体积下来）
    setBytes(service.getByteStats());
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

  /* ===== 第 196 波：勾选 + 批量同意 / 批量拒绝（含全选） ===== */

  /** 勾选/取消勾选一条 */
  const togglePendingSelected = (id: string) => {
    setSelectedPending((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 全选 / 全不选（判据是"当前是不是全选中"，不是"集合非空"） */
  const toggleSelectAllPending = () => {
    setSelectedPending((prev) => {
      const all = pending.length > 0 && pending.every((p) => prev.has(p.id));
      return all ? new Set() : new Set(pending.map((p) => p.id));
    });
  };

  /**
   * 选中集合必须**跟着待批准列表收敛**。
   *
   * 两条都要挡住：① 批处理之后（那些 id 已经不在待批准区了）选中状态必须清掉；
   * ② 条目在别处被批/删/改（例如体检那边处置过）时，同一个 id 不许继续挂在这里。
   * 返回同一个 Set 引用（内容没变时）以免无谓重渲染 —— 这个 effect 在每次 loadEntries 后都会跑。
   */
  useEffect(() => {
    setSelectedPending((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(pending.map((p) => p.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [pending]);

  const handleApproveSelected = () => {
    const ids = [...selectedPending];
    const result = getMemoryService().approveMany(ids);
    setNotice(result.message);
    setSelectedPending(new Set());
    loadEntries();
  };

  const handleRejectSelected = () => {
    const ids = [...selectedPending];
    const result = getMemoryService().rejectMany(ids);
    setNotice(result.message);
    setSelectedPending(new Set());
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
      /*
       * 旧数据（来源未知）在这里只能预选 `manual`：表单的 `source` 是**可写入的两态**
       * （`manual` / `auto`），"未知"不是一个可以写回去的值。预选手动 = 与保护口径一致
       * （旧数据按手动条目保护），且**用户保存即确认**"这条是我手写的" ⇒ 不是编造。
       * 详情页在保存前如实显示「未知（旧数据）」（`sourceHint`）。
       */
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
    // R7：文件名里的日期是**给人看的**（本地日）—— 旧写法取 UTC 日，本地 00:00–08:00 会写成前一天
    a.download = `codem-memory-${localDateString(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportMarkdown = () => {
    const md = getMemoryService().exportAsMarkdown();
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codem-memory-${localDateString(new Date())}.md`;
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

  /** 三级分组：手动在前、来源未知（旧数据）居中、自动在后
   *  —— 与注入文本里的三桶顺序（`computeInjection` 的 KINDS）**同一口径** */
  const grouped = SCOPE_ORDER.map((scope) => {
    const scoped = displayEntries.filter((e) => e.scope === scope);
    return {
      scope,
      manual: scoped.filter((e) => memorySourceOf(e) === "manual"),
      unknown: scoped.filter((e) => memorySourceOf(e) === "unknown"),
      auto: scoped.filter((e) => memorySourceOf(e) === "auto"),
    };
  }).filter((g) => g.manual.length + g.unknown.length + g.auto.length > 0);

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
          <span className={`memory-source-badge ${sourceBadgeClass(entry.source)}`}>
            {sourceLabel(entry.source)}
          </span>
          {isPendingMemoryEntry(entry) && (
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
        {/*
          O-36：**体积**这一格是"记忆镜像字节预算"的用户可见出口。
          没有它时，体积只存在于 `stats().memoryBytes` 里 —— 全仓一个消费方都没有，
          用户只感觉"记忆越多越卡"而看不到原因（这正是 O-36 的另一半）。
        */}
        {bytes && (
          <div className="memory-stat" title={`记忆整份 payload 约 ${formatBytes(bytes.payloadBytes)}；预算 ${formatBytes(bytes.budgetBytes)}`}>
            <span className={`memory-stat-value ${bytes.overBy > 0 ? "other" : ""}`}>{formatBytes(bytes.payloadBytes)}</span>
            <span className="memory-stat-label">体积</span>
          </div>
        )}
      </div>

      {/*
        O-36：超预算 ⇒ 一条**可操作**的说明（不是"失败"，因为什么都没丢）。
        数字与上面那格、与上报通道**同一个来源**（`getByteStats()`）。
      */}
      {bytes && bytes.overBy > 0 && (
        <div className="memory-notice">
          记忆体积约 {formatBytes(bytes.payloadBytes)}，已超过预算 {formatBytes(bytes.budgetBytes)}（超出{" "}
          {formatBytes(bytes.overBy)}）；最大的一块是「{bytes.biggestBucket}」（{formatBytes(bytes.biggestBucketBytes)}）。
          超预算**不会删除或截断任何条目**；要缩小可删掉不再需要的条目，或先「导出为 JSON」留档再清理。
        </div>
      )}

      {/*
        S4：默认审批开启 ⇒ 自动记忆先进待批准区、**不进上下文**。
        旧实现只有「待批准」数字，没有一句解释 ⇒ 用户以为自动记忆坏了。
        这里给一条常驻说明（有 pending 时强调并给出条数）。
      */}
      <div className={`memory-pending-hint ${pending.length > 0 ? "active" : ""}`}>
        {pending.length > 0
          ? `有 ${pending.length} 条自动记忆等待批准：它们**现在不会进上下文**，批准后才生效（手动条目不受影响）。可以逐条批准/拒绝，也可以勾选后批量处置（含全选）。`
          : `自动提取的记忆按上面「写入审批」的开关处理：**对话级默认直接生效**（只跟本次对话有关的事实不再打扰你），项目级 / 平台级默认先进待批准区、批准后才进上下文。`}
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
          未批准的自动记忆不进上下文；**对话级默认直接生效**（自动提取里"只跟本次对话有关"的那些）；
          手动条目永不被自动流程改写。
        </span>
      </div>

      {notice && <div className="memory-notice">{notice}</div>}

      {/* 待批准区 */}
      {pending.length > 0 && (
        <div className="memory-pending-section">
          <div className="memory-pending-title">待批准的自动记忆（{pending.length} 条，未批准不进上下文）</div>
          {/*
            第 196 波：勾选 + 批量同意/拒绝（用户要求「含全选」）。
            三个细节是刻意的：
            ① 「全选」复选框的可访问名说清**它管的是哪一批**（不是光秃秃一个勾选框）；
            ② 两个批量按钮在没有勾选时 **disabled**（点了也不会误伤，避免"空批量"看起来像生效了）；
            ③ 按钮上的数字是**当前勾选数**（用户勾几条就等于知道自己要动几条）。
          */}
          <div className="memory-pending-batch-bar">
            <label className="memory-pending-check memory-pending-check-all">
              <input
                type="checkbox"
                checked={pending.every((p) => selectedPending.has(p.id))}
                onChange={toggleSelectAllPending}
                aria-label={`全选当前 ${pending.length} 条待批准记忆`}
              />
              <span>全选</span>
            </label>
            <span className="memory-pending-selected-hint">
              {selectedPending.size > 0 ? `已勾选 ${selectedPending.size} / ${pending.length} 条` : "勾选后可批量处置"}
            </span>
            <button
              className="memory-approve-btn"
              disabled={selectedPending.size === 0}
              title="批准所有勾选的条目：它们从现在起参与上下文"
              onClick={handleApproveSelected}
            >
              批量同意（{selectedPending.size}）
            </button>
            <button
              className="memory-reject-btn"
              disabled={selectedPending.size === 0}
              title="拒绝并删除所有勾选的条目"
              onClick={handleRejectSelected}
            >
              批量拒绝（{selectedPending.size}）
            </button>
          </div>
          {pending.map((entry) => (
            <div key={entry.id} className="memory-pending-item">
              <label className="memory-pending-check">
                <input
                  type="checkbox"
                  checked={selectedPending.has(entry.id)}
                  onChange={() => togglePendingSelected(entry.id)}
                  aria-label={`勾选「${entry.key}」`}
                />
              </label>
              <span className="memory-pending-key">{entry.key}</span>
              {/*
                第 199 波（用户直报：待批准区没显示类型，没法判断该不该批准）：
                **作用域**是批准与否的第一依据 —— 平台级处处生效、项目级对这个项目以后的每个对话生效、
                对话级只影响当前对话。徽标文案取自唯一一份表（`MEMORY_SCOPE_BADGE_LABEL`），
                认不出来的旧作用域**原样显示**（不许猜成三者之一，那正是"归属未知"要防的事）。
              */}
              <span
                className="memory-pending-scope"
                style={{ color: getScopeColor(entry.scope) }}
                title={pendingScopeTitle(entry)}
              >
                {pendingScopeLabel(entry)}
              </span>
              {!hasPendingOwner(entry) && (
                <span className="memory-pending-noowner" title="这条没有归属键 ⇒ 任何上下文都不会注入它">
                  无归属
                </span>
              )}
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
            {/* R3：排序口径必须**说白**（列表按创建序 = 注入顺序；`timestamp` 只是单条字段） */}
            <div className="memory-batch-note">{MemoryService.PANEL_ORDER_NOTE}</div>
            {displayEntries.length === 0 && (
              <div className="empty-hint">暂无记忆条目</div>
            )}
            {filterScope === "all" || searchResults.length > 0
              ? grouped.map((group) => (
                  <div key={group.scope} className="memory-group">
                    <div className="memory-group-title">
                      {getScopeLabel(group.scope)}记忆 · {getScopeHint(group.scope)}
                    </div>
                    {/* 手动块在前、来源未知居中、自动块在后 —— 与注入到系统提示里的分块顺序一致；
                        R5：三态文案一律走 `MEMORY_SOURCE_KIND_LABEL`（旧写法在这里自写「手动维护」/「自动提取（可能不准，可删）」，
                        改文案表不会改这两处 ⇒ 同一屏里并存三套说法） */}
                    {group.manual.length > 0 && (
                      <div className="memory-group-sub">{MEMORY_SOURCE_KIND_LABEL.manual}（{group.manual.length}）</div>
                    )}
                    {group.manual.map(renderItem)}
                    {group.unknown.length > 0 && (
                      <div className="memory-group-sub unknown">
                        来源{MEMORY_SOURCE_KIND_LABEL.unknown}（{group.unknown.length}）· 按手动条目保护
                      </div>
                    )}
                    {group.unknown.map(renderItem)}
                    {group.auto.length > 0 && (
                      <div className="memory-group-sub auto">
                        {MEMORY_SOURCE_KIND_LABEL.auto}（{MEMORY_AUTO_GROUP_HINT}）（{group.auto.length}）
                      </div>
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
                <span>{sourceLabel(selectedEntry.source)}（{sourceHint(selectedEntry.source)}）</span>
              </div>

              <div className="memory-detail-section">
                <label>状态</label>
                <span>
                  {isPendingMemoryEntry(selectedEntry)
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
                {/* R3：如实命名 —— `update()` 每次刷新这个字段 ⇒ 它是「最后修改时间」，不是「创建时间」 */}
                <label>{MemoryService.PANEL_TIMESTAMP_LABEL}</label>
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
