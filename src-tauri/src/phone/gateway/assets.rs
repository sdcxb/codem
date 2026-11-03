// ============================================================
// phone/gateway/assets.rs — 共享 UI 的静态资源
//
// M1 不另写手机页面：网关直接提供 `packages/host/web` 的构建物
// （`ui.js` / `ui.css` / `index.html`）。这样手机看到的会话组件、样式
// 与 Host/桌面是**同一份**。
//
// ## 路径解析顺序
//
// 1. 安装包资源：`<resource_dir>/resources/host/web`（网关共享 UI 的 staging 位置；
//    M4 后桌面不再有 Host sidecar，目录名保留是为了兼容既有安装包布局）
// 2. 安装包资源的另一种布局：`<resource_dir>/host/web`
// 3. 开发树：`src-tauri/resources/host/web`（`stage-host-sidecar.mjs` 的产物）
// 4. 开发树：`packages/host/web`（未 stage 时也能用）
//
// 四个都找不到就**启动失败**并列出尝试过的路径 —— 不能在手机上静默打开一个
// 空白页。
//
// ## 为什么这里**不再**注入只读标记
//
// M1 时网关在 `index.html` 里注入过 `window.__CODEM_GATEWAY_READ_ONLY__`，
// 因为那时手机端还没有事件流与审批，写入口只能是半套 UI。
//
// M2 之后写/审批/取消/事件都通了，"能不能写"不再由**哪个宿主在发页面**决定，
// 而由 `host.hello.capabilities`（服务器实际开放的方法）决定：
// 能力表里有 `prompt.send`/`run.cancel`/`approval.*` 就是写模式，没有就是只读。
// 这样同一份 `ui.js` 服务 Host 与网关时不会出现两个真相，也不会出现
// "网关升级了但标记忘删" 的属性 —— 标记本身已整块删除。
// ============================================================

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// 静态资源的固定白名单。网关不提供目录遍历，也不猜测任意文件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Asset {
    Index,
    UiJs,
    UiCss,
}

impl Asset {
    #[cfg(test)]
    pub fn path(self) -> &'static str {
        match self {
            Asset::Index => "/",
            Asset::UiJs => "/ui.js",
            Asset::UiCss => "/ui.css",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Asset::Index => "text/html; charset=utf-8",
            Asset::UiJs => "text/javascript; charset=utf-8",
            Asset::UiCss => "text/css; charset=utf-8",
        }
    }
}

#[derive(Debug)]
pub struct GatewayWeb {
    index: Vec<u8>,
    ui_js: Vec<u8>,
    ui_css: Vec<u8>,
}

impl GatewayWeb {
    /// 从安装包/开发树的候选目录加载。所有文件必须同时存在。
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = app.path().resource_dir() {
            candidates.push(dir.join("resources").join("host").join("web"));
            candidates.push(dir.join("host").join("web"));
        }
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(manifest.join("resources").join("host").join("web"));
        candidates.push(manifest.join("..").join("packages").join("host").join("web"));

        let mut tried: Vec<String> = Vec::new();
        for dir in candidates {
            // 规范化只用于错误信息和打开文件；路径不存在时保留原样，让 `from_dir`
            // 给出“缺少 index.html”的精确错误。
            let dir = dir.canonicalize().unwrap_or(dir);
            tried.push(dir.display().to_string());
            if let Ok(web) = Self::from_dir(&dir) {
                return Ok(web);
            }
        }
        Err(format!(
            "缺少共享 UI 静态资源（找过：{}）。先运行 `npm run host:build:ui` 与 `node tools/build/stage-host-sidecar.mjs`",
            tried.join(" / ")
        ))
    }

    pub fn from_dir(dir: &Path) -> Result<Self, String> {
        let index = std::fs::read_to_string(dir.join("index.html"))
            .map_err(|e| format!("读取 {} 失败: {}", dir.join("index.html").display(), e))?;
        let index = validate_index(&index)?;
        let ui_js = std::fs::read(dir.join("ui.js"))
            .map_err(|e| format!("读取 {} 失败: {}", dir.join("ui.js").display(), e))?;
        let ui_css = std::fs::read(dir.join("ui.css"))
            .map_err(|e| format!("读取 {} 失败: {}", dir.join("ui.css").display(), e))?;
        Ok(GatewayWeb {
            index: index.into_bytes(),
            ui_js,
            ui_css,
        })
    }

    /// 测试/嵌入场景直接给三份字节（不经过文件系统）。
    #[cfg(test)]
    pub fn from_parts(index_html: &str, ui_js: Vec<u8>, ui_css: Vec<u8>) -> Result<Self, String> {
        Ok(GatewayWeb {
            index: validate_index(index_html)?.into_bytes(),
            ui_js,
            ui_css,
        })
    }

    pub fn get(&self, asset: Asset) -> &[u8] {
        match asset {
            Asset::Index => &self.index,
            Asset::UiJs => &self.ui_js,
            Asset::UiCss => &self.ui_css,
        }
    }
}

/// 只做"这是一份能挂共享 UI 的 index"的结构校验：必须引用 `ui.js`。
///
/// M2 不再改写 HTML（只读标记已删）：返回原文本，让网关提供的页面与
/// Host 提供的页面**逐字节相同**。
fn validate_index(html: &str) -> Result<String, String> {
    if !html.contains("ui.js") {
        return Err("共享 UI 的 index.html 没有引用 ui.js，网关无法挂载".to_string());
    }
    Ok(html.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn html() -> &'static str {
        "<!doctype html><html><head><title>x</title></head><body><div id=\"app\"></div><script src=\"ui.js\"></script></body></html>"
    }

    #[test]
    fn index_is_served_verbatim_without_any_injected_marker() {
        let web = GatewayWeb::from_parts(html(), b"js".to_vec(), b"css".to_vec()).unwrap();
        let index = String::from_utf8(web.get(Asset::Index).to_vec()).unwrap();
        // M2：能力由 host.hello 决定，页面不再被网关改写（否则 Host 与网关两套 DOM）。
        assert_eq!(index, html());
        assert!(!index.contains("__CODEM_GATEWAY_READ_ONLY__"));
    }

    #[test]
    fn rejects_html_without_ui_bundle() {
        assert!(
            GatewayWeb::from_parts("<html><head></head><body>no bundle</body></html>", vec![], vec![])
                .is_err(),
            "没有 ui.js 的 index 不能启动网关"
        );
    }

    #[test]
    fn asset_paths_and_types_are_explicit() {
        assert_eq!(Asset::Index.path(), "/");
        assert_eq!(Asset::UiJs.path(), "/ui.js");
        assert!(Asset::Index.content_type().starts_with("text/html"));
        assert!(Asset::UiJs.content_type().starts_with("text/javascript"));
        assert!(Asset::UiCss.content_type().starts_with("text/css"));
    }
}
