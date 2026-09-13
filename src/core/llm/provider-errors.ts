/**
 * Provider 错误的**语义识别**（第 69 波）。
 *
 * ## 真实事故
 *
 * 用户会话涨到约 104.8 万 token，超过模型上限（1,048,576），DeepSeek 返回：
 * \`\`\`
 * API error 400: {"error":{"message":"This model's maximum context length is 1048576 tokens.
 *   However, you requested 1048735 tokens ... Please reduce the length of the messages or completion."}}
 * \`\`\`
 * 而循环里的"反应式压缩"只匹配两个字符串 —— \`prompt_too_long\` 与 \`context_length_exceeded\` ——
 * **DeepSeek 的措辞一个都不含**。于是本来能救场的压缩从未触发，循环只是把同一个必然失败的请求
 * 重试 3 次（400 是确定性错误，重试毫无意义），最后整轮死掉、用户只看到一屏 400。
 *
 * 教训：**错误分类不能只匹配自家见过的措辞**。各家措辞不同，必须按"语义特征"匹配，
 * 并且对**确定性错误**（非 429 的 4xx）**快速失败**而不是重试。
 */

/**
 * 这个错误是不是"上下文超出模型上限"？
 *
 * 覆盖主流措辞：
 *   · DeepSeek/OpenAI：`maximum context length is N tokens`、`context_length_exceeded`、
 *     `reduce the length of the messages`；
 *   · Anthropic：`prompt is too long`；
 *   · 通用：`prompt_too_long`、`too many tokens`、`input is too long`、
 *     `exceeds the maximum number of tokens`。
 */
export function isContextOverflowError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("maximum context length") ||
    m.includes("context_length_exceeded") ||
    m.includes("prompt_too_long") ||
    m.includes("prompt is too long") ||
    m.includes("reduce the length of the messages") ||
    m.includes("too many tokens") ||
    m.includes("input is too long") ||
    m.includes("exceeds the maximum number of tokens") ||
    m.includes("context length exceeded")
  );
}

/**
 * 从 API 错误信息里解析出「上限 / 实际请求」两个数字（用于给用户一句可读的说明）。
 * 解析不出来时返回 undefined，不要瞎猜。
 */
export function parseContextOverflowNumbers(message: string | undefined): { limit?: number; requested?: number } {
  if (!message) return {};
  const limit = message.match(/(?:maximum context length is|max(?:imum)?(?:\s+\w+){0,3}\s+is)\s*([\d,]+)\s*tokens/i);
  const requested = message.match(/requested\s*([\d,]+)\s*tokens/i);
  const num = (s?: string) => (s ? Number(s.replace(/,/g, "")) : undefined);
  return { limit: num(limit?.[1]), requested: num(requested?.[1]) };
}

/**
 * 给用户看的溢出说明：把"超了多少"讲清楚，并给出可执行的下一步。
 */
export function describeContextOverflow(message: string | undefined): string {
  const { limit, requested } = parseContextOverflowNumbers(message);
  const detail =
    limit !== undefined && requested !== undefined
      ? `本次请求约 ${requested.toLocaleString()} tokens，模型上限 ${limit.toLocaleString()} tokens（超出约 ${(requested - limit).toLocaleString()}）`
      : limit !== undefined
        ? `模型上下文上限 ${limit.toLocaleString()} tokens`
        : "上下文已超出模型上限";
  return (
    `⚠️ **上下文超出模型上限**：${detail}。\n` +
    `已尝试压缩历史消息仍不够，无法继续本轮。建议：\n` +
    `  · **开一个新对话**并把要做的任务重新描述一遍（最干净）；\n` +
    `  · 或者删掉/收敛这个会话里体积大的内容（例如让它少读大文件、只保留结论）；\n` +
    `  · 或者换一个上下文更大的模型。`
  );
}
