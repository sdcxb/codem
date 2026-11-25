/**
 * TurnEvidenceRail — 消息流末尾的「工作证据」rail
 *
 * ## 它回答的问题
 *
 * 助手气泡里的 `StatsLine` 是**运行成本**（token/缓存/耗时）；
 * 用户真正要扫的是**这一轮动了什么、验过什么**：
 * - 最近一次文件变更记录（复用 `FileChangeStorage` 的有界一屏）；
 * - 本会话最近跑过的验证命令（复用 `listVerificationChecks`，带通过/失败**文字**）。
 *
 * ## 为什么只挂一次（不放进每轮 footer）
 *
 * `app.deliverable-files` slot 在 `ChatPanel` 的消息流末尾只消费一次（`SlotBridge`
 * 对 single/root slot 取最高优先级的那一个注册）。如果放进每轮 footer，每轮都会
 * 重新 `loadBySession()` + 重新渲染同一批 chip —— 既是重复 IPC，也是同一条证据
 * 在滚动区里出现 N 次。所以 `DeliverableFiles` 只做兼容出口，真实渲染在这里，
 * 且**整条消息流只有一个实例**。
 *
 * ## 口径必须写实
 *
 * - 文件记录不绑定"用户刚刚问的那一轮"：`loadBySession()` 给的是本会话
 *   `created_at DESC` 的有界一屏，`records[0]` 是**最近一次记录**（可能是上一轮）。
 *   ⇒ 文案写「本会话最近一次记录」，绝**不**写「本轮」；
 * - 验证记录同样不绑轮次（`verification-checks.ts` 文件头写明了原因）
 *   ⇒ 文案写「本会话最近」；
 * - 没有验证记录时**不画**验证区（不显示一个看起来正常的空块，更不画假绿）。
 *
 * ## 视觉
 *
 * 只输出 `turn-evidence-*` 类名，不写内联样式（样式留给集成方）。
 */

import { memo, useEffect, useMemo, useState } from 'react'
import { useLang } from '../core/i18n/lang'
import {
  FileChangeStorage,
  type ChangedFile,
  type TurnFileChangeRecord,
} from '../core/storage/file-change-storage'
import { onFileChangesTracked } from '../core/environment/file-change-tracker'
import {
  listVerificationChecks,
  type VerificationCheck,
} from '../core/environment/verification-checks'

export interface TurnEvidenceRailProps {
  /** 会话 ID */
  sessionId: string
  /** 工作区路径（只用于把绝对路径缩成可读的相对路径） */
  workspace?: string
  /** 打开文件回调（没有 diff 回调时的兜底） */
  onOpenFile?: (path: string) => void
  /** 查看 diff 回调（文件 chip 的主路径） */
  onViewDiff?: (record: TurnFileChangeRecord, file: ChangedFile) => void
  /**
   * 会话是否仍在流式输出。
   *
   * 验证命令是在流式过程中由工具执行端写入的（`agenticLoop` 的 `recordVerificationCheck`），
   * 所以"流式结束"是刷新「最近验证」最自然的信号；文件变更另有事件订阅。
   * 不传也不影响文件区（按会话加载 + 变更事件刷新）。
   */
  streaming?: boolean
}

/** 文件 chip 一屏最多显示几个（其余收进 +N） */
const VISIBLE_FILE_LIMIT = 6
/** 验证结果最多显示几条（更早的仍在 Inspector 的「最近检查」里） */
const VISIBLE_CHECK_LIMIT = 3

/** 绝对路径 → 工作区相对路径（只用于显示；不改变点击时传下去的原始 path） */
function toDisplayPath(filePath: string, workspace?: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const root = (workspace ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1)
  }
  return normalized
}

function statusLabel(status: string, zh: boolean): string {
  switch (status) {
    case 'A':
      return zh ? '新增' : 'added'
    case 'D':
      return zh ? '删除' : 'deleted'
    case 'R':
      return zh ? '重命名' : 'renamed'
    case 'M':
      return zh ? '修改' : 'modified'
    default:
      return status || (zh ? '变更' : 'changed')
  }
}

/** 纯展示层：数据由上面/测试直接传入，不在这里取数 */
interface TurnEvidenceRailViewProps {
  files: ChangedFile[]
  /** 文件列表所属记录（点开 diff 需要它） */
  record: TurnFileChangeRecord | null
  checks: VerificationCheck[]
  workspace?: string
  onOpenFile?: (path: string) => void
  onViewDiff?: (record: TurnFileChangeRecord, file: ChangedFile) => void
}

const TurnEvidenceRailView = memo(function TurnEvidenceRailView({
  files,
  record,
  checks,
  workspace,
  onOpenFile,
  onViewDiff,
}: TurnEvidenceRailViewProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [expanded, setExpanded] = useState(false)

  // 没有数据就不占位：不发一个空壳 section（rail 只在有证据时存在）
  if (files.length === 0 && checks.length === 0) return null

  const visibleFiles = expanded ? files : files.slice(0, VISIBLE_FILE_LIMIT)
  const hiddenFileCount = files.length - visibleFiles.length
  const visibleChecks = checks.slice(0, VISIBLE_CHECK_LIMIT)

  const openFile = (file: ChangedFile) => {
    if (record && onViewDiff) onViewDiff(record, file)
    else if (onOpenFile) onOpenFile(file.path)
  }
  const fileInteractive = Boolean(record && onViewDiff) || Boolean(onOpenFile)

  return (
    <section className="turn-evidence-rail" aria-label={zh ? '工作证据' : 'Work evidence'}>
      <div className="turn-evidence-head">
        <span className="turn-evidence-title">{zh ? '工作证据' : 'Work evidence'}</span>
      </div>

      {files.length > 0 && (
        <div className="turn-evidence-section turn-evidence-files">
          <div className="turn-evidence-section-head">
            <span className="turn-evidence-section-title">{zh ? '最近改动' : 'Recent changes'}</span>
            <span className="turn-evidence-section-meta">
              {zh
                ? `本会话最近一次记录 · ${files.length} 个文件`
                : `Latest record in this session · ${files.length} file${files.length > 1 ? 's' : ''}`}
            </span>
          </div>

          <div className="turn-evidence-file-row">
            {visibleFiles.map((file, index) => {
              const label = toDisplayPath(file.path, workspace)
              const content = (
                <>
                  <span className="turn-evidence-file-status">{statusLabel(file.status, zh)}</span>
                  <span className="turn-evidence-file-name">{label}</span>
                </>
              )
              return fileInteractive ? (
                <button
                  key={`${file.path}-${index}`}
                  type="button"
                  className="turn-evidence-file"
                  title={file.path}
                  onClick={() => openFile(file)}
                >
                  {content}
                </button>
              ) : (
                <span
                  key={`${file.path}-${index}`}
                  className="turn-evidence-file"
                  title={file.path}
                >
                  {content}
                </span>
              )
            })}

            {hiddenFileCount > 0 && !expanded && (
              <button
                type="button"
                className="turn-evidence-more"
                onClick={() => setExpanded(true)}
              >
                {zh ? `+${hiddenFileCount} 更多` : `+${hiddenFileCount} more`}
              </button>
            )}
            {expanded && files.length > VISIBLE_FILE_LIMIT && (
              <button
                type="button"
                className="turn-evidence-more"
                onClick={() => setExpanded(false)}
              >
                {zh ? '收起' : 'Less'}
              </button>
            )}
          </div>
        </div>
      )}

      {checks.length > 0 && (
        <div className="turn-evidence-section turn-evidence-checks">
          <div className="turn-evidence-section-head">
            <span className="turn-evidence-section-title">{zh ? '最近验证' : 'Recent verification'}</span>
            <span className="turn-evidence-section-meta">
              {zh
                ? `本会话 · ${checks.length} 条记录`
                : `This session · ${checks.length} record${checks.length > 1 ? 's' : ''}`}
            </span>
          </div>

          <ul className="turn-evidence-check-list">
            {visibleChecks.map((check, index) => (
              <li
                key={`${check.command}-${index}`}
                className={`turn-evidence-check ${
                  check.ok ? 'turn-evidence-check--pass' : 'turn-evidence-check--fail'
                }`}
              >
                <span className="turn-evidence-check-result">
                  {check.ok ? (zh ? '通过' : 'pass') : (zh ? '失败' : 'fail')}
                </span>
                <code className="turn-evidence-check-command" title={check.command}>
                  {check.command}
                </code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
})

/**
 * 取数层：按会话加载文件变更一屏 + 最近验证记录。
 *
 * - 文件：`loadBySession()` 是**按需读**（失败会抛 ⇒ 这里只在控制台留痕，
 *   整块留空；不把"读不到"画成"没有记录"的结论，也不在每条消息上刷错误）；
 * - 验证：`listVerificationChecks()` 是同步、有界的设置面读取；
 * - 刷新：会话切换 / `onFileChangesTracked` / 流式结束。
 */
export const TurnEvidenceRail = memo(function TurnEvidenceRail({
  sessionId,
  workspace,
  onOpenFile,
  onViewDiff,
  streaming,
}: TurnEvidenceRailProps) {
  /**
   * 一屏记录与**它属于哪个会话**一起存。
   *
   * 只存 `rows` 的话，切会话后的首帧会拿上一个会话的文件渲染一帧（stale flash）；
   * 带上 sessionId 后，渲染时先对账，不匹配就当没有数据。
   */
  const [recordsState, setRecordsState] = useState<{
    sessionId: string
    rows: TurnFileChangeRecord[]
  }>({ sessionId: '', rows: [] })

  // 文件变更：会话切换 → 重新读一屏；文件变更事件 → 也重读（换会话后旧会话的事件不再匹配）
  useEffect(() => {
    if (!sessionId) return

    let alive = true
    const load = () => {
      FileChangeStorage.loadBySession(sessionId)
        .then((list) => {
          if (alive) setRecordsState({ sessionId, rows: list })
        })
        .catch((e) => {
          if (!alive) return
          console.warn('[TurnEvidenceRail] 读取本会话文件变更失败（证据区留空）:', e)
          setRecordsState({ sessionId, rows: [] })
        })
    }
    load()
    const unsubscribe = onFileChangesTracked(() => load())
    return () => {
      alive = false
      unsubscribe()
    }
  }, [sessionId])

  const records = recordsState.sessionId === sessionId ? recordsState.rows : []
  const latestRecordId = records[0]?.id ?? ''

  /**
   * 验证记录：跟随会话、流式状态与"最近一条变更记录"刷新。
   *
   * 这里**同步读**（`listVerificationChecks` 是有界的设置面读取，与 `useLang` 同一条路），
   * 不用 state + effect：否则切会话时会有一帧仍显示**上一个会话**的验证记录。
   */
  const checks = useMemo(() => {
    try {
      return listVerificationChecks(sessionId)
    } catch {
      return []
    }
  }, [sessionId, streaming, latestRecordId])

  const latestRecord = records[0] ?? null
  const files = latestRecord ? FileChangeStorage.parseChangedFiles(latestRecord) : []

  return (
    <TurnEvidenceRailView
      files={files}
      record={latestRecord}
      checks={checks}
      workspace={workspace}
      onOpenFile={onOpenFile}
      onViewDiff={onViewDiff}
    />
  )
})
