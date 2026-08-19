/**
 * 健壮的 LLM 输出解析工具
 *
 * 核心原则: 永不信任模型的输出格式 — 模型可能在 JSON 外包裹 markdown 代码块、
 * 添加解释文字、使用中文标点、截断输出等。此模块提供容错解析。
 */

/**
 * 从 LLM 响应中提取 JSON 对象或数组
 *
 * 处理以下常见模型行为:
 * 1. 纯 JSON 输出
 * 2. ```json ... ``` 代码块包裹
 * 3. ``` ... ``` 代码块包裹（无语言标记）
 * 4. JSON 前后有解释文字（提取第一个 { ... } 或 [ ... ]）
 * 5. 中文标点（"" → ""，'' → ''）— 模型常在中文上下文中混淆标点
 * 6. 尾部逗号（JSON5 风格）— 模型常在最后一个元素后加逗号
 * 7. 单引号字符串 — 部分模型使用单引号而非双引号
 *
 * @returns 解析后的对象，或 null（解析失败时）
 */
export function extractJSON<T = any>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Step 1: 去除 markdown 代码块包裹
  // 匹配 ```json\n...\n``` 或 ```\n...\n```
  const codeBlockMatch = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  // Step 2: 修复中文标点
  text = text
    .replace(/[\u201c\u201d]/g, '"')  // " " → "
    .replace(/[\u2018\u2019]/g, "'")  // ' ' → '
    .replace(/，/g, ',')               // 中文逗号
    .replace(/：/g, ':')               // 中文冒号
    .replace(/【/g, '[').replace(/】/g, ']')  // 中文方括号
    .replace(/｛/g, '{').replace(/｝/g, '}'); // 中文花括号

  // Step 3: 尝试直接解析
  try {
    return JSON.parse(text) as T;
  } catch (e) { console.warn('[output-parser.ts]', e) }

  // Step 4: 去除尾部逗号 (JSON5 风格)
  const noTrailingComma = text
    .replace(/,\s*([\]}])/g, '$1');
  try {
    return JSON.parse(noTrailingComma) as T;
  } catch (e) { console.warn('[output-parser.ts]', e) }

  // Step 5: 提取第一个 JSON 对象 { ... }
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const cleaned = objMatch[0]
        .replace(/,\s*([\]}])/g, '$1'); // 尾部逗号
      return JSON.parse(cleaned) as T;
    } catch (e) { console.warn('[output-parser.ts]', e) }
  }

  // Step 6: 提取第一个 JSON 数组 [ ... ]
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const cleaned = arrMatch[0]
        .replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(cleaned) as T;
    } catch (e) { console.warn('[output-parser.ts]', e) }
  }

  // Step 7: 逐步缩小范围 — 模型可能在 JSON 后添加了说明文字
  // 从后往前找到最后一个 } 或 ]，从前往后找到第一个 { 或 [
  const firstBrace = text.search(/[{[]/);
  const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const subset = text.substring(firstBrace, lastBrace + 1)
      .replace(/,\s*([\]}])/g, '$1');
    try {
      return JSON.parse(subset) as T;
    } catch (e) { console.warn('[output-parser.ts]', e) }
  }

  return null;
}

/**
 * 从 LLM 响应中提取列表（每行一个条目）
 *
 * 处理以下常见模型行为:
 * 1. 纯文本，每行一个条目
 * 2. 带编号 (1. 2. 3. 或 1) 2) 3))
 * 3. 带 bullet (- 或 *)
 * 4. JSON 数组格式
 * 5. Markdown 引用 (> ...)
 * 6. 前后有解释文字
 *
 * @returns 清理后的字符串数组
 */
export function extractList(raw: string): string[] {
  if (!raw || typeof raw !== 'string') return [];

  let text = raw.trim();

  // 先尝试 JSON 数组
  const jsonArray = extractJSON<string[]>(text);
  if (Array.isArray(jsonArray) && jsonArray.length > 0) {
    return jsonArray
      .map(s => typeof s === 'string' ? s.trim() : String(s).trim())
      .filter(s => s.length > 0);
  }

  // 去除 markdown 代码块
  const codeBlockMatch = text.match(/```(?:\w+)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  return text
    .split('\n')
    .map(line => line.trim())
    // 去除编号前缀: "1. " "1) " "1、"
    .map(line => line.replace(/^\d+[\.\)]\s*/, '').replace(/^\d+[、，]\s*/, ''))
    // 去除 bullet: "- " "* " "• "
    .map(line => line.replace(/^[-*•]\s+/, ''))
    // 去除引用: "> "
    .map(line => line.replace(/^>\s*/, ''))
    // 去除 markdown 加粗
    .map(line => line.replace(/\*\*(.+?)\*\*/g, '$1'))
    .map(line => line.trim())
    .filter(line => line.length > 2)           // 过滤空行和太短的行
    .filter(line => !line.startsWith('```'))   // 过滤代码块标记
    .filter(line => !line.startsWith('#'))     // 过滤标题行
    .filter(line => !line.match(/^(here|以下是|以下为|below)/i)); // 过滤引导句
}

/**
 * 从 LLM 响应中提取 Mermaid 代码
 *
 * 处理:
 * 1. 纯 Mermaid 代码
 * 2. ```mermaid ... ``` 代码块
 * 3. ``` ... ``` 代码块
 * 4. 前后有解释文字
 *
 * @returns Mermaid 代码字符串，或 null
 */
export function extractMermaid(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // 尝试提取 mermaid 代码块
  const mermaidMatch = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)\n?```/);
  if (mermaidMatch) {
    const code = mermaidMatch[1].trim();
    if (code.startsWith('mindmap') || code.startsWith('graph') || code.startsWith('flowchart') ||
        code.startsWith('sequenceDiagram') || code.startsWith('classDiagram') ||
        code.startsWith('stateDiagram') || code.startsWith('erDiagram') ||
        code.startsWith('gantt') || code.startsWith('pie')) {
      return code;
    }
  }

  // 检查是否本身就是 mermaid 代码
  const trimmed = text.trim();
  if (trimmed.startsWith('mindmap') || trimmed.startsWith('graph') || trimmed.startsWith('flowchart') ||
      trimmed.startsWith('sequenceDiagram') || trimmed.startsWith('classDiagram') ||
      trimmed.startsWith('stateDiagram') || trimmed.startsWith('erDiagram') ||
      trimmed.startsWith('gantt') || trimmed.startsWith('pie')) {
    return trimmed;
  }

  // 尝试找到 mermaid 关键字开始的行
  const lines = text.split('\n');
  const startIndex = lines.findIndex(line =>
    /^\s*(mindmap|graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie)\b/i.test(line)
  );

  if (startIndex >= 0) {
    // 从关键字行开始，到代码块结束或文件末尾
    const codeLines: string[] = [];
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      // 遇到代码块结束标记则停止
      if (line.trim() === '```') break;
      // 遇到明显的非代码行则停止（如 markdown 标题、空行后的解释）
      if (i > startIndex && line.trim() === '' && codeLines.length > 3) {
        // 检查后面是否还有缩进内容
        const next = lines[i + 1];
        if (!next || !next.startsWith(' ') && !next.startsWith('\t')) break;
      }
      codeLines.push(line);
    }
    if (codeLines.length > 0) {
      return codeLines.join('\n').trim();
    }
  }

  return null;
}
