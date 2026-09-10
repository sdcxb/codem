/**
 * PersonaManager — 人设卡管理（B2，对标 EAC dsh-soul-md 人设卡）
 *
 * - 卡片列表：激活状态 / 名称 / 来源（内联 or 文件路径）
 * - 新建/编辑：名称 + 内容（或外部 soul.md 路径）+ 兜底文本
 * - 设为激活 / 取消激活 / 删除
 * - 提示：文件模式改动即热重载（下次组装生效，无需重启）
 */
import { useState, useEffect, useCallback } from "react";
import { useLang } from "../core/i18n/lang";
import { Plus, Trash2, Check, Star, X, FileText, Pencil } from "lucide-react";
import {
  listPersonaCards, savePersonaCard, deletePersonaCard,
  getActivePersonaId, setActivePersona, clearActivePersona,
  type PersonaCard,
} from "../core/persona/persona";

interface PersonaManagerProps {
  onClose?: () => void;
}

export function PersonaManager({ onClose }: PersonaManagerProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [cards, setCards] = useState<PersonaCard[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [editing, setEditing] = useState<PersonaCard | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [fallback, setFallback] = useState("");

  const reload = useCallback(() => {
    setCards(listPersonaCards());
    setActiveId(getActivePersonaId());
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const startNew = () => {
    setEditing({ id: "", name: "", content: "", path: "", fallback: "", createdAt: 0 });
    setIsNew(true);
    setName(""); setContent(""); setPath(""); setFallback("");
  };

  const startEdit = (c: PersonaCard) => {
    setEditing(c); setIsNew(false);
    setName(c.name); setContent(c.content || ""); setPath(c.path || ""); setFallback(c.fallback || "");
  };

  const cancelEdit = () => { setEditing(null); };

  const handleSave = () => {
    if (!name.trim()) return;
    savePersonaCard({
      id: editing?.id || undefined,
      name: name.trim(),
      content: content || undefined,
      path: path.trim() || undefined,
      fallback: fallback || undefined,
    });
    setEditing(null);
    reload();
  };

  const handleDelete = (id: string) => {
    deletePersonaCard(id);
    reload();
  };

  const handleActivate = (id: string) => {
    if (activeId === id) clearActivePersona();
    else setActivePersona(id);
    reload();
  };

  return (
    <div className="persona-manager">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <strong style={{ fontSize: 'var(--fs-md)' }}>
          {zh ? "人设卡" : "Persona Cards"}
        </strong>
        <button className="mode-toggle-btn" onClick={startNew} title={zh ? "新建人设卡" : "New persona"}>
          <Plus size={15} />
        </button>
      </div>

      {editing ? (
        <div style={{ display: "grid", gap: 8, border: "1px solid var(--border-primary)", borderRadius: 10, padding: 12 }}>
          <div>
            <label style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              {zh ? "名称" : "Name"}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={zh ? "如：严谨工程师 / 创意作家" : "e.g. Senior Engineer"}
              style={{ width: "100%", padding: "6px 8px", background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 6, fontSize: 'var(--fs-sm)', boxSizing: "border-box" }}
            />
          </div>
          <div>
            <label style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              {zh ? "人设内容 (markdown，注入 # Persona 段)" : "Persona content (markdown, injected as # Persona)"}
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder={zh ? "你是……请始终……" : "You are... Always..."}
              style={{ width: "100%", padding: "6px 8px", background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 6, fontSize: 'var(--fs-sm)', boxSizing: "border-box", resize: "vertical" }}
            />
          </div>
          <div>
            <label style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              {zh ? "外部文件路径（可选，soul.md 风格热重载；填写后以文件为准）" : "External file path (optional, soul.md-style hot reload; takes priority)"}
            </label>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={zh ? "如 D:/Workspace/soul.md（留空则用上方内容）" : "e.g. D:/Workspace/soul.md (leave empty to use content above)"}
              style={{ width: "100%", padding: "6px 8px", background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 6, fontSize: 'var(--fs-sm)', boxSizing: "border-box" }}
            />
          </div>
          <div>
            <label style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              {zh ? "兜底文本（文件缺失/不可读时使用；留空 = 该卡不注入）" : "Fallback (used when file missing/unreadable; empty = card not injected)"}
            </label>
            <input
              value={fallback}
              onChange={(e) => setFallback(e.target.value)}
              style={{ width: "100%", padding: "6px 8px", background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 6, fontSize: 'var(--fs-sm)', boxSizing: "border-box" }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="inline-edit-btn save" disabled={!name.trim()} onClick={handleSave}>
              ✓ {zh ? "保存" : "Save"}
            </button>
            <button className="inline-edit-btn cancel" onClick={cancelEdit}>
              ✕ {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      ) : cards.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", padding: "12px 4px" }}>
          {zh
            ? "还没有人设卡。点击 ＋ 新建一张，激活后它会以 # Persona 段注入每个会话的系统提示（子代理同样可见）。"
            : "No persona cards yet. Create one with ＋ — when active, it is injected as a # Persona section into every session's system prompt (sub-agents included)."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {cards.map((c) => (
            <div
              key={c.id}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px", borderRadius: 8,
                background: activeId === c.id ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "var(--bg-secondary)",
                border: activeId === c.id ? "1px solid var(--accent)" : "1px solid var(--border-primary)",
              }}
            >
              {activeId === c.id
                ? <Star size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
                : <Check size={14} style={{ opacity: 0, flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
                  {c.name}
                  {c.path && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
                      <FileText size={11} /> {c.path.split(/[\\/]/).pop()}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {(c.content || c.path ? (c.path ? (zh ? "文件模式（热重载）" : "file mode (hot reload)") : (c.content || "").slice(0, 80)) : "") || (zh ? "空内容" : "empty")}
                </div>
              </div>
              <button className="toolbar-btn" aria-label={zh ? "编辑" : "Edit"} onClick={() => startEdit(c)} title={zh ? "编辑" : "Edit"}>
                <Pencil size={13} />
              </button>
              <button
                className="toolbar-btn"
                aria-label={activeId === c.id ? (zh ? "取消激活" : "Deactivate") : (zh ? "设为激活" : "Activate")}
                onClick={() => handleActivate(c.id)}
                title={activeId === c.id ? (zh ? "取消激活" : "Deactivate") : (zh ? "设为激活" : "Activate")}
              >
                {activeId === c.id ? <X size={13} /> : <Check size={13} />}
              </button>
              <button className="toolbar-btn" aria-label={zh ? "删除" : "Delete"} onClick={() => handleDelete(c.id)} title={zh ? "删除" : "Delete"}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", marginTop: 10, lineHeight: 1.6 }}>
        {zh
          ? "激活后：# Persona 段落注入系统提示（紧跟身份/语言段）。文件模式保存后下次对话自动生效（热重载）。插件管理禁用 @codem/persona 可整体关闭。"
          : "When active: a # Persona section is injected after the identity section. File-mode cards hot-reload on next turn. Disable @codem/persona in Plugin Manager to turn this off."}
      </div>
    </div>
  );
}
