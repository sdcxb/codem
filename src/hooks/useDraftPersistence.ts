/**
 * useDraftPersistence — 草稿持久化 Hook
 *
 * 为每个对话保存独立的输入草稿，切换对话时自动恢复。
 */

import { useState, useEffect, useCallback } from "react";
import { getSetting, setSetting } from "../core/storage/settings";

export function useDraftPersistence(draftKey: string | null) {
  const [draft, setDraft] = useState("");

  // 加载草稿
  useEffect(() => {
    if (!draftKey) {
      setDraft("");
      return;
    }
    const saved = getSetting(`composer-draft-${draftKey}`);
    setDraft(typeof saved === "string" ? saved : "");
  }, [draftKey]);

  // 保存草稿（防抖 500ms）
  useEffect(() => {
    if (!draftKey) return;
    const timer = setTimeout(() => {
      setSetting(`composer-draft-${draftKey}`, draft);
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, draftKey]);

  const clearDraft = useCallback(() => {
    setDraft("");
    if (draftKey) setSetting(`composer-draft-${draftKey}`, "");
  }, [draftKey]);

  return { draft, setDraft, clearDraft };
}
