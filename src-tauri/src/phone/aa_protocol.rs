// ============================================================
// phone/aa_protocol.rs — Agents Anywhere 私有协议的**规格层**（阶段 R1）
//
// 这一层只有**纯函数与数据结构**：不碰网络、不碰状态。
// 好处是协议里最容易错的部分（帧形状、序号时钟、selectionId 派生）
// 可以被直接钉住，而不是只能在"连上真服务器"时才暴露。
//
// 所有字段名与形状**逐字对齐**它捆绑 connector 的 Python 源码：
//   …/dsh-bridge-next/lib/bundled-connector/connector/server/protocol.py
// 以及运行时名单 `protocol.py:15`、能力↔方法表 `capabilities.py:14-22`、
// 序号时钟 `protocol_revision.py:15-21`。
//
// ## 一个必须记档的坑：**不能依赖 serde_json 的键序**
//
// 它的 `selectionId` 派生是（`protocol.py:126-133`）：
//
//     raw = f"1:{runtime}:{catalog_type}:{canonical_json(identity)}"
//     digest = base64url(sha256(raw)).rstrip("=")
//     return f"sel_{catalog_type}_{digest[:24]}"
//
// 其中 `canonical_json` 用的是 Python 的
// `json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",", ":"))`
// —— **键有序**是它的一部分语义。
//
// 而我们这边：serde_json 的 `Map` 在**默认**情况下是 BTreeMap（键天然有序），
// 所以在我们**当前**的构建里顺序恰好是对的。
//
// 但这个"恰好"由**依赖树**决定，不由我们控制：任何一层依赖打开了 serde_json 的
// `preserve_order`，`Map` 就变成插入序，我们的派生会静默变样
// （表现只是"服务端认不出这个 selectionId"，极难归因）。
//
// 所以这里**自己排序**，把"键有序"变成我们自己的代码行为。
//
// ⚠️ 更要紧的是**判据怎么证明这件事** —— 第一版我正是在这里栽的：
// 只测 `canonical_json(&Value)` 时，因为 `Map` 本来就是有序的，
// **把 `keys.sort()` 删掉判据照样全绿**（变异自证当场抓住）。
// 也就是"我们排了序"这个性质**在 `Value` 这个输入上无法被区分**。
//
// 修法见下面的 `canonical_json_of_pairs`：用**明确的插入顺序**做输入，
// 让"排序"成为可被证明、也可被变异咬住的行为。
// （另一条不变：用独立实现算出的基准值交叉验证 `selectionId`。）
// ============================================================

// 这是一个**规格模块**：它的价值在于把从它 Python 里读出的形状固定成代码。
// 因此**必然**有一部分类型/常量在对应功能接线之前没有生产调用方
// （例如目录结构与握手请求 —— 握手是我们**刻意不发**的，见 `aa_connector.rs` 文件头）。
//
// 用模块级 allow 而不是删掉它们，理由具体：删掉等于把**规格**丢了，
// 而那些形状正是后面接线时的依据；而且它们**都有判据**（`#[cfg(test)]` 里的
// 形状测试逐字段核对），所以不会悄悄腐烂成"没人看也不知道对不对"的注释。
//
// 与之相对，真正"写了没人用、也没有规格价值"的东西**直接删**
// （例如 `AccessTokenCache` —— 见 `aa_connector.rs` 里的说明）。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 协议版本。目前只有 "1.0"（`protocol.py:9-10`）。
pub const PROTOCOL_VERSION_1: &str = "1.0";
/// revision 的上限（`protocol.py:12`，2^53-1 —— JS 安全整数上限）。
pub const PROTOCOL_MAX_REVISION: u64 = 9_007_199_254_740_991;

/// 运行时名单（`protocol.py:15`）。
///
/// 注意它**比 `runtimes/` 目录里的三个多**：`opencode` 与 `acp` 也在协议里。
/// 我们只说自己是 `dsh`（我们复刻的就是 DSH 那一支）。
pub const RUNTIME_NAMES: &[&str] = &["codex", "claude", "opencode", "acp", "dsh"];

// ---------------- 帧信封（三条，`protocol.py:32-50`）----------------

/// 请求帧。`id` 由**发起方**给，回执用同一个 id。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AaRpcRequest {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String, // 恒为 "request"
    pub method: String,
    pub params: serde_json::Value,
}

impl AaRpcRequest {
    pub fn new(id: impl Into<String>, method: impl Into<String>, params: serde_json::Value) -> Self {
        AaRpcRequest {
            id: id.into(),
            kind: "request".into(),
            method: method.into(),
            params,
        }
    }
}

/// 应答帧。`ok=false` 时带 `error`。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AaRpcResponse {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String, // 恒为 "response"
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<std::collections::BTreeMap<String, String>>,
}

impl AaRpcResponse {
    pub fn ok(id: impl Into<String>, result: serde_json::Value) -> Self {
        AaRpcResponse {
            id: id.into(),
            kind: "response".into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }
    pub fn err(id: impl Into<String>, error: std::collections::BTreeMap<String, String>) -> Self {
        AaRpcResponse {
            id: id.into(),
            kind: "response".into(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

/// 通知帧：**没有 id**（不需要回执）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AaRpcNotification {
    #[serde(rename = "type")]
    pub kind: String, // 恒为 "notification"
    pub method: String,
    pub params: serde_json::Value,
}

impl AaRpcNotification {
    pub fn new(method: impl Into<String>, params: serde_json::Value) -> Self {
        AaRpcNotification {
            kind: "notification".into(),
            method: method.into(),
            params,
        }
    }
}

/// 从一行文本解析出三种帧之一。
///
/// 为什么要有它：**判据要能直接喂一行 JSON 进去**，而不是非得建一个连接。
/// 同时它把"认不出就报错"这件事变成显式行为（而不是静默忽略一个我们不认识的帧）。
#[derive(Debug, Clone, PartialEq)]
pub enum AaFrame {
    Request(AaRpcRequest),
    Response(AaRpcResponse),
    Notification(AaRpcNotification),
}

pub fn parse_frame(line: &str) -> Result<AaFrame, String> {
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("不是合法 JSON: {}", e))?;
    let kind = v
        .get("type")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "缺少 type 字段".to_string())?;
    match kind {
        "request" => serde_json::from_value(v)
            .map(AaFrame::Request)
            .map_err(|e| format!("request 帧字段不合法: {}", e)),
        "response" => serde_json::from_value(v)
            .map(AaFrame::Response)
            .map_err(|e| format!("response 帧字段不合法: {}", e)),
        "notification" => serde_json::from_value(v)
            .map(AaFrame::Notification)
            .map_err(|e| format!("notification 帧字段不合法: {}", e)),
        other => Err(format!("未知的帧类型: {}", other)),
    }
}

// ---------------- 握手（`protocol.py:53-56`）----------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolRuntimeIdentity {
    pub runtime: String,
    pub runtime_version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolHandshakeRequest {
    pub protocol_versions: Vec<String>,
    pub connector_version: String,
    pub runtimes: Vec<ProtocolRuntimeIdentity>,
}

impl ProtocolHandshakeRequest {
    /// 造一份"我们是 dsh 运行时"的握手。
    pub fn for_dsh(connector_version: &str, dsh_version: &str) -> Self {
        ProtocolHandshakeRequest {
            protocol_versions: vec![PROTOCOL_VERSION_1.to_string()],
            connector_version: connector_version.to_string(),
            runtimes: vec![ProtocolRuntimeIdentity {
                runtime: "dsh".into(),
                runtime_version: dsh_version.to_string(),
            }],
        }
    }
}

// ---------------- 能力集（`protocol.py:66-77` + `capabilities.py:14-22`）----------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolCapability {
    pub capability_id: String,
    pub version: String,
    pub scope: String, // "runtime" | "session"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub supported: bool,
    pub available: bool,
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub parameters: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolCapabilitySet {
    pub revision: u64,
    pub capabilities: Vec<ProtocolCapability>,
}

/// 能力 id → 协议方法名。**逐字照抄** `capabilities.py:14-22`。
///
/// 这张表是"复刻"的核心之一：它决定服务端认为我们会哪些方法。
/// 表里的每条我们都要真的实现，否则服务端会调一个我们不认的方法。
pub const CAPABILITY_METHODS: &[(&str, &str)] = &[
    ("modelCatalog", "catalog.model"),
    ("modelCatalog", "catalog.effort"),
    ("permissionCatalog", "catalog.permission"),
    ("steerTurn", "session.steer"),
    ("interruptTurn", "session.interrupt"),
    ("commands", "session.commands"),
    ("interactions", "session.interaction.approval"),
    ("attachments", "runtime.attachment"),
];

/// 我们**当前**能声称支持的能力（其余一律 `supported: false`）。
///
/// 诚实标注：声称支持但没实现 = 服务端调过来才发现，
/// 所以这张清单必须与 `aa_dispatch` 里真正处理的方法**一一对应**（有判据钉住）。
pub const OUR_SUPPORTED_CAPABILITIES: &[&str] = &[
    "modelCatalog",
    "permissionCatalog",
    "interruptTurn",
    "interactions",
];

/// 造能力集。
pub fn build_capability_set(revision: u64, runtime: &str) -> ProtocolCapabilitySet {
    let mut capabilities = Vec::new();
    // 表里出现过的所有 capabilityId 都要出现（不支持的用 supported:false 明确报出来）
    let mut ids: Vec<&str> = CAPABILITY_METHODS.iter().map(|(c, _)| *c).collect();
    ids.sort_unstable();
    ids.dedup();
    for id in ids {
        let supported = OUR_SUPPORTED_CAPABILITIES.contains(&id);
        capabilities.push(ProtocolCapability {
            capability_id: id.to_string(),
            version: "1".into(),
            scope: if id == "attachments" { "runtime" } else { "session" }.into(),
            runtime: Some(runtime.to_string()),
            session_id: None,
            supported,
            available: supported,
            allowed: supported,
            unavailable_reason: if supported {
                None
            } else {
                Some("Codem 当前未实现该能力".into())
            },
            parameters: serde_json::json!({}),
        });
    }
    ProtocolCapabilitySet {
        revision,
        capabilities,
    }
}

// ---------------- 目录（`protocol.py:89-97`）----------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolModelItem {
    pub display_name: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub default: bool,
    pub reasoning_items: Vec<serde_json::Value>,
    pub metadata: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolModelCatalog {
    pub runtime: String,
    pub revision: u64,
    pub models: Vec<ProtocolModelItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolPermissionItem {
    pub display_name: String,
    pub id: String,
    pub selection_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub default: bool,
    pub metadata: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolPermissionCatalog {
    pub runtime: String,
    pub revision: u64,
    pub permissions: Vec<ProtocolPermissionItem>,
}

// ---------------- 交互状态机（`protocol.py:22-31`）----------------

/// 它的交互状态**比我们阶段 0 的四个多**（`protocol.py:22-31`）。
///
/// 我们原来的 `open | resolved | closed | expired` 是它的子集；
/// 复刻意味着**用它的状态机**（这也是它能在多端之间正确协调的原因：
/// `responding` / `response_accepted` / `resolving` 三段把"有人点了"
/// 与"服务端收下了"与"正在落地"分开）。
pub const INTERACTION_STATUSES: &[&str] = &[
    "open",
    "responding",
    "response_accepted",
    "resolving",
    "resolved",
    "expired",
    "cancelled",
    "failed",
];

/// 状态是否仍在等待/处理中（即"还没结束"）。
pub fn status_is_pending(status: &str) -> bool {
    matches!(
        status,
        "open" | "responding" | "response_accepted" | "resolving"
    )
}

/// 落定后**不再接受回答**的状态。
pub fn status_is_terminal(status: &str) -> bool {
    matches!(status, "resolved" | "expired" | "cancelled" | "failed")
}

pub const NOTICE_TYPES: &[&str] = &["notification", "interaction"];
pub const NOTICE_SEVERITIES: &[&str] = &["info", "success", "warning", "error"];
pub const ACTION_STYLES: &[&str] = &["primary", "secondary", "danger", "default"];

// ---------------- 序号时钟（`protocol_revision.py:15-21`）----------------

/// 单调 revision 时钟：`next() = max(now_us, last + 1)`。
///
/// 为什么不是简单的自增：`revision` 在它那边被当作**跨端可比较的版本号**，
/// 用微秒时间戳做底，不同来源（能力集/目录/通知）各自推进时不会撞号，
/// 而同一次调用内又保证严格递增。
///
/// 我们把"时间源"做成可注入的，这样判据可以喂一个**不前进或后退的时钟**
/// 来验证"仍然严格递增"这条性质。
pub struct RevisionClock {
    last: u64,
    source: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl RevisionClock {
    pub fn new() -> Self {
        RevisionClock {
            last: 0,
            source: Box::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_micros() as u64)
                    .unwrap_or(0)
            }),
        }
    }

    /// 注入一个时间源（测试用：可以造出"时间停住"或"时间倒退"）。
    pub fn with_source<F: Fn() -> u64 + Send + Sync + 'static>(f: F) -> Self {
        RevisionClock {
            last: 0,
            source: Box::new(f),
        }
    }

    pub fn next(&mut self) -> u64 {
        let candidate = (self.source)();
        self.last = candidate.max(self.last.saturating_add(1));
        // 不许超过协议上限（`protocol.py:12`）
        self.last.min(PROTOCOL_MAX_REVISION)
    }
}

impl Default for RevisionClock {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------- canonical JSON + selectionId ----------------

/// **我们自己的**规范 JSON 序列化：键递归排序、紧凑分隔符、非 ASCII 原样输出。
///
/// 对应 Python 的 `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`。
/// 为什么不用 `serde_json::to_string` 再指望它排序 —— 见文件头那段（feature 可加）。
pub fn canonical_json(v: &serde_json::Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::Null => out.push_str("null"),
        serde_json::Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        serde_json::Value::Number(n) => out.push_str(&n.to_string()),
        serde_json::Value::String(s) => write_json_string(s, out),
        serde_json::Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        serde_json::Value::Object(m) => {
            // 从 Map 取键值对再交给**统一的排序写出**。
            // 注意：Map 在默认构建里已是 BTreeMap（有序），所以这一步
            // "看不出差别" —— 排序的可证明性由 `canonical_json_of_pairs` 承担。
            let pairs: Vec<(&str, &serde_json::Value)> =
                m.iter().map(|(k, v)| (k.as_str(), v)).collect();
            write_canonical_pairs(&pairs, out);
        }
    }
}

/// 按**键排序**写出一组键值对（紧凑分隔符）。
///
/// 为什么要有这个函数，而不是直接在 `write_canonical` 里排序：
///
/// `Value::Object` 的迭代顺序取决于 serde_json 的 feature（默认 BTreeMap ⇒ 已有序），
/// 所以在 `Value` 上**无法区分**"它本来就有序"和"我们排了序" ——
/// 变异自证会证明这一点（删掉排序，判据照样绿）。
///
/// 这个函数接收**调用方给定的插入顺序**，因此"排序"是它的行为，
/// 可以被判据直接盯住（见 `canonical_json_of_pairs` 与 `sorts_keys_provably`）。
fn write_canonical_pairs(pairs: &[(&str, &serde_json::Value)], out: &mut String) {
    // 排序：Rust 的 String Ord 是 UTF-8 字节序，
    // 而 UTF-8 的字节序与 Unicode 码点序**一致** ⇒ 与 Python 的 str 排序同结果。
    let mut order: Vec<usize> = (0..pairs.len()).collect();
    order.sort_by(|&a, &b| pairs[a].0.cmp(pairs[b].0));
    out.push('{');
    for (i, &j) in order.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_json_string(pairs[j].0, out);
        out.push(':');
        write_canonical(pairs[j].1, out);
    }
    out.push('}');
}

/// 供**判据**使用：从调用方给定的插入顺序构造规范 JSON。
///
/// 它存在的唯一理由就是让"键必须有序"这条性质可被证明（而不是"碰巧成立"）。
pub fn canonical_json_of_pairs(pairs: &[(&str, serde_json::Value)]) -> String {
    let refs: Vec<(&str, &serde_json::Value)> =
        pairs.iter().map(|(k, v)| (*k, v)).collect();
    let mut out = String::new();
    write_canonical_pairs(&refs, &mut out);
    out
}

/// 按 Python `json.dumps(ensure_ascii=False)` 的转义规则写字符串。
///
/// 它只转义 JSON 必须转义的：`"` `\` 与控制字符（`\b \f \n \r \t` 用短转义，
/// 其余控制字符用 `\u00XX`）。**不**转义非 ASCII —— 这一点很关键，
/// 因为中文键值会直接进 sha256 的输入字节。
fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `protocol_selection_id`（`protocol.py:126-133`）的 Rust 版。
///
/// 同一份 identity 在任何地方都算出同一个 id —— 服务端拿它做"用户选的是哪一项"的凭据，
/// 所以**逐字节**一致才有意义。
pub fn protocol_selection_id(
    runtime: &str,
    catalog_type: &str,
    identity: &serde_json::Value,
) -> String {
    let raw = format!(
        "1:{}:{}:{}",
        runtime,
        catalog_type,
        canonical_json(identity)
    );
    let digest = Sha256::digest(raw.as_bytes());
    let b64 = base64url_nopad(&digest);
    let short: String = b64.chars().take(24).collect();
    format!("sel_{}_{}", catalog_type, short)
}

/// base64url（无填充）—— 与 Python 的 `base64.urlsafe_b64encode(...).rstrip("=")` 一致。
pub fn base64url_nopad(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        if c.len() > 1 {
            out.push(T[(n >> 6) as usize & 63] as char);
        }
        if c.len() > 2 {
            out.push(T[n as usize & 63] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_and_envelope_shape() {
        // 请求帧
        let req = AaRpcRequest::new("r1", "catalog.model", serde_json::json!({ "runtime": "dsh" }));
        let js = serde_json::to_string(&req).unwrap();
        assert!(js.contains("\"type\":\"request\""));
        assert!(js.contains("\"id\":\"r1\""));
        assert!(js.contains("\"method\":\"catalog.model\""));
        assert_eq!(parse_frame(&js).unwrap(), AaFrame::Request(req));

        // 应答帧：ok 时不带 error 字段（不是带一个 null）
        let ok = AaRpcResponse::ok("r1", serde_json::json!({ "v": 1 }));
        let ojs = serde_json::to_string(&ok).unwrap();
        assert!(!ojs.contains("error"), "ok 的应答不该有 error 字段：{}", ojs);
        assert_eq!(parse_frame(&ojs).unwrap(), AaFrame::Response(ok));

        // 通知帧：**没有 id**
        let n = AaRpcNotification::new("connector.heartbeat", serde_json::json!({}));
        let njs = serde_json::to_string(&n).unwrap();
        assert!(!njs.contains("\"id\""), "通知帧不该有 id：{}", njs);
        assert_eq!(parse_frame(&njs).unwrap(), AaFrame::Notification(n));

        // 认不出来就报错，不静默吞
        assert!(parse_frame("not json").is_err());
        assert!(parse_frame("{\"type\":\"weird\"}").is_err());
        assert!(parse_frame("{\"id\":\"x\"}").is_err());
    }

    #[test]
    fn handshake_uses_camel_case_like_python() {
        let h = ProtocolHandshakeRequest::for_dsh("2.0.0", "0.9.1");
        let js = serde_json::to_string(&h).unwrap();
        // 字段名必须是 camelCase（Python 的 BaseModel 默认就是字段名原样，
        // 而它定义的是 protocolVersions / connectorVersion / runtimeVersion）
        assert!(js.contains("\"protocolVersions\""));
        assert!(js.contains("\"connectorVersion\""));
        assert!(js.contains("\"runtimeVersion\""));
        assert!(js.contains("\"runtime\":\"dsh\""));
    }

    #[test]
    fn selection_id_matches_independent_reference() {
        // 基准值由**独立实现（Node）**按同一份 Python 语义算出 —— 交叉验证。
        assert_eq!(
            protocol_selection_id("dsh", "model", &serde_json::json!({"id":"mimo-v2.5-pro"})),
            "sel_model_a3a9N1XurexwY5RDxgh1LmaH"
        );
        assert_eq!(
            protocol_selection_id(
                "dsh",
                "permission",
                &serde_json::json!({"id":"ask","label":"请求批准","meta":{"b":1,"a":2}})
            ),
            "sel_permission_DsXUiUHt1Zvn00gArSu87PIR"
        );
        assert_eq!(
            protocol_selection_id("dsh", "model", &serde_json::json!({})),
            "sel_model_mXP3Gbn7dtW7WNxHi3sqGVBy"
        );
        // 形状：sel_<catalog>_<24 字符>
        let s = protocol_selection_id("dsh", "model", &serde_json::json!({"id":"x"}));
        assert!(s.starts_with("sel_model_"));
        assert_eq!(s.len(), "sel_model_".len() + 24);
    }

    #[test]
    fn sorts_keys_provably() {
        // 这条判据是为了让"**我们自己排序**"可被证明。
        // 背景（记档）：`canonical_json(&Value)` 这条路上，serde_json 的 `Map`
        // 在当前构建里本身就是 BTreeMap（键天然有序），所以把排序删掉
        // **判据照样全绿** —— 变异自证当场抓住了这个盲区。
        // 用**明确的插入顺序**当输入，就再也藏不住了。
        let out = canonical_json_of_pairs(&[
            ("z", serde_json::json!(1)),
            ("a", serde_json::json!(2)),
            ("m", serde_json::json!(3)),
        ]);
        assert_eq!(out, "{\"a\":2,\"m\":3,\"z\":1}");
        // 中文键也要参与排序（按码点序，UTF-8 字节序与之一致）
        let out = canonical_json_of_pairs(&[
            ("b", serde_json::json!(1)),
            ("甲", serde_json::json!(2)),
            ("a", serde_json::json!(3)),
        ]);
        assert_eq!(out, "{\"a\":3,\"b\":1,\"甲\":2}");
        // 嵌套也要排（内层由 write_canonical 递归走 pairs 路径）
        let out = canonical_json_of_pairs(&[(
            "k",
            serde_json::json!({"z":1,"a":{"y":1,"b":2}}),
        )]);
        assert_eq!(out, "{\"k\":{\"a\":{\"b\":2,\"y\":1},\"z\":1}}");
        // 空对象
        assert_eq!(canonical_json_of_pairs(&[]), "{}");
    }

    #[test]
    fn canonical_json_sorts_keys_and_keeps_unicode_raw() {        // 键必须递归排序（**不依赖 serde_json 的 Map 顺序**）
        let v = serde_json::json!({"b":1,"a":{"z":2,"y":3},"c":"甲"});
        // 先用 serde_json 自己的序列化看看顺序（这正是不能依赖的东西）
        let via_serde = serde_json::to_string(&v).unwrap();
        let ours = canonical_json(&v);
        assert_eq!(ours, "{\"a\":{\"y\":3,\"z\":2},\"b\":1,\"c\":\"甲\"}");
        // 中文必须**原样**输出（ensure_ascii=False），不是 \uXXXX
        assert!(ours.contains("甲"));
        assert!(!ours.contains("\\u7532"));
        // 紧凑分隔符：没有空格
        assert!(!ours.contains(": "));
        assert!(!ours.contains(", "));
        // 记档：serde_json 自己的顺序**不保证**有序（这里只断言"我们自己的是对的"，
        // 不假设 via_serde 一定乱序 —— 它取决于依赖树里的 feature）
        assert!(via_serde.contains("\"a\""));
    }

    #[test]
    fn canonical_json_escapes_like_python() {
        let v = serde_json::json!({"s":"a\"b\\c\nd\te\u{1}f"});
        assert_eq!(
            canonical_json(&v),
            "{\"s\":\"a\\\"b\\\\c\\nd\\te\\u0001f\"}"
        );
    }

    #[test]
    fn revision_clock_is_strictly_increasing_even_when_time_stands_still() {
        // 时间停住 ⇒ 仍然严格递增（这是它的 last+1 的意义）
        let mut c = RevisionClock::with_source(|| 1000);
        assert_eq!(c.next(), 1000);
        assert_eq!(c.next(), 1001);
        assert_eq!(c.next(), 1002);
        // 时间倒退 ⇒ 也不许倒退
        let mut back = RevisionClock::with_source(|| 5);
        assert_eq!(back.next(), 5);
        assert_eq!(back.next(), 6);
        // 时间跳到很前面 ⇒ 跟上去
        let seq = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1));
        let s2 = seq.clone();
        let mut jump = RevisionClock::with_source(move || s2.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(jump.next(), 1);
        seq.store(9_000_000_000_000, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(jump.next(), 9_000_000_000_000);
        // 上限
        let mut capped = RevisionClock::with_source(|| u64::MAX);
        assert_eq!(capped.next(), PROTOCOL_MAX_REVISION);
    }

    #[test]
    fn capability_set_is_honest_about_what_we_support() {
        let set = build_capability_set(7, "dsh");
        assert_eq!(set.revision, 7);
        // 表里出现过的 id 都要在（不支持的也要明确报出来）
        let ids: Vec<&str> = set.capabilities.iter().map(|c| c.capability_id.as_str()).collect();
        for (id, _) in CAPABILITY_METHODS {
            assert!(ids.contains(id), "能力集里缺少 {}（必须显式报 supported:false）", id);
        }
        // 声称支持的必须与常量表一致
        for c in &set.capabilities {
            let expect = OUR_SUPPORTED_CAPABILITIES.contains(&c.capability_id.as_str());
            assert_eq!(c.supported, expect, "{} 的 supported 与清单不符", c.capability_id);
            // 不支持时必须给理由（否则服务端只能猜）
            if !c.supported {
                assert!(c.unavailable_reason.is_some(), "{} 不支持却没给理由", c.capability_id);
            }
        }
    }

    #[test]
    fn interaction_status_machine_matches_protocol() {
        // 它的八个状态一个都不能少
        assert_eq!(INTERACTION_STATUSES.len(), 8);
        for s in ["open", "responding", "response_accepted", "resolving"] {
            assert!(status_is_pending(s), "{} 应算未结束", s);
            assert!(!status_is_terminal(s));
        }
        for s in ["resolved", "expired", "cancelled", "failed"] {
            assert!(status_is_terminal(s), "{} 应算已落定", s);
            assert!(!status_is_pending(s));
        }
        // pending 与 terminal 必须**覆盖全部且互斥**（漏一个状态就会有人永远等下去）
        for s in INTERACTION_STATUSES {
            assert!(
                status_is_pending(s) ^ status_is_terminal(s),
                "{} 必须恰好属于 pending 或 terminal 之一",
                s
            );
        }
        assert_eq!(NOTICE_TYPES.len(), 2);
        assert_eq!(ACTION_STYLES.len(), 4);
    }

    #[test]
    fn base64url_matches_known_vectors() {
        // 与 Node 的 base64url 对照
        assert_eq!(base64url_nopad(b""), "");
        assert_eq!(base64url_nopad(b"f"), "Zg");
        assert_eq!(base64url_nopad(b"fo"), "Zm8");
        assert_eq!(base64url_nopad(b"foo"), "Zm9v");
        assert_eq!(base64url_nopad(b"foob"), "Zm9vYg");
        assert_eq!(base64url_nopad(b"fooba"), "Zm9vYmE");
        assert_eq!(base64url_nopad(b"foobar"), "Zm9vYmFy");
        // url-safe 字母表：+ / 换成 - _
        assert!(!base64url_nopad(&[0xfb, 0xff]).contains('+'));
    }

    #[test]
    fn runtime_names_include_dsh() {
        // 我们复刻的是 DSH 那一支；这个名单也要能容纳它的其他运行时
        assert!(RUNTIME_NAMES.contains(&"dsh"));
        assert!(RUNTIME_NAMES.contains(&"claude"));
        assert!(RUNTIME_NAMES.contains(&"codex"));
        // 且**不限于** runtimes/ 目录里那三个（协议里还有这两个）
        assert!(RUNTIME_NAMES.contains(&"opencode"));
        assert!(RUNTIME_NAMES.contains(&"acp"));
    }

    #[test]
    fn notice_enums_match_the_protocol() {
        // 通知的种类与严重度是**线上契约**的一部分（服务端按它渲染），不许随手改
        assert_eq!(NOTICE_TYPES, &["notification", "interaction"]);
        assert_eq!(NOTICE_SEVERITIES, &["info", "success", "warning", "error"]);
        assert_eq!(ACTION_STYLES, &["primary", "secondary", "danger", "default"]);
    }

    #[test]
    fn catalog_wire_shape_is_pinned() {
        // 这两个目录是 R3 要发出去的东西。现在就把**线上形状**钉住，
        // 免得 R3 接线时才发现字段名或大小写不对（那种错要到连上真服务端才暴露）。
        let model = ProtocolModelCatalog {
            runtime: "dsh".into(),
            revision: 42,
            models: vec![ProtocolModelItem {
                display_name: "MiMo v2.5 Pro".into(),
                id: "mimo-v2.5-pro".into(),
                selection_id: Some(protocol_selection_id(
                    "dsh",
                    "model",
                    &serde_json::json!({"id":"mimo-v2.5-pro"}),
                )),
                description: None,
                default: true,
                reasoning_items: vec![],
                metadata: serde_json::json!({}),
            }],
        };
        let js = serde_json::to_string(&model).unwrap();
        // 字段名必须是 camelCase（它那边是 Pydantic 的字段名原样）
        for k in ["runtime", "revision", "models", "displayName", "selectionId", "reasoningItems"] {
            assert!(js.contains(&format!("\"{}\"", k)), "模型目录缺字段 {}：{}", k, js);
        }
        // 可选字段缺省时**不许**发 null（Python 那边是 Optional，缺省即省略）
        assert!(!js.contains("\"description\":null"), "可选字段不该发 null：{}", js);
        // selectionId 必须派生自**同一个函数**（不是随手编的字符串）
        assert!(js.contains("sel_model_"));

        let perm = ProtocolPermissionCatalog {
            runtime: "dsh".into(),
            revision: 43,
            permissions: vec![ProtocolPermissionItem {
                display_name: "请求批准".into(),
                id: "ask".into(),
                selection_id: protocol_selection_id(
                    "dsh",
                    "permission",
                    &serde_json::json!({"id":"ask"}),
                ),
                description: Some("每次都问".into()),
                default: true,
                metadata: serde_json::json!({}),
            }],
        };
        let pjs = serde_json::to_string(&perm).unwrap();
        for k in ["runtime", "revision", "permissions", "displayName", "selectionId"] {
            assert!(pjs.contains(&format!("\"{}\"", k)), "权限目录缺字段 {}：{}", k, pjs);
        }
        assert!(pjs.contains("sel_permission_"));
        // 中文描述必须**原样**输出（不转义），与 ensure_ascii=False 一致
        assert!(pjs.contains("每次都问"));
    }
}
