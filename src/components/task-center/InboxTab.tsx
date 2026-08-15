/**
 * InboxTab — 全局通知中心
 *
 * 聚合所有需要人类关注的事件：
 * - Issue 状态变更 / 分配
 * - 委派完成 / 失败
 * - 子智能体完成
 * - 自动化触发
 * - Squad 事件
 */

import { useState, useEffect, useCallback } from "react";
import { Inbox as InboxIcon, CheckCheck, Archive, ClipboardList, Link2, Bot, Clock, Users, AlertTriangle } from "lucide-react";
import { getInboxManager, type InboxItem, type InboxCategory } from "../../core/inbox/inbox";
import { useProjectStore } from "../../core/store";
import { useLang } from "../../core/i18n/lang";

const CATEGORY_CONFIG: Record<InboxCategory, { Icon: typeof InboxIcon; color: string }> = {
  issue: { Icon: ClipboardList, color: "var(--accent)" },
  squad: { Icon: Users, color: "var(--accent)" },
  delegation: { Icon: Link2, color: "var(--accent)" },
  automation: { Icon: Clock, color: "var(--warning)" },
  system: { Icon: AlertTriangle, color: "var(--error)" },
  agent: { Icon: Bot, color: "var(--success)" },
};

function formatTime(timestamp: number, zh: boolean): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return zh ? `${Math.floor(diff / 1000)}秒前` : `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return zh ? `${Math.floor(diff / 60000)}分钟前` : `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return zh ? `${Math.floor(diff / 3600000)}小时前` : `${Math.floor(diff / 3600000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function InboxTab() {
  const lang = useLang();
  const zh = lang === "zh";
  const [items, setItems] = useState<InboxItem[]>([]);
  const [filter, setFilter] = useState<InboxCategory | "all">("all");

  const loadItems = useCallback(() => {
    const mgr = getInboxManager();
    const projectId = useProjectStore.getState().currentProject?.id;
    setItems(mgr.list({
      projectId,
      category: filter === "all" ? undefined : filter,
    }));
  }, [filter]);

  useEffect(() => {
    loadItems();
    const mgr = getInboxManager();
    const unsub = mgr.onInboxChange(() => loadItems());
    return () => { unsub(); };
  }, [loadItems]);

  const handleMarkAllRead = () => {
    const projectId = useProjectStore.getState().currentProject?.id;
    getInboxManager().markAllRead(projectId);
    loadItems();
  };

  const handleClick = (item: InboxItem) => {
    if (!item.read) {
      getInboxManager().markRead(item.id);
    }
  };

  const handleArchive = (id: string) => {
    getInboxManager().archive(id);
    loadItems();
  };

  const unreadCount = items.filter((i) => !i.read).length;
  const filters: { value: InboxCategory | "all"; labelZh: string; labelEn: string }[] = [
    { value: "all", labelZh: "全部", labelEn: "All" },
    { value: "issue", labelZh: "Issue", labelEn: "Issues" },
    { value: "squad", labelZh: "Squad", labelEn: "Squads" },
    { value: "delegation", labelZh: "委派", labelEn: "Delegation" },
    { value: "agent", labelZh: "智能体", labelEn: "Agents" },
    { value: "automation", labelZh: "自动化", labelEn: "Automation" },
    { value: "system", labelZh: "系统", labelEn: "System" },
  ];

  return (
    <div style={{ padding: "16px 20px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <InboxIcon size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
            {zh ? "收件箱" : "Inbox"}
          </span>
          {unreadCount > 0 && (
            <span style={{
              fontSize: "11px", fontWeight: 700, color: "#fff",
              background: "var(--error)", padding: "1px 8px", borderRadius: 10,
            }}>
              {unreadCount}
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 12px", borderRadius: 4, fontSize: 12,
              border: "1px solid var(--border-primary)", background: "none",
              color: "var(--text-secondary)", cursor: "pointer",
            }}
          >
            <CheckCheck size={14} /> {zh ? "全部已读" : "Mark all read"}
          </button>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px", flexWrap: "wrap" }}>
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            style={{
              padding: "4px 12px", borderRadius: 4, fontSize: 12,
              border: `1px solid ${filter === f.value ? "var(--accent)" : "var(--border-primary)"}`,
              background: filter === f.value ? "var(--accent)22" : "none",
              color: filter === f.value ? "var(--accent)" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {zh ? f.labelZh : f.labelEn}
          </button>
        ))}
      </div>

      {/* Items */}
      {items.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "14px" }}>
          {zh ? "暂无通知" : "No notifications"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {items.map((item) => {
            const catConfig = CATEGORY_CONFIG[item.category] || CATEGORY_CONFIG.system;
            const CatIcon = catConfig.Icon;
            return (
              <div
                key={item.id}
                onClick={() => handleClick(item)}
                style={{
                  display: "flex", alignItems: "flex-start", gap: "10px",
                  padding: "10px 12px", borderRadius: 6,
                  background: item.read ? "var(--bg-tertiary)" : "var(--bg-secondary)",
                  border: `1px solid ${item.read ? "var(--border-primary)" : `${catConfig.color}44`}`,
                  borderLeft: `3px solid ${catConfig.color}`,
                  cursor: "pointer", fontSize: "12px",
                }}
              >
                <CatIcon size={14} style={{ color: catConfig.color, marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    {!item.read && (
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                    )}
                    <span style={{
                      fontWeight: item.read ? 400 : 600,
                      color: "var(--text-primary)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {item.title}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: "10px", color: "var(--text-muted)", flexShrink: 0 }}>
                      {formatTime(item.createdAt, zh)}
                    </span>
                  </div>
                  {item.body && (
                    <div style={{
                      fontSize: "11px", color: "var(--text-secondary)", marginTop: 2,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {item.body}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleArchive(item.id); }}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "2px", flexShrink: 0 }}
                  title={zh ? "归档" : "Archive"}
                >
                  <Archive size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
