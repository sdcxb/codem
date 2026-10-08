/**
 * 「记忆体检」视图（设置 → 记忆体检）。
 *
 * ## 这个视图存在的理由
 *
 * 作用域/信任边界重构之后，用户真正需要回答的问题是"**我这些记忆到底在哪儿生效、是谁写的**"。
 * 尤其对**升级前就存在的老数据**：迁移只能如实保留行为（旧 `project` → `platform`、
 * 旧 `session` → 无归属 `conversation`），但用户得看得见"这些条目的归属是不知道的"，
 * 并且能一条条梳理（批量删除 / 手工归位）。
 *
 * ## 硬纪律（写在组件里，避免以后被"优化"掉）
 *
 * 1. **自动判断只能用于展示**：`unknown`/`auto` 这类标注只是标签，任何地方都**不许**据此
 *    自动删除或自动改写条目 —— 删除/归位必须来自用户显式勾选；
 * 2. **归属解析失败一律显示"未知"**：不许猜、更不许把"归属未知"静默归到平台级；
 * 3. **不 N+1**：项目/会话名**批量**取一次（`buildOwnershipIndexFrom`），渲染几百条也只有一次解析。
 */
import { useMemo, useState } from "react";
import { useProjectStore } from "../core/store";
import { confirmDialog } from "../core/ui/native-dialog";
import {
  getMemoryService,
  isLegacyPoolInjectionPaused,
  setLegacyPoolInjectionPaused,
  type MemoryScope,
} from "../core/memory/memory";
import {
  buildOwnershipIndexFrom,
  createMemoryCheckup,
  keepManyAsPlatform,
  retargetEntry,
  UNRESOLVED_REASON,
  type CheckupGroup,
  type CheckupRetarget,
  type CheckupSource,
} from "../core/memory/checkup";

interface MemoryCheckupViewProps {
  /** 当前项目 id（归一化工作目录）；用于显示"这条现在会不会生效" */
  projectId?: string;
  /** 当前对话 id */
  sessionId?: string;
  /** 跳到某个项目 / 某个对话（归属那一栏可点） */
  onNavigate?: (target: { projectId?: string; sessionId?: string }) => void;
}

const SOURCE_LABEL: Record<CheckupSource, string> = {
  manual: "手动",
  auto: "自动",
  unknown: "未知（旧数据）",
};

/** 作用域徽标文案（M-5：不认识的词要**原样**显示，不许假装它是三者之一） */
function scopeBadgeLabel(entry: CheckupGroup["entries"][number]): string {
  if (entry.scope === "platform") return "平台级";
  if (entry.scope === "project") return "项目级";
  if (entry.scope === "conversation") return "对话级";
  return `作用域：${entry.scopeRaw || "（空）"}`;
}

function formatTime(timestamp: number): string {
  // C2：缺时间戳的旧条目原来会显示 "Invalid Date"，这里如实写「日期未知」
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "日期未知";
  return new Date(timestamp).toLocaleString("zh-CN");
}

export function MemoryCheckupView({ projectId, sessionId, onNavigate }: MemoryCheckupViewProps) {
  const projects = useProjectStore((s) => s.projects);
  const sessions = useProjectStore((s) => s.sessions);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const [retargetFor, setRetargetFor] = useState<string | null>(null);
  const [retargetValue, setRetargetValue] = useState("");
  /** M-2：「暂停注入旧版跨项目记忆」开关（默认关 = 保持既有可见范围不变） */
  const [paused, setPaused] = useState(() => isLegacyPoolInjectionPaused());

  /**
   * 归属索引**批量**建一次（用 store 里已加载的项目/会话，不额外打存储）；
   * `version` 只为在删除/归位后强制重算。
   */
  const index = useMemo(() => {
    const byProject = new Map<string, Array<{ id: string; title: string }>>();
    for (const s of sessions) {
      const list = byProject.get(s.projectId) ?? [];
      list.push({ id: s.id, title: s.title });
      byProject.set(s.projectId, list);
    }
    return buildOwnershipIndexFrom(projects, byProject);
  }, [projects, sessions]);

  const checkup = useMemo(() => createMemoryCheckup({ projectId, sessionId }, { index }), [index, projectId, sessionId, version]);

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (group: CheckupGroup) => {
    const ids = group.entries.map((e) => e.id);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 批量删除 + **确认落库**（F6）：`removeMany` 只把改动交给确认链，
   * 所以回执必须等 `flushPendingPersist()` —— 否则库写不进去时界面那句「删除 N 条」是假成功。
   */
  const applyDelete = async (ids: string[], what: string) => {
    const service = getMemoryService();
    const result = service.removeMany(ids);
    const landed = await service.flushPendingPersist();
    setSelected(new Set());
    setNotice(
      `${what}：删除 ${result.removed} 条` +
        (result.notFound.length > 0 ? `（${result.notFound.length} 条已不存在）` : "") +
        (landed ? "，已落库。" : `，但**未落库**：${service.getLastPersistError() ?? "未知原因"}（重启后这些删除会失效）。`) +
        `未勾选的条目一条都没动。`,
    );
    setVersion((v) => v + 1);
  };

  const handleDeleteSelected = () => {
    if (selected.size === 0) {
      setNotice("没有勾选任何条目。体检的标注只用于展示，删除必须由你勾选确认。");
      return;
    }
    void applyDelete(Array.from(selected), "批量删除");
  };

  const handleClearAll = async () => {
    const all = checkup.groups.flatMap((g) => g.entries.map((e) => e.id));
    if (all.length === 0) {
      setNotice("没有可清空的记忆。");
      return;
    }
    /*
     * 二次确认：清空全部是不可撤销的破坏性动作。
     *
     * ⚠️ 必须走 `confirmDialog()`，**不能**用 `window.confirm`：
     * 在 Tauri 的 dialog 插件下 `window.confirm` 返回的是 **Promise**（恒为真值）⇒
     * "确认"这道闸门会静默失效（NC-1 就是这么被钉住的）。
     * 拿不到答案时 `confirmDialog` 按**取消**处理（fail-closed），正是这里要的语义。
     */
    const confirmed = await confirmDialog(`确定清空全部 ${all.length} 条记忆？此操作不可撤销（包括手动记忆）。`);
    if (!confirmed) {
      setNotice("已取消清空全部（没有删除任何条目）。");
      return;
    }
    void applyDelete(all, "清空全部");
  };

  const handleRetarget = async (id: string) => {
    const raw = retargetValue.trim();
    if (!raw) {
      setNotice("请选择归位目标。");
      return;
    }
    let target: CheckupRetarget;
    if (raw === "platform") target = { scope: "platform" };
    else if (raw.startsWith("project:")) target = { scope: "project", projectId: raw.slice("project:".length) };
    else target = { scope: "conversation", sessionId: raw.slice("conversation:".length) };

    const result = await retargetEntry(id, target);
    setNotice(result.ok ? `${result.message}（来源与批次归属不变）` : result.message);
    setRetargetFor(null);
    setRetargetValue("");
    setVersion((v) => v + 1);
  };

  /**
   * M-2：「暂停注入旧版跨项目记忆」。
   *
   * 默认**关**（保持既有可见范围不变，不偷偷改行为）；打开后带 `legacyPool` 标记的条目
   * 停止注入，直到用户把它们删掉、归位、或显式「保留为平台级」。
   */
  const handleTogglePause = () => {
    const next = !paused;
    setLegacyPoolInjectionPaused(next);
    setPaused(next);
    setNotice(
      next
        ? "已暂停注入旧版跨项目记忆：这些条目现在**不进上下文**（其它记忆不受影响）。处置完可再关掉开关。"
        : "已恢复注入旧版跨项目记忆：它们重新参与所有项目的上下文（与升级前一致）。",
    );
    setVersion((v) => v + 1);
  };

  /** M-2：把（一组）旧池条目「保留为平台级」—— 只摘标记，不改可见范围（回执等确认落库，F6） */
  const handleKeepAsPlatform = async (ids: string[]) => {
    if (ids.length === 0) {
      setNotice("这一组已经空了。");
      return;
    }
    const result = await keepManyAsPlatform(ids);
    setSelected(new Set());
    /*
     * F3：批量动作的回执**直接用 checkup 侧那句如实的话**（它已经含"已确认落库/未落库 + 失败原因"），
     * 这里不再自己拼一遍（自己拼就会把"未落库"说成"N 条失败"，或者把失败吞掉）。
     */
    setNotice(
      `${result.message}。可见范围不变（仍对所有项目生效），它们已移入普通「平台级」组、不再受暂停开关影响。`,
    );
    setVersion((v) => v + 1);
  };

  /** M-6：迁移前快照（有它才显示「回退」入口） */
  const snapshot = useMemo(
    () => getMemoryService().getPreMigrationSnapshot(),
    [version],
  );

  /**
   * M-6：回退到迁移前 —— **二次确认 + 不可逆提示**，然后逐字写回原字符串。
   */
  const handleRollback = async () => {
    if (!snapshot) {
      setNotice("没有可用的迁移前快照。");
      return;
    }
    const confirmed = await confirmDialog(
      `确定回退到迁移前（${formatTime(snapshot.takenAt)}，${snapshot.entries} 条）？\n` +
        `此操作**不可撤销**：会把记忆库整体恢复成迁移前那份原始内容（当前对记忆做的所有改动都会丢失）。\n` +
        `回退后旧作用域条目只能在「作用域无法识别」组里看到，需要你逐条归位。`,
    );
    if (!confirmed) {
      setNotice("已取消回退（库内容一字未动）。");
      return;
    }
    const result = await getMemoryService().restorePreMigrationSnapshot();
    setNotice(result.message);
    setSelected(new Set());
    setVersion((v) => v + 1);
  };

  /** M-6：导出这份快照（留档用；与「导出 JSON」同一条本地下载路径） */
  const handleExportSnapshot = () => {
    const text = getMemoryService().exportPreMigrationSnapshot();
    if (!text) {
      setNotice("没有可用的迁移前快照。");
      return;
    }
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codem-memory-pre-migration-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice("已导出迁移前快照（含时间、条数与迁移前的原始字符串）。");
  };

  const renderEntry = (entry: CheckupGroup["entries"][number]) => (
    <div key={entry.id} className={`mc-entry ${selected.has(entry.id) ? "selected" : ""}`}>
      <label className="mc-entry-check">
        <input
          type="checkbox"
          checked={selected.has(entry.id)}
          aria-label={`勾选记忆 ${entry.key}`}
          onChange={() => toggleOne(entry.id)}
        />
      </label>
      <div className="mc-entry-body">
        <div className="mc-entry-header">
          <span className="mc-entry-key">{entry.key}</span>
          <span className={`mc-source-badge ${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
          <span className={`mc-scope-badge ${entry.legacyPool ? "legacy-pool" : entry.scope}`}>
            {scopeBadgeLabel(entry)}
          </span>
          {/* M-2：旧版跨项目池的**可展示标记**（用户要能一眼认出"哪几条是被污染进来的"） */}
          {entry.legacyPool && <span className="mc-source-badge legacy-pool">旧版跨项目池</span>}
          {entry.status === "pending" && <span className="mc-source-badge pending">待批准</span>}
          {!entry.injected && <span className="mc-source-badge not-injected">不进上下文</span>}
        </div>
        <div className={`mc-entry-content ${expanded.has(entry.id) ? "expanded" : ""}`}>{entry.content}</div>
        {/* I4：`injected=false` 必须给**真实原因**（不许只给一个徽标让用户猜） */}
        {!entry.injected && entry.notInjectedReason && (
          <div className="mc-entry-reason">不注入的原因：{entry.notInjectedReason}</div>
        )}
        <button className="mc-expand-btn" onClick={() => toggleExpand(entry.id)}>
          {expanded.has(entry.id) ? "收起" : "展开"}
        </button>
        <div className="mc-entry-meta">
          <span>{formatTime(entry.timestamp)}</span>
          {entry.batchId && <span className="mc-entry-batch">批次 {entry.batchId}</span>}
          {entry.scope === "project" && (
            <button
              className="mc-owner-link"
              onClick={() => onNavigate?.({ projectId: entry.projectId })}
              title="跳到该项目"
            >
              归属：{entry.projectId ? index.projectName(entry.projectId) : "未知"}
            </button>
          )}
          {entry.scope === "conversation" && (
            <button
              className="mc-owner-link"
              onClick={() => onNavigate?.({ sessionId: entry.sessionId })}
              title="跳到该对话"
            >
              归属：{entry.sessionId ? index.sessionTitle(entry.sessionId) : "未知"}
            </button>
          )}
          {entry.scope === "platform" && <span className="mc-entry-owner">归属：所有项目</span>}
          {/* 旧条目**没有 batchId** ⇒「撤销批次」对它们结构性无意义，这里如实说明 */}
          {entry.legacyPool && <span className="mc-entry-owner">无批次信息（不能用「撤销批次」，请用批量删除）</span>}
        </div>

        {retargetFor === entry.id ? (
          <div className="mc-retarget-row">
            <select
              value={retargetValue}
              aria-label={`选择「${entry.key}」的归位目标`}
              onChange={(e) => setRetargetValue(e.target.value)}
            >
              <option value="">选择归位目标…</option>
              <option value="platform">平台级（所有项目）</option>
              {projects.map((p) => (
                <option key={p.id} value={`project:${p.path}`}>
                  项目级 · {p.name}
                </option>
              ))}
              {sessions.map((s) => (
                <option key={s.id} value={`conversation:${s.id}`}>
                  对话级 · {(projects.find((p) => p.id === s.projectId)?.name ?? s.projectId)} / {s.title}
                </option>
              ))}
            </select>
            <button className="mc-retarget-confirm" onClick={() => void handleRetarget(entry.id)}>确认归位</button>
            <button className="mc-retarget-cancel" onClick={() => { setRetargetFor(null); setRetargetValue(""); }}>取消</button>
          </div>
        ) : (
          <button
            className="mc-retarget-btn"
            onClick={() => { setRetargetFor(entry.id); setRetargetValue(""); }}
          >
            归位…
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="memory-checkup">
      <div className="mc-header">
        <div className="mc-title">记忆体检</div>
        <div className="mc-header-actions">
          <button className="mc-action-btn" onClick={handleDeleteSelected}>
            批量删除选中（{selected.size}）
          </button>
          <button className="mc-action-btn danger" onClick={handleClearAll}>清空全部</button>
        </div>
      </div>

      <div className="mc-summary">
        <span>总计 {checkup.total} 条</span>
        <span>手动 {checkup.sourceCounts.manual}</span>
        <span>自动 {checkup.sourceCounts.auto}</span>
        <span className="mc-summary-unknown">未知（旧数据）{checkup.sourceCounts.unknown}</span>
        <span>待批准 {checkup.pendingCount}</span>
        <span>归属未知 {checkup.unresolvedCount}</span>
        {/* I4：注入上限与"实际会进上下文"的条数必须披露（否则用户以为每条都生效） */}
        <span>实际注入 {checkup.injectedCount} 条</span>
        {checkup.truncatedCount > 0 && (
          <span className="mc-summary-unknown">超出注入上限未注入 {checkup.truncatedCount} 条</span>
        )}
        {checkup.legacyPoolCount > 0 && <span className="mc-summary-unknown">旧版跨项目池 {checkup.legacyPoolCount} 条</span>}
        {checkup.unknownScopeCount > 0 && <span className="mc-summary-unknown">作用域无法识别 {checkup.unknownScopeCount} 条</span>}
        <span>分组 {checkup.groupCount}</span>
      </div>

      {/*
        M-2：**暂停注入旧版跨项目记忆**开关。
        默认**关**（保持既有可见范围不变，不偷偷改变行为）；打开后这些条目停止注入。
      */}
      <div className="mc-switch-bar">
        <label className="mc-switch-label">
          <input
            type="checkbox"
            checked={paused}
            aria-label="暂停注入旧版跨项目记忆"
            onChange={handleTogglePause}
          />
          <span>暂停注入旧版跨项目记忆{checkup.legacyPoolCount > 0 ? `（共 ${checkup.legacyPoolCount} 条）` : ""}</span>
        </label>
        <span className="mc-switch-hint">
          默认关闭 = 与升级前行为完全一致（这些条目仍在所有项目生效）。
          打开后它们**停止进上下文**，直到你删除、归位或「保留为平台级」；其它记忆不受影响。
        </span>
      </div>

      {/* M-6：迁移前快照 —— 有快照才显示回退入口 */}
      {snapshot && (
        <div className="mc-snapshot">
          <div className="mc-snapshot-title">迁移前快照（可回退）</div>
          <div className="mc-snapshot-meta">
            拍摄于 {formatTime(snapshot.takenAt)}，含 {snapshot.entries} 条，逐字保存了迁移前的原始内容。
          </div>
          <div className="mc-snapshot-actions">
            <button className="mc-action-btn danger" onClick={handleRollback}>回退到迁移前</button>
            <button className="mc-action-btn" onClick={handleExportSnapshot}>导出这份快照</button>
          </div>
          <div className="mc-snapshot-hint">
            回退**不可撤销**：会把整库恢复成迁移前那份原始内容（迁移后做的改动都会丢失），
            且回退后旧作用域条目只能逐条归位。
          </div>
        </div>
      )}

      <div className="mc-note">
        这里的来源/归属标注**只用于展示**：程序不会因为"看起来像自动提取"就删除或改写任何条目，
        删除与归位都必须由你勾选确认。归属解析不出来的一律显示「未知」，不会被算进平台级。
        自动提取流程**不会**在后台自动删除或改写任何条目（整合只在你显式点「整合」或跑 /memory consolidate 时发生）。
      </div>

      {notice && <div className="mc-notice">{notice}</div>}

      {checkup.total === 0 && <div className="empty-hint">暂无记忆条目</div>}

      {checkup.groups.map((group) => (
        <div key={group.groupKey} className={`mc-group ${group.kind}${group.unresolved ? " unresolved" : ""}`}>
          <div className="mc-group-header">
            <button className="mc-group-select" onClick={() => toggleGroup(group)}>
              全选本组
            </button>
            <span className="mc-group-title">{group.title}</span>
            <span className="mc-group-count">{group.entries.length} 条</span>
            {/* M-2：旧池组的**批量处置**（保留为平台级）；删除/归位是下面每条的通用动作 */}
            {group.actionable && (
              <button
                className="mc-group-action"
                onClick={() => handleKeepAsPlatform(group.entries.map((e) => e.id))}
              >
                整组保留为平台级
              </button>
            )}
          </div>
          {/* 组头**必须**写明原因：旧池组、归属未知组、归属已失效组、作用域无法识别组各自一句 */}
          {group.unresolved && <div className="mc-group-reason">{group.note || UNRESOLVED_REASON}</div>}
          {!group.unresolved && <div className="mc-group-note">{group.note}</div>}
          <div className="mc-group-entries">{group.entries.map(renderEntry)}</div>
        </div>
      ))}

      {checkup.unresolvedCount === 0 && (
        <div className="mc-note">
          当前没有"归属未知"的条目。若以后出现（例如从旧版本升级后首次打开），它们会单独成组并写明原因，
          不会被算进平台级。
        </div>
      )}
    </div>
  );
}

/** 供设置面板/测试复用的作用域文案（与 MemoryManager 的措辞保持一致） */
function scopeLabel(scope: MemoryScope): string {
  if (scope === "platform") return "平台级";
  if (scope === "project") return "项目级";
  return "对话级";
}
