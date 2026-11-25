/**
 * DeliverableFiles — `app.deliverable-files` slot 的兼容出口
 *
 * ## 为什么只剩一个转发
 *
 * 这个 slot 在 `ChatPanel` 的消息流末尾**只消费一次**（`SlotBridge` 对 single/root
 * slot 只取最高优先级的注册）。以前这里自己 `loadBySession()` + 画文件 chips，
 * 现在升级成整条「工作证据」rail：文件变更 + 最近验证。取数与渲染都在
 * `TurnEvidenceRail`（同类名 `turn-evidence-*`），避免两份加载逻辑各自演化。
 *
 * 组件名与 slot 注册保持不变（`ui-panels` / `ui-deliverables-provider` 都引用它），
 * 插件契约不需要跟着改。
 */

import { memo } from 'react'
import {
  TurnEvidenceRail,
  type TurnEvidenceRailProps,
} from './TurnEvidenceRail'

export type DeliverableFilesProps = TurnEvidenceRailProps

/**
 * Turn tail 工作证据 rail（文件变更 + 最近验证）。
 *
 * 没有数据时 `TurnEvidenceRail` 返回 `null`（不画空壳）。
 */
export const DeliverableFiles = memo(function DeliverableFiles(props: DeliverableFilesProps) {
  return <TurnEvidenceRail {...props} />
})
