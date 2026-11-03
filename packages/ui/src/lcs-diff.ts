/**
 * 逐行 LCS diff（纯函数，无 React / 无宿主依赖）。
 *
 * 为什么在共享包：桌面写确认、快照对比、回合变更（`src/components/DiffViewer.tsx` 的三个入口）
 * 与差异面板的每一次渲染都要跑它；算法与渲染上限只有**一份**（桌面适配器从这里 re-export，
 * 既有 import 路径与判据因此不用改）。
 */

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  oldLineNum: number | null;
  newLineNum: number | null;
  content: string;
}

/** unified / split 视图最多渲染的 diff 行数（超出只渲染前 N 行并明确告知） */
export const DIFF_RENDER_ROW_CAP = 400;

/**
 * DP 单元格上限（`中间段长度之积`）。超过就退化成「全删 + 全增」。
 *
 * 4M 格 ≈ 32 MB（数字数组按 8 字节算）且是毫秒级；超过这个量级用户也不会逐行看，
 * 退化 + 说明比"卡住 3 秒再给一张没人看得完的表"更诚实。
 */
const DIFF_MAX_CELLS = 4_000_000;

/**
 * 逐行 LCS diff。
 *
 * ## 第 233 轮审计：三项有界化（语义不变）
 *
 * 1. **先剥公共前后缀**：两端的相同行必然是 `unchanged`，DP 只需跑中间那段。
 *    一次只改 3 行的大文件从此几乎零成本（原来要跑整张 m×n 表）。
 * 2. **结果 push + reverse**：原来逐行 `unshift` 是 O(L²)（1 万行要搬 5000 万次元素）。
 * 3. **按"中间段格数"而不是"总行数"设上限**：原来 `m > 5000` 就退化成全删全增，
 *    而"5000 行里改 1 行"本可以精确 diff。
 *
 * 导出是为了让判据直接测算法（组件判据只能看到渲染结果）。
 */
export function computeDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  // ===== 1) 剥公共前缀 / 后缀 =====
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  const m = midOld.length;
  const n = midNew.length;

  const head: DiffLine[] = [];
  for (let k = 0; k < prefix; k++) {
    head.push({ type: "unchanged", oldLineNum: k + 1, newLineNum: k + 1, content: oldLines[k] });
  }
  const tail: DiffLine[] = [];
  for (let k = 0; k < suffix; k++) {
    const oldNo = oldLines.length - suffix + k + 1;
    const newNo = newLines.length - suffix + k + 1;
    tail.push({
      type: "unchanged",
      oldLineNum: oldNo,
      newLineNum: newNo,
      content: oldLines[oldLines.length - suffix + k],
    });
  }

  // ===== 2) 中间段：超过格数上限就退化成「全删 + 全增」 =====
  if (m === 0 && n === 0) return [...head, ...tail];
  if (m * n > DIFF_MAX_CELLS) {
    const result: DiffLine[] = [...head];
    for (let i = 0; i < m; i++) {
      result.push({ type: "removed", oldLineNum: prefix + i + 1, newLineNum: null, content: midOld[i] });
    }
    for (let j = 0; j < n; j++) {
      result.push({ type: "added", oldLineNum: null, newLineNum: prefix + j + 1, content: midNew[j] });
    }
    return [...result, ...tail];
  }

  // ===== 3) LCS DP（只跑中间段）=====
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = midOld[i - 1] === midNew[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // 回溯（push 完再 reverse —— 原来是逐行 unshift，O(L²)）
  const mid: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && midOld[i - 1] === midNew[j - 1]) {
      mid.push({ type: "unchanged", oldLineNum: prefix + i, newLineNum: prefix + j, content: midOld[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      mid.push({ type: "added", oldLineNum: null, newLineNum: prefix + j, content: midNew[j - 1] });
      j--;
    } else {
      mid.push({ type: "removed", oldLineNum: prefix + i, newLineNum: null, content: midOld[i - 1] });
      i--;
    }
  }
  mid.reverse();

  return [...head, ...mid, ...tail];
}
