// ============================================================
// ilink/store.rs — 会话文件读写（token/游标/历史 token）
//
// 文件：app-data/ilink/session.json（登录会话）与 tokens.json（历史 ≤10）。
// 原则：
//  - 只接受结构合法的会话；`{}`/损坏一律视为未登录【EAC 桥】。
//  - token 绝不打日志；0600 权限（Windows 由 ACL/用户目录兜底）。
//  - 写采用 temp+rename，避免崩溃写半文件。
// ============================================================

use crate::ilink::proto::WechatSession;
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_TOKEN_HISTORY: usize = 10;

pub fn session_path(dir: &Path) -> PathBuf {
    dir.join("session.json")
}
pub fn tokens_path(dir: &Path) -> PathBuf {
    dir.join("tokens.json")
}

/// 目录不存在则创建。
pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("ilink dir create failed: {}", e))
}

/// 读取会话；结构不合法/损坏 → None（视为未登录）。
pub fn load_session(dir: &Path) -> Option<WechatSession> {
    let raw = fs::read_to_string(session_path(dir)).ok()?;
    let s: WechatSession = serde_json::from_str(&raw).ok()?;
    if s.token.is_empty() || s.bot_id.is_empty() || s.user_id.is_empty() {
        return None;
    }
    Some(s)
}

pub fn save_session(dir: &Path, session: &WechatSession) -> Result<(), String> {
    ensure_dir(dir)?;
    let tmp = session_path(dir).with_extension("json.tmp");
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| format!("ilink session write failed: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, session_path(dir)).map_err(|e| format!("ilink session rename failed: {}", e))
}

pub fn clear_session(dir: &Path) {
    let _ = fs::remove_file(session_path(dir));
}

/// 读取历史 token 列表（最新在前）。
pub fn load_tokens(dir: &Path) -> Vec<String> {
    let raw = fs::read_to_string(tokens_path(dir)).ok();
    let v: Option<Vec<String>> = raw.and_then(|r| serde_json::from_str(&r).ok());
    v.unwrap_or_default()
}

/// 记录一个新 bot_token（去重，保留最近 MAX_TOKEN_HISTORY 个）——用于
/// get_bot_qrcode 的 local_token_list（多端互认/重装少一次绑定）【官方】。
pub fn record_token(dir: &Path, token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Ok(());
    }
    let mut list = load_tokens(dir);
    list.retain(|t| t != token);
    list.insert(0, token.to_string());
    if list.len() > MAX_TOKEN_HISTORY {
        list.truncate(MAX_TOKEN_HISTORY);
    }
    ensure_dir(dir)?;
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    fs::write(tokens_path(dir), json).map_err(|e| format!("ilink tokens write failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_roundtrip_and_validation() {
        let dir = std::env::temp_dir().join(format!("ilink-test-{}", uuid::Uuid::new_v4()));
        let s = WechatSession {
            token: "tok".into(),
            bot_id: "abc@im.bot".into(),
            user_id: "u@im.wechat".into(),
            base_url: String::new(),
            saved_at_ms: 1,
            cursor: String::new(),
        };
        save_session(&dir, &s).expect("save");
        let loaded = load_session(&dir).expect("load");
        assert_eq!(loaded.token, "tok");
        assert_eq!(loaded.bot_id, "abc@im.bot");

        // 损坏 → None
        fs::write(session_path(&dir), "{}").unwrap();
        assert!(load_session(&dir).is_none());
        fs::write(session_path(&dir), "not json").unwrap();
        assert!(load_session(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_history_dedupe_and_cap() {
        let dir = std::env::temp_dir().join(format!("ilink-test-{}", uuid::Uuid::new_v4()));
        for i in 0..12 {
            record_token(&dir, &format!("tok-{}", i % 5)).expect("record");
        }
        let list = load_tokens(&dir);
        assert!(list.len() <= MAX_TOKEN_HISTORY);
        // 最新在前（序列 0..12 模 5，最后插入的是 tok-1）
        assert_eq!(list.first().map(|s| s.as_str()), Some("tok-1"));
        // 无重复
        let mut sorted = list.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), list.len());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_session_removes() {
        let dir = std::env::temp_dir().join(format!("ilink-test-{}", uuid::Uuid::new_v4()));
        let s = WechatSession {
            token: "t".into(),
            bot_id: "b@im.bot".into(),
            user_id: "u@im.wechat".into(),
            base_url: String::new(),
            saved_at_ms: 1,
            cursor: String::new(),
        };
        save_session(&dir, &s).unwrap();
        clear_session(&dir);
        assert!(load_session(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
