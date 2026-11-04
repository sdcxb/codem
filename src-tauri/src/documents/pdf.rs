//! PDF 提取（PDFium，动态加载）。
//!
//! ## 为什么是 PDFium（ADR-0008 §8）
//!
//! 它一次覆盖四件事：逐页文本（Chrome 同源的字符提取）、页面尺寸/坐标、
//! 书签（P1）、页面渲染（P1 视觉转录用）。替代方案里 MuPDF/Poppler 是 AGPL/GPL
//! （分发不可接受），纯 Rust 的 CMap/子集字体支持不足以处理中文 PDF，
//! PDF→DOCX 往返（LibreOffice Draw 模型）不可回归。
//!
//! ## 缺库时的诚实降级
//!
//! `pdfium.dll` 随包分发，加载失败时**不**返回空文本、**不**标 `ready`，
//! 而是 `needs_engine`（UI 明说「PDF 引擎未就绪」）。
//!
//! ## P0 的边界
//!
//! - 只做文本页与分类；图片页 → `needs_ocr`（视觉转录在 P1）；
//! - 标题先用**文本启发式**（`第X章` / `Chapter N` / `1.2 标题` 这类行首模式）；
//!   书签树与字号推断放在 P1（PDFium 已具备能力，缺的是结构化阈值与判据）。

use std::collections::HashMap;
use std::path::Path;

use super::chunk::Sink;
use super::extract::Outcome;

/// 进程级 PDFium 句柄（**只绑定一次**）。
///
/// 为什么必须缓存：`pdfium-render` 的动态绑定在进程内是**一次性**的 —— 第二次
/// `bind_to_library` 会失败。而真实调用顺序恰恰是「先探测（`documents_pdf_probe` /
/// `engine_available`）→ 再提取」，于是**每次**提取都会拿到绑定错误、被降级成
/// `needs_engine`（真机判据 `extracts_text_from_real_pdf_with_pdfium` 抓到过）。
///
/// 另一个理由：PDFium 不是线程安全的。这里用一把互斥锁把「一次 PDF 提取」串起来，
/// 宁可并行度低一点，也不冒数据竞争/崩溃的险。
static PDFIUM: std::sync::OnceLock<std::sync::Mutex<pdfium_render::prelude::Pdfium>> =
    std::sync::OnceLock::new();
static PDFIUM_INIT: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 取进程级 PDFium（首次调用时绑定；失败**不缓存**，装好动态库后可恢复）。
fn pdfium_guard() -> Result<std::sync::MutexGuard<'static, pdfium_render::prelude::Pdfium>, String> {
    if PDFIUM.get().is_none() {
        let _init = PDFIUM_INIT
            .lock()
            .map_err(|_| "PDFium 初始化锁中毒".to_string())?;
        if PDFIUM.get().is_none() {
            let pdfium = bind_pdfium()?;
            let _ = PDFIUM.set(std::sync::Mutex::new(pdfium));
        }
    }
    PDFIUM
        .get()
        .ok_or_else(|| "PDFium 未初始化".to_string())?
        .lock()
        .map_err(|_| "PDFium 句柄锁中毒".to_string())
}

/// 引擎是否可用（用于 UI/状态：`needs_engine`）。
pub fn engine_available() -> bool {
    pdfium_guard().is_ok()
}

fn bind_pdfium() -> Result<pdfium_render::prelude::Pdfium, String> {
    use pdfium_render::prelude::Pdfium;
    // 1) 随包资源目录（Tauri resource_dir/pdfium/<platform>/）
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("CODEM_PDFIUM_DIR") {
        candidates.push(std::path::PathBuf::from(dir));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
            candidates.push(dir.join("pdfium"));
            candidates.push(dir.join("resources").join("pdfium"));
        }
    }
    for dir in candidates {
        if let Ok(bindings) = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir))
        {
            return Ok(Pdfium::new(bindings));
        }
    }
    // 2) 系统库（开发机 / 已装 PDFium 的环境）
    match Pdfium::bind_to_system_library() {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(e) => Err(format!(
            "PDFium 动态库不可用（已查找资源目录与系统库）：{e}"
        )),
    }
}

/// 每页「有文本」的最低字符数（低于它算扫描/图片页）。
const PAGE_TEXT_MIN_CHARS: usize = 40;
/// 页文本字符数低于它且高于 0 → 混合页（有少量文字 + 图片）。
const PAGE_TEXT_MIXED_CHARS: usize = 400;

/// 按可提取字符数给页面分类（P0 的判据：分类只依赖文本密度，不猜版面）。
///
/// - `scanned`：一个可提取字符都没有 ⇒ 图片/扫描页，P0 标 `needs_ocr`；
/// - `mixed`：文本很少（<40 字符）⇒ 有图有少量字，转录时也要看图；
/// - `text`：正常文本页。
pub fn classify_page(chars: usize) -> &'static str {
    if chars == 0 {
        "scanned"
    } else if chars < PAGE_TEXT_MIN_CHARS {
        "mixed"
    } else {
        "text"
    }
}

/// 渲染一页为 PNG（视觉转录用）。返回 PNG 字节与像素尺寸。
pub struct RenderedPage {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// 把 PDF 第 `page_no` 页（**1 起**）渲染成 PNG。
///
/// `max_width` 会被夹到 320–2400：视觉模型对过大图片会自己缩放，先由我们控制体积，
/// 避免一页 4K 图把 IPC 与 token 成本顶满。
pub fn render_page_png(path: &Path, page_no: i64, max_width: u32) -> Result<RenderedPage, String> {
    use pdfium_render::prelude::PdfRenderConfig;
    let pdfium = pdfium_guard()?;
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("PDF 打开失败（可能加密或损坏）：{e}"))?;
    let pages = doc.pages();
    let total = pages.len() as i64;
    if page_no < 1 || page_no > total {
        return Err(format!("页号越界：{page_no}（共 {total} 页）"));
    }
    let page = pages
        .get((page_no - 1) as i32)
        .map_err(|e| format!("取第 {page_no} 页失败：{e}"))?;
    let target_width = max_width.clamp(320, 2400) as i32;
    let config = PdfRenderConfig::new().set_target_width(target_width);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("渲染第 {page_no} 页失败：{e}"))?;
    let (width, height) = (bitmap.width(), bitmap.height());
    let rgba = bitmap.as_rgba_bytes();

    let mut png: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG 头写入失败：{e}"))?;
        writer
            .write_image_data(&rgba)
            .map_err(|e| format!("PNG 写入失败：{e}"))?;
    }
    Ok(RenderedPage {
        png,
        width: width as u32,
        height: height as u32,
    })
}

/// 按字号推断标题层级（书签/文本模式都不命中时的兜底）。
///
/// 刻意保守：只认「行短、字号显著大于正文、不是句子结尾」的整行；
/// 命错标题比漏标题更糟（citation 会漂）。正文基准取本页行字号中位数。
pub fn font_heading_level(line: &str, font_size: Option<f32>, body_size: f32) -> Option<usize> {
    let text = line.trim();
    let chars = text.chars().count();
    if body_size <= 0.0 || chars < 2 || chars > 80 {
        return None;
    }
    if text.ends_with(['。', '！', '？', '；', '.', '!', '?', ';', '，', ',']) {
        return None;
    }
    let size = font_size?;
    if !size.is_finite() || size <= 0.0 {
        return None;
    }
    let ratio = size / body_size;
    if ratio >= 1.8 {
        Some(1)
    } else if ratio >= 1.45 {
        Some(2)
    } else if ratio >= 1.25 {
        Some(3)
    } else {
        None
    }
}

/// 一页的「行 → 该行最大字号」与正文基准字号（行字号中位数）。
fn page_font_stats(
    page: &pdfium_render::prelude::PdfPage,
) -> (HashMap<String, f32>, f32) {
    fn push_line(buf: &mut String, max: &mut f32, sizes: &mut HashMap<String, f32>) {
        let key = buf.trim().to_string();
        if key.chars().count() >= 2 {
            sizes
                .entry(key)
                .and_modify(|v| *v = v.max(*max))
                .or_insert(*max);
        }
        buf.clear();
        *max = 0.0;
    }

    let mut sizes: HashMap<String, f32> = HashMap::new();
    let Ok(text) = page.text() else {
        return (sizes, 0.0);
    };
    let mut buf = String::new();
    let mut max = 0.0f32;
    for ch in text.chars().iter() {
        let Some(c) = ch.unicode_char() else {
            continue;
        };
        if c == '\n' || c == '\r' {
            push_line(&mut buf, &mut max, &mut sizes);
        } else {
            buf.push(c);
            let s = ch.scaled_font_size().value;
            if s.is_finite() && s > max {
                max = s;
            }
        }
    }
    push_line(&mut buf, &mut max, &mut sizes);

    let mut values: Vec<f32> = sizes.values().copied().filter(|v| *v > 0.0).collect();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let body = values.get(values.len() / 2).copied().unwrap_or(0.0);
    (sizes, body)
}

pub fn extract_pdf(path: &Path, sink: &mut dyn Sink, start_page: i64) -> Result<Outcome, String> {
    let pdfium = match pdfium_guard() {
        Ok(p) => p,
        Err(e) => {
            return Ok(Outcome {
                page_count: 0,
                status: "needs_engine",
                error: Some(e),
            })
        }
    };
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("PDF 打开失败（可能加密或损坏）：{e}"))?;
    let pages = doc.pages();
    let total = pages.len() as i64;
    if total == 0 {
        return Err("PDF 没有页面".to_string());
    }

    let mut scanned = 0i64;
    let mut text_pages = 0i64;
    let mut heading_stack: Vec<String> = Vec::new();
    let mut current_heading_level: usize = 0;

    /**
     * 书签（PDF outline）= 作者亲手写的目录，比文本启发式可靠得多。
     * 先整份收集成 owned 列表，再在每页开头把它转成标题块；没有书签的 PDF 行为不变。
     */
    struct TocEntry {
        page: i64,
        title: String,
        level: usize,
    }
    let mut toc_entries: Vec<TocEntry> = Vec::new();
    for bookmark in doc.bookmarks().iter() {
        let Some(title) = bookmark.title().map(|t| t.trim().to_string()) else {
            continue;
        };
        if title.is_empty() || title.chars().count() > 200 {
            continue;
        }
        let Some(page) = bookmark
            .destination()
            .and_then(|d| d.page_index().ok())
            .map(|i| i as i64 + 1)
        else {
            continue;
        };
        let mut level = 1usize;
        let mut parent = bookmark.parent();
        while let Some(p) = parent {
            level += 1;
            if level >= 6 {
                break;
            }
            parent = p.parent();
        }
        toc_entries.push(TocEntry { page, title, level });
    }

    let mut toc_idx = 0usize;
    let mut toc_stack: Vec<(usize, String)> = Vec::new();

    for (idx, page) in pages.iter().enumerate() {
        let page_no = idx as i64 + 1;

        // 书签：即使本页因续跑被跳过，也要维护标题栈（后续页继承正确路径）。
        while toc_idx < toc_entries.len() && toc_entries[toc_idx].page <= page_no {
            let entry = &toc_entries[toc_idx];
            if entry.page == page_no {
                toc_stack.retain(|(level, _)| *level < entry.level);
                toc_stack.push((entry.level, entry.title.clone()));
                if entry.page >= start_page {
                    let path = toc_stack
                        .iter()
                        .map(|(_, t)| t.as_str())
                        .collect::<Vec<_>>()
                        .join(" > ");
                    sink.begin_block(page_no, "heading", Some(path));
                    sink.push_text(&entry.title);
                    sink.push_text("\n\n");
                    sink.end_block();
                }
            }
            toc_idx += 1;
        }
        if !toc_stack.is_empty() {
            heading_stack = toc_stack.iter().map(|(_, t)| t.clone()).collect();
            current_heading_level = toc_stack.last().map(|(l, _)| *l).unwrap_or(0);
        }

        // 续跑：已完成页不再解析（页行/块/分块已在库里；书签栈上面已维护）
        if page_no <= start_page {
            continue;
        }

        let text = page.text().map(|t| t.all()).unwrap_or_default();
        let chars = text.chars().count();
        let kind = classify_page(chars);
        if kind == "scanned" {
            scanned += 1;
        }
        /*
         * 字号标题：有书签时完全以书签为准（避免两套标题打架）；
         * 否则用本页行字号相对正文基准推断，补足「没有 outline、但标题字号明显更大」的 PDF。
         */
        let has_toc = !toc_entries.is_empty();
        let (line_font_sizes, body_font_size) = if has_toc || kind == "scanned" {
            (HashMap::new(), 0.0)
        } else {
            page_font_stats(&page)
        };
        let mut bytes = 0i64;

        for raw_line in text.split('\n') {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            let level = heading_level_of_line(line).or_else(|| {
                font_heading_level(
                    line,
                    line_font_sizes.get(line).copied(),
                    body_font_size,
                )
            });
            if let Some(level) = level {
                let title: String = line.chars().take(120).collect();
                heading_stack.truncate(level.saturating_sub(1));
                heading_stack.push(title.clone());
                current_heading_level = level;
                sink.begin_block(page_no, "heading", Some(heading_stack.join(" > ")));
                sink.push_text(&title);
                sink.push_text("\n\n");
                sink.end_block();
                bytes += title.len() as i64;
                continue;
            }
            let heading = if heading_stack.is_empty() {
                None
            } else {
                Some(heading_stack.join(" > "))
            };
            sink.begin_block(page_no, "paragraph", heading);
            sink.push_text(line);
            sink.push_text("\n");
            sink.end_block();
            bytes += line.len() as i64;
        }
        sink.page(page_no, kind, "layout", bytes);
        sink.progress(0, page_no);
        if sink.is_cancelled() {
            return Err("已取消".to_string());
        }
        if text_pages == 0 && chars > PAGE_TEXT_MIXED_CHARS {
            text_pages = 1;
        }
        let _ = current_heading_level;
    }

    let status = if scanned == total {
        "needs_ocr"
    } else {
        "ready"
    };
    let error = if scanned > 0 {
        Some(format!(
            "{scanned}/{total} 页没有可提取文本（扫描/图片页），P0 标记 needs_ocr，视觉转录在 P1"
        ))
    } else {
        None
    };
    Ok(Outcome {
        page_count: total,
        status,
        error,
    })
}

/// 从一行文本猜标题层级（`第一章` / `Chapter 3` / `1.2 迁移` / `第三节`）。
///
/// 刻意保守：**只认行首模式且行长有限**。命错标题比漏标题更糟（citation 会漂）。
pub fn heading_level_of_line(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let chars = trimmed.chars().count();
    if chars == 0 || chars > 80 {
        return None;
    }
    let bytes = trimmed.as_bytes();

    // 第一章 / 第1章 / 第 3 节
    // 第一章 / 第1章 / 第 3 节（允许「第」与数字之间有空格）
    if let Some(after) = trimmed.strip_prefix('第') {
        let (digits, consumed) = take_number_prefix(after)?;
        if digits == 0 {
            return None;
        }
        let rest = &after[consumed..];
        if rest.starts_with('章') || rest.starts_with('篇') || rest.starts_with("部分") {
            return Some(1);
        }
        if rest.starts_with('节') {
            return Some(2);
        }
        return None;
    }

    // Chapter 3 / CHAPTER IV
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("chapter") {
        if rest.starts_with(' ') || rest.starts_with('\t') {
            return Some(1);
        }
    }

    // 1.2 迁移 / 1.2.3 细节（点号数字编号，且点后不是数字的纯序号）
    if bytes.first().map(|b| b.is_ascii_digit()).unwrap_or(false) {
        let mut dots = 0;
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'.' => {
                    dots += 1;
                    i += 1;
                }
                b if b.is_ascii_digit() => i += 1,
                b' ' | b'\t' => break,
                _ => return None,
            }
        }
        // 只有 "1.2 " 这种形态才算；纯 "2023 年" 不算
        if dots >= 1 && i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
            /*
             * 句子守卫：编号后面若是**句子**（带句读、写得很长），它不是标题。
             * 没有这条，"1. 这是一个很长的正文句子，因为它带逗号与句号。" 会被当成标题，
             * citation 的 heading 就会挂上一整句话。
             *
             * 只看编号**之后**的文本：编号里的 `.` 不能当成句号。
             */
            let tail = &trimmed[i..];
            let has_sentence_punct = tail
                .chars()
                .any(|c| matches!(c, '。' | '！' | '？' | '；' | '，' | '!' | '?' | ';' | ','));
            if !has_sentence_punct && tail.chars().count() <= 60 && dots <= 5 {
                return Some(dots.min(4));
            }
        }
    }
    None
}

/// 读「第」后面的编号：返回（数字个数, 已消费字节数）。
///
/// 允许前后空格（`第 3 节`），但**必须在数字后面停下** —— `consumed` 是
/// 「数字 + 数字两侧空白」的长度，用来定位 `章/节/篇/部分` 这几个后缀字。
fn take_number_prefix(s: &str) -> Option<(usize, usize)> {
    let mut digits = 0usize;
    let mut consumed = 0usize;
    let mut seen_digit = false;
    for c in s.chars() {
        if c.is_ascii_digit() || is_cjk_numeral(c) {
            digits += 1;
            consumed += c.len_utf8();
            seen_digit = true;
        } else if c.is_whitespace() {
            consumed += c.len_utf8();
        } else {
            break;
        }
    }
    if seen_digit {
        Some((digits, consumed))
    } else {
        None
    }
}

/// 中文数字（只用于识别「第X章/节」这种编号，不做数值换算）。
fn is_cjk_numeral(c: char) -> bool {
    matches!(
        c,
        '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十' | '零' | '百' | '〇'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_classification_distinguishes_scanned_and_text() {
        assert_eq!(classify_page(0), "scanned");
        assert_eq!(classify_page(5), "mixed");
        assert_eq!(classify_page(40), "text");
        assert_eq!(classify_page(4000), "text");
    }

    #[test]
    fn heading_heuristics_are_conservative() {
        assert_eq!(heading_level_of_line("第一章 总则"), Some(1));
        assert_eq!(heading_level_of_line("第2章 现状"), Some(1));
        assert_eq!(heading_level_of_line("第 3 节 迁移"), Some(2));
        assert_eq!(heading_level_of_line("Chapter 3 Data"), Some(1));
        assert_eq!(heading_level_of_line("1.2 迁移步骤"), Some(1));
        assert_eq!(heading_level_of_line("1.2.3 细节"), Some(2));
        // 不误判
        assert_eq!(heading_level_of_line("2023 年报表"), None);
        assert_eq!(heading_level_of_line("1. 这是一个很长的正文句子，不是标题，因为它带逗号与句号。"), None);
        assert_eq!(heading_level_of_line("很长的文字".repeat(30).as_str()), None);
    }

    /// 收集器：只保留块文本与页分类，够断言用。
    #[derive(Default)]
    struct Collect {
        blocks: Vec<(i64, String, String)>,
        pages: Vec<(i64, String)>,
    }
    impl crate::documents::chunk::Sink for Collect {
        fn begin_block(&mut self, page: i64, kind: &str, _heading: Option<String>) {
            self.blocks.push((page, kind.to_string(), String::new()));
        }
        fn push_text(&mut self, text: &str) {
            if let Some(last) = self.blocks.last_mut() {
                last.2.push_str(text);
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

    /// 手写一个两页 PDF（第 1 页有可提取文本，第 2 页空白）——不依赖任何外部夹具生成器。
    fn tiny_pdf_two_pages() -> Vec<u8> {
        let content1 = "BT /F1 18 Tf 72 700 Td (Chapter 1 Migration Plan) Tj 0 -28 Td \
                        (This page describes the migration steps in detail.) Tj ET";
        let objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
              /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
                .to_vec(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", content1.len(), content1).into_bytes(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
              /Resources << >> /Contents 7 0 R >>"
                .to_vec(),
            b"<< /Length 0 >>\nstream\n\nendstream".to_vec(),
        ];
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
        let mut offsets = Vec::new();
        for (i, obj) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(obj);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref_pos = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for off in &offsets {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        out
    }

    /// **真机级验证**：真的加载 PDFium 动态库、真的解析 PDF、真的抽出文本。
    ///
    /// 默认 `#[ignore]`（CI 没有动态库）；发布/验收时先跑
    /// `node tools/vendor/fetch-pdfium.mjs`，再带环境变量跑本用例：
    /// `CODEM_PDFIUM_DIR=src-tauri/resources/pdfium/win32-x64 cargo test --lib extracts_text_from_real_pdf -- --ignored`
    #[test]
    #[ignore = "需要 PDFium 动态库：先 node tools/vendor/fetch-pdfium.mjs 并设置 CODEM_PDFIUM_DIR"]
    fn extracts_text_from_real_pdf_with_pdfium() {
        assert!(
            engine_available(),
            "PDFium 不可用：先跑 node tools/vendor/fetch-pdfium.mjs，并设置 CODEM_PDFIUM_DIR"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.pdf");
        std::fs::write(&path, tiny_pdf_two_pages()).unwrap();

        let mut sink = Collect::default();
        let out = extract_pdf(&path, &mut sink, 0).unwrap();
        assert_eq!(out.status, "ready", "有文本页的 PDF 必须 ready");
        assert_eq!(sink.pages.len(), 2, "必须报告 2 页");
        assert_eq!(sink.pages[0].1, "text");
        assert_eq!(sink.pages[1].1, "scanned", "空白页必须被标 scanned");
        let text: String = sink.blocks.iter().map(|b| b.2.clone()).collect();
        assert!(text.contains("Migration Plan"), "PDFium 抽出的文本：{text}");
        assert!(text.contains("migration steps"), "PDFium 抽出的文本：{text}");
        assert!(
            sink.blocks.iter().any(|b| b.1 == "heading" && b.2.contains("Chapter 1")),
            "Chapter 1 应识别为标题：{:?}",
            sink.blocks
        );
    }

    /// 字号标题必须保守：只认「短行 + 字号显著更大 + 不是句子结尾」。
    #[test]
    fn font_heading_level_is_conservative() {
        assert_eq!(font_heading_level("第一章 总则", Some(24.0), 10.0), Some(1));
        assert_eq!(font_heading_level("迁移范围", Some(16.0), 10.0), Some(2));
        assert_eq!(font_heading_level("实施步骤", Some(13.0), 10.0), Some(3));
        assert_eq!(
            font_heading_level("这是正文里稍微大一点的行", Some(11.5), 10.0),
            None,
            "字号比不足 1.25 不得当标题"
        );
        assert_eq!(
            font_heading_level("这一行看起来很大但其实是句子。", Some(24.0), 10.0),
            None,
            "句子结尾不得当标题"
        );
        assert_eq!(
            font_heading_level(&"很长的一行".repeat(20), Some(24.0), 10.0),
            None,
            "超长行不得当标题"
        );
        assert_eq!(font_heading_level("标题", None, 10.0), None);
        assert_eq!(font_heading_level("标题", Some(24.0), 0.0), None, "无正文基准不猜");
    }

    /// 续跑：从第 2 页开始，不再解析第 1 页（已完成页不重复进正文/块）。
    #[test]
    #[ignore = "需要 PDFium 动态库：先 node tools/vendor/fetch-pdfium.mjs 并设置 CODEM_PDFIUM_DIR"]
    fn resumes_pdf_from_page_two_without_reparsing_first() {
        assert!(engine_available(), "PDFium 不可用：先跑 fetch-pdfium.mjs");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.pdf");
        std::fs::write(&path, tiny_pdf_two_pages()).unwrap();

        let mut sink = Collect::default();
        let out = extract_pdf(&path, &mut sink, 1).unwrap();
        assert_eq!(out.page_count, 2, "总页数仍是 2");
        assert_eq!(sink.pages.len(), 1, "只应处理第 2 页");
        assert_eq!(sink.pages[0].0, 2);
        assert_eq!(sink.pages[0].1, "scanned");
        let text: String = sink.blocks.iter().map(|b| b.2.clone()).collect();
        assert!(
            !text.contains("Migration Plan"),
            "第 1 页不应被重新解析：{text}"
        );
    }

    /// 视觉转录用：真实 PDFium 渲染真 PDF 页 → PNG（签名/尺寸/越界）。
    #[test]
    #[ignore = "需要 PDFium 动态库：先 node tools/vendor/fetch-pdfium.mjs 并设置 CODEM_PDFIUM_DIR"]
    fn renders_page_to_png_with_pdfium() {
        assert!(engine_available(), "PDFium 不可用：先跑 fetch-pdfium.mjs");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.pdf");
        std::fs::write(&path, tiny_pdf_two_pages()).unwrap();

        let rendered = render_page_png(&path, 1, 400).expect("render page 1");
        assert!(
            rendered.png.starts_with(&[0x89, 0x50, 0x4e, 0x47]),
            "必须是 PNG 签名"
        );
        assert!(rendered.width > 0 && rendered.height > 0);
        assert!(rendered.width <= 400, "宽度应受 max_width 约束");

        assert!(
            render_page_png(&path, 3, 400).is_err(),
            "越界页号必须报错，不能返回空图"
        );
    }
}
