/**
 * 笔记本式知识管理 — PDF 文本提取器（纯 TypeScript，零依赖）
 *
 * 这是一个基础实现，能处理简单的文本型 PDF。
 * 不支持：加密 PDF、扫描图片型 PDF、复杂字体编码。
 *
 * 原理：
 * 1. 读取 PDF 二进制内容
 * 2. 定位 stream...endstream 块（内容流）
 * 3. 解码 FlateDecode 压缩（使用浏览器内置 DecompressionStream）
 * 4. 提取 BT...ET 文本块中的 Tj/TJ 操作符文本
 */

// ========== 主提取函数 ==========

export async function extractPdfText(fileData: Uint8Array): Promise<string> {
  // Convert to string for pattern matching (Latin1 to preserve byte values)
  const pdfString = binaryToLatin1(fileData);

  // Check if it's a valid PDF
  if (!pdfString.startsWith('%PDF-')) {
    throw new Error('Not a valid PDF file');
  }

  // Find all stream objects
  const streams = findStreamContents(pdfString, fileData);
  if (streams.length === 0) {
    throw new Error('No content streams found in PDF');
  }

  const textParts: string[] = [];

  for (const stream of streams) {
    // Check if stream is FlateDecode compressed
    const isCompressed = stream.filter !== 'FlateDecode';
    let decodedData: Uint8Array;

    if (stream.isCompressed) {
      try {
        decodedData = await flateDecode(stream.data);
      } catch {
        // Skip streams that can't be decoded
        continue;
      }
    } else {
      decodedData = stream.data;
    }

    const decodedString = binaryToLatin1(decodedData);
    const text = extractTextFromContentStream(decodedString);
    if (text) textParts.push(text);
  }

  const result = textParts.join('\n\n').trim();
  if (!result) {
    throw new Error('No extractable text found. This PDF may be image-based or encrypted.');
  }

  return result;
}

// ========== 二进制工具 ==========

function binaryToLatin1(data: Uint8Array): string {
  let str = '';
  const chunkSize = 8192;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    str += String.fromCharCode(...chunk);
  }
  return str;
}

function latin1ToBinary(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// ========== 流查找 ==========

interface PdfStream {
  data: Uint8Array;
  isCompressed: boolean;
  filter?: string;
}

function findStreamContents(pdfString: string, fileData: Uint8Array): PdfStream[] {
  const streams: PdfStream[] = [];

  // Find stream...endstream blocks
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(pdfString)) !== null) {
    const streamContent = match[1];

    // Check if the preceding object dictionary mentions FlateDecode
    const beforeStream = pdfString.slice(Math.max(0, match.index - 200), match.index);
    const isCompressed = beforeStream.includes('FlateDecode');

    // Extract binary data from the stream content
    const streamData = latin1ToBinary(streamContent);

    streams.push({
      data: streamData,
      isCompressed,
      filter: isCompressed ? 'FlateDecode' : undefined,
    });
  }

  return streams;
}

// ========== FlateDecode (zlib) 解压 ==========

async function flateDecode(data: Uint8Array): Promise<Uint8Array> {
  // Use browser's built-in DecompressionStream (available in modern browsers and Tauri)
  if (typeof DecompressionStream !== 'undefined') {
    // Copy to ensure ArrayBuffer backing (not SharedArrayBuffer)
    const buffer = new ArrayBuffer(data.length);
    const view = new Uint8Array(buffer);
    view.set(data);

    const decompressionStream = new DecompressionStream('deflate');
    const writer = decompressionStream.writable.getWriter();
    writer.write(view);
    writer.close();

    const reader = decompressionStream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  throw new Error('DecompressionStream not available');
}

// ========== 文本提取 ==========

function extractTextFromContentStream(content: string): string {
  const lines: string[] = [];

  // Find BT...ET (Begin Text...End Text) blocks
  const btRegex = /BT\s*([\s\S]*?)\s*ET/g;
  let btMatch: RegExpExecArray | null;

  while ((btMatch = btRegex.exec(content)) !== null) {
    const textBlock = btMatch[1];
    const text = extractTextOperators(textBlock);
    if (text) lines.push(text);
  }

  // Also check for Td/TD/T* operators which indicate line breaks
  return lines.join('\n');
}

function extractTextOperators(block: string): string {
  const parts: string[] = [];

  // Tj operator: (text) Tj
  const tjRegex = /\(([^()]*)\)\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = tjRegex.exec(block)) !== null) {
    const text = decodePdfString(match[1]);
    if (text) parts.push(text);
  }

  // TJ operator: [(text1) num (text2) num ...] TJ
  const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
  while ((match = tjArrayRegex.exec(block)) !== null) {
    const arrayContent = match[1];
    // Extract all (text) from the array
    const textRegex = /\(([^()]*)\)/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textRegex.exec(arrayContent)) !== null) {
      const text = decodePdfString(textMatch[1]);
      if (text) parts.push(text);
    }
  }

  // Check for Td/TD operators (positioning = line breaks)
  // Replace Td/TD with newline markers
  const result = parts.join('');

  // Add newlines for Td/TD operators
  const lineBreakRegex = /T[dD*]/g;
  if (lineBreakRegex.test(block)) {
    return result;
  }

  return result;
}

function decodePdfString(str: string): string {
  // Handle escape sequences
  let result = '';
  let i = 0;
  while (i < str.length) {
    const char = str[i];
    if (char === '\\') {
      const next = str[i + 1];
      switch (next) {
        case 'n': result += '\n'; i += 2; break;
        case 'r': result += '\r'; i += 2; break;
        case 't': result += '\t'; i += 2; break;
        case 'b': result += '\b'; i += 2; break;
        case 'f': result += '\f'; i += 2; break;
        case '(': result += '('; i += 2; break;
        case ')': result += ')'; i += 2; break;
        case '\\': result += '\\'; i += 2; break;
        case '\n': i += 2; break; // Line continuation
        case '\r':
          if (str[i + 2] === '\n') { i += 3; } else { i += 2; }
          break;
        default:
          // Octal escape \ddd
          if (next >= '0' && next <= '7') {
            const octal = str.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] || '';
            if (octal) {
              result += String.fromCharCode(parseInt(octal, 8));
              i += 1 + octal.length;
            } else {
              result += next;
              i += 2;
            }
          } else {
            result += next || '';
            i += 2;
          }
      }
    } else if (char.charCodeAt(0) > 127) {
      // Try to handle Latin-1 characters
      result += char;
      i++;
    } else {
      result += char;
      i++;
    }
  }

  return result;
}

// ========== 检查是否为 PDF ==========

export function isPdfFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf');
}
