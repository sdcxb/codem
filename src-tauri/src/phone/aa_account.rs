// ============================================================
// phone/aa_account.rs — 账号登录 + 把本机注册成一台设备（阶段 N1–N3）
//
// **这一层是我先前漏掉的那一段。** 我原来只实现了"connector 拿凭据去连"
// （R1–R5），然后让用户自己去准备 `connectorId` / `connectorToken` ——
// 那是**把插件该做的事推给了用户**。用户看到的就是
// "为什么我要买服务端？DSH 登录一下就能用啊"。
//
// ## 它的实际登录流程（逐行有据）
//
// 1. 起一个**本机回环** HTTP 监听（随机端口）当 OAuth 回调地址
//    （`host/onboarding/loopback.ts:34-40`）
// 2. 生成 PKCE：`state=randomBytes(32).base64url`、
//    `verifier=randomBytes(48).base64url`、`challenge=sha256(verifier).base64url`
//    （`loopback.ts:11-13,42`）
// 3. 拼**授权 URL**：它在 **Web 端的哈希路由**上，不是普通 path：
//    `${webBaseUrl}/#/plugin-oauth?response_type=code&client_id=…&redirect_uri=…&
//      code_challenge=…&code_challenge_method=S256&scope=profile&state=…`
//    （`loopback.ts:41-49`）
// 4. 浏览器登录完，回调打到 `http://127.0.0.1:<port>/oauth/callback?code=…&state=…`
// 5. 用 code+verifier 换 token：`POST {api}/api/v2/oauth/token`
//    （`host/account/api.ts:60-66`，表单编码）
// 6. 读账号：`GET /api/v2/auth/me`
// 7. **注册本机**：`POST /api/v2/connectors`
//    `{name, connectorKind:'cli', installationId}` ⇒ `{connector, connectorToken}`
//    （`api.ts:89-98`）
// 8. 用第 7 步的凭据启动 connector（已实现，见 `aa_connector.rs`）
//
// ## 回环那台小服务器的安全检查（照抄，别省）
//
// `loopback.ts:66-71`：`Host` 头必须与本机 origin 一致（防 DNS rebinding）、
// 只允许 GET、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、
// `X-Content-Type-Options: nosniff`，回调用**恒定时间**比 `state`。
// 这些和我们在手机边缘上做的**是同一类防护** —— 回环端口同样会被网页访问到。
// ============================================================

// 这是**登录流程**（N1–N4）的构件层：PKCE、授权 URL、回调解析、回环安全检查、
// 以及换 token / 读账号 / 注册本机这三个 HTTP 调用。
//
// 它**暂时没有生产调用方**，因为把这些接成命令与界面（N1–N4 的最后一公里）
// 是**下一步**的工作。所以这里用模块级 allow 而不是删掉：
// 删掉等于把已经读通、已经判据钉住的规格丢掉，而它正是那一步的依据。
//
// 与 `aa_protocol.rs` 同一处理方式，理由也同一类。**有生产调用方之后就该撤掉它。**
#![allow(dead_code)]


use std::collections::BTreeMap;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 它注册的 OAuth 客户端标识（`contracts/index.ts:8`）。
///
/// ⚠️ 这是**它 DSH 插件的身份**。我们默认用它是为了"开箱即用、与 DSH 行为一致"，
/// 但它不是我们的 —— 所以做成**可配置**（`AaAccountConfig::client_id`）。
pub const AA_OAUTH_CLIENT_ID: &str = "agents-anywhere-dsh-plugin";
/// 授权 scope（`loopback.ts:44`）。
pub const AA_OAUTH_SCOPE: &str = "profile";
/// 回调路径（`loopback.ts:35`）。
pub const AA_OAUTH_CALLBACK_PATH: &str = "/oauth/callback";
/// 登录整体超时（`loopback.ts:33`：10 分钟）。
pub const AA_LOGIN_TIMEOUT_MS: u64 = 10 * 60_000;

fn b64url(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// PKCE 三元组（`loopback.ts:11-13,42`）。
#[derive(Debug, Clone, PartialEq)]
pub struct Pkce {
    pub state: String,
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// 从给定的随机字节造一份（判据用：可以喂**确定性**输入）。
    pub fn from_entropy(state_bytes: &[u8], verifier_bytes: &[u8]) -> Self {
        let verifier = b64url(verifier_bytes);
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
        Pkce {
            state: b64url(state_bytes),
            verifier,
            challenge,
        }
    }

    /// 用**已经成形的 verifier 文本**造一份（判据用）。
    ///
    /// 与 `from_entropy` 的区别很重要：那个把输入当**原始随机字节**再编码，
    /// 而这个把输入当**已编码的 verifier**。RFC 7636 给的是后者 ——
    /// 我第一版在判据里用错了构造器，于是拿到的是"把 ASCII 再编一次"的结果。
    pub fn from_verifier(state: &str, verifier: &str) -> Self {
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
        Pkce {
            state: state.to_string(),
            verifier: verifier.to_string(),
            challenge,
        }
    }

    /// 用系统 CSPRNG 造一份：state 32 字节、verifier 48 字节。
    pub fn generate() -> Result<Self, String> {
        use ring::rand::{SecureRandom, SystemRandom};
        let rng = SystemRandom::new();
        let mut s = [0u8; 32];
        let mut v = [0u8; 48];
        rng.fill(&mut s).map_err(|_| "取随机数失败".to_string())?;
        rng.fill(&mut v).map_err(|_| "取随机数失败".to_string())?;
        Ok(Pkce::from_entropy(&s, &v))
    }
}

/// 授权 URL（`loopback.ts:41-49`）。
///
/// ⚠️ 两个容易搞错的地方：
/// 1. 它在 **Web 端的哈希路由**上（`/#/plugin-oauth?…`），不是 `{api}/oauth/authorize`；
/// 2. `web_base_url` 是**去掉 `/api/v2` 的站点 origin**（`resolveOAuthWebOrigin`）。
///
/// 参数顺序也照抄它的字面顺序 —— 服务端不该依赖顺序，但**照抄能减少差异**。
pub fn authorization_url(
    web_base_url: &str,
    client_id: &str,
    redirect_uri: &str,
    pkce: &Pkce,
) -> Result<String, String> {
    let mut base = web_base_url.trim_end_matches('/').to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err(format!("web_base_url 必须是 http(s) 地址：{}", web_base_url));
    }
    base = base.trim_end_matches('/').to_string();
    // 哈希路由（`#/plugin-oauth`）—— 用 URLSearchParams 的编码规则
    let q = form_urlencode(&[
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("code_challenge", &pkce.challenge),
        ("code_challenge_method", "S256"),
        ("scope", AA_OAUTH_SCOPE),
        ("state", &pkce.state),
    ]);
    Ok(format!("{}/#/plugin-oauth?{}", base, q))
}

/// `application/x-www-form-urlencoded` 编码（JS `URLSearchParams` 的规则）。
///
/// 空格编成 `+`（不是 `%20`）—— 这是表单编码与路径编码的区别，
/// 而它用的正是 `URLSearchParams`。
pub fn form_urlencode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", form_escape(k), form_escape(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn form_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 换 token 的表单体（`host/account/api.ts:61-64`）。
///
/// 注意它**没有**带 `client_secret`（公开客户端 + PKCE），且 grant_type 是
/// `authorization_code`。
pub fn token_exchange_form(client_id: &str, code: &str, verifier: &str, redirect_uri: &str) -> String {
    form_urlencode(&[
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ])
}

/// 注册本机的请求体（`host/account/api.ts:89-98`）。
pub fn register_body(name: &str, installation_id: &str) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        // 它写死 `cli`（`api.ts:93`）—— 这是个**类型标记**，不是我们的选择
        "connectorKind": "cli",
        "installationId": installation_id,
    })
}

// ---------------- 换 token / 读账号 / 注册本机 ----------------

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_in: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AaAccountProfile {
    pub user_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
}

impl AaAccountProfile {
    /// 从它的 `/auth/me` 响应里取（字段名按 `AccountProfile`）。
    pub fn from_json(v: &serde_json::Value) -> Result<Self, String> {
        let user_id = v
            .get("userId")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "账号响应里没有 userId".to_string())?;
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
        Ok(AaAccountProfile {
            user_id: user_id.to_string(),
            display_name: s("displayName").or_else(|| s("name")),
            email: s("email"),
            // 头像只接受它约定的 data-image（`api.ts:29`）—— 其它一律丢掉，
            // 免得把远端给的任意 URL 当成图片加载
            avatar: s("avatar").filter(|a| {
                a.starts_with("data:image/png;base64,")
                    || a.starts_with("data:image/jpeg;base64,")
                    || a.starts_with("data:image/jpg;base64,")
                    || a.starts_with("data:image/webp;base64,")
                    || a.starts_with("data:image/gif;base64,")
            }),
        })
    }
}

/// 本机已注册的设备凭据。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AaDeviceCredential {
    pub connector_id: String,
    pub connector_token: String,
}

impl AaDeviceCredential {
    /// 从 `POST /connectors` 的响应里取（`api.ts:95-97`）。
    pub fn from_json(v: &serde_json::Value) -> Result<Self, String> {
        let id = v
            .get("connector")
            .and_then(|c| c.get("id"))
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "设备注册响应里没有 connector.id".to_string())?;
        let token = v
            .get("connectorToken")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "设备注册响应里没有 connectorToken".to_string())?;
        Ok(AaDeviceCredential {
            connector_id: id.to_string(),
            connector_token: token.to_string(),
        })
    }
}

/// 从授权站点地址推出 **Web 端 origin**（`contracts/web-address.ts:2-6`）。
///
/// 它还带一条**开发模式**规则：`127.0.0.1:8000` ⇒ `127.0.0.1:5174`。
/// 照抄它，否则本地自建时登录页会指到 API 端口上（那里没有登录页）。
pub fn resolve_web_origin(api_base_url: &str) -> Result<String, String> {
    let u = url::Url::parse(api_base_url).map_err(|e| format!("地址不合法: {}", e))?;
    let host = u.host_str().unwrap_or("");
    let is_loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
    if is_loopback && u.port() == Some(8000) {
        let mut v = u.clone();
        v.set_port(Some(5174)).map_err(|_| "改端口失败".to_string())?;
        return Ok(v.origin().ascii_serialization());
    }
    Ok(u.origin().ascii_serialization())
}

/// 回调查询串（`code` / `state` / `error`）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// 解析回调的查询串（纯函数，判据可直接喂字符串）。
pub fn parse_callback(query: &str) -> CallbackParams {
    let mut out = CallbackParams::default();
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        let val = percent_decode(v);
        match k {
            "code" => out.code = Some(val),
            "state" => out.state = Some(val),
            "error" => out.error = Some(val),
            _ => {}
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 回环回调服务器的安全检查（`loopback.ts:66-71`）。
///
/// 返回 `None` 表示"这个请求合法，可以处理"；返回 `Some(status)` 表示要拒绝。
/// 做成纯函数是为了**能直接喂构造出来的请求头**做判据 ——
/// 这些检查每一条都对应一个真实的攻击面，不该只在跑起来之后才被测到。
pub fn loopback_guard(
    method: &str,
    host_header: Option<&str>,
    expected_host: &str,
) -> Option<(u16, &'static str)> {
    // Host 必须与本机 origin 一致 ⇒ 挡住 DNS rebinding
    if host_header != Some(expected_host) {
        return Some((403, "bad host"));
    }
    if method != "GET" {
        return Some((405, "method not allowed"));
    }
    None
}

/// 恒定时间比较（回调用它比 `state`，`loopback.ts` 里用的是 `timingSafeEqual`）。
pub fn timing_safe_eq(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    // 长度不同直接 false —— 长度的差异本身不算秘密（与它 timingSafeEqual 的行为一致）
    if x.len() != y.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..x.len() {
        diff |= x[i] ^ y[i];
    }
    diff == 0
}

/// 持久化的账号态（`<app-data>/phone/aa-account.json`）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AaAccountState {
    pub server_url: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub expires_at_ms: Option<u64>,
    #[serde(default)]
    pub profile: Option<AaAccountProfile>,
    #[serde(default)]
    pub device: Option<AaDeviceCredential>,
}

impl AaAccountState {
    pub fn client_id(&self) -> &str {
        self.client_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(AA_OAUTH_CLIENT_ID)
    }

    /// token 还有效吗（**留 60 秒余量**，与它的刷新习惯一致）。
    pub fn token_valid(&self, now_ms: u64) -> bool {
        match (&self.access_token, self.expires_at_ms) {
            (Some(t), Some(exp)) => !t.is_empty() && now_ms + 60_000 < exp,
            _ => false,
        }
    }

    /// 去掉敏感字段的视图（给界面用）。
    ///
    /// **绝不**把 `accessToken` / `connectorToken` 发给前端：
    /// 界面只需要知道"有没有"，不需要拿着它们 —— 少一个泄漏面。
    pub fn redacted(&self, now_ms: u64) -> serde_json::Value {
        serde_json::json!({
            "serverUrl": self.server_url,
            "clientId": self.client_id(),
            "signedIn": self.access_token.is_some(),
            "tokenValid": self.token_valid(now_ms),
            "profile": self.profile,
            "deviceId": self.device.as_ref().map(|d| d.connector_id.clone()),
            // 只报"有没有"，不报内容
            "hasDeviceToken": self.device.as_ref().map(|d| !d.connector_token.is_empty()).unwrap_or(false),
        })
    }
}

/// 凭据持久化用的键（与它 `connector.json` 的字段名一致，便于互认）。
pub fn connector_config_json(server_url: &str, cred: &AaDeviceCredential) -> BTreeMap<String, serde_json::Value> {
    let mut m = BTreeMap::new();
    m.insert("serverUrl".into(), serde_json::json!(server_url));
    m.insert("connectorId".into(), serde_json::json!(cred.connector_id));
    m.insert("connectorToken".into(), serde_json::json!(cred.connector_token));
    m
}

// ---------------- HTTP：换 token / 读账号 / 注册本机（N1–N3）----------------

/// `POST {api}/api/v2/oauth/token`（表单编码，PKCE 公开客户端）。
pub async fn exchange_code(
    client: &reqwest::Client,
    api_base_url: &str,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<(String, f64), String> {
    let resp = client
        .post(format!("{}/api/v2/oauth/token", api_base_url.trim_end_matches('/')))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(token_exchange_form(client_id, code, verifier, redirect_uri))
        .send()
        .await
        .map_err(|e| format!("换 token 请求失败: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("换 token 被拒（HTTP {}）", status.as_u16()));
    }
    let b: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("token 响应不可解析: {}", e))?;
    if b.access_token.is_empty() {
        return Err("服务端返回了空 access_token".into());
    }
    Ok((b.access_token, b.expires_in))
}

/// `GET {api}/api/v2/auth/me`。
pub async fn fetch_me(
    client: &reqwest::Client,
    api_base_url: &str,
    access_token: &str,
) -> Result<AaAccountProfile, String> {
    let resp = client
        .get(format!("{}/api/v2/auth/me", api_base_url.trim_end_matches('/')))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("读账号失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("读账号被拒（HTTP {}）", resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("账号响应不可解析: {}", e))?;
    AaAccountProfile::from_json(&v)
}

/// `POST {api}/api/v2/connectors` —— **把本机注册成一台设备**（`api.ts:89-98`）。
///
/// 这一步就是我先前漏掉的那一段：`connectorToken` 是**这里换来的**，
/// 不是让用户手工准备的。
pub async fn register_connector(
    client: &reqwest::Client,
    api_base_url: &str,
    access_token: &str,
    name: &str,
    installation_id: &str,
) -> Result<AaDeviceCredential, String> {
    let resp = client
        .post(format!("{}/api/v2/connectors", api_base_url.trim_end_matches('/')))
        .bearer_auth(access_token)
        .json(&register_body(name, installation_id))
        .send()
        .await
        .map_err(|e| format!("注册本机失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("注册本机被拒（HTTP {}）", resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("注册响应不可解析: {}", e))?;
    AaDeviceCredential::from_json(&v)
}

/// 它的云地址（`host/index.ts:9` 的 `CLOUD_API_BASE_URL`）。
///
/// 这是 DSH 的**默认值**，我们照抄 —— 所以界面上"云端"是默认选项，
/// 用户不需要填任何地址。
pub const AA_CLOUD_BASE_URL: &str = "https://web.agents-anywhere.com";

/// 把用户填的地址规范化成 API 根（允许只填域名、允许带 `/api/v2`）。
///
/// 为什么值得单独一个函数：填地址是**最容易出错**的一步
/// （多一个斜杠、带了 `/api/v2`、带了末尾路径）。这里统一收口，
/// 于是后面所有拼接都不用再想这件事。
pub fn normalize_api_base(input: &str) -> Result<String, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("服务器地址不能为空".into());
    }
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("https://{}", raw) };
    let u = url::Url::parse(&with_scheme).map_err(|_| format!("服务器地址不合法：{}", input))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("服务器地址必须是 http(s)".into());
    }
    if u.host_str().unwrap_or("").is_empty() {
        return Err("服务器地址缺少主机名".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("服务器地址里不要带账号密码".into());
    }
    Ok(u.origin().ascii_serialization().trim_end_matches('/').to_string())
}

// ---------------- 邮箱 + 密码登录（最简单的那条）----------------
//
// 为什么**不用**它插件那套 OAuth（PKCE + 回环回调）：
//
// 1. 服务端本身就支持邮箱+密码（`POST /api/v2/auth/register` 与 `/auth/login`），
//    我在这台真服务端上就是用这条建的管理员；
// 2. OAuth 那条路要用**它插件的 client id**（`agents-anywhere-dsh-plugin`）——
//    那是它的身份，不是我们的；
// 3. 用户要的是"不要太复杂"：邮箱+密码是一屏能说清的事，
//    而 PKCE + 回环监听 + 授权 URL 不是。
//
// `Pkce` / `authorization_url` / 回环那几件**保留**（已写好并有判据），
// 作为将来的备选路线，但**默认不走**。

#[derive(Debug, Deserialize)]
struct AuthResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
}

/// `POST /api/v2/auth/login`。
pub async fn login_with_password(
    client: &reqwest::Client,
    api_base: &str,
    email: &str,
    password: &str,
) -> Result<String, String> {
    auth_post(
        client,
        api_base,
        "/api/v2/auth/login",
        serde_json::json!({ "email": email, "password": password }),
    )
    .await
}

/// `POST /api/v2/auth/register`（首次没有账号时用）。
///
/// `setup_token` 只在**自建服务端首次运行**时需要（它把 token 打在服务端日志里）。
/// 云端注册不需要。
pub async fn register_with_password(
    client: &reqwest::Client,
    api_base: &str,
    email: &str,
    password: &str,
    display_name: Option<&str>,
    setup_token: Option<&str>,
) -> Result<String, String> {
    let mut body = serde_json::json!({ "email": email, "password": password });
    if let Some(n) = display_name.filter(|s| !s.trim().is_empty()) {
        body["displayName"] = serde_json::json!(n);
    }
    if let Some(t) = setup_token.filter(|s| !s.trim().is_empty()) {
        body["setupToken"] = serde_json::json!(t);
    }
    auth_post(client, api_base, "/api/v2/auth/register", body).await
}

/// `POST /api/v2/auth/email-code` —— 请求一封验证码邮件。
///
/// **什么时候需要它**：服务端启用了邮件验证时（`get_email_settings().enabled`），
/// 注册/绑定就必须要一个 6 位码（`require_verification`）。
/// 首次运行的自建服务端通常**没有**配邮件服务，所以不需要它。
///
/// 我们把它接上，否则遇到"要验证码"的服务端时，用户会卡在一个
/// **他没有入口去拿**的字段上 —— 和这次 `displayName` 是同一类问题。
pub async fn send_email_code(
    client: &reqwest::Client,
    api_base: &str,
    email: &str,
    purpose: &str,
) -> Result<(), String> {
    let resp = client
        .post(format!("{}/api/v2/auth/email-code", api_base.trim_end_matches('/')))
        .json(&serde_json::json!({ "email": email, "purpose": purpose }))
        .send()
        .await
        .map_err(|e| format!("发送验证码失败: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("{}（HTTP {}）", msg, status.as_u16()));
    }
    Ok(())
}

async fn auth_post(
    client: &reqwest::Client,
    api_base: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<String, String> {
    let resp = client
        .post(format!("{}{}", api_base.trim_end_matches('/'), path))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // 把服务端的话**原样带出来**：它比我们能编的话准确
        //（"密码不对" / "邮箱未验证" / "setup token 无效" 是三件不同的事）
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("{}（HTTP {}）", msg, status.as_u16()));
    }
    let parsed: AuthResponse =
        serde_json::from_str(&text).map_err(|e| format!("登录响应不可解析: {}", e))?;
    if parsed.access_token.is_empty() {
        return Err("服务端返回了空 accessToken".into());
    }
    Ok(parsed.access_token)
}

// ---------------- 账号态持久化 ----------------

/// 账号态文件（`<app-data>/phone/aa-account.json`）。
pub fn account_state_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("aa-account.json")
}

/// 读；文件不存在或坏了都返回 `None`（**不报错**：首次运行是正常状态）。
pub fn load_account_state(dir: &std::path::Path) -> Option<AaAccountState> {
    let raw = std::fs::read_to_string(account_state_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 写账号态（含令牌）。
pub fn save_account_state(dir: &std::path::Path, st: &AaAccountState) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {}", e))?;
    let json = serde_json::to_string_pretty(st).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(account_state_path(dir), json).map_err(|e| format!("写账号态失败: {}", e))
}

/// 账号态的**内存 + 落盘**封装。
///
/// 为什么要它而不是每次读写文件：界面会在几处读状态（显示账号、显示连接阶段），
/// 每次都读文件既慢又可能读到半个写。内存里一份、写的时候落盘即可。
pub struct AaAccountStore {
    dir: std::path::PathBuf,
    state: tokio::sync::Mutex<Option<AaAccountState>>,
}

impl AaAccountStore {
    /// 构造时**不读盘**（读盘可能失败，不该拖住应用启动）；第一次 `get` 时懒加载。
    pub fn new(dir: std::path::PathBuf) -> std::sync::Arc<Self> {
        std::sync::Arc::new(AaAccountStore {
            dir,
            state: tokio::sync::Mutex::new(None),
        })
    }

    pub async fn get(&self) -> Option<AaAccountState> {
        let mut g = self.state.lock().await;
        if g.is_none() {
            *g = load_account_state(&self.dir);
        }
        g.clone()
    }

    pub async fn set(&self, st: AaAccountState) -> Result<(), String> {
        save_account_state(&self.dir, &st)?;
        *self.state.lock().await = Some(st);
        Ok(())
    }

    pub async fn clear(&self) -> Result<(), String> {
        let path = account_state_path(&self.dir);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("删除账号态失败: {}", e))?;
        }
        *self.state.lock().await = None;
        Ok(())
    }

    /// 只改设备凭据（登录态不变）—— "注册本机"那一步用。
    pub async fn set_device(&self, cred: AaDeviceCredential) -> Result<AaAccountState, String> {
        let mut st = self.get().await.ok_or_else(|| "请先登录".to_string())?;
        st.device = Some(cred);
        self.set(st.clone()).await?;
        Ok(st)
    }

    /// 安装标识文件（同一台机器上应当**稳定**，它那边用来避免重复注册）。
    pub fn installation_id_path(&self) -> std::path::PathBuf {
        self.dir.join("aa-installation-id")
    }

    /// 账号态目录（给命令层拼别的文件用）。
    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_vector() {
        // RFC 7636 附录 B 的官方测试向量。

        // 为什么值得钉：PKCE 的 challenge 算法错一点（比如对 **base64url 文本**
        // 求 sha256 而不是对 verifier 本身、或者用了带填充的 base64），
        // 表现只是"登录时服务端说 code_challenge 不对" —— 而那是授权服务器给的
        // 一句含糊报错，很难归因到"我们哈希错了"。
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);

        // 同一个 verifier 走 from_verifier 也要一致。
        // ⚠️ 这里必须用 `from_verifier`（把输入当**已编码的 verifier**），
        // 不能用 `from_entropy`（把输入当**原始随机字节**再编码）——
        // 我第一版用错了构造器，拿到的是"把那段 ASCII 再编一次"的结果，
        // 判据红得对，是**我**搞错了语义。
        let p = Pkce::from_verifier("STATE", verifier);
        assert_eq!(p.verifier, verifier);
        assert_eq!(p.challenge, expected);
    }

    #[test]
    fn pkce_generate_has_expected_lengths_and_is_fresh() {
        let a = Pkce::generate().unwrap();
        let b = Pkce::generate().unwrap();
        // 32 字节 → 43 个 base64url 字符；48 字节 → 64 个
        assert_eq!(a.state.len(), 43, "state 应是 32 字节的 base64url");
        assert_eq!(a.verifier.len(), 64, "verifier 应是 48 字节的 base64url");
        assert_eq!(a.challenge.len(), 43, "challenge 是 32 字节摘要");
        // 无填充
        assert!(!a.verifier.contains('=') && !a.state.contains('='));
        // 每次都不同（防止"忘了取随机数"这种低级错）
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.state, b.state);
        // 字符集只能是 url-safe 的
        assert!(a.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn authorization_url_uses_the_hash_route() {
        let p = Pkce::from_entropy(b"STATE", b"VERIFIER");
        let url = authorization_url(
            "https://web.agents-anywhere.com",
            AA_OAUTH_CLIENT_ID,
            "http://127.0.0.1:53211/oauth/callback",
            &p,
        )
        .unwrap();
        // 最要紧的一条：它在 **Web 端的哈希路由**上（`/#/plugin-oauth?…`），
        // 不是 `{api}/oauth/authorize`。
        // 搞错这一点的表现是"浏览器打开一个 404 页面"，
        // 而代码本身看起来完全合理。
        assert!(url.starts_with("https://web.agents-anywhere.com/#/plugin-oauth?"), "{}", url);
        // 七个参数一个都不能少
        for k in [
            "response_type=code",
            "client_id=agents-anywhere-dsh-plugin",
            "code_challenge_method=S256",
            "scope=profile",
        ] {
            assert!(url.contains(k), "授权 URL 缺少 {}：{}", k, url);
        }
        assert!(url.contains(&format!("code_challenge={}", p.challenge)));
        assert!(url.contains(&format!("state={}", p.state)));
        // redirect_uri 里的 `:` 与 `/` 必须被转义（否则参数会断成两半）
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A53211%2Foauth%2Fcallback"), "{}", url);
        // 末尾斜杠容错
        let url2 = authorization_url("https://x.example.com/", "c", "http://127.0.0.1:1/cb", &p).unwrap();
        assert!(url2.starts_with("https://x.example.com/#/plugin-oauth?"));
        // 非法地址要报错，而不是拼出一个畸形 URL
        assert!(authorization_url("ftp://x", "c", "r", &p).is_err());
        assert!(authorization_url("", "c", "r", &p).is_err());
    }

    #[test]
    fn form_encoding_matches_urlsearchparams() {
        // `URLSearchParams` 的空格是 `+`，且 `*` 不转义 —— 与路径编码不同
        assert_eq!(form_escape("a b"), "a+b");
        assert_eq!(form_escape("a*b"), "a*b");
        assert_eq!(form_escape("a/b"), "a%2Fb");
        assert_eq!(form_escape("a:b"), "a%3Ab");
        let form = token_exchange_form("cid", "the code", "ver", "http://127.0.0.1:1/cb");
        // grant_type 必须是最前面那个（它的字面顺序）
        assert!(form.starts_with("grant_type=authorization_code&client_id=cid&"), "{}", form);
        assert!(form.contains("code=the+code"), "空格要编成 +：{}", form);
        assert!(form.contains("code_verifier=ver"));
        assert!(form.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcb"));
    }

    #[test]
    fn register_body_uses_its_field_names() {
        let b = register_body("我的电脑", "inst-1");
        assert_eq!(b.get("connectorKind").and_then(|v| v.as_str()), Some("cli"));
        assert_eq!(b.get("installationId").and_then(|v| v.as_str()), Some("inst-1"));
        assert_eq!(b.get("name").and_then(|v| v.as_str()), Some("我的电脑"));
    }

    #[test]
    fn device_credential_parsing_requires_both_fields() {
        let ok = serde_json::json!({"connector":{"id":"c1","name":"n","userId":"u"},"connectorToken":"t1"});
        let c = AaDeviceCredential::from_json(&ok).unwrap();
        assert_eq!(c.connector_id, "c1");
        assert_eq!(c.connector_token, "t1");
        // 缺哪个都要报错（不许猜、不许留空）
        assert!(AaDeviceCredential::from_json(&serde_json::json!({"connector":{"id":"c1"}})).is_err());
        assert!(AaDeviceCredential::from_json(&serde_json::json!({"connectorToken":"t"})).is_err());
        assert!(AaDeviceCredential::from_json(&serde_json::json!({"connector":{"id":""},"connectorToken":"t"})).is_err());
        assert!(AaDeviceCredential::from_json(&serde_json::json!({"connector":{"id":"c"},"connectorToken":""})).is_err());
    }

    #[test]
    fn profile_parsing_and_avatar_allowlist() {
        let p = AaAccountProfile::from_json(&serde_json::json!({
            "userId":"u1","displayName":"张三","email":"a@b.c",
            "avatar":"data:image/png;base64,AAAA"
        }))
        .unwrap();
        assert_eq!(p.user_id, "u1");
        assert_eq!(p.display_name.as_deref(), Some("张三"));
        assert!(p.avatar.is_some());
        // 非 data-image 的头像**一律丢掉**（不许把远端给的任意 URL 当图片加载）
        let p2 = AaAccountProfile::from_json(&serde_json::json!({
            "userId":"u1","avatar":"https://evil.example.com/x.png"
        }))
        .unwrap();
        assert!(p2.avatar.is_none());
        assert!(AaAccountProfile::from_json(&serde_json::json!({"displayName":"x"})).is_err());
    }

    #[test]
    fn web_origin_dev_port_rule() {
        // 它的开发模式规则：127.0.0.1:8000 ⇒ 5174（那个端口上才有登录页）
        assert_eq!(resolve_web_origin("http://127.0.0.1:8000").unwrap(), "http://127.0.0.1:5174");
        assert_eq!(resolve_web_origin("http://localhost:8000").unwrap(), "http://localhost:5174");
        // 其它端口原样
        assert_eq!(resolve_web_origin("http://127.0.0.1:9000").unwrap(), "http://127.0.0.1:9000");
        assert_eq!(
            resolve_web_origin("https://web.agents-anywhere.com/api/v2").unwrap(),
            "https://web.agents-anywhere.com"
        );
        assert!(resolve_web_origin("not a url").is_err());
    }

    #[test]
    fn callback_parsing_and_errors() {
        let c = parse_callback("code=abc%2Fdef&state=s1");
        assert_eq!(c.code.as_deref(), Some("abc/def"));
        assert_eq!(c.state.as_deref(), Some("s1"));
        assert!(c.error.is_none());
        // 错误回调（用户拒绝授权）
        let e = parse_callback("error=access_denied&state=s1");
        assert_eq!(e.error.as_deref(), Some("access_denied"));
        assert!(e.code.is_none());
        // 空查询串不崩
        assert_eq!(parse_callback(""), CallbackParams::default());
        // `+` 解成空格
        assert_eq!(parse_callback("state=a+b").state.as_deref(), Some("a b"));
    }

    #[test]
    fn loopback_guard_blocks_rebinding_and_non_get() {
        let host = "127.0.0.1:53211";
        // 正常请求
        assert_eq!(loopback_guard("GET", Some(host), host), None);
        // Host 不匹配 ⇒ 403。这是**防 DNS rebinding** 的那一条：
        // 恶意页面可以把某个域名解析到 127.0.0.1，于是浏览器会带着
        // 那个域名去访问我们的回环端口 —— 而 Host 头会暴露它是谁。
        assert_eq!(loopback_guard("GET", Some("evil.example.com"), host), Some((403, "bad host")));
        assert_eq!(loopback_guard("GET", None, host), Some((403, "bad host")));
        // 只允许 GET
        assert_eq!(loopback_guard("POST", Some(host), host), Some((405, "method not allowed")));
    }

    #[test]
    fn timing_safe_eq_is_correct() {
        assert!(timing_safe_eq("abc", "abc"));
        assert!(!timing_safe_eq("abc", "abd"));
        assert!(!timing_safe_eq("abc", "ab"));
        assert!(!timing_safe_eq("", "a"));
        assert!(timing_safe_eq("", ""));
        // 反向判据：**循环内部不许提前返回**。

        // ⚠️ 这条判据我第一版写成"整个函数里不许出现 `return false;`" —— 那是错的：
        // 长度不等时**本来就该**立刻返回（长度的差异不算秘密，与它 `timingSafeEqual`
        // 的行为一致）。所以判据只能盯**累积比较那一段**：
        // 真正的错误写法是在循环里遇到第一个不同就 return。

        // （诚实说明：这条**证明不了**恒定时间 —— 那要测耗时分布。
        // 它能做的是**防止有人后来顺手把它改成短路**。）
        let src = include_str!("aa_account.rs");
        let start = src.find("pub fn timing_safe_eq").unwrap();
        let body = &src[start..start + 700];
        let loop_start = body.find("let mut diff").expect("应有累积变量");
        let loop_end = body.find("diff == 0").expect("应有最终判定");
        let loop_body = &body[loop_start..loop_end];
        assert!(loop_body.contains("diff |= "), "应当用累积异或而不是短路比较");
        assert!(
            !loop_body.contains("return"),
            "累积比较那一段里不该有提前返回（那会把耗时泄漏出去）：{}",
            loop_body
        );
    }

    #[test]
    fn account_state_redacts_secrets() {
        let st = AaAccountState {
            server_url: "https://web.agents-anywhere.com".into(),
            client_id: None,
            access_token: Some("SECRET-TOKEN".into()),
            expires_at_ms: Some(10_000_000),
            profile: Some(AaAccountProfile {
                user_id: "u1".into(),
                ..Default::default()
            }),
            device: Some(AaDeviceCredential {
                connector_id: "c1".into(),
                connector_token: "SECRET-DEVICE".into(),
            }),
        };
        let v = st.redacted(1_000).to_string();
        // 这两个令牌**绝不能**出现在给界面的视图里。
        // 界面只需要知道"有没有" —— 少一个泄漏面（前端日志、错误上报、
        // DOM 检查都可能把它带出去）。
        assert!(!v.contains("SECRET-TOKEN"), "accessToken 泄漏了：{}", v);
        assert!(!v.contains("SECRET-DEVICE"), "connectorToken 泄漏了：{}", v);
        assert!(v.contains("\"signedIn\":true"));
        assert!(v.contains("\"hasDeviceToken\":true"));
        assert!(v.contains("\"deviceId\":\"c1\""));
        // 默认 client id 要显示出来（让用户知道用的是谁的身份）
        assert!(v.contains(AA_OAUTH_CLIENT_ID));
        // token 有效性：留 60 秒余量
        assert!(!st.token_valid(10_000_000));
        assert!(!st.token_valid(9_940_001)); // 离到期不足 60 秒
        assert!(st.token_valid(9_900_000));
    }

    #[test]
    fn connector_config_uses_its_json_field_names() {
        let c = AaDeviceCredential {
            connector_id: "cn-1".into(),
            connector_token: "tk".into(),
        };
        let m = connector_config_json("https://x.example.com", &c);
        assert_eq!(m.get("serverUrl").unwrap(), &serde_json::json!("https://x.example.com"));
        assert_eq!(m.get("connectorId").unwrap(), &serde_json::json!("cn-1"));
        assert_eq!(m.get("connectorToken").unwrap(), &serde_json::json!("tk"));
    }

    #[test]
    fn normalize_api_base_accepts_the_ways_people_actually_type_it() {
        // 只填域名 ⇒ 补 https
        assert_eq!(normalize_api_base("web.agents-anywhere.com").unwrap(), "https://web.agents-anywhere.com");
        // 带协议
        assert_eq!(normalize_api_base("https://web.agents-anywhere.com").unwrap(), "https://web.agents-anywhere.com");
        // 带末尾斜杠
        assert_eq!(normalize_api_base("https://web.agents-anywhere.com/").unwrap(), "https://web.agents-anywhere.com");
        // 带 /api/v2（**最常见的误填**：从文档里抄来的地址就长这样）
        assert_eq!(
            normalize_api_base("https://web.agents-anywhere.com/api/v2").unwrap(),
            "https://web.agents-anywhere.com"
        );
        // 本机自建 + 端口
        assert_eq!(normalize_api_base("http://127.0.0.1:8010/").unwrap(), "http://127.0.0.1:8010");
        // 前后空格
        assert_eq!(normalize_api_base("  https://x.example.com  ").unwrap(), "https://x.example.com");
        // 非法
        assert!(normalize_api_base("").is_err());
        assert!(normalize_api_base("ftp://x.example.com").is_err());
    }

    #[test]
    fn normalize_api_base_rejects_embedded_credentials() {
        // 地址里带账号密码是**危险**的：它会跟着错误信息、日志、
        // 甚至界面上"服务器"那一行一起显示出来。直接拒绝，而不是默默带下去。
        assert!(normalize_api_base("https://user:pass@example.com").is_err());
        assert!(normalize_api_base("https://user@example.com").is_err());
    }

    #[test]
    fn cloud_is_the_default_like_dsh() {
        // DSH 的默认值（`host/index.ts:9`）—— 照抄，所以界面默认不填地址
        assert_eq!(AA_CLOUD_BASE_URL, "https://web.agents-anywhere.com");
        // 规范化之后仍然等于它自己（幂等）
        assert_eq!(normalize_api_base(AA_CLOUD_BASE_URL).unwrap(), AA_CLOUD_BASE_URL);
    }

    #[test]
    fn account_state_roundtrips_through_disk() {
        let dir = std::env::temp_dir().join(format!("aa-acct-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // 没有文件时是 None（首次运行是正常状态，不是错误）
        assert!(load_account_state(&dir).is_none());
        let st = AaAccountState {
            server_url: AA_CLOUD_BASE_URL.into(),
            client_id: None,
            access_token: Some("tok".into()),
            expires_at_ms: Some(1),
            profile: Some(AaAccountProfile { user_id: "u".into(), ..Default::default() }),
            device: Some(AaDeviceCredential { connector_id: "c".into(), connector_token: "t".into() }),
        };
        save_account_state(&dir, &st).unwrap();
        let back = load_account_state(&dir).expect("应当读得回来");
        assert_eq!(back.server_url, st.server_url);
        assert_eq!(back.access_token.as_deref(), Some("tok"));
        assert_eq!(back.device.as_ref().unwrap().connector_id, "c");
        // 坏文件 ⇒ None（不 panic、不报错）
        std::fs::write(account_state_path(&dir), "{ 这不是 json").unwrap();
        assert!(load_account_state(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auth_response_field_is_camel_case() {
        // 它的字段是 camelCase（`accessToken`），不是 snake
        let v: AuthResponse = serde_json::from_str(r#"{"accessToken":"abc"}"#).unwrap();
        assert_eq!(v.access_token, "abc");
        assert!(serde_json::from_str::<AuthResponse>(r#"{"access_token":"abc"}"#).is_err());
    }
}
