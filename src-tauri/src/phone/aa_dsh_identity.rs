// ============================================================
// phone/aa_dsh_identity.rs — **DSH 运行时**的标识符派生（阶段 R3）
//
// 这是整个复刻里最关键的一个发现：
//
// **它的 `dsh` 运行时不用通用的 `sel_*` 方案，而是自己一套 `dsh:` 前缀方案。**
//
// 通用方案（`protocol.py:126-133` 的 `protocol_selection_id`）产出 `sel_model_xxx`，
// 那是给 claude / codex 这类运行时用的；而 DSH 那一支在
// `runtimes/dsh/identity.py` 里另立了一套：
//
//     model       = "dsh:model:"      + base64url( json([provider, model, effort]) )
//     permission  = "dsh:permission:" + base64url( preset )
//     timelineId  = "dsh_" + sha256_hex( f"{external_session_id}\0{kind}\0{business_id}" )
//
// 我一开始只实现了通用方案 —— 那对 `dsh` 运行时是**错的**：
// 服务端（以及它存下来的选择）用的会是 `dsh:` 形式，
// 而我们发出 `sel_model_...` 会导致"用户选了模型但设备不认"，且很难归因。
// 这就是"读协议文件不够、必须读它**这个运行时**的适配层"的实例。
//
// ## 两个必须照抄的细节
//
// 1. **json 不带 `sort_keys`**：那是一个**数组**，键序无意义，但分隔符是
//    `separators=(",", ":")`（紧凑）且 `ensure_ascii=False`。
// 2. **解码时要重新算一遍做规范性校验**（`identity.py:41-42`）：
//    `model_selection_id(...) != selection_id` ⇒ 报 "not canonical"。
//    这不是多余的 —— 它挡住了"同一份内容有多个 base64 写法"（填充、非规范位）
//    导致的**同一选择被当成两个**的问题。
// ============================================================

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::aa_protocol::{base64url_nopad, canonical_json};

pub const DSH_MODEL_PREFIX: &str = "dsh:model:";
pub const DSH_PERMISSION_PREFIX: &str = "dsh:permission:";

/// `dsh:model:<base64url(json([provider, model, effort]))>`（`identity.py:9-22`）。
///
/// 三个分量都不许为空（`effort` 可以为 `None`，但不许是空字符串）——
/// 它那边是 `raise ValueError`，这里返回 `Err`。
pub fn model_selection_id(
    provider: &str,
    model: &str,
    effort: Option<&str>,
) -> Result<String, String> {
    if provider.is_empty() || model.is_empty() || matches!(effort, Some("")) {
        return Err("模型选择的三个分量都不许为空".into());
    }
    let payload = match effort {
        Some(e) => serde_json::json!([provider, model, e]),
        None => serde_json::json!([provider, model, Value::Null]),
    };
    Ok(format!(
        "{}{}",
        DSH_MODEL_PREFIX,
        base64url_nopad(canonical_json(&payload).as_bytes())
    ))
}

/// 解出 `(provider, model, effort)`，并做**规范性**校验（`identity.py:25-43`）。
pub fn decode_model_selection_id(selection_id: &str) -> Result<(String, String, Option<String>), String> {
    let raw = decode_prefixed(selection_id, DSH_MODEL_PREFIX)?;
    let text = String::from_utf8(raw).map_err(|_| "DSH 模型选择不是合法 UTF-8".to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "DSH 模型选择不是合法 JSON".to_string())?;
    let arr = v
        .as_array()
        .filter(|a| a.len() == 3)
        .ok_or_else(|| "DSH 模型选择必须是三个元素的数组".to_string())?;
    let provider = arr[0]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "provider 非法".to_string())?
        .to_string();
    let model = arr[1]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "model 非法".to_string())?
        .to_string();
    let effort = match &arr[2] {
        Value::Null => None,
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => return Err("effort 非法".into()),
    };
    // 规范性复核：重算一遍必须与输入**逐字**相等
    let recomputed = model_selection_id(&provider, &model, effort.as_deref())?;
    if recomputed != selection_id {
        return Err("DSH 模型选择不是规范形式".into());
    }
    Ok((provider, model, effort))
}

/// `dsh:permission:<base64url(preset)>`（`identity.py:46-49`）。
pub fn permission_selection_id(preset: &str) -> Result<String, String> {
    if preset.is_empty() {
        return Err("权限档名不许为空".into());
    }
    Ok(format!(
        "{}{}",
        DSH_PERMISSION_PREFIX,
        base64url_nopad(preset.as_bytes())
    ))
}

/// 解出预设名并做规范性校验（`identity.py:52-60`）。
pub fn decode_permission_selection_id(selection_id: &str) -> Result<String, String> {
    let raw = decode_prefixed(selection_id, DSH_PERMISSION_PREFIX)?;
    let preset = String::from_utf8(raw).map_err(|_| "DSH 权限选择不是合法 UTF-8".to_string())?;
    if preset.is_empty() {
        return Err("DSH 权限选择为空".into());
    }
    if permission_selection_id(&preset)? != selection_id {
        return Err("DSH 权限选择不是规范形式".into());
    }
    Ok(preset)
}

/// 时间线条目 id：`dsh_<sha256_hex(external_session_id \0 kind \0 business_id)>`
/// （`identity.py:63-73`）。三个分量都不许为空。
pub fn timeline_item_id(
    external_session_id: &str,
    projection_kind: &str,
    business_id: &str,
) -> Result<String, String> {
    if external_session_id.is_empty() || projection_kind.is_empty() || business_id.is_empty() {
        return Err("时间线标识的三个分量都不许为空".into());
    }
    let mut h = Sha256::new();
    h.update(external_session_id.as_bytes());
    h.update([0u8]);
    h.update(projection_kind.as_bytes());
    h.update([0u8]);
    h.update(business_id.as_bytes());
    Ok(format!("dsh_{:x}", h.finalize()))
}

/// 去掉前缀后 base64url 解码；**带 `=` 一律拒绝**（`identity.py:84-85`：
/// 规范形式不许有填充 —— 否则同一份内容会有两种写法）。
fn decode_prefixed(value: &str, prefix: &str) -> Result<Vec<u8>, String> {
    let Some(encoded) = value.strip_prefix(prefix) else {
        return Err(format!("缺少前缀 {}", prefix));
    };
    if encoded.is_empty() || encoded.contains('=') {
        return Err("DSH 的 base64url 不许为空、也不许带填充".into());
    }
    base64url_decode_nopad(encoded)
}

/// base64url 解码（无填充）。不认识的字符一律拒绝（对应 Python 的 `validate=True`）。
pub fn base64url_decode_nopad(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.chars() {
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '-' => 62,
            '_' => 63,
            _ => return Err(format!("base64url 里出现非法字符: {}", c)),
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    // 剩下的位必须是 0 填充，否则不是规范编码
    if bits > 0 && (acc & ((1 << bits) - 1)) != 0 {
        return Err("base64url 有非零填充位（非规范编码）".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_selection_id_known_values() {
        // 基准值由**独立实现（Node）**按 identity.py 的语义算出，逐字抄在这里。
        // （第一次我把第一串手抄错了——少了一个 m——判据立刻红，正好说明它在真的比对。）
        // 解出来是 ["anthropic","claude-3",null]
        assert_eq!(
            model_selection_id("anthropic", "claude-3", None).unwrap(),
            "dsh:model:WyJhbnRocm9waWMiLCJjbGF1ZGUtMyIsbnVsbF0"
        );
        // 解出来是 ["mimo","mimo-v2.5-pro","high"]
        assert_eq!(
            model_selection_id("mimo", "mimo-v2.5-pro", Some("high")).unwrap(),
            "dsh:model:WyJtaW1vIiwibWltby12Mi41LXBybyIsImhpZ2giXQ"
        );
        // 中文分量（ensure_ascii=False ⇒ 直接进 UTF-8 字节）
        let s = model_selection_id("厂商", "模型", Some("高")).unwrap();
        assert!(s.starts_with("dsh:model:"));
        let (p, m, e) = decode_model_selection_id(&s).unwrap();
        assert_eq!((p.as_str(), m.as_str(), e.as_deref()), ("厂商", "模型", Some("高")));
    }

    #[test]
    fn model_selection_rejects_empty_components() {
        // 它那边是 raise ValueError
        assert!(model_selection_id("", "m", None).is_err());
        assert!(model_selection_id("p", "", None).is_err());
        assert!(model_selection_id("p", "m", Some("")).is_err());
        // effort 为 None 是合法的
        assert!(model_selection_id("p", "m", None).is_ok());
    }

    #[test]
    fn decode_verifies_canonical_form() {
        // 正常往返
        let s = model_selection_id("p", "m", None).unwrap();
        assert!(decode_model_selection_id(&s).is_ok());
        // 前缀不对
        assert!(decode_model_selection_id("sel_model_xxx").is_err());
        assert!(decode_model_selection_id("dsh:permission:YXNr").is_err());
        // 带填充 ⇒ 非规范（identity.py 明确拒绝 "="）
        let padded = format!("{}=", s);
        assert!(decode_model_selection_id(&padded).is_err());
        // 内容合法但**不是三个元素**
        let two = format!(
            "{}:{}",
            DSH_MODEL_PREFIX,
            base64url_nopad(b"[\"a\",\"b\"]")
        );
        assert!(decode_model_selection_id(&two).is_err());
        // 非 JSON
        let notjson = format!("{}:{}", DSH_MODEL_PREFIX, base64url_nopad(b"hello"));
        assert!(decode_model_selection_id(&notjson).is_err());
        // 空分量
        let empty = format!(
            "{}:{}",
            DSH_MODEL_PREFIX,
            base64url_nopad(b"[\"\",\"b\",null]")
        );
        assert!(decode_model_selection_id(&empty).is_err());
    }

    #[test]
    fn permission_selection_id_known_values() {
        assert_eq!(permission_selection_id("ask").unwrap(), "dsh:permission:YXNr");
        assert_eq!(
            permission_selection_id("acceptEdits").unwrap(),
            "dsh:permission:YWNjZXB0RWRpdHM"
        );
        // 中文
        assert_eq!(
            permission_selection_id("请求批准").unwrap(),
            "dsh:permission:6K-35rGC5om55YeG"
        );
        // 往返 + 规范性
        for p in ["ask", "auto", "full", "acceptEdits", "请求批准"] {
            let id = permission_selection_id(p).unwrap();
            assert_eq!(decode_permission_selection_id(&id).unwrap(), p);
        }
        assert!(permission_selection_id("").is_err());
        assert!(decode_permission_selection_id("dsh:model:YXNr").is_err());
        assert!(decode_permission_selection_id("dsh:permission:YXNr=").is_err());
    }

    #[test]
    fn timeline_item_id_known_value_and_separators() {
        // 基准值由独立实现（Node）算出
        assert_eq!(
            timeline_item_id("sess-1", "message", "m-9").unwrap(),
            "dsh_ac429b7e9be6bdfb46bfcda0040af09ecaba550e8dbf417319218d3352beba28"
        );
        // 以 dsh_ 开头、后面是 64 位十六进制
        let id = timeline_item_id("a", "b", "c").unwrap();
        assert!(id.starts_with("dsh_"));
        assert_eq!(id.len(), 4 + 64);
        assert!(id[4..].chars().all(|c| c.is_ascii_hexdigit()));
        // `\0` 分隔符必须**真的**存在。
        //
        // 反例：如果改用普通拼接，("ab","c","d") 与 ("a","bc","d") 会算出同一个 id
        // —— 而那是两个不同的条目，会**静默合并**。
        assert_ne!(
            timeline_item_id("ab", "c", "d").unwrap(),
            timeline_item_id("a", "bc", "d").unwrap(),
            "\\0 分隔符丢失会导致不同条目撞同一个 id"
        );
        assert_ne!(
            timeline_item_id("a", "bc", "d").unwrap(),
            timeline_item_id("a", "b", "cd").unwrap()
        );
        // 空分量
        assert!(timeline_item_id("", "b", "c").is_err());
        assert!(timeline_item_id("a", "", "c").is_err());
        assert!(timeline_item_id("a", "b", "").is_err());
    }

    #[test]
    fn base64url_decode_is_strict() {
        // 与编码器互为逆
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar", "请求批准", "dsh"] {
            let enc = base64url_nopad(s.as_bytes());
            assert_eq!(base64url_decode_nopad(&enc).unwrap(), s.as_bytes(), "往返失败: {}", s);
        }
        // 非法字符
        assert!(base64url_decode_nopad("a+b").is_err());
        assert!(base64url_decode_nopad("a/b").is_err());
        assert!(base64url_decode_nopad("a=").is_err());
        // 非零填充位（"Zg" 合法；"Zh" 的最后 4 位非零 ⇒ 非规范）
        assert_eq!(base64url_decode_nopad("Zg").unwrap(), b"f");
        assert!(base64url_decode_nopad("Zh").is_err());
    }
}
