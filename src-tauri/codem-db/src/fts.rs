//! CJK 全文检索切分（第 92 波 P3 第 8 段）
//!
//! ## 为什么需要它（真机实测的事实）
//!
//! 生产库的 `session_fts` 用 `tokenize=unicode61`。实测：
//! - `MATCH 'ChatPanel'` → 17 行（英文没问题）
//! - `MATCH '存储'` / `'迁移'` / `'索引'` → **0 行**，而库里明明有含这些词的消息
//!
//! 原因：unicode61 把**一整串 CJK 字符当作一个 token**（CJK 码点被归为"字母"，
//! 中间没有分隔符就不切）。所以"关于存储迁移的讨论"整句是一个 token，
//! 查"存储"当然匹配不到 —— **中文全文检索实际上是不可用的**，
//! 而这是一个中文优先的产品。
//!
//! ## 解法：入库与查询都做同一套切分
//!
//! CJK 段切成"单字 + 相邻双字"：
//! - 单字保证 1 字查询能命中；
//! - 双字（bigram）保证 2 字及以上查询能以词组形式命中；
//! - ASCII 词保持原样（`ChatPanel`、`API error 400` 照旧）。
//!
//! 查询侧用**同样的规则**切分，再用 `AND`/`OR` 拼成 FTS 查询表达式。
//! 索引里存的是切分后的文本（因此 `snippet()` 出来的是切分形式，不适合展示）——
//! 需要展示片段时由渲染侧按 message_id 取真实正文来高亮，
//! 这也是"索引是索引、正文在正文表里"的一贯分工。

/// 判断是否为 CJK 表意文字（含扩展 A 与兼容区，覆盖中日韩常用字）
fn is_cjk(c: char) -> bool {
    let code = c as u32;
    (0x3400..=0x9fff).contains(&code) || (0xf900..=0xfaff).contains(&code)
}

/// 可参与 ASCII 词的字符（字母/数字）
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() && !is_cjk(c)
}

/// 把文本切成适合 FTS 索引/查询的形式。
///
/// 规则：
/// - CJK 连续段 → 逐字 + 相邻双字（空格分隔）；
/// - ASCII 字母数字连续段 → 原样保留为一个词；
/// - 其它字符（标点、空白、emoji）→ 分隔符，丢弃。
///
/// 例：`关于存储迁移的讨论` → `关 关于 于 于存 存 存储 储 储迁 迁 迁移 移 移的 的 的讨 讨 讨论 论`
pub fn tokenize(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();

    fn flush_ascii(out: &mut Vec<String>, ascii: &mut String) {
        if !ascii.is_empty() {
            out.push(std::mem::take(ascii));
        }
    }
    fn flush_cjk(out: &mut Vec<String>, cjk: &mut Vec<char>) {
        if cjk.is_empty() {
            return;
        }
        for i in 0..cjk.len() {
            out.push(cjk[i].to_string());
            if i + 1 < cjk.len() {
                out.push(format!("{}{}", cjk[i], cjk[i + 1]));
            }
        }
        cjk.clear();
    }

    for ch in text.chars() {
        if is_cjk(ch) {
            flush_ascii(&mut out, &mut ascii);
            cjk.push(ch);
        } else if is_word_char(ch) {
            flush_cjk(&mut out, &mut cjk);
            ascii.push(ch);
        } else {
            flush_ascii(&mut out, &mut ascii);
            flush_cjk(&mut out, &mut cjk);
        }
    }
    flush_ascii(&mut out, &mut ascii);
    flush_cjk(&mut out, &mut cjk);
    out.join(" ")
}

/// 把用户查询转成 FTS 查询表达式。
///
/// - ASCII 词：加引号（避免 `AND`/`OR`/`*` 之类被当成语法）；
/// - CJK：按同一套规则切分，各 token 用**空格连接**（FTS 默认按 AND 处理，
///   于是"存储迁移"会要求同时含"存储"与"迁移"，符合直觉）；
/// - 空查询 → 返回 None（调用方应当报参数错误，而不是返回全表）。
pub fn query_expr(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let tokens: Vec<String> = tokenize(trimmed)
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_splits_cjk_into_unigrams_and_bigrams() {
        let t = tokenize("存储迁移");
        // 单字 + 相邻双字
        for expect in ["存", "储", "迁", "移", "存储", "储迁", "迁移"] {
            assert!(t.split(' ').any(|x| x == expect), "缺少 token {expect}：{t}");
        }
        assert!(!tokenize("存储迁移").contains("存储迁移"), "整句不该作为一个 token");
    }

    #[test]
    fn tokenize_keeps_ascii_words_intact() {
        let t = tokenize("ChatPanel 的引导栏 API error 400");
        for expect in ["ChatPanel", "API", "error", "400"] {
            assert!(t.split(' ').any(|x| x == expect), "ASCII 词应保留：{expect} / {t}");
        }
        // 中文部分仍然切
        assert!(t.split(' ').any(|x| x == "引导"));
        assert!(t.split(' ').any(|x| x == "导栏"));
    }

    #[test]
    fn tokenize_drops_punctuation_and_emoji() {
        let t = tokenize("⚠️ 工具执行失败：API error 400");
        assert!(t.split(' ').any(|x| x == "工具"));
        assert!(t.split(' ').any(|x| x == "执行"));
        assert!(!t.contains('⚠'));
        assert!(!t.contains('：'));
    }

    #[test]
    fn query_expr_quotes_tokens_and_handles_empty() {
        assert_eq!(query_expr(""), None);
        assert_eq!(query_expr("   "), None);
        let q = query_expr("ChatPanel").unwrap();
        assert_eq!(q, "\"ChatPanel\"");
        // 中文查询会被切成多个 token（AND 语义）
        let cjk = query_expr("存储迁移").unwrap();
        assert!(cjk.contains("\"存储\""), "{cjk}");
        assert!(cjk.contains("\"迁移\""), "{cjk}");
        // 危险字符被剥掉，且每个 token 都被引号包住：
        // 于是 `OR` 只能是**被搜索的字面词**，不会变成 FTS 的布尔运算符（注入防范）
        let injected = query_expr("a\" OR b").unwrap();
        assert!(
            injected.split(' ').all(|t| t.starts_with('"') && t.ends_with('"')),
            "每个 token 都必须被引号包住：{injected}"
        );
        assert!(
            injected.contains("\"OR\""),
            "OR 应作为被引号包住的字面词出现，而不是裸运算符：{injected}"
        );
    }

    #[test]
    fn mixed_text_matches_at_word_boundaries() {
        // "存储迁移（storage migration）" 这类中英混排
        let t = tokenize("存储迁移(storage migration)");
        for expect in ["存储", "迁移", "storage", "migration"] {
            assert!(t.split(' ').any(|x| x == expect), "缺少 {expect}：{t}");
        }
    }
}
