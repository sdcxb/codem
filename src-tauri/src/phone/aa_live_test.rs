// ============================================================
// phone/aa_live_test.rs — 用**我们真正的 Rust connector** 打真服务端（阶段 R6）
//
// 与 `aa_mock_test.rs` 的区别：那个打的是**我按 spec 写的 mock**，
// 这个打的是**它自己跑起来的服务端**。两者都要有 ——
// mock 能覆盖异常路径（401、未实现的方法），而只有真服务端能回答
// "我们发出去的帧它到底认不认"。
//
// ## 怎么跑
//
// 它需要一台在跑的服务端 + 一对设备凭据，所以标了 `#[ignore]`（默认不跑，
// 不让 CI 依赖外部服务）。手工跑：
//
//     # 1. 起服务端（SQLite 模式，见 .preview-shot/_aa-repo/server/aa_launcher.py）
//     # 2. 建管理员与连接器，拿凭据（.preview-shot/_aa-setup.mjs）
//     # 3. 跑这条：
//     $env:AA_BASE="http://127.0.0.1:8010"
//     $env:AA_CONNECTOR_ID="conn_xxx"; $env:AA_CONNECTOR_TOKEN="yyy"
//     cargo test --lib phone::aa_live_test -- --ignored --nocapture
//
// ## 它验的是一条**链**，不是单点
//
//   R2 鉴权链（`Connector <id>:<token>` 换 accessToken）
//   → R2 WS 升级（Bearer + X-Device-OS）
//   → R1 能力集通知（`protocol.capabilitiesUpdated`）
//   → R2 心跳（`connector.heartbeat`）
//   → **它主动调 `runtime.discover`** → R5 的本机合成应答
//
// 最后一条最关键：真服务端**真的会调它**，而我们那张方法表覆盖住了。
// ============================================================

use std::time::Duration;

use super::aa_connector::{self, AaConfig};
use super::PhoneState;

/// 从环境变量取真服务端凭据；缺任何一个就跳过（`None`）。
fn live_env() -> Option<(String, String, String)> {
    let base = std::env::var("AA_BASE").ok()?;
    let id = std::env::var("AA_CONNECTOR_ID").ok()?;
    let token = std::env::var("AA_CONNECTOR_TOKEN").ok()?;
    if base.trim().is_empty() || id.trim().is_empty() || token.trim().is_empty() {
        return None;
    }
    Some((base, id, token))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要一台在跑的 AA 服务端 + 账号（见文件头）"]
async fn live_login_then_register_this_machine() {
    // 这条就是"登录一下就能用"的**前两步**，对着真服务端验：
    //   登录（邮箱+密码）→ 读账号 → **注册本机**（拿 connectorId/connectorToken）
    let (Ok(base), Ok(email), Ok(password)) = (
        std::env::var("AA_BASE"),
        std::env::var("AA_EMAIL"),
        std::env::var("AA_PASSWORD"),
    ) else {
        eprintln!("跳过：未设置 AA_BASE / AA_EMAIL / AA_PASSWORD");
        return;
    };
    let base = super::aa_account::normalize_api_base(&base).expect("地址规范化");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();

    // 1) 登录
    let token = super::aa_account::login_with_password(&client, &base, &email, &password)
        .await
        .expect("登录应当成功");
    assert!(!token.is_empty());

    // 2) 读账号（/auth/me）—— 顺便证明这个 token 真的能用
    let me = super::aa_account::fetch_me(&client, &base, &token)
        .await
        .expect("读账号应当成功");
    assert!(!me.user_id.is_empty(), "账号应当有 userId");

    // 3) **注册本机** —— 这是我先前漏掉的那一步
    let name = format!("Codem live test {}", std::process::id());
    let cred = super::aa_account::register_connector(
        &client,
        &base,
        &token,
        &name,
        &uuid::Uuid::new_v4().to_string(),
    )
    .await
    .expect("注册本机应当成功");
    assert!(!cred.connector_id.is_empty(), "应当拿到 connectorId");
    assert!(!cred.connector_token.is_empty(), "应当拿到 connectorToken");
    println!("注册本机成功: id={} token_len={}", cred.connector_id, cred.connector_token.len());

    // 4) 这套凭据要能过 connector 鉴权（**闭环**：注册出来的东西真的可用）
    let auth = client
        .post(format!("{}/api/v2/connector/auth", base))
        .header(
            "authorization",
            format!("Connector {}:{}", cred.connector_id, cred.connector_token),
        )
        .send()
        .await
        .expect("connector/auth 请求");
    assert!(
        auth.status().is_success(),
        "刚注册出来的凭据通不过 connector/auth：HTTP {}",
        auth.status().as_u16()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要一台在跑的 AA 服务端 + 设备凭据（见文件头）"]
async fn live_connector_authenticates_and_answers_runtime_discover() {
    let Some((base, id, token)) = live_env() else {
        eprintln!("跳过：未设置 AA_BASE / AA_CONNECTOR_ID / AA_CONNECTOR_TOKEN");
        return;
    };

    let st = PhoneState::new();
    {
        let mut g = st.inner.lock().await;
        g.running = true;
        // 真机上这里是渲染进程的回环上游端口。这条判据只走 Inline 方法
        // （`runtime.discover`），不需要上游 —— 所以留 0，
        // 顺带验证"上游没起来时不会把 Inline 也一起拒掉"。
        g.upstream_port = 0;
        g.edge_token = "live-test".to_string();
    }
    let cs = aa_connector::AaConnectorState::new();

    let mut cfg = AaConfig::new(&base, &id, &token);
    cfg.heartbeat_seconds = 2;
    cfg.reconnect_seconds = 2;
    aa_connector::start(st.clone(), cs.clone(), cfg)
        .await
        .expect("启动 connector");

    // 给它时间：换 token → 连 WS → 发能力集 → 服务端调 runtime.discover → 我们回
    let mut snap = serde_json::json!({});
    let mut connected_at_least_once = false;
    for _ in 0..50 {
        snap = aa_connector::snapshot(cs.clone()).await;
        if snap.get("connected").and_then(|v| v.as_bool()) == Some(true) {
            connected_at_least_once = true;
        }
        if snap.get("requestsServed").and_then(|v| v.as_u64()).unwrap_or(0) >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    aa_connector::stop(cs.clone()).await;

    println!("真服务端验证快照: {}", snap);

    // 1) 鉴权 + WS 成功过（`connected` 是瞬时状态，所以记"是否出现过"）
    assert!(
        connected_at_least_once,
        "从未连上 —— 快照={}（检查 AA_BASE 与凭据）",
        snap
    );
    assert_eq!(
        snap.get("credentialsRevoked").and_then(|v| v.as_bool()),
        Some(false),
        "真服务端把凭据判成无效了：{}",
        snap
    );
    // 2) 能力集发出去了（revision 非零）
    let rev = snap.get("capabilitiesRevision").and_then(|v| v.as_u64()).unwrap_or(0);
    assert!(rev > 0, "能力集没有发出（revision=0）：{}", snap);
    // 3) **它真的调了方法，而且我们答了** —— Inline 路径会计入 requestsServed
    let served = snap.get("requestsServed").and_then(|v| v.as_u64()).unwrap_or(0);
    assert!(
        served >= 1,
        "真服务端一次都没调我们（或我们没答成功）—— 快照={}",
        snap
    );
    // 4) 没有累积错误
    let errors = snap.get("errors").and_then(|v| v.as_u64()).unwrap_or(0);
    assert_eq!(errors, 0, "出现了错误：{}", snap);
}
