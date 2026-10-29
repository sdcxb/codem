/**
 * 改动前快照的**前置判定**：工作区不存在时跳过快照（不报错、不弹"操作没有生效"）。
 *
 * 为什么单独抽出来：
 * 1. 真机上"项目目录被删/移动 / 副本工作区为空"时，`ensureSnapshot` 必然抛 `os error 3`，
 *    而它原来的失败通道会弹一条「操作没有生效（loop.preCallSnapshot）」—— 用户以为坏了。
 *    这条判定是**纯决策**，可以逐条判据（含"exists 自己抛错时不要静默跳过"）。
 * 2. 判据不依赖真实文件系统：注入 `exists` 即可测三种分支。
 */

export interface PreCallSnapshotDecision {
  /** true = 跳过快照（工作区不存在） */
  skip: boolean;
  /** 给 debugLog 的原因（skip 时才有） */
  reason?: string;
}

/**
 * @param cwd 工作区绝对路径（空 = 没有工作区，同样跳过）
 * @param exists 文件存在性探测（注入以便测试；真实现是 `file-api.exists`）
 */
export async function decidePreCallSnapshot(
  cwd: string | undefined,
  exists: (path: string) => Promise<boolean>,
): Promise<PreCallSnapshotDecision> {
  if (!cwd) return { skip: true, reason: "no cwd" };
  try {
    const present = await exists(cwd);
    return present ? { skip: false } : { skip: true, reason: `workspace missing: ${cwd}` };
  } catch {
    /**
     * 探测本身失败（例如 file-api 没接好）⇒ **不要**跳过：
     * 跳过等于悄悄放弃回滚证据；让真正的快照路径去抛错、走上报通道，才符合"如实上报"。
     */
    return { skip: false };
  }
}
