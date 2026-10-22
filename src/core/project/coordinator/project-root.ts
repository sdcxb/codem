import { executeCommand } from "../../file-api";

/**
 * 从任意工作目录解析**主工作区**（不是 worktree）。
 *
 * thread 常在 worktree 里跑；项目状态必须写回主工作区的 `.codem/project/`，
 * 否则协调者永远看不到报告。`--git-common-dir` 在 worktree 里返回主仓库的 `.git`，
 * 它所在目录就是主工作区；普通仓库同理。
 */
export async function resolveMainProjectRoot(startPath: string): Promise<string> {
  if (!startPath) return startPath;
  try {
    const quoted = `'${startPath.replace(/'/g, "'\\''")}'`;
    const r = await executeCommand(
      `git -C ${quoted} rev-parse --path-format=absolute --git-common-dir`,
      startPath
    );
    if (!r.exitCode && r.stdout.trim()) {
      const common = r.stdout.trim().replace(/[\\/]+$/, "");
      const marker = common.replace(/[\\/]+/g, "/");
      if (marker.endsWith("/.git")) return common.slice(0, -5).replace(/[\\/]+$/, "") || startPath;
      if (marker.endsWith("/.git/modules")) return common.slice(0, -13).replace(/[\\/]+$/, "") || startPath;
    }
  } catch {
    // 非 git / 旧 git：退回原路径（报告会落在当前工作区）
  }
  return startPath;
}
