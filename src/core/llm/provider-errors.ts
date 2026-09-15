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
 * 这个错误是不是"服务器不认识这个模型名"？（第 81 波）
 *
 * 为什么需要：内置目录里的条目是**我们写死的**。如果供应商把模型改名（DeepSeek 就干过：
 * `deepseek-v4-flash` → `deepseek-flash`）甚至下线，用户会在下拉里看到一个**永远调不通**的
 * 死选项，而且只有真正点了才会发现。
 *
 * 本函数只认"模型名不被接受"这一类语义，**不认**网络失败、鉴权失败、配额、限流、上下文超限 ——
 * 那些都不是模型名的问题，误记会让用户看到错误的结论。实测样本（DeepSeek）：
 *
 *   HTTP 400 {"error":{"message":"The supported API model names are deepseek-flash,
 *   deepseek-v4-pro, but you passed DeepSeek-V4-Flash-Vision-Exp"}}
 *
 * 各家措辞：OpenAI `model_not_found` / `The model 'x' does not exist`；Anthropic 404
 * `model: x not found`；Ollama `model "x" not found, try pulling it first`。
 */
export function isUnknownModelError(message: string | undefined, status?: number): boolean {
  if (!message) return false;
  // 鉴权/限流/服务端故障都不是"名字不对"
  if (status !== undefined && ![400, 404, 422].includes(status)) return false;
  const m = message.toLowerCase();
  // 上下文超限的措辞里也可能带 "model"，必须先排除（否则会把能用的模型标成失效）
  if (isContextOverflowError(m)) return false;
  return (
    m.includes("supported api model names") ||
    m.includes("model_not_found") ||
    m.includes("model not found") ||
    m.includes("unknown model") ||
    m.includes("no such model") ||
    m.includes("unrecognized model") ||
    m.includes("unsupported model") ||
    m.includes("invalid model") ||
    m.includes("not a valid model") ||
    m.includes("try pulling it first") ||
    /model[^.\n]{0,60}(does not exist|not exist|not found|is not available)/.test(m)
  );
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
