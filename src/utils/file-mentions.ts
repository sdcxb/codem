/**
 * File-mention resolver — 借鉴 DSH 的 MarkdownFileMentions 设计。
 *
 * 核心思路：渲染器不猜测什么是文件路径，而是由上层基于工具调用记录
 * 传入一个 resolve(value) 函数。当 inline code 的值能被解析为实际创建/修改
 * 的文件时，自动变为可点击链接。
 *
 * 来源：DSH packages/client/ui-deliverables/src/client/turn-deliverables.ts
 */

/**
 * 文件提及解析器接口。
 * resolve 返回 { open, label, title } 表示该 token 是一个可打开的文件；
 * 返回 undefined 表示该 token 不是已知文件，保持普通 code 样式。
 */
export interface FileMention {
  /** 点击时的回调（打开文件管理器或编辑器） */
  open: () => void;
  /** 无障碍标签，如 "打开 src/index.ts" */
  label: string;
  /** 完整路径，用作 title 属性 */
  title: string;
}

export interface FileMentions {
  resolve(value: string): FileMention | undefined;
}

/** 路径的最后一段（basename），用于模糊匹配。 */
function basename(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at === -1 ? path : path.slice(at + 1);
}

/** 在 produced paths 中找到唯一一个 basename 匹配的路径。 */
function onlyPathWithBasename(paths: readonly string[], value: string): string | undefined {
  const matches = paths.filter((path) => basename(path) === value);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 从工具调用列表中提取本轮创建/修改的文件路径。
 * 覆盖 write, edit, multi_edit, str_replace 等写操作工具。
 */
export function extractProducedPaths(toolCalls: readonly { tool: string; args: Record<string, unknown>; status: string }[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const tc of toolCalls) {
    if (tc.status === "error") continue;
    const writeTools = ["write", "edit", "multi_edit", "str_replace", "str_replace_editor"];
    if (!writeTools.includes(tc.tool)) continue;

    // write / edit: args.file_path
    const filePath = tc.args?.file_path;
    if (typeof filePath === "string" && !seen.has(filePath)) {
      seen.add(filePath);
      paths.push(filePath);
    }

    // multi_edit: args.edits[].file_path (有些实现把 file_path 放在每个 edit 里)
    const edits = tc.args?.edits;
    if (Array.isArray(edits)) {
      for (const edit of edits) {
        if (edit && typeof edit.file_path === "string" && !seen.has(edit.file_path)) {
          seen.add(edit.file_path);
          paths.push(edit.file_path);
        }
      }
    }
  }

  return paths;
}

/**
 * 基于工具调用记录构建一个 FileMentions resolver。
 *
 * 匹配规则（与 DSH 一致）：
 * 1. 精确匹配：inline code 的值恰好等于某个 produced path
 * 2. basename 唯一匹配：inline code 的值恰好等于某个 produced path 的 basename，
 *    且该 basename 在所有 produced paths 中唯一（不歧义）
 * 3. 其他情况返回 undefined（保持普通 code 样式）
 *
 * @param toolCalls 本轮工具调用列表
 * @param openFile 打开文件的回调（Tauri reveal_item_in_dir 或 open_file_external）
 * @returns FileMentions 实例，或 null（当没有 produced paths 时）
 */
export function createFileMentions(
  toolCalls: readonly { tool: string; args: Record<string, unknown>; status: string }[] | undefined,
  openFile: (path: string) => void,
): FileMentions | null {
  if (!toolCalls || toolCalls.length === 0) return null;

  const paths = extractProducedPaths(toolCalls);
  if (paths.length === 0) return null;

  return {
    resolve(value: string): FileMention | undefined {
      // 1. 精确匹配
      const exact = paths.includes(value) ? value : undefined;
      // 2. basename 唯一匹配
      const byBasename = exact === undefined ? onlyPathWithBasename(paths, value) : undefined;
      const path = exact ?? byBasename;
      if (path === undefined) return undefined;
      return {
        open: () => openFile(path),
        label: `打开 ${path}`,
        title: path,
      };
    },
  };
}
