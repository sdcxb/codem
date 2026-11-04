//! 文档文本提取（Rust 侧，**流式**）。
//!
//! 支持的格式与结构（ADR-0008 §9）：
//! - 纯文本族（txt/md/rst/log/csv/tsv/json/yaml/yml/xml/toml/ini/cfg/conf）：按行流式读，段落/标题切块；
//! - docx：zip 内 `word/document.xml`，按 `<w:p>`/`<w:tbl>` 取段落、表格、标题样式；
//! - xlsx：`sharedStrings.xml` + 每个 `sheetN.xml`，按行取单元格；
//! - pptx：`ppt/slides/slideN.xml`，按页取段落；
//! - pdf：交给 [`crate::documents::pdf`]（PDFium）；
//! - 图片：只登记元数据，状态 `needs_ocr`（视觉转录在 P1）。
//!
//! ## 为什么不用渲染侧现成的 `knowledge/extractor.ts`
//!
//! 它把整个文件 base64 进渲染进程再 `atob`（100MB 就顶爆），且服务笔记本 RAG 的
//! 生命周期（chunk 镜像 2000 行上限）。文档索引不能沿用那条路径，也不去改它
//! （既有判据仍在守它）。
//!
//! ## 解压炸弹防线
//!
//! zip 条目读取前检查**声明大小**与压缩比：单条目 ≤ 8 GiB、压缩比 > 200 且 > 512 MiB
//! 一律拒绝（宁可 `failed`，也不让一个 4KB 的 zip 把内存吃光）。

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use super::chunk::{estimate_tokens, Sink, CHUNK_TARGET_TOKENS};

/// 单条目解压后上限（8 GiB）。
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// 压缩比可疑阈值（配合 `MAX_RATIO_MIN_BYTES` 使用，避免误伤小文件）。
const MAX_COMPRESSION_RATIO: u64 = 200;
const MAX_RATIO_MIN_BYTES: u64 = 512 * 1024 * 1024;
/// 单个段落/单元格文本上限（字符），防止一个畸形 XML 把块撑爆。
const MAX_PIECE_CHARS: usize = 200_000;

/// 提取结果：状态与统计（**不**在这里写 DB）。
#[derive(Debug)]
pub struct Outcome {
    pub page_count: i64,
    pub status: &'static str,
    pub error: Option<String>,
}

impl Outcome {
    fn ready(page_count: i64) -> Self {
        Self {
            page_count,
            status: "ready",
            error: None,
        }
    }
}

/// 按扩展名分派提取。任何错误都以 `failed` 语义返回（调用方写 DB 状态）。
pub fn extract(path: &Path, sink: &mut dyn Sink) -> Result<Outcome, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "txt" | "md" | "markdown" | "rst" | "log" | "csv" | "tsv" | "json" | "jsonl" | "yaml"
        | "yml" | "toml" | "ini" | "cfg" | "conf" | "xml" | "html" | "htm" | "sql" | "sh"
        | "bat" | "ps1" | "py" | "js" | "ts" | "tsx" | "jsx" | "css" | "rs" | "go" | "java"
        | "c" | "cpp" | "h" | "hpp" => extract_text(path, sink, &ext),
        "docx" => extract_docx(path, sink),
        "xlsx" => extract_xlsx(path, sink),
        "pptx" => extract_pptx(path, sink),
        "pdf" => crate::documents::pdf::extract_pdf(path, sink),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "svg" => {
            extract_image(path, sink)
        }
        "doc" | "xls" | "ppt" => Err(format!(
            "旧版二进制格式 .{ext} 暂不支持：请另存为 .{ext}x 后再索引"
        )),
        other => Err(format!("不支持的文件类型 .{other}")),
    }
}

// ═══════════════════════════ 纯文本族 ═══════════════════════════

fn extract_text(path: &Path, sink: &mut dyn Sink, ext: &str) -> Result<Outcome, String> {
    let file = File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line = Vec::new();
    let mut buf = String::new();
    let mut heading_stack: Vec<String> = Vec::new();
    let mut bytes: u64 = 0;
    let mut paragraph_chars = 0usize;
    let markdown = matches!(ext, "md" | "markdown");
    let line_mode = matches!(ext, "csv" | "tsv" | "jsonl" | "log");

    let flush = |sink: &mut dyn Sink,
                     buf: &mut String,
                     heading_stack: &mut Vec<String>,
                     kind: &str|
     -> Result<(), String> {
        let text = std::mem::take(buf);
        let trimmed = text.trim_end();
        if trimmed.is_empty() {
            return Ok(());
        }
        let heading = if heading_stack.is_empty() {
            None
        } else {
            Some(heading_stack.join(" > "))
        };
        sink.begin_block(0, kind, heading);
        sink.push_text(trimmed);
        sink.push_text("\n\n");
        sink.end_block();
        if sink.is_cancelled() {
            return Err("已取消".to_string());
        }
        Ok(())
    };

    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        let raw = String::from_utf8_lossy(&line);
        let text = raw.trim_end_matches(['\r', '\n']);

        if markdown {
            let hashes = text.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&hashes) && text[hashes..].starts_with(' ') {
                // 标题：先收尾上一段，再更新标题栈
                flush(sink, &mut buf, &mut heading_stack, "paragraph")?;
                let title: String = text[hashes + 1..].trim().chars().take(120).collect();
                heading_stack.truncate(hashes - 1);
                heading_stack.push(title.clone());
                let heading_path = heading_stack.join(" > ");
                sink.begin_block(0, "heading", Some(heading_path));
                sink.push_text(&title);
                sink.push_text("\n\n");
                sink.end_block();
                paragraph_chars = 0;
                sink.progress(bytes, 0);
                continue;
            }
        }

        if text.trim().is_empty() {
            flush(sink, &mut buf, &mut heading_stack, "paragraph")?;
            paragraph_chars = 0;
        } else {
            buf.push_str(text);
            buf.push('\n');
            paragraph_chars += text.chars().count() + 1;
            // 行模式（csv/log/jsonl）：每行一块；否则按 ~4KB 或 800 token 收段
            let cut = if line_mode {
                true
            } else {
                paragraph_chars >= 4000 || estimate_tokens(&buf) >= CHUNK_TARGET_TOKENS * 2
            };
            if cut {
                let kind = if line_mode { "row" } else { "paragraph" };
                flush(sink, &mut buf, &mut heading_stack, kind)?;
                paragraph_chars = 0;
            }
        }

        if bytes % (4 * 1024 * 1024) < n as u64 {
            sink.progress(bytes, 0);
            if sink.is_cancelled() {
                return Err("已取消".to_string());
            }
        }
    }
    flush(sink, &mut buf, &mut heading_stack, "paragraph")?;
    sink.page(0, "text", "layout", bytes as i64);
    Ok(Outcome::ready(1))
}

// ═══════════════════════════ 图片 ═══════════════════════════

fn extract_image(path: &Path, sink: &mut dyn Sink) -> Result<Outcome, String> {
    let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
    sink.page(1, "scanned", "none", 0);
    Ok(Outcome {
        page_count: 1,
        status: "needs_ocr",
        error: Some(format!(
            "图片待视觉转录：已登记元数据（{size} 字节），转录后进入检索"
        )),
    })
}

// ═══════════════════════════ docx ═══════════════════════════

fn extract_docx(path: &Path, sink: &mut dyn Sink) -> Result<Outcome, String> {
    let file = File::open(path).map_err(|e| format!("打开 docx 失败: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("docx 不是有效 zip: {e}"))?;
    let mut entry = open_guarded(&mut zip, "word/document.xml")?;
    let mut scanner = XmlScanner::new(std::io::BufReader::new(entry.by_ref()), 512 * 1024);

    let mut heading_stack: Vec<String> = Vec::new();
    let mut para = String::new();
    let mut style: Option<String> = None;
    let mut in_text = false;
    let mut in_table = false;
    let mut para_count: i64 = 0;
    let mut row = String::new();

    while let Some(token) = scanner.next_token().map_err(|e| format!("docx XML 解析失败: {e}"))? {
        match token {
            XmlToken::Start(tag) => {
                let name = tag_name(&tag);
                match name {
                    "w:tbl" => in_table = true,
                    "w:tr" => row.clear(),
                    "w:p" => {
                        para.clear();
                        style = None;
                        para_count += 1;
                        if para_count % 200 == 0 {
                            sink.progress(0, 0);
                            if sink.is_cancelled() {
                                return Err("已取消".to_string());
                            }
                        }
                    }
                    "w:pStyle" => style = attr_value(&tag, "w:val"),
                    "w:t" | "w:instrText" => in_text = true,
                    "w:drawing" | "w:pict" => {
                        if !in_table {
                            row.clear();
                        }
                    }
                    _ => {}
                }
            }
            XmlToken::End(tag) => {
                let name = tag_name_end(&tag);
                match name {
                    "w:t" | "w:instrText" => in_text = false,
                    "w:p" => {
                        let text = clean_ws(&para);
                        if in_table {
                            if !text.is_empty() {
                                row.push_str(&text);
                                row.push_str(" | ");
                            }
                        } else if !text.is_empty() {
                            emit_paragraph(sink, &mut heading_stack, &text, style.as_deref())?;
                        }
                    }
                    "w:tr" => {
                        let text = clean_ws(&row);
                        if !text.is_empty() {
                            sink.begin_block(0, "table_row", heading_of(&heading_stack));
                            sink.push_text(&text);
                            sink.push_text("\n");
                            sink.end_block();
                        }
                        row.clear();
                    }
                    "w:tbl" => in_table = false,
                    _ => {}
                }
            }
            XmlToken::Text(t) => {
                if in_text {
                    push_limited(&mut para, &t);
                }
            }
        }
    }

    sink.page(0, "text", "layout", 0);
    Ok(Outcome::ready(1))
}

fn emit_paragraph(
    sink: &mut dyn Sink,
    heading_stack: &mut Vec<String>,
    text: &str,
    style: Option<&str>,
) -> Result<(), String> {
    if let Some(level) = heading_level(style) {
        let title: String = text.chars().take(120).collect();
        heading_stack.truncate(level.saturating_sub(1));
        heading_stack.push(title.clone());
        sink.begin_block(0, "heading", Some(heading_stack.join(" > ")));
        sink.push_text(&title);
        sink.push_text("\n\n");
        sink.end_block();
    } else {
        sink.begin_block(0, "paragraph", heading_of(heading_stack));
        sink.push_text(text);
        sink.push_text("\n\n");
        sink.end_block();
    }
    Ok(())
}

fn heading_of(stack: &[String]) -> Option<String> {
    if stack.is_empty() {
        None
    } else {
        Some(stack.join(" > "))
    }
}

/// 从 `w:pStyle w:val="Heading2"` / `"2"` / `"标题 2"` 里取层级。
fn heading_level(style: Option<&str>) -> Option<usize> {
    let s = style?;
    let lower = s.to_lowercase();
    if !(lower.contains("heading") || lower.contains("标题") || lower.contains("title")) {
        // 纯数字样式（部分 Word 模板用 "1"/"2"）
        let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        return digits.parse::<usize>().ok().filter(|n| (1..=6).contains(n));
    }
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    let level = digits.parse::<usize>().unwrap_or(1);
    Some(level.clamp(1, 6))
}

// ═══════════════════════════ xlsx ═══════════════════════════

fn extract_xlsx(path: &Path, sink: &mut dyn Sink) -> Result<Outcome, String> {
    let file = File::open(path).map_err(|e| format!("打开 xlsx 失败: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("xlsx 不是有效 zip: {e}"))?;

    // 1) 共享字符串表（上限 2,000,000 条；超了只保留前 N 条并继续，宁可少索引也不 OOM）
    let mut shared: Vec<String> = Vec::new();
    if let Ok(mut entry) = open_guarded(&mut zip, "xl/sharedStrings.xml") {
        let mut scanner = XmlScanner::new(std::io::BufReader::new(entry.by_ref()), 512 * 1024);
        let mut cur = String::new();
        let mut in_si = false;
        let mut in_t = false;
        while let Some(token) = scanner.next_token().map_err(|e| e.to_string())? {
            match token {
                XmlToken::Start(tag) => match tag_name(&tag) {
                    "si" => {
                        in_si = true;
                        cur.clear();
                    }
                    "t" => in_t = true,
                    _ => {}
                },
                XmlToken::End(tag) => match tag_name_end(&tag) {
                    "t" => in_t = false,
                    "si" => {
                        in_si = false;
                        if shared.len() < 2_000_000 {
                            shared.push(std::mem::take(&mut cur));
                        }
                    }
                    _ => {}
                },
                XmlToken::Text(t) => {
                    if in_si && in_t {
                        push_limited(&mut cur, &t);
                    }
                }
            }
        }
    }

    // 2) workbook 里的 sheet 名（按出现顺序）
    let mut sheet_names: Vec<String> = Vec::new();
    if let Ok(mut entry) = open_guarded(&mut zip, "xl/workbook.xml") {
        let mut scanner = XmlScanner::new(std::io::BufReader::new(entry.by_ref()), 256 * 1024);
        while let Some(token) = scanner.next_token().map_err(|e| e.to_string())? {
            if let XmlToken::Start(tag) = token {
                if tag_name(&tag) == "sheet" {
                    if let Some(name) = attr_value(&tag, "name") {
                        sheet_names.push(name);
                    }
                }
            }
        }
    }

    // 3) 逐个 sheet 文件（按文件名里的数字排序）
    let mut sheets: Vec<(i64, String)> = zip
        .file_names()
        .filter_map(|n| {
            let rest = n.strip_prefix("xl/worksheets/sheet")?;
            let num = rest.strip_suffix(".xml")?;
            num.parse::<i64>().ok().map(|i| (i, n.to_string()))
        })
        .collect();
    sheets.sort_by_key(|(i, _)| *i);

    let mut page_no = 0i64;
    for (idx, (_, name)) in sheets.iter().enumerate() {
        page_no = idx as i64 + 1;
        let heading = sheet_names
            .get(idx)
            .cloned()
            .unwrap_or_else(|| format!("Sheet {page_no}"));
        let mut entry = match open_guarded(&mut zip, name) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut scanner = XmlScanner::new(std::io::BufReader::new(entry.by_ref()), 512 * 1024);
        let mut row = String::new();
        let mut cell = String::new();
        let mut cell_type: Option<String> = None;
        let mut in_v = false;
        let mut in_t = false;
        let mut rows = 0i64;
        let mut bytes = 0i64;

        while let Some(token) = scanner.next_token().map_err(|e| e.to_string())? {
            match token {
                XmlToken::Start(tag) => match tag_name(&tag) {
                    "c" => {
                        cell.clear();
                        cell_type = attr_value(&tag, "t");
                    }
                    "v" => in_v = true,
                    "t" => in_t = true,
                    _ => {}
                },
                XmlToken::End(tag) => match tag_name_end(&tag) {
                    "v" => in_v = false,
                    "t" => in_t = false,
                    "c" => {
                        let text = if cell_type.as_deref() == Some("s") {
                            cell.trim()
                                .parse::<usize>()
                                .ok()
                                .and_then(|i| shared.get(i).cloned())
                                .unwrap_or_default()
                        } else {
                            std::mem::take(&mut cell)
                        };
                        let text = clean_ws(&text);
                        if !text.is_empty() {
                            row.push_str(&text);
                            row.push_str(" | ");
                            bytes += text.len() as i64;
                        }
                        cell_type = None;
                    }
                    "row" => {
                        let text = row.trim_end_matches(" | ").to_string();
                        row.clear();
                        if !text.is_empty() {
                            sink.begin_block(page_no, "table_row", Some(heading.clone()));
                            sink.push_text(&text);
                            sink.push_text("\n");
                            sink.end_block();
                            rows += 1;
                            if rows % 500 == 0 {
                                sink.progress(0, page_no);
                                if sink.is_cancelled() {
                                    return Err("已取消".to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                },
                XmlToken::Text(t) => {
                    if in_v || in_t {
                        push_limited(&mut cell, &t);
                    }
                }
            }
        }
        sink.page(page_no, "text", "layout", bytes);
    }

    if page_no == 0 {
        return Err("xlsx 里没有可读的工作表".to_string());
    }
    Ok(Outcome::ready(page_no))
}

// ═══════════════════════════ pptx ═══════════════════════════

fn extract_pptx(path: &Path, sink: &mut dyn Sink) -> Result<Outcome, String> {
    let file = File::open(path).map_err(|e| format!("打开 pptx 失败: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("pptx 不是有效 zip: {e}"))?;

    let mut slides: Vec<(i64, String)> = zip
        .file_names()
        .filter_map(|n| {
            let rest = n.strip_prefix("ppt/slides/slide")?;
            let num = rest.strip_suffix(".xml")?;
            num.parse::<i64>().ok().map(|i| (i, n.to_string()))
        })
        .collect();
    slides.sort_by_key(|(i, _)| *i);
    if slides.is_empty() {
        return Err("pptx 里没有幻灯片".to_string());
    }

    for (idx, (_, name)) in slides.iter().enumerate() {
        let page_no = idx as i64 + 1;
        let mut entry = match open_guarded(&mut zip, name) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut scanner = XmlScanner::new(std::io::BufReader::new(entry.by_ref()), 256 * 1024);
        let mut para = String::new();
        let mut in_t = false;
        let mut bytes = 0i64;
        while let Some(token) = scanner.next_token().map_err(|e| e.to_string())? {
            match token {
                XmlToken::Start(tag) => match tag_name(&tag) {
                    "a:p" => para.clear(),
                    "a:t" => in_t = true,
                    _ => {}
                },
                XmlToken::End(tag) => match tag_name_end(&tag) {
                    "a:t" => in_t = false,
                    "a:p" => {
                        let text = clean_ws(&para);
                        if !text.is_empty() {
                            bytes += text.len() as i64;
                            sink.begin_block(page_no, "paragraph", Some(format!("slide {page_no}")));
                            sink.push_text(&text);
                            sink.push_text("\n\n");
                            sink.end_block();
                        }
                    }
                    _ => {}
                },
                XmlToken::Text(t) => {
                    if in_t {
                        push_limited(&mut para, &t);
                    }
                }
            }
        }
        sink.page(page_no, "text", "layout", bytes);
        sink.progress(0, page_no);
        if sink.is_cancelled() {
            return Err("已取消".to_string());
        }
    }
    Ok(Outcome::ready(slides.len() as i64))
}

// ═══════════════════════════ zip 辅助 ═══════════════════════════

fn open_guarded<'a>(
    zip: &'a mut zip::ZipArchive<File>,
    name: &str,
) -> Result<zip::read::ZipFile<'a>, String> {
    let entry = zip
        .by_name(name)
        .map_err(|e| format!("zip 里没有 {name}: {e}"))?;
    let size = entry.size();
    let compressed = entry.compressed_size();
    if size > MAX_ENTRY_BYTES {
        return Err(format!(
            "zip 条目 {name} 解压后 {size} 字节，超过 {MAX_ENTRY_BYTES} 上限"
        ));
    }
    if size > MAX_RATIO_MIN_BYTES
        && compressed > 0
        && size / compressed.max(1) > MAX_COMPRESSION_RATIO
    {
        return Err(format!(
            "zip 条目 {name} 压缩比异常（{size}/{compressed}），按解压炸弹拒绝"
        ));
    }
    Ok(entry)
}

// ═══════════════════════════ XML 扫描器 ═══════════════════════════

#[derive(Debug, PartialEq, Eq)]
enum XmlToken {
    Start(String),
    End(String),
    Text(String),
}

/// 极简流式 XML 扫描器：只区分「开始标签 / 结束标签 / 文本」，不做完整 DOM。
///
/// 对 Office 的 OOXML 足够（我们只需要段落/单元格/文本边界），且内存恒定。
struct XmlScanner<R: BufRead> {
    reader: R,
    buf: Vec<u8>,
    pos: usize,
    eof: bool,
    chunk: usize,
}

impl<R: BufRead> XmlScanner<R> {
    fn new(reader: R, chunk: usize) -> Self {
        Self {
            reader,
            buf: Vec::with_capacity(chunk),
            pos: 0,
            eof: false,
            chunk,
        }
    }

    fn fill(&mut self) -> std::io::Result<bool> {
        if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        let mut tmp = vec![0u8; self.chunk];
        let n = self.reader.read(&mut tmp)?;
        if n == 0 {
            self.eof = true;
            return Ok(false);
        }
        self.buf.extend_from_slice(&tmp[..n]);
        Ok(true)
    }

    fn next_token(&mut self) -> std::io::Result<Option<XmlToken>> {
        loop {
            if self.pos >= self.buf.len() {
                if !self.fill()? && self.eof {
                    return Ok(None);
                }
                continue;
            }
            let lt = {
                let rest = &self.buf[self.pos..];
                rest.iter().position(|b| *b == b'<')
            };
            let Some(lt) = lt else {
                /*
                 * 纯文本段：**绝不能把多字节 UTF-8 字符切成两半**。
                 *
                 * 缓冲边界会落在任意字节上；直接 `from_utf8_lossy` 整段会把一个字拆成
                 * `�` + 半个字（判据 `xml_scanner_splits_tags_and_text` 抓到过：
                 * `T:�` / `T:�题`）。这里只消费「最后一个完整字符」之前的部分，
                 * 剩下的 1–3 个字节留到下一轮与后续输入拼起来。
                 */
                let safe = {
                    let rest = &self.buf[self.pos..];
                    if self.eof {
                        rest.len()
                    } else {
                        utf8_complete_prefix(rest)
                    }
                };
                if safe == 0 {
                    if self.fill()? {
                        continue;
                    }
                    // 到 EOF 仍不完整：按 lossy 收尾（不丢内容，只标替换符）
                    let text = String::from_utf8_lossy(&self.buf[self.pos..]).to_string();
                    self.pos = self.buf.len();
                    if !text.is_empty() {
                        return Ok(Some(XmlToken::Text(decode_entities(&text))));
                    }
                    return Ok(None);
                }
                let text = String::from_utf8_lossy(&self.buf[self.pos..self.pos + safe]).to_string();
                self.pos += safe;
                if !text.is_empty() {
                    return Ok(Some(XmlToken::Text(decode_entities(&text))));
                }
                continue;
            };
            if lt > 0 {
                let text = String::from_utf8_lossy(&self.buf[self.pos..self.pos + lt]).to_string();
                self.pos += lt;
                if !text.is_empty() {
                    return Ok(Some(XmlToken::Text(decode_entities(&text))));
                }
            }
            // 找到标签结束 '>'
            let gt = {
                let rest = &self.buf[self.pos..];
                rest.iter().position(|b| *b == b'>')
            };
            let Some(gt) = gt else {
                if self.fill()? {
                    continue;
                }
                // 未闭合标签：当作文本收尾，避免死循环
                let text = String::from_utf8_lossy(&self.buf[self.pos..]).to_string();
                self.pos = self.buf.len();
                return Ok(Some(XmlToken::Text(decode_entities(&text))));
            };
            let raw = String::from_utf8_lossy(&self.buf[self.pos..self.pos + gt + 1]).to_string();
            self.pos += gt + 1;
            if raw.starts_with("<!--") {
                // 注释：跳过直到 -->
                if let Some(end) = raw.find("-->") {
                    let _ = end;
                    continue;
                }
                // 跨块注释：持续丢弃直到找到 -->
                loop {
                    if self.pos >= self.buf.len() && !self.fill()? && self.eof {
                        return Ok(None);
                    }
                    let hay = String::from_utf8_lossy(&self.buf[self.pos..]).to_string();
                    if let Some(i) = hay.find("-->") {
                        self.pos += i + 3;
                        break;
                    }
                    self.pos = self.buf.len();
                }
                continue;
            }
            if raw.starts_with("<![CDATA[") {
                let mut content = raw.trim_start_matches("<![CDATA[").to_string();
                loop {
                    if let Some(i) = content.find("]]>") {
                        content.truncate(i);
                        return Ok(Some(XmlToken::Text(content)));
                    }
                    if self.pos >= self.buf.len() && !self.fill()? && self.eof {
                        return Ok(Some(XmlToken::Text(content)));
                    }
                    content.push_str(&String::from_utf8_lossy(&self.buf[self.pos..]));
                    self.pos = self.buf.len();
                }
            }
            if raw.starts_with("<?") || raw.starts_with("<!") {
                continue;
            }
            if raw.starts_with("</") {
                return Ok(Some(XmlToken::End(raw)));
            }
            return Ok(Some(XmlToken::Start(raw)));
        }
    }
}

fn tag_name(raw: &str) -> &str {
    let s = raw.trim_start_matches('<');
    let end = s
        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .unwrap_or(s.len());
    &s[..end]
}

fn tag_name_end(raw: &str) -> &str {
    let s = raw.trim_start_matches("</");
    let end = s
        .find(|c: char| c.is_whitespace() || c == '>')
        .unwrap_or(s.len());
    &s[..end]
}

fn attr_value(tag: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn push_limited(buf: &mut String, text: &str) {
    if buf.chars().count() >= MAX_PIECE_CHARS {
        return;
    }
    buf.push_str(text);
}

/// `bytes` 里**最长完整 UTF-8 前缀**的字节长度（用于跨缓冲边界不切断多字节字符）。
///
/// 只回看最多 3 个字节（UTF-8 最长 4 字节）；如果落在完整的 ASCII/字符边界上，
/// 返回 `bytes.len()`。非法字节序列按「安全前缀」处理（宁可下一轮再判）。
fn utf8_complete_prefix(bytes: &[u8]) -> usize {
    let len = bytes.len();
    if len == 0 {
        return 0;
    }
    let mut back = 0usize;
    while back < 3 && back < len {
        let idx = len - 1 - back;
        let b = bytes[idx];
        if b & 0xC0 == 0x80 {
            // 续字节：继续往前找起始字节
            back += 1;
            continue;
        }
        let need = if b & 0x80 == 0 {
            1
        } else if b & 0xE0 == 0xC0 {
            2
        } else if b & 0xF0 == 0xE0 {
            3
        } else if b & 0xF8 == 0xF0 {
            4
        } else {
            // 非法起始字节：保守地认为这一段不可用
            return idx;
        };
        let available = len - idx;
        if available < need {
            return idx;
        }
        return len;
    }
    len
}

fn clean_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim().to_string()
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(semi) = s[i..].find(';').map(|p| i + p) {
                let entity = &s[i + 1..semi];
                let decoded = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ => {
                        if let Some(hex) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
                            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                        } else if let Some(dec) = entity.strip_prefix('#') {
                            dec.parse::<u32>().ok().and_then(char::from_u32)
                        } else {
                            None
                        }
                    }
                };
                if let Some(ch) = decoded {
                    out.push(ch);
                    i = semi + 1;
                    continue;
                }
            }
        }
        // 逐字符推进（保证 UTF-8 边界安全）
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Collect {
        blocks: Vec<(i64, String, Option<String>, String)>,
        pages: Vec<(i64, String)>,
    }
    impl Sink for Collect {
        fn begin_block(&mut self, page: i64, kind: &str, heading: Option<String>) {
            self.blocks.push((page, kind.to_string(), heading, String::new()));
        }
        fn push_text(&mut self, text: &str) {
            if let Some(last) = self.blocks.last_mut() {
                last.3.push_str(text);
            }
        }
        fn end_block(&mut self) {}
        fn page(&mut self, page: i64, kind: &str, _src: &str, _bytes: i64) {
            self.pages.push((page, kind.to_string()));
        }
        fn progress(&mut self, _b: u64, _p: i64) {}
        fn is_cancelled(&self) -> bool {
            false
        }
    }

    #[test]
    fn xml_scanner_splits_tags_and_text() {
        let xml = "<w:p><w:pStyle w:val=\"Heading1\"/><w:t>标题</w:t></w:p>";
        let mut s = XmlScanner::new(xml.as_bytes(), 8);
        let mut kinds = Vec::new();
        while let Some(t) = s.next_token().unwrap() {
            kinds.push(match t {
                XmlToken::Start(x) => format!("S:{}", tag_name(&x)),
                XmlToken::End(x) => format!("E:{}", tag_name_end(&x)),
                XmlToken::Text(x) => format!("T:{x}"),
            });
        }
        assert_eq!(
            kinds,
            vec!["S:w:p", "S:w:pStyle", "S:w:t", "T:标题", "E:w:t", "E:w:p"]
        );
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(decode_entities("a &amp; b &#x4E2D;"), "a & b 中");
    }

    #[test]
    fn heading_levels_from_styles() {
        assert_eq!(heading_level(Some("Heading1")), Some(1));
        assert_eq!(heading_level(Some("2")), Some(2));
        assert_eq!(heading_level(Some("标题 3")), Some(3));
        assert_eq!(heading_level(Some("Normal")), None);
        assert_eq!(heading_level(None), None);
    }

    #[test]
    fn docx_extraction_reads_headings_paragraphs_and_tables() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.docx");
        {
            let file = std::fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("word/document.xml", options).unwrap();
            zip.write_all(
                r#"<?xml version="1.0"?><w:document><w:body>
                <w:p><w:pStyle w:val="Heading1"/><w:r><w:t>第一章 总则</w:t></w:r></w:p>
                <w:p><w:r><w:t>正文段落，说明迁移目标。</w:t></w:r></w:p>
                <w:tbl><w:tr><w:tc><w:p><w:r><w:t>列一</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>列二</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
                </w:body></w:document>"#
                    .as_bytes(),
            )
            .unwrap();
            zip.finish().unwrap();
        }

        let mut sink = Collect::default();
        let out = extract_docx(&path, &mut sink).unwrap();
        assert_eq!(out.status, "ready");
        assert!(
            sink.blocks.iter().any(|b| b.1 == "heading" && b.3.contains("第一章")),
            "应识别标题块：{:?}",
            sink.blocks
        );
        assert!(
            sink.blocks.iter().any(|b| b.3.contains("正文段落")),
            "应读到正文"
        );
        assert!(
            sink.blocks.iter().any(|b| b.1 == "table_row" && b.3.contains("列一")),
            "表格行应作为独立块：{:?}",
            sink.blocks
        );
        assert!(!sink.pages.is_empty(), "应记录页");
    }

    #[test]
    fn broken_docx_is_an_error_not_ready() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.docx");
        std::fs::write(&path, b"not a zip at all").unwrap();
        let mut sink = Collect::default();
        let err = extract_docx(&path, &mut sink).unwrap_err();
        assert!(err.contains("zip") || err.contains("docx"), "错误应说清原因：{err}");
    }

    #[test]
    fn text_extraction_marks_markdown_headings() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        std::fs::write(&p, "# 第一章\n\n正文内容。\n\n## 1.1 小节\n\n更多内容。\n").unwrap();
        let mut sink = Collect::default();
        let out = extract_text(&p, &mut sink, "md").unwrap();
        assert_eq!(out.status, "ready");
        assert!(sink.blocks.iter().any(|b| b.1 == "heading" && b.3.contains("第一章")));
        assert!(sink.blocks.iter().any(|b| b.3.contains("正文内容")));
        assert!(sink.blocks.iter().any(|b| b.2.as_deref() == Some("第一章 > 1.1 小节")));
    }

    impl Default for Collect {
        fn default() -> Self {
            Self {
                blocks: Vec::new(),
                pages: Vec::new(),
            }
        }
    }
}
