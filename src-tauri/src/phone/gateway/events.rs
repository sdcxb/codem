// ============================================================
// phone/gateway/events.rs — 网关事件枢纽 + `/events` SSE 事件流
//
// ## 为什么需要它（ADR-0005 M2）
//
// 手机能 `prompt.send` 之后，必须能看到**这一轮到底在干什么**（正文流、工具开始/
// 结束、审批请求、结束原因），否则写入入口就是半套：发了消息看不到结果，遇到
// 需要批准的工具也没法回答。数据面仍然只有一条：渲染层的唯一 Agent 循环
// （`executeSessionTurn`）产生事件 → 渲染层调用 `gateway_publish_event` →
// **本模块**分配序号并广播给已配对的设备。网关不跑第二条循环、不读库。
//
// ## 序号与断线重连
//
// 每条事件拿一个**全局单调 seq**。SSE 帧带 `id: <seq>`，浏览器 `EventSource`
// 断线重连时自动带 `Last-Event-ID`（也接受 `?sinceSeq=`）。
//
// - **不重复**：只补发 `seq > since` 的事件；直播阶段再按 `seq > cursor` 去重
//   （订阅先于补发建立，所以"补发与直播之间"不会漏，也不会重复）。
// - **不丢终态**：`run.finished/failed/cancelled` 另存一份有界终态日志。若断线
//   太久、普通日志已经把这批事件挤掉（"缺口"），连接会先收到 `gateway.reset`
//   （让界面从桌面存储重新对齐），再补发**已被挤掉但仍新于 since 的终态**。
//   "至少不丢终态"是刻意的边界：缺口中间的正文流不重放（重放会让界面重复追加
//   文本），由 reset 触发的 `session.get` 对齐覆盖。
//
// 事件日志跨 `gateway_stop` / `gateway_start` 保留（同一个进程内），所以"停一下
// 再开"不会让正在跑的回合的终态消失。进程重启则序号从 0 开始，旧 `Last-Event-ID`
// 会触发一次 reset —— 这是正确行为（旧运行随进程一起没了）。
//
// ## 为什么事件流在 Rust 侧而不是转发给渲染层
//
// 渲染层一次往返有 15s 上限（`phone/mod.rs::PROXY_TIMEOUT`），SSE 是长连接；
// 而且事件是"已发生的事实"，不需要渲染层再回答一次。Rust 只做序号、缓冲与
// 广播；事件内容全部由渲染层产生。
// ============================================================

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch};
use tokio::time::{interval_at, Duration, Instant};

use crate::phone::now_ms;

/// 普通事件日志上限（条）。
pub const EVENT_LOG_CAPACITY: usize = 1024;
/// 普通事件日志的**总字节**上限。条数上限单独不够：一条 256KB 的事件 × 1024 条
/// 会把网关内存吃到 256MB；按字节淘汰才能真正有界。
pub const EVENT_LOG_MAX_BYTES: usize = 8 * 1024 * 1024;
/// 终态事件保留上限（条）。终态是"这次运行结束没有"的唯一凭证，单独留一份。
pub const TERMINAL_EVENT_CAPACITY: usize = 128;
/// 广播通道容量：慢客户端会收到 `Lagged`，由 `serve_stream` 用 reset 对齐。
pub const SUBSCRIBER_BUFFER: usize = 256;
/// 同时打开的事件流上限。配对设备可以重连，但不该能无限占住连接。
pub const MAX_EVENT_CLIENTS: usize = 16;
/// 单条事件载荷上限（字节）。事件是给手机看的摘要，不是文件传输通道。
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 256 * 1024;
/// 注释心跳：既保活，也不会进客户端的事件队列。
pub const HEARTBEAT: Duration = Duration::from_secs(15);

/// 与 Host 事件流一致的通知方法名（共享 UI 的 HostClient 只认 message）。
pub const SESSION_EVENT_METHOD: &str = "session.event";
/// 连接建立后先发一条"流已就绪"（不带 id，不占序号）。
pub const READY_EVENT: &str = "gateway.ready";
/// 缺口/慢客户端时发的对齐信号（不带 id，不占序号）。
pub const RESET_EVENT: &str = "gateway.reset";

/// 渲染层**允许发布**的事件类型（精确白名单）。
///
/// 为什么收窄：`/events` 会把 payload 原样送到已配对设备。白名单让"某段代码顺手
/// 把内部事件名/内部对象发出去"变成一条明确的错误，而不是一个悄悄扩大的泄露面。
/// `gateway.reset` / `gateway.ready` 由本模块自己产生，渲染层不许发。
pub const PUBLISHABLE_EVENT_TYPES: &[&str] = &[
    "run.started",
    "assistant.text",
    "assistant.reasoning",
    "tool.start",
    "tool.end",
    "tool.error",
    "approval.requested",
    "approval.resolved",
    "run.finished",
    "run.failed",
    "run.cancelled",
];

/// 终态事件（单独保留，断线太久也不丢）。
pub const TERMINAL_EVENT_TYPES: &[&str] = &["run.finished", "run.failed", "run.cancelled"];

/// 合成事件（ready/reset）的序号：真实事件从 1 开始，0 表示"不占序号、帧里不带 id"。
pub const SYNTHETIC_SEQ: u64 = 0;

/// 一条已入库的事件。序列化形状与共享 UI 的 `HostEvent` 对齐。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayEvent {
    pub seq: u64,
    pub session_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub timestamp: i64,
    pub method: &'static str,
    /// 序列化后的近似字节数（**不进协议**；用于按字节淘汰日志）。
    #[serde(skip)]
    pub bytes: usize,
}

impl GatewayEvent {
    /// 合成事件（ready/reset）：seq=0，不写 `id:`。
    fn synthetic(kind: &str, session_id: &str, payload: serde_json::Value) -> Self {
        GatewayEvent {
            seq: SYNTHETIC_SEQ,
            session_id: session_id.to_string(),
            kind: kind.to_string(),
            payload,
            run_id: None,
            timestamp: now_ms(),
            method: SESSION_EVENT_METHOD,
            bytes: 0,
        }
    }
}

/// `resume()` 的补发计划。
#[derive(Debug, Default)]
pub struct ResumePlan {
    /// 需要先发的 `gateway.reset`（缺口/换了一代网关）。
    pub reset: Option<GatewayEvent>,
    /// 已被普通日志挤掉、但客户端可能没见过的终态（仅缺口时非空）。
    pub terminals: Vec<GatewayEvent>,
    /// 普通日志里 `seq > since` 且属于该会话的事件（无缺口时按序补发）。
    pub events: Vec<GatewayEvent>,
    /// 补发结束后直播应从哪个 seq 之后开始去重。
    pub cursor_after: u64,
}

struct HubInner {
    seq: u64,
    log: VecDeque<GatewayEvent>,
    terminals: VecDeque<GatewayEvent>,
    log_capacity: usize,
    terminal_capacity: usize,
    log_bytes: usize,
    log_max_bytes: usize,
}

/// 事件枢纽：序号、有界日志、终态日志、广播。
pub struct EventHub {
    inner: Mutex<HubInner>,
    subscribers: broadcast::Sender<GatewayEvent>,
    clients: AtomicUsize,
}

impl EventHub {
    pub fn new() -> Arc<Self> {
        Self::with_capacity(EVENT_LOG_CAPACITY, TERMINAL_EVENT_CAPACITY)
    }

    pub fn with_capacity(log_capacity: usize, terminal_capacity: usize) -> Arc<Self> {
        Self::with_limits(log_capacity, terminal_capacity, EVENT_LOG_MAX_BYTES)
    }

    fn with_limits(
        log_capacity: usize,
        terminal_capacity: usize,
        log_max_bytes: usize,
    ) -> Arc<Self> {
        let (tx, _rx) = broadcast::channel(SUBSCRIBER_BUFFER);
        Arc::new(EventHub {
            inner: Mutex::new(HubInner {
                seq: 0,
                log: VecDeque::new(),
                terminals: VecDeque::new(),
                // 0 会让 `VecDeque` 语义变得可疑；至少留 1 条。
                log_capacity: log_capacity.max(1),
                terminal_capacity: terminal_capacity.max(1),
                log_bytes: 0,
                log_max_bytes: log_max_bytes.max(1),
            }),
            subscribers: tx,
            clients: AtomicUsize::new(0),
        })
    }

    /// 发布一条事件：校验 → 分配序号 → 入日志/终态日志 → 广播。
    ///
    /// 返回的 `Ok(event)` 带本次分配到的 `seq`（调用方可用它做诊断/回执）。
    pub fn publish(
        &self,
        session_id: &str,
        kind: &str,
        payload: serde_json::Value,
        run_id: Option<String>,
    ) -> Result<GatewayEvent, String> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err("sessionId 不能为空".to_string());
        }
        if !PUBLISHABLE_EVENT_TYPES.contains(&kind) {
            return Err(format!("事件类型不在白名单里：{}", kind));
        }
        let payload_bytes = serde_json::to_vec(&payload)
            .map_err(|e| format!("事件载荷无法序列化：{}", e))?
            .len();
        if payload_bytes > MAX_EVENT_PAYLOAD_BYTES {
            return Err(format!(
                "事件载荷过大（{} 字节，上限 {}）",
                payload_bytes, MAX_EVENT_PAYLOAD_BYTES
            ));
        }

        let mut inner = lock(&self.inner);
        let log_capacity = inner.log_capacity;
        let terminal_capacity = inner.terminal_capacity;
        let log_max_bytes = inner.log_max_bytes;
        inner.seq += 1;
        let mut event = GatewayEvent {
            seq: inner.seq,
            session_id: session_id.to_string(),
            kind: kind.to_string(),
            payload,
            run_id: run_id.filter(|r| !r.trim().is_empty()),
            timestamp: now_ms(),
            method: SESSION_EVENT_METHOD,
            bytes: 0,
        };
        // 协议本身不含 `bytes`（`serde(skip)`），这里只在内存里记一份大小用于淘汰。
        event.bytes = serde_json::to_vec(&event).map(|raw| raw.len()).unwrap_or(0);
        inner.log_bytes = inner.log_bytes.saturating_add(event.bytes);
        inner.log.push_back(event.clone());
        // 条数与**总字节**双上限：只按条数算，一条大事件也能把内存吃穿。
        while inner.log.len() > 1
            && (inner.log.len() > log_capacity || inner.log_bytes > log_max_bytes)
        {
            if let Some(front) = inner.log.pop_front() {
                inner.log_bytes = inner.log_bytes.saturating_sub(front.bytes);
            }
        }
        if TERMINAL_EVENT_TYPES.contains(&kind) {
            push_bounded(&mut inner.terminals, event.clone(), terminal_capacity);
        }
        drop(inner);
        // 没有订阅者时 `send` 返回 Err —— 那是正常状态（手机没在看），不是失败。
        let _ = self.subscribers.send(event.clone());
        Ok(event)
    }

    /// 订阅直播（必须先于 `resume` 调用，避免"补发与直播之间"漏事件）。
    pub fn subscribe(&self) -> broadcast::Receiver<GatewayEvent> {
        self.subscribers.subscribe()
    }

    /// 计算断线重连的补发计划。见文件头：缺口时不重放正文，只补终态 + reset。
    pub fn resume(&self, since: u64, session_id: &str) -> ResumePlan {
        let inner = lock(&self.inner);
        let latest = inner.seq;
        let oldest = inner.log.front().map(|e| e.seq).unwrap_or(latest + 1);
        // since == 0 = 新建连接（浏览器没带 Last-Event-ID）：只要直播，不补发历史。
        // 这样重新打开页面不会把上一次运行的正文再追加一遍。
        if since == 0 {
            return ResumePlan {
                reset: None,
                terminals: Vec::new(),
                events: Vec::new(),
                cursor_after: 0,
            };
        }
        let gap = latest == 0 || since > latest || since + 1 < oldest;
        if gap {
            let reason = if since > latest || latest == 0 {
                "generation_changed"
            } else {
                "replay_gap"
            };
            let reset = GatewayEvent::synthetic(
                RESET_EVENT,
                session_id,
                serde_json::json!({
                    "reason": reason,
                    "lastEventId": since,
                    "oldestAvailable": if inner.log.is_empty() {
                        serde_json::Value::Null
                    } else {
                        serde_json::json!(oldest)
                    },
                    "latest": latest,
                }),
            );
            // 被普通日志挤掉、但仍新于 since 的终态：客户端可能没见过。
            let terminals = inner
                .terminals
                .iter()
                .filter(|e| e.seq > since && e.seq < oldest && e.session_id == session_id)
                .cloned()
                .collect();
            return ResumePlan {
                reset: Some(reset),
                terminals,
                events: Vec::new(),
                cursor_after: latest,
            };
        }
        let events = inner
            .log
            .iter()
            .filter(|e| e.seq > since && e.session_id == session_id)
            .cloned()
            .collect();
        ResumePlan {
            reset: None,
            terminals: Vec::new(),
            events,
            cursor_after: latest,
        }
    }

    pub fn latest_seq(&self) -> u64 {
        lock(&self.inner).seq
    }

    pub fn client_count(&self) -> usize {
        self.clients.load(Ordering::SeqCst)
    }

    /// 占一个事件流名额；超过上限返回 `None`（调用方答 503，不静默排队）。
    pub fn acquire_client(self: &Arc<Self>) -> Option<ClientSlot> {
        let mut current = self.clients.load(Ordering::SeqCst);
        loop {
            if current >= MAX_EVENT_CLIENTS {
                return None;
            }
            match self.clients.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Some(ClientSlot(self.clone())),
                Err(actual) => current = actual,
            }
        }
    }
}

/// 事件流名额的 RAII 计数（连接断开/任务退出都会归还）。
pub struct ClientSlot(Arc<EventHub>);

impl Drop for ClientSlot {
    fn drop(&mut self) {
        self.0.clients.fetch_sub(1, Ordering::SeqCst);
    }
}

fn lock(inner: &Mutex<HubInner>) -> std::sync::MutexGuard<'_, HubInner> {
    // 事件枢纽没有"半更新"窗口（全是内存操作）：poison 只可能来自别的线程 panic，
    // 这里继续用里面的数据，比在网关里再抛一次 panic 更有用。
    inner.lock().unwrap_or_else(|e| e.into_inner())
}

fn push_bounded(queue: &mut VecDeque<GatewayEvent>, event: GatewayEvent, capacity: usize) {
    queue.push_back(event);
    while queue.len() > capacity {
        queue.pop_front();
    }
}

// ---- SSE 帧 ----

fn frame_with_id(event: &GatewayEvent) -> String {
    let data = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    format!("id: {}\ndata: {}\n\n", event.seq, data)
}

fn frame_without_id(event: &GatewayEvent) -> String {
    let data = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    format!("data: {}\n\n", data)
}

async fn write_frame(stream: &mut TcpStream, frame: &str) -> Result<(), ()> {
    stream.write_all(frame.as_bytes()).await.map_err(|_| ())
}

/// 按 `cursor` 补发。**调用方必须先 `subscribe()` 再调它**（原因见 `serve_stream`）。
async fn send_resume(
    stream: &mut TcpStream,
    hub: &EventHub,
    session_id: &str,
    cursor: &mut u64,
) -> Result<(), ()> {
    let plan = hub.resume(*cursor, session_id);
    if let Some(reset) = plan.reset {
        write_frame(stream, &frame_without_id(&reset)).await?;
    }
    for event in plan.terminals.iter().chain(plan.events.iter()) {
        write_frame(stream, &frame_with_id(event)).await?;
    }
    *cursor = plan.cursor_after;
    Ok(())
}

/// 跑完一条 `/events` 连接：写响应头 → ready → 补发 → 直播直到断开/网关停止。
///
/// 鉴权由调用方（`gateway/mod.rs`）在写响应头**之前**完成。
pub async fn serve_stream(
    mut stream: TcpStream,
    hub: Arc<EventHub>,
    session_id: String,
    since: u64,
    device_id: String,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), ()> {
    let Some(_slot) = hub.acquire_client() else {
        eprintln!(
            "[gateway] too many event streams ({} open, max {})",
            hub.client_count(),
            MAX_EVENT_CLIENTS
        );
        let body = r#"{"error":"too_many_streams","message":"事件流连接数已达上限，请稍后重试"}"#;
        let head = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await.map_err(|_| ())?;
        stream.write_all(body.as_bytes()).await.map_err(|_| ())?;
        return Ok(());
    };

    /*
     * 顺序是刻意的：**先订阅，再补发**。
     * 反过来的话，"补发查询"与"订阅生效"之间发布的事件会永远丢失 —— 而 SSE 的
     * 补发语义正是"不丢"。订阅后收到的重复（补发里也有）由 `seq > cursor` 去掉。
     */
    let mut receiver = hub.subscribe();
    let header = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream; charset=utf-8\r\n",
        "Cache-Control: no-cache, no-transform\r\n",
        "X-Accel-Buffering: no\r\n",
        "X-Content-Type-Options: nosniff\r\n",
        "Referrer-Policy: no-referrer\r\n",
        "Connection: keep-alive\r\n",
        "\r\n",
        // EventSource 的默认重连间隔是 3s；显式写出来，手机弱网下更可预期。
        "retry: 2000\n\n"
    );
    write_frame(&mut stream, header).await?;

    let ready = GatewayEvent::synthetic(
        READY_EVENT,
        &session_id,
        serde_json::json!({
            "deviceId": device_id,
            "sessionId": session_id,
            "since": since,
            "latest": hub.latest_seq(),
        }),
    );
    write_frame(&mut stream, &frame_without_id(&ready)).await?;

    let mut cursor = since;
    send_resume(&mut stream, &hub, &session_id, &mut cursor).await?;

    let mut heartbeat = interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
    loop {
        tokio::select! {
            // 停止网关时优先断开（`stop` 会等监听任务，但事件流是独立任务，必须主动收）。
            changed = shutdown.changed() => {
                let _ = changed;
                break;
            }
            _ = heartbeat.tick() => {
                if write_frame(&mut stream, &format!(": ping {}\n\n", now_ms())).await.is_err() {
                    break;
                }
            }
            received = receiver.recv() => {
                match received {
                    Ok(event) => {
                        // 补发已经发过的（或不属于这个会话的）不再发。
                        if event.seq <= cursor || event.session_id != session_id {
                            continue;
                        }
                        if write_frame(&mut stream, &frame_with_id(&event)).await.is_err() {
                            break;
                        }
                        cursor = event.seq;
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // 慢客户端：不能假装没丢。发 reset（界面据此重新对齐），
                        // 再补发还在日志里的终态。cursor 由 resume 更新。
                        eprintln!(
                            "[gateway] event stream lagged ({} events skipped); resetting cursor",
                            skipped
                        );
                        let mut lag_cursor = cursor;
                        if send_resume(&mut stream, &hub, &session_id, &mut lag_cursor)
                            .await
                            .is_err()
                        {
                            break;
                        }
                        cursor = lag_cursor;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
}

// ---- 单测 ----

#[cfg(test)]
mod tests {
    use super::*;

    fn publish(hub: &EventHub, kind: &str) -> GatewayEvent {
        hub.publish("s1", kind, serde_json::json!({ "n": kind }), Some("run-1".into()))
            .expect("publish")
    }

    #[test]
    fn publish_assigns_monotonic_global_seq_and_rejects_unknown_types() {
        let hub = EventHub::new();
        let a = publish(&hub, "assistant.text");
        let b = publish(&hub, "tool.start");
        assert_eq!(a.seq, 1);
        assert_eq!(b.seq, 2);
        assert_eq!(hub.latest_seq(), 2);
        assert_eq!(a.method, SESSION_EVENT_METHOD);
        assert_eq!(a.run_id.as_deref(), Some("run-1"));

        // 白名单 / 空会话 / 超大载荷都必须如实拒绝（不静默丢弃）。
        assert!(hub
            .publish("s1", "gateway.reset", serde_json::json!({}), None)
            .is_err());
        assert!(hub
            .publish("  ", "assistant.text", serde_json::json!({}), None)
            .is_err());
        let huge = "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1);
        assert!(hub
            .publish("s1", "assistant.text", serde_json::json!({ "text": huge }), None)
            .is_err());
        assert_eq!(hub.latest_seq(), 2, "被拒绝的事件不许占序号");
    }

    #[test]
    fn resume_replays_only_newer_events_for_the_same_session() {
        let hub = EventHub::new();
        publish(&hub, "assistant.text");
        hub.publish("s2", "assistant.text", serde_json::json!({}), None)
            .expect("s2");
        publish(&hub, "tool.start");

        // 新连接：只直播，不补发历史（否则重开页面会重复追加正文）。
        let fresh = hub.resume(0, "s1");
        assert!(fresh.reset.is_none());
        assert!(fresh.events.is_empty());
        assert_eq!(fresh.cursor_after, 0);

        // 从 seq=1 续传：只给 s1 的 seq=3（seq=2 是别的会话）。
        let resumed = hub.resume(1, "s1");
        assert!(resumed.reset.is_none());
        assert_eq!(
            resumed.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![3]
        );
        assert_eq!(resumed.cursor_after, 3);
        assert!(resumed.terminals.is_empty());
    }

    #[test]
    fn gap_sends_reset_and_keeps_terminal_events_that_fell_out() {
        // 容量 2：seq1 普通、seq2 终态、seq3/seq4 普通 ⇒ seq1、seq2 被挤出普通日志。
        let hub = EventHub::with_capacity(2, 8);
        hub.publish("s1", "assistant.text", serde_json::json!({}), None)
            .expect("1");
        hub.publish("s1", "run.finished", serde_json::json!({ "state": "succeeded" }), None)
            .expect("2");
        hub.publish("s1", "assistant.text", serde_json::json!({}), None)
            .expect("3");
        hub.publish("s1", "assistant.text", serde_json::json!({}), None)
            .expect("4");

        let plan = hub.resume(1, "s1");
        assert!(plan.reset.is_some(), "缺口必须显式告诉客户端");
        assert_eq!(
            plan.reset.as_ref().map(|r| r.seq),
            Some(SYNTHETIC_SEQ),
            "reset 不占序号、帧里不带 id"
        );
        assert_eq!(
            plan.terminals.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![2],
            "被挤出日志的终态必须补发（至少不丢终态）"
        );
        assert!(
            plan.events.is_empty(),
            "缺口时不重放正文（重放会让界面重复追加文本）"
        );
        assert_eq!(plan.cursor_after, 4);

        // 终端已经在 since 之前收到过 ⇒ 不重复补发。
        let seen = hub.resume(2, "s1");
        assert!(seen.terminals.is_empty());
    }

    #[test]
    fn generation_change_resets_cursor_so_live_events_are_not_skipped() {
        let hub = EventHub::with_capacity(8, 8);
        publish(&hub, "assistant.text"); // seq=1
        // 客户端拿着上一代网关的 Last-Event-ID=42 回来：必须 reset，且 cursor 归到当前真值。
        let plan = hub.resume(42, "s1");
        assert!(plan.reset.is_some());
        assert_eq!(plan.cursor_after, 1);
        assert!(plan.events.is_empty());

        // 之后直播的新事件（seq=2）必须还能送达（cursor=1 < 2）。
        let next = publish(&hub, "run.finished");
        assert_eq!(next.seq, 2);
        assert!(next.seq > plan.cursor_after);
    }

    #[test]
    fn terminal_log_is_bounded_and_last_events_survive() {
        let hub = EventHub::with_capacity(1, 2);
        for _ in 0..4 {
            hub.publish("s1", "run.finished", serde_json::json!({}), None)
                .expect("terminal");
        }
        let plan = hub.resume(0, "s1"); // since=0 不补发；借 inner 检查有界
        assert!(plan.events.is_empty());
        let inner = lock(&hub.inner);
        assert_eq!(inner.terminals.len(), 2);
        assert_eq!(inner.terminals.back().map(|e| e.seq), Some(4));
    }

    #[test]
    fn log_is_bounded_by_total_bytes_not_only_count() {
        // 条数上限很大、字节上限很小：必须按字节淘汰（一条大事件也不能吃穿内存）。
        let hub = EventHub::with_limits(10_000, 8, 32 * 1024);
        for _ in 0..20 {
            hub.publish(
                "s1",
                "assistant.text",
                serde_json::json!({ "text": "x".repeat(4000) }),
                None,
            )
            .expect("publish");
        }
        let inner = lock(&hub.inner);
        assert!(inner.log.len() < 20, "字节上限必须真的淘汰旧事件");
        assert!(
            inner.log_bytes <= 32 * 1024,
            "日志字节数必须始终有界：{}",
            inner.log_bytes
        );
        assert_eq!(
            inner.log.back().map(|e| e.seq),
            Some(20),
            "最新事件永远保留（不能为了限额把刚发生的丢掉）"
        );
    }

    #[test]
    fn client_slots_are_bounded_and_released_on_drop() {
        let hub = EventHub::new();
        let mut slots = Vec::new();
        for _ in 0..MAX_EVENT_CLIENTS {
            slots.push(hub.acquire_client().expect("slot"));
        }
        assert_eq!(hub.client_count(), MAX_EVENT_CLIENTS);
        assert!(hub.acquire_client().is_none(), "超过上限必须拒绝，而不是无限接受");
        slots.pop();
        assert_eq!(hub.client_count(), MAX_EVENT_CLIENTS - 1);
        assert!(hub.acquire_client().is_some());
    }
}
