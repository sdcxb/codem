/**
 * Diff 解析与"统一 / 分屏"两种视图的行模型。
 *
 * ## 为什么抽成纯函数
 *
 * 分屏视图的关键是**左右行配对**（连续的删除行与新增行按顺序配对，上下文行两边都有），
 * 以及两侧各自的**行号**。把这件事写在 JSX 里既难读又难测；抽出来后判据可以直接断言：
 * - `del,del,add,add` ⇒ 两行配对 + 左侧缺第二行时右侧为空；
 * - 行号：删除行只推进旧号，新增行只推进新号，上下文行两边都推进；
 * - 分屏与统一视图的总行数一致（同一份解析结果，不许两套口径）。
 *
 * 判据 `DIFFVIEW-1..5`。
 */

type DiffLineKind = "add" | "del" | "ctx";

export interface ParsedDiffLine {
  kind: DiffLineKind;
  /** 去掉行首 `+`/`-`/` ` 标记后的正文（已去掉 unified diff 的元数据行） */
  text: string;
}

/** 统一的元数据行（`+++` / `---` / `@@` / `diff --git` 等）：不参与行配对 */
function isMetaLine(line: string): boolean {
  return (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("@@") ||
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode")
  );
}

/**
 * 解析一段 unified diff 文本（也接受"只有 +/- 标记的补丁片段"）。
 * 无法识别标记的行按上下文行处理（`newText` 里本来就可能是整段代码）。
 */
export function parseDiffLines(text: string): ParsedDiffLine[] {
  const out: ParsedDiffLine[] = [];
  for (const raw of String(text ?? "").split("\n")) {
    if (isMetaLine(raw)) continue;
    if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1) });
    else out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return out;
}

export interface DiffRow {
  kind: DiffLineKind;
  /** 旧文件行号（null 表示这一行在旧文件里不存在） */
  oldNum: number | null;
  /** 新文件行号（null 表示这一行在新文件里不存在） */
  newNum: number | null;
  text: string;
}

/** 单侧视图（统一 diff）的行模型：每行带旧的/新的行号 */
export function toUnifiedRows(lines: ParsedDiffLine[]): DiffRow[] {
  let oldNum = 0;
  let newNum = 0;
  return lines.map((line) => {
    if (line.kind === "del") {
      oldNum += 1;
      return { kind: line.kind, oldNum, newNum: null, text: line.text };
    }
    if (line.kind === "add") {
      newNum += 1;
      return { kind: line.kind, oldNum: null, newNum, text: line.text };
    }
    oldNum += 1;
    newNum += 1;
    return { kind: line.kind, oldNum, newNum, text: line.text };
  });
}

export interface SplitRow {
  kind: "ctx" | "change";
  left: { num: number; text: string; kind: DiffLineKind } | null;
  right: { num: number; text: string; kind: DiffLineKind } | null;
}

/**
 * 分屏行模型：上下文行两边同显；连续的删除/新增按顺序配对（多出来的一侧留空）。
 * 行号来自 `toUnifiedRows`（同一份口径，不许另算一套）。
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

export type DiffViewMode = "unified" | "split";
