// ============================================================
// phone/edge_test.rs — 第 122 轮阶段 1 的**真机套接字**集成判据
//
// 为什么不能只靠单元测试：`guard.rs` 的纯函数都测过了，但"边缘到底有没有
// 被咨询""上游到底有没有真的拒绝无标记请求"是**接线**问题 ——
// 纯函数全绿而接线漏掉，正是本仓反复栽过的那种形态。
//
// 所以这里起**真的 TCP + 真的 TLS**（证书也是真的生成），
// 用一个真的 TLS 客户端（只信任我们刚生成的那个 CA）去打，
// 并让"上游"记录它收到的请求头，从而断言三类事实：
//
//   E1 正常请求能过，且**上游收到的头里带着我们的边缘标记**（闭环）
//   E2 Host 不是我们宣告的地址 ⇒ 421，且上游**根本没被连过**
//   E3 `Sec-Fetch-Site: cross-site` ⇒ 403，且上游**根本没被连过**
//   E4 客户端伪造边缘标记 ⇒ 被删掉、换成我们的（否则就是一个绕过点）
//   E5 直连上游不带标记 ⇒ `upstream_admit` 拒绝（"上游只绑回环"的实际内容）
//   E6 SAN 覆盖：客户端以 **IP** 作为 server name 能验证通过 ——
//      若证书 SAN 里没有该 IP，这一步会直接失败（这是行为判据，不是字符串判据）
// ============================================================

use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 起一个"上游"：实现与生产**同一个**准入函数，并把收到的头交给断言。
async fn spawn_fake_upstream(
    token: String,
) -> (u16, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定假上游");
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let tx = tx.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let Ok((head, _body)) = read_http_request(&mut stream).await else {
                    return;
                };
                let _ = tx.send(head.clone());
                if upstream_admit(&head, &token) {
                    let _ = write_simple(&mut stream, 200, "OK", "UPSTREAM_OK").await;
                } else {
                    let _ = write_simple(&mut stream, 403, "Forbidden", "NO_MARKER").await;
                }
            });
        }
    });
    (port, rx)
}

/// 起真的 TLS 边缘（复用生产的 `handle_edge_conn`）。
///
/// 返回边缘端口。允许集合**由本函数在拿到真实端口之后构造** ——
/// 让调用方先猜一个端口再补，是"允许集合与实际监听端口不一致"的经典写法，
/// 那种不一致会让 E2 的判据失去意义（拒掉的原因可能只是端口对不上）。
async fn spawn_real_edge(
    material: &tls::CertMaterial,
    upstream_port: u16,
    lan_ip: &str,
    token: String,
) -> u16 {
    let cfg = tls::server_config(material).expect("构造 TLS 配置");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定边缘");
    let port = listener.local_addr().unwrap().port();
    // 端口已知 ⇒ 用**生产的**同一个函数构造允许集合
    let allowed = Arc::new(guard::allowed_hosts(lan_ip, port));
    let token = Arc::new(token);
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            handle_edge_conn(
                tokio_rustls::TlsAcceptor::from(cfg.clone()),
                stream,
                upstream_port,
                allowed.clone(),
                token.clone(),
            )
            .await;
        }
    });
    port
}

/// 信任指定 CA 的 TLS 客户端，向 `127.0.0.1:port` 以 IP 作为 server name 发一个请求。
///
/// 返回 `(响应原文, 是否握手成功)`。
async fn tls_request(port: u16, ca_pem: &str, head: &str) -> (String, bool) {
    let ca_der = tls::pem_to_der(ca_pem).expect("CA 能取 DER");
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(ca_der))
        .expect("能加入根");
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("协议版本")
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    let stream = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => s,
        Err(_) => return (String::new(), false),
    };
    // ⚠️ 用 IP 作为 server name：证书 SAN 里没有这个 IP 时，这一步**必然失败**。
    // 这就是"SAN 覆盖"的行为判据。
    let name = rustls::pki_types::ServerName::IpAddress(
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST).into(),
    );
    let mut tls = match connector.connect(name, stream).await {
        Ok(t) => t,
        Err(_) => return (String::new(), false),
    };
    let req = format!("{}\r\n\r\n", head);
    if tls.write_all(req.as_bytes()).await.is_err() {
        return (String::new(), true);
    }
    let _ = tls.flush().await;
    let mut out = Vec::new();
    let _ = tls.read_to_end(&mut out).await;
    (String::from_utf8_lossy(&out).into_owned(), true)
}

/// 建一套临时证书（真的生成），返回 (材料, 临时目录)。
fn fresh_material() -> (tls::CertMaterial, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("codem-tls-it-{}", random_hex(8)));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let m = tls::ensure(&dir, &["127.0.0.1".to_string()]).expect("生成证书");
    (m, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edge_https_security_properties() {
    let token = "tok-integration-abcdef".to_string();
    let (up_port, mut seen) = spawn_fake_upstream(token.clone()).await;
    let (material, dir) = fresh_material();
    let edge_port = spawn_real_edge(&material, up_port, "127.0.0.1", token.clone()).await;
    assert!(edge_port > 0);

    // ---- E6 + E1：用 IP 作 server name 能验证通过（SAN 覆盖），且请求被放行 ----
    // 用**带端口**的 Host（浏览器真实发的形态）；E3/E4 用不带端口的形态，
    // 两种写法都要被允许集合覆盖。
    let (resp, hs) = tls_request(
        edge_port,
        &material.ca_pem,
        &format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close",
            edge_port
        ),
    )
    .await;
    assert!(hs, "E6：以 IP 为 server name 应能完成握手（证明 SAN 覆盖了该 IP）");
    assert!(
        resp.contains("UPSTREAM_OK"),
        "E1：正常请求应被上游放行，实际响应：{}",
        resp
    );
    let head = seen.recv().await.expect("上游应收到请求");
    assert!(
        head.to_ascii_lowercase().contains(&format!("x-codem-edge: {}", token)),
        "E1：上游收到的请求必须带我们的边缘标记，实际：{}",
        head
    );

    // ---- E2：Host 不是我们宣告的地址 ⇒ 421，且上游没被连过 ----
    let (resp2, hs2) = tls_request(
        edge_port,
        &material.ca_pem,
        "GET / HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close",
    )
    .await;
    assert!(hs2);
    assert!(
        resp2.starts_with("HTTP/1.1 421"),
        "E2：陌生 Host 应被拒（DNS rebinding），实际：{}",
        resp2.lines().next().unwrap_or("")
    );
    assert!(
        seen.try_recv().is_err(),
        "E2：被拒的请求**不该**到达上游（边缘就该挡住）"
    );

    // ---- E3：跨站 ⇒ 403，且上游没被连过 ----
    let (resp3, _) = tls_request(
        edge_port,
        &material.ca_pem,
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nSec-Fetch-Site: cross-site\r\nConnection: close",
    )
    .await;
    assert!(
        resp3.starts_with("HTTP/1.1 403"),
        "E3：跨站请求应被拒，实际：{}",
        resp3.lines().next().unwrap_or("")
    );
    assert!(seen.try_recv().is_err(), "E3：被拒的跨站请求不该到达上游");

    // ---- E4：客户端伪造边缘标记 ⇒ 被删掉换成我们的 ----
    let (resp4, _) = tls_request(
        edge_port,
        &material.ca_pem,
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Codem-Edge: FORGED\r\nConnection: close",
    )
    .await;
    assert!(
        resp4.contains("UPSTREAM_OK"),
        "E4：伪造标记不该导致请求被拒（应被替换成真的），实际：{}",
        resp4
    );
    let head4 = seen.recv().await.expect("上游应收到第 4 个请求");
    assert!(
        !head4.contains("FORGED"),
        "E4：客户端伪造的标记必须被删除，实际：{}",
        head4
    );
    assert_eq!(
        head4.to_ascii_lowercase().matches("x-codem-edge").count(),
        1,
        "E4：边缘标记必须只有一条"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upstream_direct_connection_is_refused() {
    // E5：`upstream_admit` 是"上游只绑回环"的实际内容。
    // 直连（不带标记）必须被拒；带上正确标记才放行。
    // 这条判据同时说明为什么**上游端口不设防也不等于安全**：
    // 防线是那个只有边缘知道的标记。
    let head_no_marker = "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:1234";
    assert!(
        !upstream_admit(head_no_marker, "REAL"),
        "E5：无标记的直连上游必须被拒"
    );
    assert!(
        !upstream_admit(
            "GET / HTTP/1.1\r\nHost: h\r\nx-codem-edge: GUESS",
            "REAL"
        ),
        "E5：猜错的标记必须被拒"
    );
    assert!(
        upstream_admit("GET / HTTP/1.1\r\nHost: h\r\nx-codem-edge: REAL", "REAL"),
        "E5：正确的标记应放行"
    );
    // 空 expected = 未启用（测试直连上游用），不放行任何错标记
    assert!(
        upstream_admit(head_no_marker, ""),
        "E5b：未启用标记机制时应放行（仅供测试直连上游）"
    );
}
