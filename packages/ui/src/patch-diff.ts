/**
 * Patch（unified diff 文本）→ 行模型的纯函数。桌面 `DiffBlockCard` 与手机
 * 「文件预览 / 差异页签 / 变更浮层」共用这一份。
 *
 * ## 为什么必须是 hunk-aware
 *
 * 真实 `git diff` 的行号来自 `@@ -旧起点,旧行数 +新起点,新行数 @@`：
 * - 只按出现顺序从 1 数，会把 `@@ -120,2 +120,3 @@` 显示成 1,2,3（信息是错的，不是样式问题）；
 * - 多 hunk 之间还会「重新从 1 数」，两个 hunk 的行号看起来是同几行。
 *
 * 另外**只有 hunk 内**的 `-` / `+` 才是正文：删掉一行 `-- foo` 在 patch 里是 `--- foo`，
 * 加一行 `++ bar` 是 `+++ bar` —— 不能把它们当文件头吞掉。hunk 外的 `---` / `+++` 才是文件头。
 *
 * 没有 `@@` 的片段（工具卡 `metadata.diff[].newText` 那种只有 `+`/`-` 的输入）保持
 * 「从 1 开始」的旧口径，桌面既有输入与判据不受影响。
 *
 * 判据 `DIFFVIEW-1..8`。
 */

export type DiffLineKind = "add" | "del" | "ctx";

export interface ParsedDiffLine {
  kind: DiffLineKind;
  /** 去掉行首 `+`/`-`/` ` 标记后的正文 */
  text: string;
  /** 旧文件行号（null = 这一行在旧文件里不存在） */
  oldNum: number | null;
  /** 新文件行号（null = 这一行在新文件里不存在） */
  newNum: number | null;
}

export interface DiffRow {
  kind: DiffLineKind;
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

export interface SplitRow {
  kind: "ctx" | "change";
  left: { num: number; text: string; kind: DiffLineKind } | null;
  right: { num: number; text: string; kind: DiffLineKind } | null;
}

export type DiffViewMode = "unified" | "split";

/** `@@ -a,b +c,d @@`（b/d 省略时按 1 行算） */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * hunk 之外的文件级元数据行：不参与行配对。
 *
 * `---` / `+++` 也在这里 —— 但**只有 hunk 外**才按文件头处理（hunk 内由调用点先分流）。
 */
function isFileMeta(line: string): boolean {
  return (
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity index") ||
    line.startsWith("dissimilarity index") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("Binary files ") ||
    line.startsWith("GIT binary patch") ||
    line.startsWith("literal ") ||
    line.startsWith("delta ")
  );
}

/**
 * 解析一段 unified diff 文本（也接受「只有 +/- 标记的补丁片段」）。
 *
 * - `@@` 头提供真实行号；hunk 内按头部声明的行数消费，消费完自动退出 hunk；
 * - hunk 内的 `---` / `+++` 是正文（保留 `--` / `++`）；
 * - `\ No newline at end of file` 不是内容行，直接跳过；
 * - CRLF 按 LF 处理；
 * - 二进制 patch 的数据块不产生正文行。
 */
export function parsePatchLines(text: string): ParsedDiffLine[] {
  const lines = String(text ?? "").split("\n");
  // 末尾换行不是一行内容；空 patch 解析出 0 行（空态文案由宿主决定，这里不编造）
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: ParsedDiffLine[] = [];
  /** 下一个可用行号（hunk 头会重置；片段输入从 1 开始） */
  let oldNext = 1;
  let newNext = 1;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  /** 头部声明了行数的 hunk 才按行数退出；`-0,0 +0,0` 这种空 hunk 不靠计数 */
  let countedHunk = false;
  let inBinaryBlock = false;

  const endHunk = (): void => {
    inHunk = false;
    oldRemaining = 0;
    newRemaining = 0;
    countedHunk = false;
  };

  const pushCtx = (body: string): void => {
    out.push({ kind: "ctx", text: body, oldNum: oldNext, newNum: newNext });
    oldNext += 1;
    newNext += 1;
  };

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (inBinaryBlock) {
      // 二进制数据块一直持续到下一个文件段；块内字节不是 diff 行
      if (!line.startsWith("diff --git ")) continue;
      inBinaryBlock = false;
    }

    if (line.startsWith("\\ No newline at end of file")) continue;

    if (line.startsWith("@@")) {
      const header = HUNK_HEADER.exec(line);
      endHunk();
      // 合并 diff（@@@）等无法识别的头：当元数据跳过，后续正文仍按片段处理
      if (!header) continue;
      oldNext = Number(header[1]);
      newNext = Number(header[3]);
      oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
      newRemaining = header[4] === undefined ? 1 : Number(header[4]);
      inHunk = true;
      countedHunk = oldRemaining > 0 || newRemaining > 0;
      continue;
    }

    if (line.startsWith("diff --git ")) {
      endHunk();
      inBinaryBlock = false;
      oldNext = 1;
      newNext = 1;
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+")) {
        out.push({ kind: "add", text: line.slice(1), oldNum: null, newNum: newNext });
        newNext += 1;
        newRemaining = Math.max(0, newRemaining - 1);
      } else if (line.startsWith("-")) {
        out.push({ kind: "del", text: line.slice(1), oldNum: oldNext, newNum: null });
        oldNext += 1;
        oldRemaining = Math.max(0, oldRemaining - 1);
      } else {
        pushCtx(line.startsWith(" ") ? line.slice(1) : line);
        oldRemaining = Math.max(0, oldRemaining - 1);
        newRemaining = Math.max(0, newRemaining - 1);
      }
      if (countedHunk && oldRemaining === 0 && newRemaining === 0) endHunk();
      continue;
    }

    // 初始行可能碰到 `Binary files … differ` / `GIT binary patch`：后续数据块全部跳过
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      inBinaryBlock = true;
      continue;
    }

    if (isFileMeta(line)) {
      // 新文件段的文件头：hunk 头若缺席，行号从 1 重新开始（与旧口径一致）
      if (line.startsWith("---") || line.startsWith("+++")) {
        oldNext = 1;
        newNext = 1;
      }
      continue;
    }

    if (line.startsWith("+")) {
      out.push({ kind: "add", text: line.slice(1), oldNum: null, newNum: newNext });
      newNext += 1;
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: line.slice(1), oldNum: oldNext, newNum: null });
      oldNext += 1;
    } else {
      pushCtx(line.startsWith(" ") ? line.slice(1) : line);
    }
  }

  return out;
}

/**
 * 统一视图：`parsePatchLines` 已经算好行号（唯一口径），这里只做模型投影。
 */
export function toUnifiedRows(lines: ParsedDiffLine[]): DiffRow[] {
  return lines.map((line) => ({
    kind: line.kind,
    oldNum: line.oldNum,
    newNum: line.newNum,
    text: line.text,
  }));
}

/**
 * 分屏行模型：上下文行两边同显；连续的删除/新增按顺序配对（多出来的一侧留空）。
 * 行号来自同一份解析结果，不另算一套。
 */
export function toSplitRows(lines: ParsedDiffLine[]): SplitRow[] {
  const unified = toUnifiedRows(lines);
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < unified.length) {
    const row = unified[i];
    if (row.kind === "ctx") {
      rows.push({
        kind: "ctx",
        left: { num: row.oldNum!, text: row.text, kind: "ctx" },
        right: { num: row.newNum!, text: row.text, kind: "ctx" },
      });
      i += 1;
      continue;
    }
    // 收集一段连续的变更（del 在前、add 在后是 unified diff 的惯例；这里顺序无关）
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < unified.length && unified[i].kind !== "ctx") {
      if (unified[i].kind === "del") dels.push(unified[i]);
      else adds.push(unified[i]);
      i += 1;
    }
    const pairs = Math.max(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const del = dels[k];
      const add = adds[k];
      rows.push({
        kind: "change",
        left: del ? { num: del.oldNum!, text: del.text, kind: "del" } : null,
        right: add ? { num: add.newNum!, text: add.text, kind: "add" } : null,
      });
    }
  }
  return rows;
}
