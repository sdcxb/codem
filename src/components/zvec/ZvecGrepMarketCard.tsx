/**
 * ZvecGrepMarketCard — 插件市场「第三方运行时增强」卡片。
 *
 * zvec-grep（zg）语义检索运行时：安装到用户数据目录（不进安装包），
 * 以 MCP stdio 接入；卡片承担：状态展示、在线一键安装、离线 zip 导入、
 * 为当前项目建立/重建索引（模型可选）、卸载。
 *
 * 与内置 grep 双轨：精确锚点仍用 grep；语义/跨文件检索由模型在对话中
 * 自动选择 zvec_grep_search（本卡片只负责运行时与索引，不做路由干预）。
 */

import { useState, useEffect, useCallback } from "react";
import { useLang } from "../../core/i18n/lang";
import { useProjectStore } from "../../core/store";
import {
  getRuntimeStatus,
  installOnline,
  installFromZip,
  uninstall,
  rebuildIndex,
  ZVEC_MODELS,
  ZVEC_EVENT_CHANGED,
  type ZvecRuntimeStatus,
} from "../../core/zvec-grep";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";

const btnBase: React.CSSProperties = {
  padding: "5px 12px", borderRadius: 6, cursor: "pointer",
  fontSize: "var(--fs-xs)", border: "1px solid var(--border-primary)",
  display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
};
const btnPrimary: React.CSSProperties = {
  ...btnBase, background: "var(--accent)", color: "var(--text-on-accent)",
};
const btnGhost: React.CSSProperties = {
  ...btnBase, background: "var(--bg-tertiary)", color: "var(--text-primary)",
};

export function ZvecGrepMarketCard() {
  const zh = useLang() === "zh";
  const currentProject = useProjectStore((s) => s.currentProject);
  const [status, setStatus] = useState<ZvecRuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");
  const [resultMsg, setResultMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [model, setModel] = useState("local/potion-code-16m-v2");

  const refresh = useCallback(async () => {
    try {
      setStatus(await getRuntimeStatus());
    } catch { setStatus(null); }
  }, []);

  useEffect(() => {
    refresh();
    const onEvent = () => refresh();
    window.addEventListener(ZVEC_EVENT_CHANGED, onEvent);
    return () => window.removeEventListener(ZVEC_EVENT_CHANGED, onEvent);
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true); setResultMsg(null);
    try {
      await fn();
      setResultMsg({ ok: true, text: okText });
    } catch (e: any) {
      setResultMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const handleInstall = () =>
    run(
      () => installOnline((_, m) => setBusyMsg(m)),
      zh ? "安装完成，对话中即可使用语义检索（首次使用请先建索引）" : "Installed — semantic search ready (build an index first)",
    );

  const handleImportZip = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = (await open({ multiple: false, filters: [{ name: "zvec-grep 离线包", extensions: ["zip"] }] })) as string | null;
      if (!picked) return;
      await run(
        () => installFromZip(picked, (_, m) => setBusyMsg(m)),
        zh ? "离线包导入完成" : "Offline package imported",
      );
    } catch (e: any) {
      setResultMsg({ ok: false, text: e?.message || String(e) });
    }
  };

  const handleIndex = () => {
    const root = currentProject?.path;
    if (!root) {
      setResultMsg({ ok: false, text: zh ? "请先选择项目再建索引" : "Select a project first" });
      return;
    }
    run(
      async () => {
        setBusyMsg(zh ? "建立索引中（大项目可能需要几分钟）..." : "Indexing (large projects may take minutes)...");
        const r = await rebuildIndex(root, model);
        if (!r.ok) throw new Error(r.error || "index failed");
        setBusyMsg("");
      },
      zh ? "索引完成" : "Index complete",
    );
  };

  const handleUninstall = () => {
    if (!confirm(zh ? "卸载将删除运行时与模型并移除 MCP 注册。继续？" : "Uninstall removes runtime, models and the MCP entry. Continue?")) return;
    run(() => uninstall(), zh ? "已卸载" : "Uninstalled");
  };

  const installed = !!status?.runtimeInstalled;

  return (
    <div className="market-skill-card" style={{ display: "flex", flexDirection: "column", gap: 8, borderColor: "var(--accent-muted, rgba(124,108,240,0.4))" }}>
      <div className="market-skill-card-header">
        <span className="market-skill-icon" style={{ background: "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff" }}>
          <Sparkles size={16} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="market-skill-name" style={{ fontSize: "var(--fs-sm)" }}>
            zvec-grep（zg）语义检索
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2, flexWrap: "wrap" }}>
            <span style={{ fontSize: "var(--fs-2xs,10px)", color: "var(--text-muted)" }}>
              {zh ? "第三方本地运行时 · 语义+词法混合检索（与内置 grep 双轨）" : "Local runtime · semantic+lexical search (dual-track with grep)"}
            </span>
            {status && (
              <span style={{
                fontSize: "var(--fs-2xs,10px)", padding: "1px 6px", borderRadius: 8,
                background: installed ? "rgba(34,197,94,0.15)" : "var(--bg-tertiary)",
                color: installed ? "#22c55e" : "var(--text-muted)",
              }}>
                {installed ? (zh ? "已安装" : "Installed") : (zh ? "未安装" : "Not installed")}
              </span>
            )}
          </div>
        </div>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
          <button
            className="save-btn"
            style={{ ...btnGhost, padding: "3px 8px" }}
            onClick={() => setExpanded(!expanded)}
            title={zh ? "展开管理（索引/模型/卸载）" : "Manage (index/model/uninstall)"}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        </span>
      </div>

      <div className="market-skill-desc" style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", lineHeight: 1.5 }}>
        {zh
          ? `本地优先检索层（zvec 向量 + BM25 + rg）。模型/运行时装在用户数据目录，不进入安装包。安装后需为项目建立索引；对话中模型会按需选择 zvec_grep_search（语义/跨文件）或内置 grep（精确锚点）。`
          : `Local-first search (zvec vector + BM25 + rg). Runtime lives in user data dir, not the installer. Index your project after install; the agent picks zvec_grep_search (semantic) vs grep (exact) automatically.`}
      </div>

      {busy && (
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--accent)" }}>
          {busyMsg || (zh ? "处理中..." : "Working...")}
        </div>
      )}
      {resultMsg && (
        <div style={{ fontSize: "var(--fs-xs)", color: resultMsg.ok ? "#22c55e" : "#ef4444", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {resultMsg.ok ? "✅ " : "❌ "}{resultMsg.text}
        </div>
      )}

      {status && !installed && (
        <div className="market-skill-card-footer" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="save-btn" style={btnPrimary} onClick={handleInstall} disabled={busy}>
            {zh ? "一键安装（在线）" : "Install (online)"}
          </button>
          <button className="save-btn" style={btnGhost} onClick={handleImportZip} disabled={busy}>
            {zh ? "导入离线包 (.zip)…" : "Import offline .zip…"}
          </button>
          <span style={{ fontSize: "var(--fs-2xs,10px)", color: "var(--text-muted)", flex: 1 }}>
            {zh ? "在线安装约 200MB（node+zg+模型），自动检测系统 node" : "~200MB online (node+zg+model); reuses system node when present"}
          </span>
        </div>
      )}

      {status && installed && expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border-primary)", paddingTop: 8 }}>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {status.label}
            {status.systemNodeVersion && <span> · node {status.systemNodeVersion}</span>}
            {status.source === "zip" && <span> · {zh ? "离线包" : "zip"}</span>}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
              {zh ? "Embedding 模型:" : "Embedding model:"}
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{
                padding: "4px 8px", borderRadius: 6, fontSize: "var(--fs-xs)",
                border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)",
              }}
            >
              {ZVEC_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label} — {m.desc}</option>
              ))}
            </select>
            <button className="save-btn" style={btnPrimary} onClick={handleIndex} disabled={busy || !currentProject}>
              {zh ? (busy ? "索引中…" : "为当前项目建立/重建索引") : "Index current project"}
            </button>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="save-btn" style={{ ...btnGhost, color: "#ef4444" }} onClick={handleUninstall} disabled={busy}>
              {zh ? "卸载（删除运行时与模型）" : "Uninstall"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
