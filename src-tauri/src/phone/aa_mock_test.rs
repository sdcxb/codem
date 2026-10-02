// ============================================================
// phone/aa_mock_test.rs — 对着**按同一份 spec 写的 mock AA 服务端**跑通（阶段 R2 判据）
//
// 为什么必须要有它：真服务器我们够不着（它的云要账号、自建要服务端软件），
// 但如果因此就不测，那么"复刻"就只能靠读代码自觉 —— 而协议这种东西
// **读对了不代表发对了**（少一个头、字段名大小写、帧形状差一点，都是连不上）。
//
// 这个 mock 只实现**契约**（不实现业务）：
//   - `POST /api/v2/connector/auth` → `{accessToken, expiresIn}`，并校验
//     `Authorization: Connector <id>:<token>` 这条头**逐字**正确
//   - `GET /api/v2/connector/ws` 升级，校验 `Authorization: Bearer <token>`
//     与 `X-Device-OS` 两条头
//   - 收 `protocol.capabilitiesUpdated` 通知，并核对能力集形状
//   - 收 `connector.heartbeat` 通知
//   - 发一条 `request`（session.discover），要求收到 `response` 且 `ok: true`
//
// 判据（M1–M7）都是"**它真的这么做了**"，而不是"代码里写了"：
//   M1 换 token 时那条 `Connector <id>:<token>` 头逐字正确
//   M2 401 ⇒ 连接器**停止**且状态标成凭据失效（不无限重连）
//   M3 WS 升级带上 Bearer 与 X-Device-OS
//   M4 上线后立刻发能力集，且 revision 非零、含我们声称支持的能力
//   M5 心跳按 heartbeatSeconds 到达（先立刻一次，再周期性）
//   M6 服务端发来的 request 被正确应答（ok:true 且带真实数据）
//   M7 未实现的方法回 `ok:false` + `method_not_supported`（**不假装成功**）
// ============================================================

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;

use super::aa_connector::{self, AaConfig};
use super::PhoneState;

/// mock 服务端观察到的东西（断言用）。
#[derive(Debug, Default, Clone)]
struct MockSeen {
    auth_header: Option<String>,
    ws_bearer: Option<String>,
    ws_device_os: Option<String>,
    capability_frames: Vec<serde_json::Value>,
    heartbeats: usize,
    /// 我们发出去的 request 收到的 response
    responses: Vec<serde_json::Value>,
}

/// 起一个 mock AA 服务端。返回 (base_url, 观察通道, 关停句柄)。
async fn start_mock(auth_status: u16) -> (String, mpsc::UnboundedReceiver<MockSeen>, tauri::async_runtime::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定 mock");
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::unbounded_channel::<MockSeen>();
    let handle = tauri::async_runtime::spawn(async move {
        let mut seen = MockSeen::default();
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            // 读请求头
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let head_end = loop {
                let Ok(n) = sock.read(&mut chunk).await else {
                    break 0;
                };
                if n == 0 {
                    break 0;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            if head_end == 0 {
                continue;
            }
            let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let is_ws = head
                .to_ascii_lowercase()
                .contains("upgrade: websocket");
            let header = |name: &str| -> Option<String> {
                head.split("\r\n")
                    .find(|l| {
                        l.split_once(':')
                            .map(|(k, _)| k.trim().eq_ignore_ascii_case(name))
                            .unwrap_or(false)
                    })
                    .and_then(|l| l.split_once(':').map(|(_, v)| v.trim().to_string()))
            };

            if is_ws {
                seen.ws_bearer = header("authorization");
                seen.ws_device_os = header("x-device-os");
                let _ = tx.send(seen.clone());
                // 手工完成 WS 握手，然后交给 tungstenite 的帧层
                let key = header("sec-websocket-key").unwrap_or_default();
                let accept = derive_accept_key(key.as_bytes());
                let resp = format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
                    accept
                );
                if sock.write_all(resp.as_bytes()).await.is_err() {
                    continue;
                }
                let cfg = WebSocketConfig::default();
                let mut ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
                    sock,
                    Role::Server,
                    Some(cfg),
                )
                .await;

                // —— 帧循环 ——
                let mut sent_discover = false;
                let mut sent_unsupported = false;
                let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
                loop {
                    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    let Ok(Some(msg)) = tokio::time::timeout(left, ws.next()).await else {
                        break;
                    };
                    let Ok(msg) = msg else { break };
                    let Message::Text(txt) = msg else { continue };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
                        continue;
                    };
                    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
                    if ty == "notification" {
                        match method {
                            "protocol.capabilitiesUpdated" => {
                                seen.capability_frames.push(v.clone());
                                // 收到能力集之后：先要心跳，再发一条真请求
                                if !sent_discover {
                                    sent_discover = true;
                                    let req = serde_json::json!({
                                        "id": "srv-1", "type": "request",
                                        "method": "session.discover", "params": {}
                                    });
                                    let _ = ws.send(Message::Text(req.to_string().into())).await;
                                }
                            }
                            "connector.heartbeat" => {
                                seen.heartbeats += 1;
                                // 心跳到了 ⇒ 再发一条"未实现的方法"，验它不假装成功
                                if !sent_unsupported {
                                    sent_unsupported = true;
                                    let req = serde_json::json!({
                                        "id": "srv-2", "type": "request",
                                        "method": "terminal.create", "params": {}
                                    });
                                    let _ = ws.send(Message::Text(req.to_string().into())).await;
                                }
                            }
                            _ => {}
                        }
                    } else if ty == "response" {
                        seen.responses.push(v.clone());
                    }
                    let _ = tx.send(seen.clone());
                    // 两条 response 都拿到了就可以收工
                    if seen.responses.len() >= 2 {
                        break;
                    }
                }
                let _ = tx.send(seen.clone());
                continue;
            }

            // —— REST：/connector/auth ——
            seen.auth_header = header("authorization");
            let _ = tx.send(seen.clone());
            let body = if auth_status == 401 {
                "{}".to_string()
            } else {
                serde_json::json!({ "accessToken": "tok-abc", "expiresIn": 3600 }).to_string()
            };
            let reason = if auth_status == 401 { "Unauthorized" } else { "OK" };
            let resp = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                auth_status,
                reason,
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
        }
    });
    (format!("http://127.0.0.1:{}", port), rx, handle)
}

/// 起一个**假的本机上游**（connector 把服务端请求转给它）。
async fn start_fake_upstream() -> (u16, tauri::async_runtime::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定假上游");
    let port = listener.local_addr().unwrap().port();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let Ok(n) = sock.read(&mut chunk).await else { break };
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).position(|w| w == b"\r\n\r\n").is_some() {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buf).to_string();
            // 断言边缘标记确实带上了（上游只认带标记的请求）
            let has_marker = head.to_ascii_lowercase().contains("x-codem-edge:");
            let body = if has_marker {
                serde_json::json!({ "ok": true, "sessions": [{ "id": "s1", "title": "真实会话" }] }).to_string()
            } else {
                serde_json::json!({ "error": "no marker" }).to_string()
            };
            let status = if has_marker { "200 OK" } else { "403 Forbidden" };
            let resp = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status,
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        }
    });
    (port, handle)
}

/// 准备一个"已经在运行"的手机状态（有上游端口与边缘标记）。
async fn phone_state_with_upstream(upstream_port: u16) -> Arc<PhoneState> {
    let st = PhoneState::new();
    {
        let mut g = st.inner.lock().await;
        g.running = true;
        g.upstream_port = upstream_port;
        g.edge_token = "edge-token-for-test".to_string();
    }
    st
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn m1_m3_m4_m5_m6_m7_full_connector_roundtrip() {
    let (base, mut seen_rx, mock) = start_mock(200).await;
    let (up_port, up) = start_fake_upstream().await;
    let st = phone_state_with_upstream(up_port).await;
    let cs = aa_connector::AaConnectorState::new();

    let mut cfg = AaConfig::new(&base, "cn-test", "secret-token");
    cfg.heartbeat_seconds = 1; // 测试里缩短周期
    cfg.reconnect_seconds = 1;
    aa_connector::start(st.clone(), cs.clone(), cfg).await.expect("启动 connector");

    // 等 mock 观察到"两条 response 都收到"
    let mut last = MockSeen::default();
    for _ in 0..80 {
        while let Ok(s) = seen_rx.try_recv() {
            last = s;
        }
        if last.responses.len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // M1：换 token 的那条头必须**逐字**是 `Connector <id>:<token>`
    assert_eq!(
        last.auth_header.as_deref(),
        Some("Connector cn-test:secret-token"),
        "M1：/connector/auth 的 Authorization 头不对（实际 {:?}）",
        last.auth_header
    );

    // M3：WS 升级要带 Bearer 与 X-Device-OS
    assert_eq!(last.ws_bearer.as_deref(), Some("Bearer tok-abc"), "M3：WS 未带 Bearer 令牌");
    assert!(
        ["windows", "macos", "linux"].contains(&last.ws_device_os.as_deref().unwrap_or("")),
        "M3：WS 未带 X-Device-OS（实际 {:?}）",
        last.ws_device_os
    );

    // M4：上线后立刻发能力集，且形状正确
    assert!(!last.capability_frames.is_empty(), "M4：没有收到能力集通知");
    let frame = &last.capability_frames[0];
    // ⚠️ 载荷在 **`params`** 里，不在帧顶层 —— 这是信封的语义
    // （`RpcNotification { type, method, params }`）。
    // 第一版我直接在帧顶层找 `revision`，拿到 0 并报"revision 必须非零"，
    // 看起来像 connector 的错，其实是**判据读错了位置**。
    assert_eq!(
        frame.get("type").and_then(|v| v.as_str()),
        Some("notification"),
        "M4：能力集必须以通知帧发出"
    );
    assert_eq!(
        frame.get("method").and_then(|v| v.as_str()),
        Some("protocol.capabilitiesUpdated"),
        "M4：方法名必须是 protocol.capabilitiesUpdated"
    );
    let caps = frame.get("params").expect("M4：通知帧必须有 params（载荷在里面）");
    let rev = caps.get("revision").and_then(|v| v.as_u64()).unwrap_or(0);
    assert!(rev > 0, "M4：能力集 revision 必须非零（实际 {}）", rev);
    let list = caps
        .get("capabilities")
        .and_then(|v| v.as_array())
        .expect("M4：能力集必须有 capabilities 数组");
    assert!(!list.is_empty(), "M4：能力集为空");
    // 我们声称支持的必须在里面且 supported=true
    for want in super::aa_protocol::OUR_SUPPORTED_CAPABILITIES {
        let found = list.iter().find(|c| {
            c.get("capabilityId").and_then(|v| v.as_str()) == Some(*want)
        });
        assert!(found.is_some(), "M4：能力集里缺少 {}", want);
    }
    // 不支持的必须显式报 supported:false 且给理由（不许沉默省略）
    let unsupported = list.iter().find(|c| {
        c.get("capabilityId").and_then(|v| v.as_str()) == Some("attachments")
    });
    if let Some(u) = unsupported {
        assert_eq!(u.get("supported").and_then(|v| v.as_bool()), Some(false));
        assert!(u.get("unavailableReason").is_some(), "M4：不支持却没给理由");
    }

    // M5：心跳至少到过一次（心跳周期设成 1 秒）
    assert!(last.heartbeats >= 1, "M5：没有收到心跳（实际 {}）", last.heartbeats);

    // M6/M7：两条 response 都要到，且一条 ok:true（真数据）、一条 method_not_supported
    assert!(last.responses.len() >= 2, "M6/M7：应答数不足（实际 {}）", last.responses.len());
    let ok_resp = last
        .responses
        .iter()
        .find(|r| r.get("id").and_then(|v| v.as_str()) == Some("srv-1"))
        .expect("M6：没有 srv-1 的应答");
    assert_eq!(ok_resp.get("ok").and_then(|v| v.as_bool()), Some(true), "M6：应为 ok:true");
    assert!(
        ok_resp.get("result").map(|r| r.to_string().contains("真实会话")).unwrap_or(false),
        "M6：应答里应带上游返回的真实数据（实际 {:?}）",
        ok_resp.get("result")
    );

    let bad = last
        .responses
        .iter()
        .find(|r| r.get("id").and_then(|v| v.as_str()) == Some("srv-2"))
        .expect("M7：没有 srv-2 的应答");
    assert_eq!(bad.get("ok").and_then(|v| v.as_bool()), Some(false), "M7：未实现的方法**不许**假装成功");
    assert_eq!(
        bad.get("error").and_then(|e| e.get("code")).and_then(|v| v.as_str()),
        Some("method_not_supported"),
        "M7：错误码应为 method_not_supported（实际 {:?}）",
        bad.get("error")
    );

    // ⚠️ 这里**不能**断言 `connected == true`，也不该去"采样它曾经为真"。

    // 两个原因，都是我第一版踩的：

    // 1. mock 收齐两条应答后就收工关连接 —— 那是它该做的事，连接器如实把

    //    `connected` 置回 false；在**事后**断言"应处于已连接"就是错的。

    // 2. 改成"轮询采样它曾经为真"之后**仍然会漏**：整个交换在 <250ms 内跑完，

    //    而采样间隔是 250ms —— 判据变成了抓一个转瞬即逝的状态，本质上是 flaky。

    // 正确的做法是断言**不会因为对端正常关闭而改变**的事实：

    // mock 亲眼看到了带 Bearer 的 WS 升级（M3），连接器也确实服务过请求、发过能力集。
    let snap = aa_connector::snapshot(cs.clone()).await;
    assert!(
        snap.get("requestsServed").and_then(|v| v.as_u64()).unwrap_or(0) >= 1,
        "应至少服务过一个请求：{}",
        snap
    );
    assert!(
        snap.get("capabilitiesRevision").and_then(|v| v.as_u64()).unwrap_or(0) > 0,
        "能力集 revision 应被记下来：{}",
        snap
    );

    aa_connector::stop(cs.clone()).await;
    mock.abort();
    up.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn m2_revoked_credentials_stop_instead_of_retrying_forever() {
    let (base, mut seen_rx, mock) = start_mock(401).await;
    let (up_port, up) = start_fake_upstream().await;
    let st = phone_state_with_upstream(up_port).await;
    let cs = aa_connector::AaConnectorState::new();

    let mut cfg = AaConfig::new(&base, "cn-bad", "bad-token");
    cfg.reconnect_seconds = 1;
    aa_connector::start(st.clone(), cs.clone(), cfg).await.expect("启动 connector");

    // 等状态落定
    let mut snap = serde_json::json!({});
    for _ in 0..40 {
        snap = aa_connector::snapshot(cs.clone()).await;
        if snap.get("running").and_then(|v| v.as_bool()) == Some(false) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // M2：必须**停**，并如实标成凭据失效
    assert_eq!(
        snap.get("running").and_then(|v| v.as_bool()),
        Some(false),
        "M2：401 之后必须停止（不许无限重连）。快照={}",
        snap
    );
    assert_eq!(
        snap.get("credentialsRevoked").and_then(|v| v.as_bool()),
        Some(true),
        "M2：必须如实标成凭据失效。快照={}",
        snap
    );
    assert_eq!(snap.get("connected").and_then(|v| v.as_bool()), Some(false));
    let msg = snap.get("lastError").and_then(|v| v.as_str()).unwrap_or("");
    assert!(msg.contains("401") || msg.contains("失效"), "M2：原因要说清是凭据问题：{}", msg);

    // 而且它**没有**去开 WS（因为第一步就失败了）
    let mut last = MockSeen::default();
    while let Ok(s) = seen_rx.try_recv() {
        last = s;
    }
    assert!(last.ws_bearer.is_none(), "M2：凭据已经失效就不该再去开 WS");
    assert_eq!(last.auth_header.as_deref(), Some("Connector cn-bad:bad-token"));

    mock.abort();
    up.abort();
}
