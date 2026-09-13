/**
 * 工具参数守卫（第 66 波）—— 「参数解析不出来时**不要执行**」这件事的单一落点。
 *
 * ## 真实事故
 *
 * 用户让模型用技能生成一张科研绘图，模型选择"写一个 Python 脚本再跑它"，脚本约 6–10KB。
 * 结果控制台反复报：
 *   `SyntaxError: Unterminated string in JSON at position 6648 / 6348 / 6001 / 2080`
 * 即**工具参数的 JSON 在字符串中间被截断**（单次输出达到上限），随后同一个 `write` 反复失败。
 *
 * 当时的处理有两个问题：
 *   1. **静默降级**：provider 解析失败只打一行日志，然后照旧 yield `tool_use_end`（`input: {}`）；
 *   2. **正则兜底反而更危险**：循环里用正则从残缺 JSON 里抽 `path` / `content`，
 *      而截断时结尾引号还没生成 → `content` 抽出空串 → `write` 拿着 **空内容** 执行。
 *      对一个已存在的文件，这就是**清空文件**（覆盖保护在 auto/full 模式下不拦）。
 *
 * ## 现在的契约
 *
 * 参数解析失败 ⇒ **拒绝执行**，并把"为什么 + 怎么办"讲清楚：
 *   · 内容型工具（write/edit/…）：教它**分块写入**（先写第一段，再用 `append: true` 追加）；
 *   · 其它工具：教它把这次调用拆小；
 *   · 一律提醒"不要原样重发"（会被重复调用守卫拦下）。
 *
 * 注意：这里**刻意不做"修复残缺 JSON"**。修复后的 `content` 只可能是**半截文件**，
 * 悄悄写下去比报错更糟 —— 报错至少让模型有机会改用分块写入。
 */

/** 这些工具的参数里带"要被写下去的内容"，截断后绝不能凑合执行 */
export const CONTENT_BEARING_TOOLS = new Set([
  "write",
  "edit",
  "multi_edit",
  "patch",
  "apply_patch",
  "notebook_create",
  "notebook_update",
]);

export function isContentBearingTool(name: string): boolean {
  return CONTENT_BEARING_TOOLS.has(name);
}

/**
 * 生成给模型看的"参数不可用"错误文本。
 *
 * 刻意包含三个要素：**发生了什么**（参数没解析出来 + 原始长度）、
 * **这次没执行**（避免它以为已经写进去了）、**怎么重试**（分块 / 拆小 / 别原样重发）。
 */
export function buildUnparsableArgsError(
  toolName: string,
  rawLength: number,
  parseError?: string,
  finishReason?: string,
): string {
  const hint = isContentBearingTool(toolName)
    ? `  · **分块写入**：先 write 第一段（建议每次不超过 ~200 行），后续段落用 \`write\` 的 \`append: true\` 追加；\n` +
      `  · 或者把大文件拆成几个小文件，最后用脚本/命令拼起来；\n`
    : `  · 把这次调用拆成多次更小的调用；\n`;
  // 结束原因能直接确认"是不是被输出上限截断"（length = 达到上限），比让用户猜有用得多
  const cause =
    finishReason === "length"
      ? `**已确认**：本次回复的结束原因是 \`length\`（达到单次输出上限），参数就是在这里被切断的。`
      : `最常见的原因是**单次输出太长被截断**（参数 JSON 在字符串中间断掉）${finishReason ? `（本次结束原因：${finishReason}）` : ""}`;
  return (
    `参数没能解析（${toolName}，原始参数 ${rawLength} 字符）—— **这次调用没有执行**，以免用错误的参数造成破坏。\n` +
    `${cause}${parseError ? `：${parseError}` : ""}\n请这样重试：\n` +
    hint +
    `  · 不要原样重发同一段内容（会被判定为重复调用并拦下）。`
  );
}
