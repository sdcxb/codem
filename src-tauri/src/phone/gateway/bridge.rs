// ============================================================
// phone/gateway/bridge.rs — 网关 → 渲染层的一次往返
//
// 生产实现走**和 AA bridge 同一条**事件桥：`phone::forward_to_renderer`
// 发 `remote-request`，TS 处理完用 `remote_respond` 回答。
//
// 为什么抽成一个 trait：`cargo test` 不该需要 Tauri `AppHandle`/窗口才能验证
// "监听 → 路由 → 转发 → 写回"这条链路。测试里换成假实现，生产里换回事件桥，
// HTTP 那一半（`gateway::serve`）一行都不用分叉。
// ============================================================

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tauri::AppHandle;

use crate::phone::http::{Request as HttpRequest, Response as HttpResponse};
use crate::phone::{forward_to_renderer, PhoneState};

/// 装箱的将来。`async fn` 在 trait 里对 `dyn` 不友好（RPITIT 不能做 trait object），
/// 所以这里显式装箱 —— 网关只按请求收费，装箱开销可以忽略。
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 网关把一条请求交给渲染层，等它的应答。
pub trait RendererBridge: Send + Sync + 'static {
    fn forward<'a>(&'a self, req: HttpRequest) -> BoxFuture<'a, HttpResponse>;
}

/// 生产实现：Tauri 事件桥（`remote-request` → `remote_respond`）。
pub struct TauriBridge {
    app: AppHandle,
    phone: Arc<PhoneState>,
}

impl TauriBridge {
    pub fn new(app: AppHandle, phone: Arc<PhoneState>) -> Self {
        Self { app, phone }
    }
}

impl RendererBridge for TauriBridge {
    fn forward<'a>(&'a self, req: HttpRequest) -> BoxFuture<'a, HttpResponse> {
        Box::pin(async move { forward_to_renderer(&self.app, &self.phone, req).await })
    }
}
