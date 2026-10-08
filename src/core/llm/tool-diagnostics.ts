/**
 * 工具结果的**结构化诊断**（第 183 波，对标 Pi 的 `ToolDiagnostic` + `<harness>` 渲染）。
 *
 * ## 为什么要它（原来只有"一句散装提示"）
 *
 * 我们的截断提示散落在各处，形态是 `... (showing lines 1-2 ... use offset to continue reading)`
 * —— 一句**看起来像正文**的括号文本。问题有两个：
 *
 * 1. **可能被误当成文件内容**：它紧跟在被读内容之后，而 `read` 的输出外面还裹着
 *    "这是待分析数据"的边界框；模型很难从形态上区分"这是文件里的字"与"这是系统在说
 *    '你只看到了一部分'"。
 * 2. **两条路径措辞不同、数字口径也不同**（Rust 分页 vs legacy 逐行），
 *    于是"截断了多少"这件事在模型侧没有稳定形状可依赖。
 *
 * Pi 的做法（`harness/tool.ts:432-474`）是把这类信息做成**结构化诊断**再渲染成
 * 带专用标记的块：
 *
 * ```text
 * <harness>
 * [warn] Output truncated to its end: 3 lines, 18 bytes dropped
 * </harness>
 * ```
 *
 * 我们照这个形状做（标记用 `<harness>` 与上游一致，便于已熟悉它的模型直接读懂），
 * 并遵守它的一条硬纪律：**只在真的截断时才渲染**（宁可少说，不可谎报）。
 */
import type { ToolCallResult } from "./types";

export interface ToolDiagnostic {
  severity: "info" | "warn" | "error";
  /** 机器可读的类别（`truncated` / `paged` / …） */
  code: string;
  /** 给模型看的一句话（含精确数字） */
  message: string;
}

/**
 * 截断/分页诊断。
 *
 * @param droppedLines 没返回给模型的行数
 * @param droppedChars 没返回给模型的字符数（按行内容计，不含行尾）
 * @param totalLines   文件总行数
 * @param retain       `end` = 保留了尾部（丢了开头）；省略 = 保留了开头（丢了尾部）
 */
export function truncatedDiagnostic(
  droppedLines: number,
  droppedChars: number,
  totalLines: number,
  retain?: "head" | "end",
): ToolDiagnostic {
  const kept = retain === "end" ? " to its end" : "";
  return {
    severity: "warn",
    code: "truncated",
    message:
      `Output truncated${kept}: ${droppedLines} lines / ${droppedChars} chars dropped ` +
      `(file has ${totalLines} lines). Use offset to continue reading.`,
  };
}

/**
 * **分页**诊断（只知道"给了哪一段"，不知道总数时用它）。
 *
 * 为什么单独有一条、而不是复用 `truncatedDiagnostic`：那条要 `totalLines` 与
 * 精确丢弃量，legacy 逐行读取路径**拿不到**这两个数。**宁可说得少，也不许编数字**
 * —— "截断了多少"说错比不说更糟（模型会据此判断该不该继续翻页）。
 */
export function pagedDiagnostic(fromLine: number, toLine: number): ToolDiagnostic {
  return {
    severity: "warn",
    code: "paged",
    message: `Only part of the file was returned (lines ${fromLine}-${toLine}). Use offset to continue reading.`,
  };
}

/**
 * **搜索窗口**诊断（第 186 波）—— 给 `glob` 用。
 *
 * ## 为什么不能复用 `truncatedDiagnostic`
 *
 * 那条说的是"**文件的行**被切了"（丢了多少行/字符，文件总共多少行），数字口径是**读取预算**；
 * 这条说的是"**匹配结果本身**有界 / 只内联了一部分"，口径是**条数**。两个不同的事实硬套
 * 同一个函数，就会逼出"glob 有 20000 行、丢了多少字符"这种既算不出也没意义的数字
 * （本仓纪律：宁可说得少，也不许编数字）。
 *
 * ## 措辞里必须同时有三件事
 *
 * 1. 结果是**有界窗口**还是**至少还有更多**（后者不许含糊成"结果很多"）；
 * 2. 内联了几条、本次返回几条（模型据此判断"要不要继续"）；
 * 3. **完整列表在哪 / 怎么继续拿**（`spillPath` 或 Rust 给的 `hint`）—— 只有"截断了"没有
 *    "怎么办"的诊断，等于改前那句 `Err(...)` 换个地方出现。
 */
export function globWindowDiagnostic(params: {
  /** 内联给模型的条数（有界） */
  inlineCount: number;
  /** 本次搜索返回的总条数（≤ limit） */
  returned: number;
  /** 本次搜索结果**至少还有更多** */
  truncated: boolean;
  /** 完整列表落盘路径（落盘成功时） */
  spillPath?: string;
  /** 落盘失败的原因（**不许沉默**：模型必须知道"完整列表没拿到"） */
  spillError?: string;
  /** Rust 侧给的下一步（夹取说明 / 翻页 offset）——原样带上，避免两处各说一套数字 */
  hint?: string;
}): ToolDiagnostic {
  const head = params.truncated
    ? `glob matched MORE than the ${params.returned} path(s) it returned — this result window is truncated (at least one more match exists)`
    : `glob returned ${params.returned} path(s)`;
  const shown = `only the first ${params.inlineCount} are shown inline`;
  const where = params.spillPath
    ? `the complete returned list is saved at ${params.spillPath} (read it with the read tool)`
    : params.spillError
      ? `saving the complete returned list to disk FAILED (${params.spillError}) — the inline list is all you have`
      : `the rest were not shown`;
  const parts = [head, shown, where];
  if (params.hint) parts.push(params.hint);
  return { severity: "warn", code: "truncated", message: `${parts.join("; ")}.` };
}

/** 渲染诊断块（`<harness>` 标记 + 每条一行） */export function renderDiagnostics(diagnostics: readonly ToolDiagnostic[] | undefined): string {
  if (!diagnostics || diagnostics.length === 0) return "";
  const lines = diagnostics.map((d) => `[${d.severity}] ${d.message}`);
  return `<harness>\n${lines.join("\n")}\n</harness>`;
}

/**
 * 把诊断**原样**拼到工具输出末尾（各工具统一走它，避免又长出一套散装文案）。
 *
 * ⚠️ 只在 `diagnostics` 非空时才追加 —— "没截断却报截断"和"截断却不说"一样是失真。
 */
export function appendDiagnostics(output: string, diagnostics: readonly ToolDiagnostic[] | undefined): string {
  const block = renderDiagnostics(diagnostics);
  if (!block) return output;
  return output ? `${output}\n${block}` : block;
}

/** 便于在 `ToolCallResult` 上挂诊断（类型安全的小工具） */
function withDiagnostics<T extends ToolCallResult>(result: T, diagnostics: ToolDiagnostic[]): T {
  if (diagnostics.length === 0) return result;
  return { ...result, diagnostics: [...(result.diagnostics ?? []), ...diagnostics] };
}
