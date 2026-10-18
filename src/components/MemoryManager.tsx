import { useState, useEffect, useRef } from "react";
import { PanelIcons, ActionIcons } from "../core/icons/icon-map";
import {
  getMemoryService,
  getWriteApprovalSetting,
  setWriteApprovalSetting,
  setWriteApprovalSettingConfirmed,
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
  /* ★ 第 228 波审计：注入截断的如实披露（条目 10000 字符上限 vs 每行注入只取前 200） */
  injectionTruncationNote,
  // 第 199 波：作用域徽标文案的唯一来源（与三态表同一条纪律）
  MEMORY_SCOPE_BADGE_LABEL,
  type MemoryPayloadByteStats,
} from "../core/memory/memory";
import { formatMemoryImportReceipt } from "../core/memory/checkup";
import { localDateString } from "../core/time/local-time";
// O-36：体积读数的人读形态走**唯一**实现（第 191 波把 4 份字节格式化副本收敛成一份）
import { formatBytes } from "../core/utils/bytes";
import { getLLMEngine } from "../core/llm";
import { alertDialog, confirmDialog } from "../core/ui/native-dialog";

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

/**
 * 把「已经处置掉的条目」从界面瞬态集合里剔掉 —— 勾选集合与展开集合**共用这一条能力**。
 *
 * 为什么不各写一份（第 226 波收敛）：两个集合的失效形态**完全一样** —— 条目被批准/拒绝/
 * 在别处（记忆体检）处理掉之后，它的 id 已经从 `pending` 里消失，而集合里还留着它。
 * 后果也一样：下一次批量动作会带着不存在的 id 去算数（"幽灵选中"，第 196 波），
 * 或者哪天同一 id 再出现时用户看到一条**自己从没双击过**的记忆是展开的（"幽灵展开"，第 226 波）。
 * 本仓在"同一件事两处实现"上吃过太多次亏（修一处漏一处），所以这里只留一处。
 *
 * 返回**同一个引用**（内容没变时）以免每次 `loadEntries` 都无谓重渲染
 * —— 这个 effect 每次刷新列表后都会跑。
 */
function pruneAliveIds(previous: Set<string>, alive: readonly { id: string }[]): Set<string> {
  if (previous.size === 0) return previous;
  const aliveIds = new Set(alive.map((entry) => entry.id));
  const next = new Set([...previous].filter((id) => aliveIds.has(id)));
  return next.size === previous.size ? previous : next;
}

/**
 * 一条记忆的**状态文案** —— 本屏唯一一处（第 226 波收敛）。
 *
 * 为什么必须收敛成一份：这句话是用户"要不要批准/留下它"的直接依据，而它现在要出现在
 * **两个**地方 —— 右侧详情面板（点列表里的条目）与**待批准条目的双击展开**（第 226 波，
 * 用户报「审批时看不到详细信息，没法判断该不该通过」）。两处各写一份三元表达式，
 * 迟早会出现「一处说会进上下文、另一处说不进」—— 那正是本仓在"同一件事两套说法"上
 * 反复吃过亏的形态（见 `MEMORY_SOURCE_KIND_LABEL` 那一段注释）。
 */
function entryStatusText(entry: MemoryEntry, injected: boolean, notInjectedReason?: string): string {
  if (isPendingMemoryEntry(entry)) return "待批准（未进上下文）";
  if (injected) {
    /**
     * ★ 第 228 波审计修复（低）：**注入时截断要披露**。
     * 条目允许 10000 字符而每行注入只取前 200 —— 此前界面照样写「已生效（参与上下文）」，
     * 用户以为整条都在上下文里（条数上限与字符预算都有披露，唯独这一处没有）。
     */
    /* 用**真正会被注入的那段文本**判定（链接展开后长度会变，只看原文会漏报） */
    const injectedText = getMemoryService().injectionTextFor({
      id: entry.id,
      key: entry.key,
      content: entry.content,
    } as MemoryEntry);
    const note = injectionTruncationNote(entry, injectedText);
    return note ? `已生效（参与上下文；${note}）` : "已生效（参与上下文）";
  }
  return `不进上下文${notInjectedReason ? `：${notInjectedReason}` : ""}`;
}

/**
 * 待批准条目的**归属**（批准之后它会在哪些项目/对话里生效 —— 判断该不该批准的第二依据）。
 *
 * 三条纪律：
 * ① 认不出来或归属键为空 ⇒ **如实说**「批准也不会进上下文」，不许猜成当前项目/当前对话；
 * ② 与当前位置一致时**显式说出来** —— 用户最常问的就是"这条是不是就管我现在这个对话"；
 * ③ 只显示**原始归属键**：这一屏没有项目/会话登记表（那在记忆体检视图里），
 *    与其猜一个好听的名字，不如给一个可核对的 id。
 */
function pendingOwnerText(entry: MemoryEntry, projectId?: string, sessionId?: string): string {
  if (entry.scope === "platform") return "所有项目、所有对话（平台级没有归属键）";
  if (entry.scope === "project") {
    if (!entry.projectId) return "无归属项目 ⇒ 即使批准也不会进任何上下文（先用「归位」指定项目，或直接拒绝）";
    return `${entry.projectId}${entry.projectId === projectId ? "（就是当前项目）" : "（不是当前项目：批准后在你打开那个项目时生效）"}`;
  }
  if (entry.scope === "conversation") {
    if (!entry.sessionId) return "无归属对话 ⇒ 即使批准也不会进任何上下文（先用「归位」指定对话，或直接拒绝）";
    return `${entry.sessionId}${entry.sessionId === sessionId ? "（就是当前对话）" : "（不是当前对话：批准后在那个对话里生效）"}`;
  }
  return hasPendingOwner(entry)
    ? "作用域无法识别：批准后会不会生效无法确定，建议先归位"
    : "作用域无法识别且没有归属键 ⇒ 即使批准也不会进上下文";
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
  /**
   * 待批准区里**被双击展开**的条目 id（第 226 波，用户要求）。
   *
   * 用户原话：「记忆系统中，审批的时候，看不到详细信息无法评估审批是否通过，
   * 增加个双击展开详细信息的功能。」—— 待批准区原来只给 `content` 的**前 80 字**，
   * 而"该不该批准"要靠 完整内容 + 作用域/生效范围 + 归属 + 来源 一起判断，
   * 光看摘要只能猜（尤其自动提取的长条目，前 80 字常常只是铺垫）。
   *
   * 与 `selectedPending` 同为**界面瞬态**（不进 payload、不落库、刷新即重来），
   * 并且同样必须跟着待批准列表收敛（见下面的 effect）—— 否则一个已经被批准/拒绝的 id
   * 留在集合里，等哪天有同名 id 出现时会被莫名其妙地展开（"幽灵展开"）。
   */
  const [expandedPending, setExpandedPending] = useState<Set<string>>(new Set());
  /**
   * 第 230 波（用户拍板）：**库内待批准条目的全局总量**（不看 ctx）。
   *
   * 为什么必须与 `pending`（本地那份）分开存：
   * 面板的待批准列表按当前位置过滤（`listPending(undefined, ctx)`）—— 这是对的（在项目 A
   * 不该看到项目 B 的待批准内容）。但**积压的成本是用户的决策次数**，那是全局的：
   * 本处 0 条、别处 5 条时，用户看到的是"没有待批准"，而实际上系统已经在
   * `MEMORY_PENDING_BACKLOG_LIMIT` 那道闸上把新候选降级成对话级了 —— 两件事对不上。
   *
   * ⚠️ **取数口径必须与闸门同一处**（`MemoryService.countPendingEntries()`）：
   * 它就是 `llm/index.ts` 里 `decidePendingBacklog` 的入参来源（第 229 波）。
   * 这里**不许**另写一份"遍历 entries 数 pending"的实现 —— 那样两处口径一分叉，
   * 界面会开始解释一个与闸门无关的数字（本仓吃过同类亏，见 `panel-scope.ts` 的文件头）。
   */
  const [globalPending, setGlobalPending] = useState(0);
  /**
   * ★ 第 231 波 A1：**本会话里被「待批准积压上限」降级为对话级、因而已经悄悄生效的条目**。
   *
   * 被守的缺陷（独立审计 · 中 · 安全面）：`llm/index.ts` 把超限候选降级为 `conversation`
   * （`status=active`、`sessionId=当前会话`）⇒ 从"不注入"变成**注入当前对话上下文**，
   * 而 `globalPending` 不计它、面板一个字的提示都没有 ⇒ 用户**这次否决机会被拿走了却不知道**。
   * 代价只写在 `pending-backlog.ts` 的文件头注释里，等于只对开发者可见。
   *
   * 现在：面板在「待批准」区标题旁显示一行可点开的计数「本会话已自动降级 N 条（查看）」，
   * 点开列出这 N 条的标题 / 时间 / **原作用域**，并明写"它们已进入本会话上下文"。
   * N 的来源是引擎（`listBacklogDemotedForSession`），不是在这里数 pending、也不是自己扫库另算。
   */
  const [demotedBacklog, setDemotedBacklog] = useState<MemoryEntry[]>([]);
  /** 降级清单是否展开（界面瞬态，与待批准区的展开/勾选同一类东西） */
  const [demotedOpen, setDemotedOpen] = useState(false);
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
    /*
     * 第 230 波：「本处 0 条、别处还有」那一行读的是**全局**待批准数。
     * 与上面的 `pending`（按 ctx 过滤的界面视图）**刻意不同口径**，理由写在 state 的注释里；
     * 取数走闸门同一个方法（`countPendingEntries()`），不另写一份。
     */
    setGlobalPending(service.countPendingEntries());
    /*
     * ★ 第 231 波 A1：**本会话被积压闸门降级、因而已经悄悄生效的条目**。
     *
     * 取数**只走引擎那一处**（`listBacklogDemotedForSession`）——它只认写入路径打的
     * `demotedFrom` 标记，与 `[extractMemories] …降级为对话级` 那行日志同源。
     * 界面自己按「对话级 + auto + 本会话」扫一遍会得到另一个口径（正常就该对话级生效的条目
     * 也会被算进来），那正是本仓反复吃过的"两处口径一分叉"。
     */
    setDemotedBacklog(service.listBacklogDemotedForSession(sessionId));
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

  /**
   * ★ 第 228 波审计修复（中）：单条动作也要**看落库结果**。
   *
   * 被守的缺陷：面板的单条删除/批准/拒绝此前只改内存 + `loadEntries()`（列表里立刻没了/变了），
   * 而 `save()` 的返回值语义是"这次写入**已被接受**"，**不等于已落库**（它自己的注释就这么写）。
   * 落库失败时用户看到"条目已消失"、该动作**零回执**，重启后条目又回来 —— 而同仓的
   * 编辑/新建/导入/体检批量都等 `flushPendingPersist()` 并如实回执（口径不一致）。
   */
  const settlePersist = async (what: string): Promise<void> => {
    const service = getMemoryService();
    const landed = await service.flushPendingPersist();
    if (!landed) {
      setNotice(`${what}，但**未落库**：${service.getLastPersistError() ?? "未知原因"}（重启后这次改动会失效）。`);
    }
  };

  const handleDelete = (id: string) => {
    const service = getMemoryService();
    const deleted = service.delete(id);
    loadEntries();
    if (selectedEntry?.id === id) {
      setSelectedEntry(null);
    }
    if (!deleted) {
      setNotice(`删除失败：未找到记忆 ${id}。`);
      return;
    }
    void settlePersist(`已删除 ${id}。`);
  };

  const handleApprove = (id: string) => {
    const result = getMemoryService().approve(id);
    setNotice(result.ok ? `已批准 ${id}：该自动记忆从现在起参与上下文。` : `批准失败：${result.message ?? "未知原因"}`);
    loadEntries();
    if (result.ok) void settlePersist(`已批准 ${id}。`);
  };

  const handleReject = (id: string) => {
    const removed = getMemoryService().reject(id);
    setNotice(removed ? `已拒绝并删除 ${id}。` : `拒绝失败：未找到或不在待批准状态。`);
    loadEntries();
    if (removed) void settlePersist(`已拒绝并删除 ${id}。`);
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
   * 双击一条待批准记忆 ⇒ 展开/收起它的**完整内容与判断依据**（第 226 波，用户要求）。
   *
   * 为什么是"双击"而不是再塞一个「详情」按钮：这一行已经有勾选框 + 批准 + 拒绝三个控件，
   * 真机上面板宽度有限，再加一个按钮会把内容摘要挤到看不见（而摘要正是"要不要展开"的依据）。
   * 手势落在行的**非控件区**（见下面的 `onDoubleClick`）：点按钮连点两下时不许顺手展开这一行
   * —— 那时它可能已经被批准/拒绝、根本不在待批准区里了。
   */
  const togglePendingExpanded = (id: string) => {
    setExpandedPending((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 两个界面瞬态集合（**勾选**、**展开**）都必须跟着待批准列表收敛。
   *
   * 两条都要挡住：① 批处理之后（那些 id 已经不在待批准区了）状态必须清掉；
   * ② 条目在别处被批/删/改（例如体检那边处置过）时，同一个 id 不许继续挂在这里。
   * 两件事是**同一条能力**（`pruneAliveIds`），所以只有一个 effect、一处实现 ——
   * 展开集合那条是第 226 波加进来的，与勾选集合逐字同源（判据 MD-8 钉住它）。
   */
  useEffect(() => {
    setSelectedPending((prev) => pruneAliveIds(prev, pending));
    setExpandedPending((prev) => pruneAliveIds(prev, pending));
  }, [pending]);

  /**
   * ★ 第 229 波：「本批」= 待批准区里**最新那一个自动提取批次**（用户要求"同批显示本批 N 条"）。
   *
   * 为什么按 `batchId` 而不是"全部待批准"：积压是**跨批次累积**的（真机取证：两条待批准
   * 带着各自批次相隔两天躺着）。用户打开面板时真正要处置的是**刚产生的那一批**，
   * 而更早的批次是"上次没处理完的存货"——两者混成一个数字，用户没法判断"这次又给我加了什么"。
   *
   * `pending` 已按 `timestamp` 倒序（`listPending` 的排序），所以第一条带批次的
   * 就是最新批次。**全部都没批次**（升级前的旧自动记忆）时是 `undefined` ⇒ 不做默认勾选
   * （没有"本批"这个概念，勾了反而是替用户猜）。
   */
  const latestBatchId = pending.find((p) => p.batchId)?.batchId;
  const batchPending = latestBatchId ? pending.filter((p) => p.batchId === latestBatchId) : [];

  /**
   * ★ 第 229 波：**本批默认勾选**（用户要求"默认全选当前批"，目的是"面板少动手"）。
   *
   * 三条纪律：
   * ① **只勾一次**：用 `autoSelectedBatchRef` 记住"已经替用户勾过哪个批次" —— 否则用户手动
   *    取消勾选后任何一次重渲染都会把它勾回来（用户会看到"取消不掉"）；
   * ② **只在批次变化时再勾**：新一批产生（`batchId` 变了）才重新默认勾选；
   * ③ **不碰勾选集合里已有的内容**（`union`，不是 `replace`）—— 用户在别的批次上勾过的选择
   *    不该被一次自动勾选抹掉。
   *
   * 放在 `pruneAliveIds` 那个 effect **之后**：先让"已经不存在的 id"退场，再补默认勾选。
   */
  const autoSelectedBatchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!latestBatchId || batchPending.length === 0) return;
    if (autoSelectedBatchRef.current === latestBatchId) return;
    autoSelectedBatchRef.current = latestBatchId;
    setSelectedPending((prev) => {
      const next = new Set(prev);
      for (const p of batchPending) next.add(p.id);
      return next;
    });
  }, [latestBatchId, batchPending]);

  const handleApproveSelected = async () => {
    const ids = [...selectedPending];
    const service = getMemoryService();
    const result = service.approveMany(ids);
    /**
     * ★ 全量审计（中）：save() 的语义是「已被接受」，**不等于已落库** ⇒ 必须等确认再回执
     * （单条路径早就这么做，批量路径漏了：落库失败时它会宣布「从现在起参与上下文」）。
     */
    const landed = await service.flushPendingPersist();
    setNotice(
      landed
        ? result.message
        : `${result.message}，但**未落库**：${service.getLastPersistError() ?? "未知原因"}（重启后这些改动会失效）。`,
    );
    setSelectedPending(new Set());
    loadEntries();
  };

  /**
   * ★ 第 229 波：**一键全部批准**（用户要求「面板少动手」）。
   *
   * ## 与「批量同意（N）」的区别（不是重复功能，别合并）
   *
   * - 「批量同意」作用于**用户勾选的**那些（勾几条动几条，按钮文案带勾选数）；
   * - 「全部批准」作用于**当前待批准区的全部**（不看勾选）。
   *
   * 两者并存是刻意的：待批准积压的处置动作绝大多数是"这一批我都认"或"这一批我都不要"，
   * 而那时用户要的是**一次点击**；逐条判断的场合仍然走勾选（`MB-UI-2` 那类场景）。
   * 所以这里不改动、也不复用 `selectedPending` —— 否则"全选才敢点"的老路径会被悄悄改掉。
   */
  const handleApproveAll = async () => {
    const ids = pending.map((p) => p.id);
    const service = getMemoryService();
    const result = service.approveMany(ids);
    const landed = await service.flushPendingPersist();
    setNotice(
      landed
        ? `一键全部批准：${result.message}`
        : `一键全部批准：${result.message}，但**未落库**：${service.getLastPersistError() ?? "未知原因"}（重启后这些改动会失效）。`,
    );
    setSelectedPending(new Set());
    loadEntries();
  };

  /**
   * ★ 第 229 波：**一键全部拒绝**（删掉当前待批准区的全部条目）。
   *
   * ## 为什么这个动作**必须**有二次确认，而勾选版没有
   *
   * 勾选版最多删用户亲手勾的那几条（他刚刚看过每一条）；这一版会在**一次点击里删掉整片积压**，
   * 而积压里可能混着用户还没看过的条目 ⇒ 命中本仓既有纪律「一次删 N 条要有二次确认」
   * （`handleUndoBatch` 与体检的批量删除走的是同一道闸）。
   * 「全部批准」**不加**确认：它是把条目变成生效，随时可以用「撤销该批」或删除回退，
   * 与"不可逆地删数据"不同档。
   */
  const handleRejectAll = async () => {
    const confirmed = await confirmDialog(
      `确定拒绝并删除全部 ${pending.length} 条待批准记忆？此操作不可撤销。` +
        "它们会被记为「已拒绝同类」⇒ 此后相似的自动记忆会被静默跳过；已生效的记忆不受影响。",
    );
    if (!confirmed) {
      setNotice("已取消：没有删除任何待批准记忆。");
      return;
    }
    const ids = pending.map((p) => p.id);
    const service = getMemoryService();
    const result = service.rejectMany(ids);
    const landed = await service.flushPendingPersist();
    setNotice(
      landed
        ? `一键全部拒绝：${result.message}`
        : `一键全部拒绝：${result.message}，但**未落库**：${service.getLastPersistError() ?? "未知原因"}（重启后这些条目会回来）。`,
    );
    setSelectedPending(new Set());
    loadEntries();
  };

  const handleRejectSelected = async () => {
    const ids = [...selectedPending];
    const service = getMemoryService();
    const result = service.rejectMany(ids);
    /**
     * ★ 全量审计（中）：回执要等**落库确认** —— `rejectMany` 的 message 只是「已被接受」，
     * 写不进去时那句「已删除」是假成功（同族的「撤销该批」早就等了 flushPendingPersist）。
     */
    const landed = await service.flushPendingPersist();
    setNotice(
      landed
        ? result.message
        : `${result.message}，但**未落库**：${service.getLastPersistError() ?? "未知原因"}（重启后这些条目会回来）。`,
    );
    setSelectedPending(new Set());
    loadEntries();
  };

  const handleUndoBatch = async (batchId: string) => {
    /**
     * ★ 全量审计（中）：**一次删 N 条要有二次确认**（与体检的删除动作同一道闸）。
     */
    const batch = getMemoryService().listBatches().find((b) => b.id === batchId);
    const confirmed = await confirmDialog(
      `确定撤销这一批（${batch?.count ?? 0} 条自动记忆）？此操作不可撤销。` +
        "手动记忆与其它批次不受影响。",
    );
    if (!confirmed) {
      setNotice("已取消撤销该批（没有删除任何条目）。");
      return;
    }
    const service = getMemoryService();
    const result = service.undoBatch(batchId);
    const landed = await service.flushPendingPersist();
    setNotice(
      landed
        ? result.message
        : `${result.message}，但**未落库**：${service.getLastPersistError() ?? "未知原因"}（重启后这些条目会回来）。`,
    );
    loadEntries();
  };

  const handleToggleApproval = async (scope: keyof ApprovalScopeSetting) => {
    /**
     * ★ 全量审计（高）：这个开关是**安全开关**（关掉审批 = 自动记忆直接进上下文），
     * 所以必须走确认式写入并如实回执 —— 原来只改内存/镜像就宣布「已更新」，
     * 磁盘可能没写 ⇒ 重启后静默回到旧值（甚至回到「直接生效」），用户以为审批开着。
     */
    const desired = { [scope]: !approval[scope] } as Partial<ApprovalScopeSetting>;
    const landed = await setWriteApprovalSettingConfirmed(desired);
    const next = setWriteApprovalSetting(desired);
    setApproval(next);
    const state =
      `平台=${next.platform ? "开" : "关"}, 项目=${next.project ? "开" : "关"}, 对话=${next.conversation ? "开" : "关"}`;
    setNotice(
      landed
        ? `写入审批已更新（已确认落库）：${state}。开启时自动提取只写入待批准区，未批准不进上下文。`
        : `写入审批${state}，但**未落库**（重启后会回到原来的设置）。请检查存储是否可用后重试。`,
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

  /**
   * 待批准条目的**判断依据**（第 226 波，用户要求：审批时看不到详细信息）。
   *
   * 内容 = 「这条记忆是什么」+「批准它会发生什么」，两半都必须有：
   * - **完整内容**（一个字符都不截断 —— 摘要里常常只剩铺垫，正是用户判断不了的原因）；
   * - **作用域 + 生效范围 + 归属**（批准后它会在哪些项目/对话里生效，还是**哪都不会**）；
   * - **来源**（自动提取的条目要单独标注，用户据此决定信任度）；
   * - **状态**（走 `entryStatusText`，与详情面板同一句话）；
   * - 批次 / 最后修改时间 / 标签（可核对、可追溯）。
   *
   * ⚠️ 文案一律取上面那些 helper（`pendingScopeLabel` / `pendingScopeTitle` / `getScopeHint` /
   * `pendingOwnerText` / `sourceLabel` / `sourceHint` / `entryStatusText` /
   * `MemoryService.PANEL_TIMESTAMP_LABEL`）—— **不在这里硬编码任何一句判断口径**，
   * 否则详情面板改了说法、这里还是旧的（本仓"两套说法"的经典形态）。
   */
  const renderPendingDetail = (entry: MemoryEntry) => (
    <div className="memory-pending-detail" data-testid="memory-pending-detail">
      <div className="memory-detail-section">
        <label>完整内容（不截断）</label>
        <pre className="memory-detail-content">{entry.content}</pre>
      </div>
      <div className="memory-detail-section">
        <label>键</label>
        <span className="memory-detail-mono">{entry.key}</span>
      </div>
      <div className="memory-detail-section">
        <label>作用域与生效范围</label>
        <span>
          {pendingScopeLabel(entry)} · {pendingScopeTitle(entry)}；生效范围：{getScopeHint(entry.scope, entry)}
        </span>
      </div>
      <div className="memory-detail-section">
        <label>归属</label>
        <span>{pendingOwnerText(entry, projectId, sessionId)}</span>
      </div>
      <div className="memory-detail-section">
        <label>来源</label>
        <span>
          {sourceLabel(entry.source)}（{sourceHint(entry.source)}）
        </span>
      </div>
      <div className="memory-detail-section">
        <label>状态</label>
        <span>{entryStatusText(entry, isInjected(entry), notInjectedReason(entry))}</span>
      </div>
      {entry.batchId && (
        <div className="memory-detail-section">
          <label>批次</label>
          <span className="memory-detail-mono">{entry.batchId}</span>
        </div>
      )}
      <div className="memory-detail-section">
        <label>{MemoryService.PANEL_TIMESTAMP_LABEL}</label>
        <span>{formatTime(entry.timestamp)}</span>
      </div>
      {entry.tags && entry.tags.length > 0 && (
        <div className="memory-detail-section">
          <label>标签</label>
          <div className="memory-detail-tags">
            {entry.tags.map((tag) => (
              <span key={tag} className="memory-detail-tag">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  /**
   * ★ 第 231 波 A1：**「本会话已自动降级 N 条」的可见信号**。
   *
   * 被守的缺陷（独立审计 · 中 · 安全面）：待批准积压到上限后，`llm/index.ts` 会把本来要用户
   * 批准的候选**降级为对话级直接生效**（只影响当前会话）。代价是"用户少了一次否决机会"，
   * 而面板此前一个字的提示都没有 ⇒ 用户不知道这次绕过了他。
   *
   * 这段的两个刻意之处：
   * - **计数来自引擎**（`listBacklogDemotedForSession`，只认写入路径打的 `demotedFrom`），
   *   不在这里数 pending、也不自己按"对话级 + auto"扫库另算（那样会多算本来就不审批的条目）；
   * - **点开要能看到是谁**：标题 / 时间 / **原作用域**，并明写"它们已进入本会话上下文" ——
   *   只给一个数字等于让用户知道"有件事发生过"却查不到，那和没提示差不多。
   */
  const renderDemotedBacklogNotice = () => {
    if (demotedBacklog.length === 0) return null;
    const n = demotedBacklog.length;
    return (
      <div className="memory-demoted-notice">
        <button
          type="button"
          className="memory-demoted-toggle"
          aria-expanded={demotedOpen}
          onClick={() => setDemotedOpen((open) => !open)}
          title="这些条目在待批准积压达到上限时被降级为对话级、并且**直接生效**了 —— 点开看是哪几条"
        >
          {demotedOpen ? "收起本会话自动降级的条目" : "本会话已自动降级 " + n + " 条（查看）"}
        </button>
        {demotedOpen && (
          <div className="memory-demoted-body">
            <div className="memory-demoted-hint">
              待批准积压达到上限后，这 {n} 条没能进入待批准区，被**降级为对话级直接生效** ——
              它们已进入本会话上下文（未经你逐条批准）。要撤销就删掉它们，或把作用域改回原样。
            </div>
            {demotedBacklog.map((entry) => (
              <div className="memory-demoted-item" key={entry.id}>
                <span className="memory-demoted-key">{entry.key}</span>
                <span className="memory-demoted-time">{formatTime(entry.timestamp)}</span>
                <span className="memory-demoted-scope">
                  原作用域：{MEMORY_SCOPE_BADGE_LABEL[entry.demotedFrom as MemoryScope] ?? String(entry.demotedFrom)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

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

      {/*
        第 230 波（用户拍板）：**本处为 0、全局 > 0** 时补一行。

        被守的形态：面板按当前位置过滤（本处 0 条 ⇒ 待批准区整块不渲染），而库里
        **别处**还躺着待批准条目 —— 用户看到的是"没有待批准"，同时系统已经在
        `MEMORY_PENDING_BACKLOG_LIMIT`（5 条）那道闸上把新候选降级成对话级了。
        两个读数对不上，而用户没有任何地方能看出"积压其实满了"。

        刻意只做**一行文字**（用既有的 `.memory-pending-hint.active` 样式，不动 styles.css）：
        - 不弹窗、不做横幅 —— 它不是失败，只是"还有别处的事"（弹窗会打断正在做的事）；
        - 不改任何既有语义：单条批准/拒绝、批量、全选、一键全部批准/拒绝、整合、双击展开
          一个字节都没动（本处 0 条时那些控件本来就不渲染）。

        判据 `MEM-OTHER-PENDING-1`~`4`（真渲染 + 变异自证）钉住：
        `本处==0 && 全局>0` ⇒ 出现且 N = **全局**数；`本处>0` ⇒ 不出现；`全局==0` ⇒ 不出现。
      */}
      {pending.length === 0 && globalPending > 0 && (
        <div className="memory-pending-hint active" data-testid="memory-other-projects-pending">
          其它项目还有 {globalPending} 条待批准（去记忆体检处置）
        </div>
      )}

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

      {/*
        ★ 第 231 波（用户实报）：待批准条数 11，列表**只显示 7 条、没有滚动条**，第 8 条起被裁在底部
        —— 既看不到也批不了，剩下 4 条无从触达。

        根因（真机量测，VP 1200×700，隔离根造 12 条 pending）：
        `.memory-pending-section` 既没有自己的高度约束、也没有 `overflow`，12 条一路把它撑到
        **619px**，而 `.memory-manager` 只有 **558px** ⇒ 超出的部分被祖先 `.app-content` 的
        `overflow: hidden` 裁掉；`section` / `manager` 的 `scrollTop` 都动不了（`tryScroll.moved=false`），
        第 12 条的 `getBoundingClientRect().bottom = 895` 已经越过面板底边 629 ——
        **没有任何一个元素负责滚动**，所以"看不到"就变成"不可达"。

        修法（结构）：把这块拆成**两段** ——
        · `.memory-pending-head`：标题 / 手势提示 / 勾选+批量栏 / 本批+一键全部，**不滚**（`flex: none`）；
        · `.memory-pending-list`：唯一的滚动区（`flex: 1 1 auto; min-height: 0; overflow-y: auto`），
          条目与展开块都在里面 ⇒ 展开一条也只是把它的 scrollHeight 撑大，后面的条目仍能滚到。
        高度上限交给 `.memory-pending-section` 的 `max-height: 55%` + `min-height: 0`（不写 `100vh` 之类）。
      */}
      {/* 待批准区 */}
      {pending.length > 0 && (
        <div className="memory-pending-section">
          <div className="memory-pending-head">
            <div className="memory-pending-title">待批准的自动记忆（{pending.length} 条，未批准不进上下文）</div>
            {renderDemotedBacklogNotice()}
            {/*
              第 226 波（用户报「审批时看不到详细信息，没法判断该不该通过」）：
              **双击任意一条**即可展开它的完整内容与判断依据（作用域 / 归属 / 来源 / 是否会进上下文）。
              这句提示是功能的一部分 —— 手势类交互没有可点的外观，不写出来用户就永远不知道有它
              （判据 MEM-APPROVE-DETAIL-7 钉住它必须在界面上）。
            */}
            <div className="memory-pending-expand-hint">
              双击任意一条可展开**完整内容与判断依据**（作用域 / 归属 / 来源 / 是否进上下文）；再双击一次收起。摘要只有前 80 字，长条目**必须**展开看全文再决定。
            </div>
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
            {/*
              ★ 第 229 波：「本批 N 条」+ **一键全部批准 / 全部拒绝**（用户要求「面板少动手」）。

              为什么**独占一行**（`.memory-pending-all-bar`）而不是塞进上面的批量条：
              上面那一条的语义是"勾选 + 批量处置"（数字 = **勾选数**），这里两个按钮的数字 =
              **待批准总数**。两种口径挤在一行里，用户会把「批量同意（2）」与「全部批准（9）」
              读成同一件事的两个数字 —— 那正是本仓反复强调的"两个数必须各说清各是什么"。
            */}
            <div className="memory-pending-all-bar">
              <span className="memory-pending-batch-hint">
                {latestBatchId
                  ? `本批 ${batchPending.length} 条（最近一次自动提取 · ${latestBatchId}）；待批准共 ${pending.length} 条。`
                  : `待批准共 ${pending.length} 条（没有批次号 —— 升级前的旧数据）⇒ 不默认勾选。`}
                {latestBatchId && batchPending.length > 0 ? "本批已默认勾选，可直接批量处置。" : ""}
              </span>
              <button
                className="memory-approve-btn"
                title={`批准当前全部 ${pending.length} 条待批准记忆：它们从现在起参与上下文`}
                onClick={handleApproveAll}
              >
                全部批准（{pending.length}）
              </button>
              <button
                className="memory-reject-btn"
                title={`拒绝并删除当前全部 ${pending.length} 条待批准记忆（删除前会二次确认）`}
                onClick={handleRejectAll}
              >
                全部拒绝（{pending.length}）
              </button>
              {/*
                2026-10-18（用户实报「每轮都有很多审批，拒绝了很多还是每轮都有」）：
                根因不是"批得太慢"，而是**项目级自动记忆默认逐条审批** —— 用户每轮都要做一次
                同样的决定。这里给一个**一次性关掉这档审批**的入口（就是写入审批里的 project 档），
                以后项目级自动记忆直接生效、不再逐条打扰；平台级仍保留审批。
                文案必须写明代价：关掉之后它不再问你就进上下文（可在写入审批里重新打开）。
              */}
              {approval.project && (
                <button
                  className="memory-approve-btn"
                  title="把「项目级」写入审批关掉：以后项目级自动记忆直接生效，不再逐条询问（平台级仍会问）"
                  onClick={async () => {
                    // 用项目统一的原生确认框（裸 window.confirm 被 NC-1 判据禁止）
                    const ok = await confirmDialog(
                      "以后项目级自动记忆直接生效、不再逐条询问（平台级仍会询问）。" +
                        "代价：这些条目会不经你确认就进入此后该项目的上下文" +
                        "（仍可在「写入审批」里重新打开审批，或在记忆列表里删除）。确定关闭吗？",
                    );
                    if (!ok) return;
                    await handleToggleApproval("project");
                  }}
                >
                  以后不再逐条批准
                </button>
              )}
            </div>
          </div>
          {/* 唯一的滚动区：条目与展开块都在这层里（见上面第 231 波的说明） */}
          <div className="memory-pending-list">
            {pending.map((entry) => {
              const expanded = expandedPending.has(entry.id);
              return (
              <div
                key={entry.id}
                className={`memory-pending-item${expanded ? " expanded" : ""}`}
                /*
                 * 第 226 波：**双击展开**（用户要求的手势）。
                 * 只在"非控件区"生效：点在勾选框/批准/拒绝上连点两下时不许顺手展开这一行
                 * —— 那时它多半已经被批准/拒绝了，展开一个马上要消失的行毫无意义，
                 * 反而会让按钮的连点行为看起来"多做了一件事"。
                 */
                onDoubleClick={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (target?.closest("button, input, label, select, a")) return;
                  togglePendingExpanded(entry.id);
                }}
                title={
                  expanded
                    ? "双击收起详细信息"
                    : "双击展开完整内容与判断依据（作用域 / 归属 / 来源 / 是否会进上下文）"
                }
              >
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
                {/* 第 226 波：双击展开的判断依据（独占一行，见 CSS 的 flex: 1 0 100%） */}
                {expanded && renderPendingDetail(entry)}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/*
        第 231 波 A1：**待批准区为空、但本会话确实有被降级的条目**时，这条信号也必须出现 ——
        否则"积压撞上限把候选悄悄放行"最典型的形态（待批准清空了、降级发生过）恰好没有提示。
        与上面 pending 区里那一处是同一个渲染函数，不另写一份。
      */}
      {pending.length === 0 && demotedBacklog.length > 0 && (
        <div className="memory-demoted-section">{renderDemotedBacklogNotice()}</div>
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
                <span>{entryStatusText(selectedEntry, isInjected(selectedEntry), notInjectedReason(selectedEntry))}</span>
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
