import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { createPortal } from "./ui/portal";
import { useProjectStore } from "../core/store";
import { useLang, S } from "../core/i18n/lang";
import { Search, Pin, Folder, PencilLine, BookMarked, Settings, MessageSquare } from "lucide-react";
import * as SessionStorage from "../core/storage/session";

interface SearchDialogProps {
  onClose: () => void;
  onSwitchProject: (projectId: string) => void;
  onNewSession: () => void;
  onOpenSkills: () => void;
  onOpenSettings?: () => void;
}

type CommandItem =
  | { type: "project"; id: string; label: string; data: any }
  | { type: "session"; id: string; label: string; data: { sessionId: string; title: string; projectId: string; projectName: string } }
  | { type: "action"; id: "new-chat" | "skills" | "settings"; label: string; shortcut: string };

interface CommandGroup {
  id: "projects" | "sessions" | "actions";
  title: string;
  items: CommandItem[];
}

export function SearchDialog({ onClose, onSwitchProject, onNewSession, onOpenSkills, onOpenSettings }: SearchDialogProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { projects, getProjectSessions, switchSession } = useProjectStore();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useDismissableLayer({ onDismiss: onClose });

  // 查询 → 结果必须记忆化：方向键只改 selectedIndex，不应重扫全部会话/重订阅监听器。
  const filteredProjects = useMemo(() => projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()) ||
    p.path.toLowerCase().includes(query.toLowerCase())
  ), [projects, query]);

  const filteredSessions = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const results: Array<{ sessionId: string; title: string; projectId: string; projectName: string }> = [];
    const globalSessions = SessionStorage.listSessions("");
    for (const s of globalSessions) {
      if (s.title?.toLowerCase().includes(q)) {
        results.push({ sessionId: s.id, title: s.title, projectId: "", projectName: zh ? "全局" : "Global" });
      }
    }
    for (const p of projects) {
      const sessions = getProjectSessions(p.id);
      for (const s of sessions) {
        if (s.title?.toLowerCase().includes(q)) {
          results.push({ sessionId: s.id, title: s.title, projectId: p.id, projectName: p.name });
        }
      }
    }
    return results.slice(0, 10);
  }, [query, projects, getProjectSessions, zh]);

  const groups = useMemo<CommandGroup[]>(() => {
    const next: CommandGroup[] = [];
    if (filteredProjects.length > 0) {
      next.push({
        id: "projects",
        title: zh ? "项目" : "Projects",
        items: filteredProjects.map((p) => ({ type: "project" as const, id: p.id, label: p.name, data: p })),
      });
    }
    if (filteredSessions.length > 0) {
      next.push({
        id: "sessions",
        title: zh ? "对话" : "Sessions",
        items: filteredSessions.map((s) => ({ type: "session" as const, id: s.sessionId, label: s.title, data: s })),
      });
    }
    const actions: CommandItem[] = [
      { type: "action", id: "new-chat", label: zh ? "新建快速对话" : "New quick chat", shortcut: "Ctrl+N" },
      { type: "action", id: "skills", label: zh ? "前往技能" : "Go to Skills", shortcut: "Ctrl+S" },
    ];
    if (onOpenSettings) {
      actions.push({ type: "action", id: "settings", label: zh ? "设置" : "Settings", shortcut: "Ctrl+," });
    }
    next.push({ id: "actions", title: zh ? "命令" : "Commands", items: actions });
    return next;
  }, [filteredProjects, filteredSessions, onOpenSettings, zh]);

  // 顺序必须与渲染顺序完全一致：索引错一位，Enter 就会执行上一项。
  const allItems = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  );

  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const allItemsRef = useRef(allItems);
  allItemsRef.current = allItems;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const selectProject = useCallback((projectId: string) => {
    onSwitchProject(projectId);
    onClose();
  }, [onSwitchProject, onClose]);

  const selectSession = useCallback((session: { sessionId: string; projectId: string }) => {
    if (session.projectId) onSwitchProject(session.projectId);
    switchSession(session.sessionId);
    onClose();
  }, [onSwitchProject, switchSession, onClose]);

  const runItem = useCallback((item: CommandItem | undefined) => {
    if (!item) return;
    if (item.type === "project") selectProject(item.id);
    else if (item.type === "session") selectSession(item.data);
    else if (item.id === "new-chat") { onNewSession(); onClose(); }
    else if (item.id === "skills") { onOpenSkills(); onClose(); }
    else if (item.id === "settings") { onOpenSettings?.(); onClose(); }
  }, [selectProject, selectSession, onNewSession, onOpenSkills, onOpenSettings, onClose]);

  useEffect(() => {
    /**
     * 第 206 轮 P1-1：命令中心的键盘契约。
     *
     * 监听器只依赖稳定回调；最新的列表和选中项走 ref，所以按方向键不会移除/重加
     * window 监听器，也不会重扫会话（RL-5 仍守）。
     */
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, allItemsRef.current.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        runItem(allItemsRef.current[selectedIndexRef.current]);
        return;
      }

      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const items = allItemsRef.current;

      // Ctrl/Cmd + 数字：选中第 N 项（1 基）—— 与项目行徽标一一对应。
      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < items.length) {
          e.preventDefault();
          setSelectedIndex(idx);
        }
        return;
      }

      const lower = e.key.toLowerCase();
      if (lower === "n") {
        e.preventDefault();
        onNewSession();
        onClose();
      } else if (lower === "s") {
        e.preventDefault();
        onOpenSkills();
        onClose();
      } else if (e.key === ",") {
        // 只有设置了 onOpenSettings 的地方才印 Ctrl+,；这里同样只在有回调时生效。
        if (!onOpenSettings) return;
        e.preventDefault();
        onOpenSettings();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onNewSession, onOpenSkills, onOpenSettings, runItem]);

  const itemIndex = useMemo(() => {
    const map = new Map<string, number>();
    allItems.forEach((item, index) => {
      const key = item.type === "action" ? `action:${item.id}` : `${item.type}:${item.id}`;
      map.set(key, index);
    });
    return map;
  }, [allItems]);

  const indexOf = (item: CommandItem) => itemIndex.get(
    item.type === "action" ? `action:${item.id}` : `${item.type}:${item.id}`,
  ) ?? -1;

  return createPortal(
    <div className="search-overlay" onClick={onClose}>
      <div
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? "命令中心" : "Command center"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-input-wrapper">
          <span className="search-icon"><Search size={16} /></span>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={zh ? "搜索对话、项目或运行命令" : "Search chats, projects or run commands"}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-center-list"
            aria-activedescendant={allItems[selectedIndex] ? `command-center-item-${selectedIndex}` : undefined}
          />
        </div>

        <div className="search-content" id="command-center-list" role="listbox" aria-label={zh ? "命令结果" : "Command results"}>
          {groups.map((group) => (
            <div className="search-section" key={group.id}>
              <div className="search-section-title">{group.title}</div>
              {group.items.map((item, index) => {
                const globalIndex = indexOf(item);
                const active = globalIndex === selectedIndex;
                return (
                  <div
                    key={item.type === "action" ? item.id : `${item.type}-${item.id}`}
                    id={`command-center-item-${globalIndex}`}
                    role="option"
                    aria-selected={active}
                    className={`search-item ${active ? "active" : ""}`}
                    onClick={() => runItem(item)}
                    onMouseEnter={() => setSelectedIndex(globalIndex)}
                  >
                    <span className="search-item-icon">
                      {item.type === "project"
                        ? (item.data.pinned ? <Pin size={16} style={{ color: "var(--accent)" }} /> : <Folder size={16} />)
                        : item.type === "session"
                          ? <MessageSquare size={16} />
                          : item.id === "new-chat"
                            ? <PencilLine size={16} />
                            : item.id === "skills"
                              ? <BookMarked size={16} />
                              : <Settings size={16} />}
                    </span>
                    <span className="search-item-label">{item.label}</span>
                    <span className="search-item-shortcut">
                      {item.type === "project"
                        ? <>Ctrl+{index + 1}</>
                        : item.type === "action"
                          ? item.shortcut
                          : item.data.projectName}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {allItems.length === 0 && (
            <div className="empty-hint is-compact">
              {zh ? "没有匹配的项目、对话或命令" : "No matching projects, chats or commands"}
            </div>
          )}
        </div>

        <div className="search-footer">
          <span>{zh ? "↑↓ 导航 · Enter 打开 · Esc 关闭" : "↑↓ navigate · Enter open · Esc close"}</span>
          <span>{zh ? "命令中心" : "Command center"}</span>
        </div>
      </div>
    </div>
  );
}
