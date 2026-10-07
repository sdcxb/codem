/**
 * DeliverableFiles — Turn tail 交付物文件列表
 *
 * 对标 DSH ui-deliverables/src/client/ProducedFiles.tsx。
 * 在每轮对话结束时展示该轮生成/修改的文件列表。
 * 每个文件显示为可点击的 chip，点击打开 DiffViewer 或文件浏览器。
 *
 * 与 InlineDiffReview 的分工：
 * - DeliverableFiles: Turn tail 摘要行 — 展示该轮修改了哪些文件（对标 DSH ProducedFiles）
 * - InlineDiffReview: 文件级 diff 审批面板 — 展示具体 diff 内容并接受/拒绝
 */

import { memo, useState, useEffect, useCallback } from 'react'
import { FileText, FilePlus, FileEdit, FileX, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react'
import { useLang } from '../core/i18n/lang'
import { FileChangeStorage, type TurnFileChangeRecord, type ChangedFile } from '../core/storage/file-change-storage'
import { onFileChangesTracked } from '../core/environment/file-change-tracker'

export interface DeliverableFilesProps {
  /** 会话 ID */
  sessionId: string
  /** 工作区路径 */
  workspace: string
  /** 打开文件回调 */
  onOpenFile?: (path: string) => void
  /** 查看 diff 回调 */
  onViewDiff?: (record: TurnFileChangeRecord, file: ChangedFile) => void
}

/** 最多显示的 chip 数量 */
const SHOWN_LIMIT = 6

/**
 * Turn tail 交付物文件列表。
 * 在对话消息末尾显示该轮修改的文件 chips。
 */
export const DeliverableFiles = memo(function DeliverableFiles({
  sessionId,
  workspace,
  onOpenFile,
  onViewDiff,
}: DeliverableFilesProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [records, setRecords] = useState<TurnFileChangeRecord[]>([])
  const [expanded, setExpanded] = useState(false)

  /**
   * ## 第 269 波：这张表不再有域镜像 ⇒ 改成**按需查询** ✓
   *
   * 原来 `listBySession()` 是**同步读镜像** ✗：真机上表超过默认上限 5000 行就被拒载 ✗
   * ⇒ 恒返回 `[]` ⇒ 交付物区块**恒不渲染** ✗（`records.length === 0` 直接 `return null` ✗）。
   *
   * 现在按会话拉最近 `TURN_FILE_CHANGE_WINDOW_ROWS` 行 ✓（不含 patch 正文 ✓）。
   * 读不到就**什么都不渲染** ✓（这个组件是消息尾部的装饰块 ✓，不该因为一次读失败
   * 在每条消息上刷一行错误 ✗）—— 但失败要留痕 ✓（`console.warn` ✓，不静默 ✗）。
   */
  const loadRecords = useCallback(() => {
    let alive = true;
    FileChangeStorage.loadBySession(sessionId)
      .then((list) => {
        if (alive) setRecords(list);
      })
      .catch((e) => {
        if (alive) console.warn("[DeliverableFiles] 读取本会话文件变更失败（本块留空）:", e);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const cancel = loadRecords();
    const unsub = onFileChangesTracked(() => loadRecords());
    return () => {
      cancel();
      unsub();
    };
  }, [loadRecords]);

  if (records.length === 0) return null

  /**
   * 获取最新一轮的文件变更。
   *
   * ⚠️ 第 269 波**顺手修了一个真缺陷** ✗→✓：原来是 `records[records.length - 1]` ✗，
   * 而接口契约（以及本波之前的镜像实现 ✓）都是 **`turn_index` DESC** ✓
   * ⇒ 最后一个元素是**最旧**的一轮 ✗ ⇒ 这个"交付文件"块显示的从来不是最新一轮 ✗
   * （在按需读下这个错误会更明显：一屏有界，取错那一端更容易看出来 ✓）。
   * 与 `FileChangesList` 的遍历顺序现在也一致了 ✓（两处都按 DESC ✓）。
   */
  const latestRecord = records[0]
  const changedFiles: ChangedFile[] = latestRecord ? FileChangeStorage.parseChangedFiles(latestRecord) : []

  if (changedFiles.length === 0) return null

  const visibleFiles = expanded ? changedFiles : changedFiles.slice(0, SHOWN_LIMIT)
  const hiddenCount = changedFiles.length - visibleFiles.length

  const getIcon = (status: string) => {
    switch (status) {
      case 'A': return FilePlus
      case 'M': return FileEdit
      case 'D': return FileX
      default: return FileText
    }
  }

  const getLabel = (file: ChangedFile) => {
    const name = file.path.split(/[\\/]/).pop() || file.path
    return name
  }

  return (
    <div
      className="deliverable-files"
    >
      <div
        className="deliverable-files-label"
      >
        <FileText size={12} />
        <span>{zh ? `交付文件 (${changedFiles.length})` : `Produced files (${changedFiles.length})`}</span>
      </div>

      <div
        className="deliverable-files-row"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
        }}
      >
        {visibleFiles.map((file, idx) => {
          const Icon = getIcon(file.status)
          return (
            <button
              key={`${file.path}-${idx}`}
              type="button"
              title={file.path}
              onClick={() => {
                if (onViewDiff && latestRecord) {
                  onViewDiff(latestRecord, file)
                } else if (onOpenFile) {
                  onOpenFile(file.path)
                }
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                borderRadius: "var(--radius-md)",
                border: '1px solid var(--border-primary)',
                background: 'var(--bg-secondary)',
                color: 'var(--text-secondary)',
                fontSize: 'var(--fs-sm)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--accent)'
                e.currentTarget.style.color = 'var(--accent)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--border-primary)'
                e.currentTarget.style.color = 'var(--text-secondary)'
              }}
            >
              <Icon size={12} />
              <span>{getLabel(file)}</span>
            </button>
          )
        })}

        {hiddenCount > 0 && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              padding: '2px 8px',
              borderRadius: "var(--radius-md)",
              border: '1px solid var(--border-primary)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: 'var(--fs-sm)',
              cursor: 'pointer',
            }}
          >
            <ChevronDown size={12} />
            <span>{zh ? `+${hiddenCount} 更多` : `+${hiddenCount} more`}</span>
          </button>
        )}

        {expanded && changedFiles.length > SHOWN_LIMIT && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              padding: '2px 8px',
              borderRadius: "var(--radius-md)",
              border: '1px solid var(--border-primary)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: 'var(--fs-sm)',
              cursor: 'pointer',
            }}
          >
            <ChevronRight size={12} />
            <span>{zh ? '收起' : 'Less'}</span>
          </button>
        )}

        {onOpenFile && (
          <button
            type="button"
            onClick={() => onOpenFile('.')}
            title={zh ? '在工作区中显示' : 'Show in workspace'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              padding: '2px 8px',
              borderRadius: "var(--radius-md)",
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: 'var(--fs-sm)',
              cursor: 'pointer',
            }}
          >
            <FolderOpen size={12} />
          </button>
        )}
      </div>
    </div>
  )
})
