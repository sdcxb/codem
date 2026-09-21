/**
 * 测试用：Tauri 文件命令的**内存桩**（第 68 轮抽出）。
 *
 * ## 为什么抽成共享文件
 *
 * 会话日志的读取从"整读 `read_file`"改成"分窗 `read_text_window`"之后，
 * 十几个测试文件各自手写的 invoke 桩都要认识新命令 —— 每个文件抄一份"窗口切片"逻辑，
 * 迟早会抄歪（而且抄歪的方向是**测试变绿、产品变红**）。所以这里放**唯一一份**桩实现。
 *
 * ## 桩要忠实到什么程度
 *
 * - `textWindowSlice` 复刻 Rust 侧的三条不变量：**只返回完整行**、`nextOffset` 落在行首、
 *   越界 offset 返回空 + `eof`（不报错）。
 * - ⚠️ **两处刻意的偏差**，都写在明面上：
 *   1. 这里按 **UTF-16 码元**切片，Rust 按**字节**切片 —— 对 ASCII 测试数据等价；
 *      多字节边界的正确性由 Rust 侧单测（`text_window_tests::multibyte_utf8_never_splits_mid_character`）
 *      证明，TS 侧只关心"按行拼回来"这个逻辑。
 *   2. 窗口上下限与 Rust 常量保持一致（64 KB ~ 8 MB），但**测试无法缩小窗口**；
 *      需要多窗口行为时把文件造得比 64 KB 大即可。
 * - `readFileWithCap` 复刻 `read_file` 的 50 MB 护栏与 `E_FILE_TOO_LARGE:` 前缀 ——
 *   这样"老代码在这个桩上会失败、新代码不会"才是**可证伪**的（见
 *   `session-log-large-file.test.ts` 的 SLF-1 对照）。
 */

/** 与 `src-tauri/src/lib.rs::READ_FILE_FULL_MAX_BYTES` 一致 */
export const READ_FILE_FULL_MAX_BYTES = 50 * 1024 * 1024;
/** 与 Rust 侧 `read_file` 的错误前缀一致 */
export const ERR_FILE_TOO_LARGE = "E_FILE_TOO_LARGE:";

const TEXT_WINDOW_MIN_BYTES = 64 * 1024;
const TEXT_WINDOW_MAX_BYTES = 8 * 1024 * 1024;

export interface WindowSlice {
  text: string;
  nextOffset: number;
  eof: boolean;
  size: number;
}

/**
 * `read_file` 的桩（含 50 MB 护栏）。
 * @throws 文件不存在或超过上限（与 Rust 侧同形）
 */
export function readFileWithCap(files: Map<string, string>, args?: Record<string, unknown>): string {
  const path = String(args?.path ?? "");
  const content = files.get(path);
  if (content === undefined) throw new Error(`not found: ${path}`);
  if (content.length > READ_FILE_FULL_MAX_BYTES) {
    throw new Error(
      `${ERR_FILE_TOO_LARGE} file is ${content.length} bytes (whole-file read limit ${READ_FILE_FULL_MAX_BYTES} bytes)`,
    );
  }
  return content;
}

/**
 * `read_text_window` 的桩：行对齐的分窗切片。
 * @throws 文件不存在
 */
export function textWindowSlice(
  files: Map<string, string>,
  args?: Record<string, unknown>,
): WindowSlice {
  const path = String(args?.path ?? "");
  const content = files.get(path);
  if (content === undefined) throw new Error(`not found: ${path}`);

  const requested = Number(args?.maxBytes ?? TEXT_WINDOW_MAX_BYTES);
  const max = Math.min(Math.max(requested, TEXT_WINDOW_MIN_BYTES), TEXT_WINDOW_MAX_BYTES);
  const size = content.length;
  const offset = Math.max(0, Number(args?.offset ?? 0));

  if (offset >= size) return { text: "", nextOffset: size, eof: true, size };

  let end = Math.min(size, offset + max);
  // 补到行尾：不切出半行（含换行符本身）
  while (end < size && content[end] !== "\n") end++;
  if (end < size) end++; // 吃掉换行符

  return {
    text: content.slice(offset, end),
    nextOffset: end,
    eof: end >= size,
    size,
  };
}
