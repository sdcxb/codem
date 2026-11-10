/**
 * 设置 →「设备同步」（25 号文 P2 · 多设备 Host 同步）。
 *
 * ## 这个卡片负责什么
 *
 * 同步本身全在 `core/storage/sync-engine.ts`（逻辑）与 `core/remote/gateway-sync*.ts`
 * （宿主面）里。这里只做三件事：
 * 1. **配置**：Host 地址、配对码、自动同步开关与间隔、是否同步记忆；
 * 2. **动作**：配对 / 取消配对 / 立即同步；
 * 3. **如实显示**：配对状态、游标（已推送/已拉取）、设备数、最后错误、本机作为 Host 的账本读数。
 *
 * ## 三条界面纪律
 *
 * - **默认关**：开关默认不勾，勾之前不会发出任何网络请求（`autoSync` 默认 false 由
 *   `DEFAULT_SYNC_CONFIG` 保证，不是这里的局部状态）；
 * - **不弹横幅**：同步失败写在这张卡里（`lastError`）+ advisory 日志。用户能做的动作
 *   只有"看错误 + 重试"，弹横幅只会打断他；
 * - **配对码不落设置**：码只在 React state 里；配对成功后设置里只有 Host 地址与设备 id
 *   （凭据是 Host 种下的 HttpOnly cookie）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SYNC_COMPLETED_EVENT,
  SYNC_CONFIG_CHANGED_EVENT,
  applySyncRuntime,
  getDeviceId,
  getSyncConfig,
  getSyncSummary,
  normalizeGatewayUrl,
  normalizeSyncProjectIds,
  pairGateway,
  setSyncConfig,
  syncNow,
  unpairGateway,
  type SyncState,
} from "../core/storage/sync-engine";
import { listProjects } from "../core/storage/project";

/** 本机作为 Host 的账本读数（懒加载：不进来就看不到，也不拖慢设置面板） */
interface HostJournalView {
  entries: number;
  pushEntries: number;
  nativeEntries: number;
  devices: number;
  cursors: number;
  pruned: number;
  dropped: number;
  droppedUnpulled: number;
  trimmedThrough: number;
  kb: number;
}

function formatTime(ts: number, zh: boolean): string {
  if (!ts) return zh ? "从未" : "never";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function DeviceSyncSettings({ zh }: { zh: boolean }): React.ReactElement {
  const isZh = zh;
  const [summary, setSummary] = useState(() => getSyncSummary());
  const [hostUrl, setHostUrl] = useState(() => summary.config.gatewayUrl ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"" | "pair" | "sync" | "save">("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [hostJournal, setHostJournal] = useState<HostJournalView | null>(null);
  /** 项目列表（复用本机现有项目；读不出来就空着，不阻断同步配置） */
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const refreshRef = useRef<() => void>(() => {});

  const refresh = useCallback(() => {
    setSummary(getSyncSummary());
  }, []);
  refreshRef.current = refresh;

  useEffect(() => {
    refresh();
    const onChange = () => refreshRef.current();
    window.addEventListener(SYNC_CONFIG_CHANGED_EVENT, onChange);
    window.addEventListener(SYNC_COMPLETED_EVENT, onChange);
    return () => {
      window.removeEventListener(SYNC_CONFIG_CHANGED_EVENT, onChange);
      window.removeEventListener(SYNC_COMPLETED_EVENT, onChange);
    };
  }, [refresh]);

  // 本机项目列表（同步范围编辑用）：只读一次，失败就空着
  useEffect(() => {
    try {
      setProjects(
        listProjects()
          .filter((project) => typeof project.id === "string" && project.id.length > 0)
          .map((project) => ({ id: project.id, name: project.name || project.id })),
      );
    } catch {
      setProjects([]);
    }
  }, []);

  // 本机作为 Host 的账本（只读；失败就空着，不影响客户端功能）
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const mod = await import("../core/remote/gateway-sync-host");
        if (!alive) return;
        setHostJournal(mod.hostSyncJournalSummary());
      } catch {
        if (alive) setHostJournal(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const config = summary.config;
  const state: SyncState = summary.state;
  const paired = Boolean(config.gatewayPairedAt);
  const autoSync = config.autoSync === true;
  const intervalSeconds = Math.max(5, Math.round((config.autoSyncInterval || 30_000) / 1000));
  const projectIds = normalizeSyncProjectIds(config.projectIds);
  const allowedProjectIds = new Set(projectIds);

  const save = (patch: Partial<typeof config>) => {
    /*
     * 基座取**最新的**配置，而不是本次渲染的那份快照：设置可能刚被
     * `pairGateway`（或另一个入口）改过，用旧快照合并会把新字段（比如 gatewayUrl）
     * 整片抹掉 —— 表现为"配对成功但一开开关就变成未配置"。
     */
    setSyncConfig({ ...getSyncConfig(), ...patch });
    refresh();
  };

  async function doPair(): Promise<void> {
    setBusy("pair");
    setNotice(null);
    try {
      const result = await pairGateway({ url: hostUrl, code, deviceName: "Codem 桌面" });
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error || (isZh ? "配对失败" : "Pairing failed") });
        return;
      }
      setCode("");
      setNotice({
        kind: "ok",
        text: isZh
          ? `已配对（设备 ${result.deviceId || "?"}）。勾选「启用设备同步」后才会开始联网。`
          : `Paired (device ${result.deviceId || "?"}). Turn on sync to start.`,
      });
      refresh();
    } finally {
      setBusy("");
    }
  }

  async function doSync(): Promise<void> {
    setBusy("sync");
    setNotice(null);
    try {
      const result = await syncNow();
      if (result.error) {
        setNotice({ kind: "error", text: result.error });
      } else {
        setNotice({
          kind: "ok",
          text: isZh
            ? `同步完成：推送 ${result.pushed} 条 / 拉取 ${result.pulled} 条 / 冲突 ${result.conflicts} 条`
            : `Done: pushed ${result.pushed}, pulled ${result.pulled}, conflicts ${result.conflicts}`,
        });
      }
      refresh();
    } finally {
      setBusy("");
    }
  }

  function toggleEnabled(next: boolean): void {
    /*
     * 开启前先确认地址可用：没有地址就打开开关，只会得到"配置不完整"的定时器空转 ——
     * 那比直接说"先配对"更难排查。
     */
    const typedUrl = normalizeGatewayUrl(hostUrl);
    const effectiveUrl = normalizeGatewayUrl(config.gatewayUrl ?? "") || typedUrl;
    if (next && !effectiveUrl) {
      setNotice({
        kind: "error",
        text: isZh ? "先填 Host 地址并配对，再打开同步" : "Fill in the host address and pair first",
      });
      return;
    }
    setBusy("save");
    try {
      save({
        autoSync: next,
        // 手填的地址在这里落进配置：不然"开了同步但地址没保存"会表现成"配置不完整"
        ...(effectiveUrl ? { gatewayUrl: effectiveUrl, backend: "gateway" as const } : {}),
      });
      const runtime = applySyncRuntime();
      if (next && !runtime.running) {
        setNotice({
          kind: "error",
          text: runtime.reason || (isZh ? "自动同步未启动" : "Auto sync did not start"),
        });
      } else {
        setNotice(null);
      }
      refresh();
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }} data-testid="device-sync">
      <div style={{ fontSize: "var(--fs-md)", fontWeight: 600 }}>
        {isZh ? "设备同步（多设备 Host 同步）" : "Device sync (multi-device host sync)"}
      </div>
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.7 }}>
        {isZh
          ? "让另一台装了 Codem 的电脑成为「客户端」，把本机会话事件、会话内容与记忆同步到一台已开启远程网关的「Host」。事件按游标增量同步；新设备/游标落后时用会话快照把完整消息（含工具结果）搬过来。不同步原始 JSONL 与附件正文。默认关闭：只有勾选并配对后才会联网。"
          : "Let another Codem desktop act as a client and sync session events, conversation content and memory to a host running the remote gateway. Events stream by cursor; new devices (or a lagging cursor) rebuild from session snapshots with full messages and tool results. Raw JSONL and attachment bytes are not synced. Off by default: nothing goes online until you enable and pair it."}
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600 }}>{isZh ? "Host 地址" : "Host address"}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            data-testid="device-sync-host-url"
            value={hostUrl}
            placeholder="http://127.0.0.1:54321"
            onChange={(e) => setHostUrl(e.target.value)}
            onBlur={() => {
              const normalized = normalizeGatewayUrl(hostUrl);
              if (normalized && normalized !== hostUrl) setHostUrl(normalized);
            }}
            style={{ minWidth: 260, padding: "4px 8px" }}
          />
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
            {isZh ? "本机设备 id：" : "This device: "}
            <code data-testid="device-sync-device-id">{summary.deviceId || getDeviceId()}</code>
          </span>
        </div>
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", lineHeight: 1.6 }}>
          {isZh
            ? "填 Host 的「连接手机」里显示的地址（不要带 /rpc）。同一台机器测试可直接用 127.0.0.1 的地址。"
            : "Use the address shown under “Phone access” on the host (without /rpc)."}
        </div>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600 }}>{isZh ? "配对" : "Pairing"}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            data-testid="device-sync-pair-code"
            value={code}
            inputMode="numeric"
            maxLength={6}
            placeholder={isZh ? "6 位配对码" : "6-digit code"}
            onChange={(e) => setCode(e.target.value.replace(/\s+/g, ""))}
            style={{ width: 140, padding: "4px 8px", letterSpacing: 2 }}
          />
          <button
            data-testid="device-sync-pair"
            disabled={busy !== "" || code.length !== 6}
            onClick={() => void doPair()}
          >
            {busy === "pair" ? (isZh ? "配对中…" : "Pairing…") : isZh ? "配对" : "Pair"}
          </button>
          <button
            data-testid="device-sync-unpair"
            disabled={busy !== "" || (!paired && !config.gatewayUrl)}
            onClick={() => {
              unpairGateway();
              setHostUrl("");
              setNotice(null);
              refresh();
            }}
          >
            {isZh ? "取消配对" : "Unpair"}
          </button>
          <span
            data-testid="device-sync-paired"
            data-paired={paired ? "1" : "0"}
            style={{ fontSize: "var(--fs-sm)", color: paired ? "var(--success, #2a7)" : "var(--text-muted)" }}
          >
            {paired
              ? isZh
                ? `已配对（${formatTime(config.gatewayPairedAt ?? 0, isZh)}）`
                : `Paired (${formatTime(config.gatewayPairedAt ?? 0, isZh)})`
              : isZh
                ? "未配对"
                : "Not paired"}
          </span>
        </div>
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", lineHeight: 1.6 }}>
          {isZh
            ? "配对码在 Host 的「设置 → 连接手机 → 生成配对码」里拿，5 分钟有效、只能用一次。凭据是 Host 种下的 HttpOnly cookie，不写进设置。"
            : "Get the code from the host's Settings → Phone access. The credential is an HttpOnly cookie set by the host; it is never stored in settings."}
        </div>
      </div>

      <div
        data-testid="device-sync-projects"
        style={{ display: "grid", gap: 6, borderTop: "1px solid var(--border-primary)", paddingTop: 10 }}
      >
        <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600 }}>
          {isZh ? "同步的项目范围" : "Projects in scope"}
        </div>
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", lineHeight: 1.6 }}>
          {isZh
            ? "不勾任何项目 = 全部项目（默认）。勾选后，拉取/推送/快照只处理这些项目；范围外的会话不会被返回，推过去也会被 Host 拒收；没有项目归属的会话一律拒绝（fail-closed）。"
            : "No selection means all projects (default). With a selection, pull/push/snapshot only cover those projects; out-of-scope sessions are not returned and pushes are refused; sessions without a project mapping are refused (fail-closed)."}
        </div>
        {projects.length === 0 ? (
          <div data-testid="device-sync-projects-empty" style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
            {isZh ? "本机还没有项目（范围只能保持「全部」）" : "No local projects yet (scope stays “all”)"}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {projects.map((project) => (
              <label key={project.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fs-sm)" }}>
                <input
                  type="checkbox"
                  data-testid={`device-sync-project-${project.id}`}
                  checked={allowedProjectIds.has(project.id)}
                  disabled={!paired || busy !== ""}
                  onChange={(e) => {
                    const next = new Set(projectIds);
                    if (e.target.checked) next.add(project.id);
                    else next.delete(project.id);
                    save({ projectIds: [...next] });
                  }}
                />
                <span>{project.name}</span>
              </label>
            ))}
          </div>
        )}
        <div data-testid="device-sync-acl-summary" style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
          {projectIds.length === 0
            ? isZh
              ? "当前限制：全部项目"
              : "Current scope: all projects"
            : isZh
              ? `当前限制：仅 ${projectIds.length} 个项目`
              : `Current scope: ${projectIds.length} project(s)`}
          {!paired ? (isZh ? "（未配对不可编辑）" : " (unavailable until paired)") : ""}
        </div>
      </div>

      <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border-primary)", paddingTop: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-sm)" }}>
          <input
            type="checkbox"
            data-testid="device-sync-enabled"
            checked={autoSync}
            disabled={busy !== ""}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
          <span>
            {isZh ? "启用设备同步（关闭时不会发出任何网络请求）" : "Enable device sync (no requests while off)"}
          </span>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-sm)" }}>
          <input
            type="checkbox"
            data-testid="device-sync-memory"
            checked={config.syncMemory !== false}
            disabled={busy !== ""}
            onChange={(e) => save({ syncMemory: e.target.checked })}
          />
          <span>{isZh ? "同时同步记忆（冲突双方都保留，记入记忆冲突审计）" : "Sync memory too (both sides kept, audited)"}</span>
        </label>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: "var(--fs-sm)" }}>
          <span>{isZh ? "自动同步间隔" : "Interval"}</span>
          <input
            data-testid="device-sync-interval"
            type="number"
            min={5}
            max={3600}
            value={intervalSeconds}
            disabled={busy !== ""}
            onChange={(e) => {
              const next = Math.max(5, Math.min(3600, Number(e.target.value) || 30));
              save({ autoSyncInterval: next * 1000 });
              if (autoSync) applySyncRuntime();
            }}
            style={{ width: 90, padding: "4px 8px" }}
          />
          <span style={{ color: "var(--text-muted)" }}>{isZh ? "秒" : "s"}</span>
          <button data-testid="device-sync-now" disabled={busy !== ""} onClick={() => void doSync()}>
            {busy === "sync" ? (isZh ? "同步中…" : "Syncing…") : isZh ? "立即同步" : "Sync now"}
          </button>
        </div>

        <div style={{ display: "grid", gap: 4, fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
          <div data-testid="device-sync-progress">
            {isZh
              ? `已推送 seq ${state.lastPushedSeq} / 已拉取 seq ${state.lastPulledSeq} / Host 设备数 ${state.lastDevices ?? 0}`
              : `pushed seq ${state.lastPushedSeq} / pulled seq ${state.lastPulledSeq} / host devices ${state.lastDevices ?? 0}`}
          </div>
          <div data-testid="device-sync-last">
            {isZh ? "上次同步：" : "Last sync: "}
            {formatTime(state.lastSyncAt, isZh)}
            {state.lastSyncStatus === "syncing" ? (isZh ? "（进行中）" : " (running)") : ""}
            {state.lastSyncStatus === "success" ? (isZh ? "（成功）" : " (ok)") : ""}
            {state.lastSyncStatus === "error" ? (isZh ? "（失败）" : " (failed)") : ""}
          </div>
          {state.lastMemoryAt ? (
            <div data-testid="device-sync-memory-state">
              {isZh
                ? `记忆同步：${formatTime(state.lastMemoryAt, isZh)}，冲突 ${state.lastMemoryConflicts ?? 0} 条`
                : `Memory: ${formatTime(state.lastMemoryAt, isZh)}, ${state.lastMemoryConflicts ?? 0} conflicts`}
              {state.lastMemoryError ? ` · ${state.lastMemoryError}` : ""}
            </div>
          ) : null}
          {state.lastError ? (
            <div data-testid="device-sync-error" style={{ color: "var(--error, #c33)" }}>
              {isZh ? "最后错误：" : "Last error: "}
              {state.lastError}
            </div>
          ) : null}
          {config.backend === "gateway" && autoSync ? (
            <div data-testid="device-sync-runtime">
              {summary.autoSyncRunning
                ? isZh
                  ? `自动同步运行中（每 ${intervalSeconds} 秒）`
                  : `Auto sync running (every ${intervalSeconds}s)`
                : isZh
                  ? "自动同步未运行（检查地址/配对）"
                  : "Auto sync not running (check address/pairing)"}
            </div>
          ) : null}
          {state.lastResetAt ? (
            <div data-testid="device-sync-reset">
              {isZh
                ? `Host 账本已修剪到本设备游标之后（最早可用 hostSeq ${state.lastResetOldestSeq ?? 0}）⇒ 已按会话快照重建${
                    (state.snapshotRemaining ?? 0) > 0 ? `，还剩 ${state.snapshotRemaining} 个会话（下一轮继续）` : ""
                  }`
                : `Host journal was trimmed past this device cursor (oldest available hostSeq ${state.lastResetOldestSeq ?? 0}) ⇒ rebuilt from session snapshots${
                    (state.snapshotRemaining ?? 0) > 0 ? `, ${state.snapshotRemaining} session(s) left` : ""
                  }`}
            </div>
          ) : null}
          {state.lastSnapshotAt ? (
            <div data-testid="device-sync-snapshot">
              {isZh
                ? `会话快照：${state.lastSnapshotSessions ?? 0} 个会话 / 写入 ${state.lastSnapshotMessages ?? 0} 条消息${
                    (state.snapshotRemaining ?? 0) > 0 ? `（待重建 ${state.snapshotRemaining} 个）` : ""
                  }`
                : `Session snapshots: ${state.lastSnapshotSessions ?? 0} session(s) / ${state.lastSnapshotMessages ?? 0} message(s) written${
                    (state.snapshotRemaining ?? 0) > 0 ? ` (${state.snapshotRemaining} pending)` : ""
                  }`}
            </div>
          ) : null}
          {(state.lastFilteredSessions ?? 0) > 0 || (state.lastProjectSkipped ?? 0) > 0 ? (
            <div data-testid="device-sync-acl-filtered">
              {isZh
                ? `项目范围过滤：宿主挡下 ${state.lastFilteredSessions ?? 0} 个会话，本机未推送 ${state.lastProjectSkipped ?? 0} 个会话`
                : `Project scope: host filtered ${state.lastFilteredSessions ?? 0} session(s), local skipped ${state.lastProjectSkipped ?? 0}`}
            </div>
          ) : null}
        </div>

        {hostJournal ? (
          <div
            data-testid="device-sync-host-journal"
            style={{
              fontSize: "var(--fs-xs)",
              color: "var(--text-muted)",
              borderTop: "1px solid var(--border-primary)",
              paddingTop: 8,
              lineHeight: 1.7,
            }}
          >
            {isZh
              ? `本机作为 Host：账本 ${hostJournal.entries} 条（推送 ${hostJournal.pushEntries} / 本机 ${hostJournal.nativeEntries}），设备 ${hostJournal.devices} 台 / 游标 ${hostJournal.cursors} 个，已正常修剪 ${hostJournal.pruned} 条（修剪到 hostSeq ${hostJournal.trimmedThrough}），约 ${hostJournal.kb} KB${
                  hostJournal.dropped > 0
                    ? `，累计容量丢弃 ${hostJournal.dropped} 条（其中 ${hostJournal.droppedUnpulled} 条当时还有设备没拉过 ⇒ 那些设备会走快照重建）`
                    : ""
                }`
              : `This desktop as host: ${hostJournal.entries} journal entries, ${hostJournal.devices} devices / ${hostJournal.cursors} cursors, ${hostJournal.pruned} pruned (through hostSeq ${hostJournal.trimmedThrough}), ~${hostJournal.kb} KB${
                  hostJournal.dropped > 0
                    ? `, ${hostJournal.dropped} dropped under capacity (${hostJournal.droppedUnpulled} unpulled at the time)`
                    : ""
                }`}
          </div>
        ) : null}
      </div>

      {notice ? (
        <div
          data-testid="device-sync-notice"
          style={{ fontSize: "var(--fs-sm)", color: notice.kind === "error" ? "var(--error, #c33)" : "var(--success, #2a7)" }}
        >
          {notice.text}
        </div>
      ) : null}
    </div>
  );
}
