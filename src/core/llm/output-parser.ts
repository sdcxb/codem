/**
 * 健壮的 LLM 输出解析工具
 *
 * 核心原则: 永不信任模型的输出格式 — 模型可能在 JSON 外包裹 markdown 代码块、
 * 添加解释文字、使用中文标点、截断输出等。此模块提供容错解析。
 */

/**
 * 把**字符串字面量内部**的裸控制字符转义掉（真实换行 / 回车 / 制表等）。
 *
 * ## 为什么需要它（第 192 波**真机**实测）
 *
 * 记忆自动提取的分叉调用返回了一个**看起来完全正常**的 JSON 数组（真机控制台原文：
 * `[{"key": "发布流程约定", "content": "本仓库的发布流程固定为三步：…"}]`），
 * 却把整批记忆丢掉了 —— 两条警告同时出现：
 *
 * ```
 * [output-parser.ts] extractJSON failed: [{"key": "发布流程约定", …
 * [extractMemories] Failed to parse memories from forked agent response: […]
 * ```
 *
 * 上面那 7 步修复**都不覆盖**这一类：它们只处理包裹、中文标点、尾逗号、前后文字。
 * 而模型给的 `content` 是**整段散文**，很容易带**真实换行**而不是 `\n` 转义 ——
 * 裸控制字符在 JSON 字符串里非法 ⇒ `JSON.parse` 直接拒绝 ⇒ 这一批自动记忆**整批消失**，
 * 用户看到的现象正是"自动记忆不好使"（S4 / O-45 要治的那个病）。
 *
 * ## 口径：**只动字符串内部**
 *
 * 用一台引号状态机判断当前位置在不在字符串里；字符串之外**一个字节不改** ——
 * 否则会把合法的结构（`{`、`,`、引号）改坏，那比不修更糟。
 * 已经成对的转义（`\"`、`\\n`）原样保留（`escaped` 状态）。
 */
export function escapeRawControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    out += ch;
    if (ch === '"') inString = true;
  }
  return out;
}

/**
 * 解析全失败时的**可诊断**说明。
 *
 * 旧写法只打 `raw.slice(0, 120)` —— 而真机那次失败的输入**前 200 字符完全正常**
 * （见 `escapeRawControlCharsInStrings` 的说明），于是现场无法定位"到底哪一处不合法"，
 * 只能等下一次再猜。这里给出三样能直接定位的东西：`JSON.parse` 的原话、出错位置附近的窗口、
 * 以及"字符串里有没有裸控制字符"这个**最可能的原因**（用状态机精确判断，不是粗筛）。
 */
export function diagnoseJsonFailure(text: string): string {
  let err: string;
  let at = -1;
  try {
    JSON.parse(text);
    err = "文本本身可解析（说明失败发生在某个修复分支上，请检查 attempts）";
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    const m = /position (\d+)/.exec(err);
    at = m ? Number(m[1]) : -1;
  }
  const window = at >= 0 ? text.slice(Math.max(0, at - 60), at + 60) : text.slice(0, 160);
  const rawCtrlInString = escapeRawControlCharsInStrings(text) !== text;
  return `${err}${at >= 0 ? ` @${at}` : ""}；出错窗口=${JSON.stringify(window)}${
    rawCtrlInString ? "；**字符串里有裸控制字符**（多为真实换行 ⇒ 整批结果会被丢掉）" : ""
  }`;
}

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
 * 8. **字符串内部的裸控制字符**（真实换行/回车/制表）— 第 192 波真机实测：整批记忆被丢掉
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

  // 解析尝试（静默，避免每次失败刷屏 —— 模型常返回"文本+JSON"混合或截断，
  // 多步修复尝试失败属常态，最终结果由调用方按 null 处理）。
  const attempts: Array<() => string | null> = [
    // Step 3: 直接解析
    () => text,
    // Step 4: 去除尾部逗号 (JSON5 风格)
    () => text.replace(/,\s*([\]}])/g, '$1'),
    // Step 5: 提取第一个 JSON 对象 { ... }
    () => {
      const m = text.match(/\{[\s\S]*\}/);
      return m ? m[0].replace(/,\s*([\]}])/g, '$1') : null;
    },
    // Step 6: 提取第一个 JSON 数组 [ ... ]
    () => {
      const m = text.match(/\[[\s\S]*\]/);
      return m ? m[0].replace(/,\s*([\]}])/g, '$1') : null;
    },
    // Step 7: 逐步缩小范围 — 模型可能在 JSON 后添加了说明文字
    () => {
      const firstBrace = text.search(/[{[]/);
      const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return text.substring(firstBrace, lastBrace + 1)
          .replace(/,\s*([\]}])/g, '$1');
      }
      return null;
    },
    // Step 8: 字符串内部的**裸控制字符**（真实换行/回车/制表）⇒ 转义（第 192 波真机实测的整批丢弃）
    () => escapeRawControlCharsInStrings(text).replace(/,\s*([\]}])/g, '$1'),
    // Step 9: 先缩范围再转义（前后有说明文字 **且** 字符串里有裸换行 —— 两类叠加）
    () => {
      const firstBrace = text.search(/[{[]/);
      const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return escapeRawControlCharsInStrings(text.substring(firstBrace, lastBrace + 1)).replace(/,\s*([\]}])/g, '$1');
      }
      return null;
    },
  ];

  for (const attempt of attempts) {
    const candidate = attempt();
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // 继续下一个修复尝试
    }
  }

  // 全部失败：单次 warn（**可诊断**：解析错误 + 出错窗口 + 裸控制字符点名），供定位且不刷屏。
  console.warn('[output-parser.ts] extractJSON failed:', diagnoseJsonFailure(text));
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
