//! 「免费模型插件」（dsh-our-free-model 的 standalone 本地服务）的**独立进程生命周期**。
//!
//! ## 为什么需要 Rust 这一侧
//!
//! 插件本体是**一个长期驻留的 Node HTTP 服务**（`packages/standalone/cli.mjs`，只监听回环地址）。
//! 渲染侧没有"起一个长驻子进程并拿住它"的能力（`execute_command` 是"跑完返回"的一次性通道），
//! 而 MCP 服务器那条路已经有现成的模式：Rust 起进程、把句柄存在 `AppState` 里、要停的时候杀。
//! 这里照那条模式做一个**最小**版本 —— 只做四件事：起、停、查、留给退出时清理。
//!
//! ## 纪律（与用户的要求一一对应）
//!
//! - **独立**：进程与数据目录都在 `<appData>/extensions/our-free-model/` 下，与 Codem 的库、日志、
//!   会话毫无交集；本模块只碰这个目录与这一个子进程。
//! - **可暂停 / 可删除**：`ofm_stop` 只杀进程（数据留着）；`ofm_delete` 由渲染侧删目录，
//!   删完把内存态清掉（下一次 `ofm_start` 会因为脚本不存在而如实报错，而不是假装成功）。
//! - **杀掉要杀干净**：Windows 上 node 会派生子进程（worker），所以停的时候走 `taskkill /T`
//!   （与 `kill_process_tree` 同一条纪律），避免"停了但端口还占着"。
//!
//! ⚠️ 这里**不**做"自动重启/看门狗"：用户暂停了就应当真停；要看状态的是界面上那张卡片。

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tokio::process::Child;
use tokio::sync::Mutex;

use tauri::{AppHandle, Manager, State};

/// 常驻的插件进程句柄（只可能有 0 或 1 个 —— 同一个数据目录只允许一个实例）
#[derive(Default)]
pub struct OfmState {
    child: Mutex<Option<Child>>,
    /// 服务端口（起来之后由 `ofm_start` 记下；`ofm_state` 回给界面用）
    port: Mutex<Option<u16>>,
}

/// 给界面看的进程状态
#[derive(Serialize, Clone)]
pub struct OfmProcessState {
    /// 我们**自己起的**那个进程还在不在（不代表服务健康 —— 健康由渲染侧请求 /health 判定）
    pub running: bool,
    /// 该进程的 pid（不在时为 None）
    pub pid: Option<u32>,
    /// 端口（起过就有；端口冲突时由 `ofm_start` 的调用方负责换一个再试）
    pub port: Option<u16>,
}

/// 测试/诊断用：本模块只碰这个相对路径（在 app data 目录下）
pub const OFM_EXTENSION_DIR: &str = "extensions/our-free-model";

/// 扩展目录的绝对路径（**唯一**的路径来源；渲染侧也用不到别的路径）
#[tauri::command]
pub async fn ofm_extension_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取不到应用数据目录：{e}"))?
        .join(OFM_EXTENSION_DIR);
    Ok(strip_verbatim(dir))
}

/// 去掉 Windows 的**逐字路径前缀** `\\?\`。
/// ## 这个前缀是真机踩出来的坑（本波最重要的一条教训）
///
/// Tauri 的 `resource_dir()` / `app_data_dir()` 在 Windows 上返回的是逐字路径
/// （`\\?\C:\Users\…\resources\ofm`）。把它原样交给 **Node** 当脚本路径，
/// Node 解析入口模块时会在 `resolveMainPath` 里崩掉：
///
/// ```text
/// Error: EISDIR: illegal operation on a directory, lstat 'C:'
///     at resolveMainPath (node:internal/modules/run_main:35:21)
/// ```
///
/// 症状极具误导性：`ofm_start` 报"进程起来了"（spawn 确实成功），12 秒后进程已退出、
/// `/health` 永远不通，而**真正的报错在 GUI 里谁都看不到** —— 那正是"子进程输出必须落盘"
/// （`plugin.log` + `ofm_log_tail`）这条改动的由来。去掉前缀后同一路径 Node 就能正常跑。
fn strip_verbatim(path: std::path::PathBuf) -> String {    let s = path.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None => s,
    }
}

/// 清掉"持有者已经死了"的 `<dataDir>/service.lock`（详见 `ofm_start` 里的说明）。
///
/// 判定：锁里 `pid` 对应的进程**不在跑**才删。`tasklist /FI "PID eq N"` 在找到进程时退出码为 0、
/// 输出里带该 pid；找不到时退出码 1 —— 用退出码判定即可（不解析本地化输出）。
fn clear_stale_lock(data_dir: &str) {
    let lock = std::path::Path::new(data_dir).join("service.lock");
    let Ok(text) = std::fs::read_to_string(&lock) else { return };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
        /* 锁文件坏了（写到一半被杀）：也可以删，否则同样会永久挡住启动 */
        let _ = std::fs::remove_file(&lock);
        return;
    };
    let Some(pid) = parsed.get("pid").and_then(|v| v.as_u64()) else {
        let _ = std::fs::remove_file(&lock);
        return;
    };
    #[cfg(target_os = "windows")]
    {
        let alive = std::process::Command::new("tasklist")
            .arg("/FI")
            .arg(format!("PID eq {pid}"))
            .arg("/NH")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map(|out| {
                /* /NH 关掉表头：还活着时输出里有那一行 pid；不在时输出是「信息: 没有运行的任务匹配指定标准。」 */
                String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
            })
            .unwrap_or(true); /* 问不出来 ⇒ **保守**当作还活着（宁可不删） */
        if !alive {
            let _ = std::fs::remove_file(&lock);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
    }
}

/// 内置插件代码所在目录（打包后是 resource 目录里的 `resources/ofm`；开发时是仓库里的同一条路径）
///
/// 为什么要 Rust 来算：只有宿主知道资源被装到哪儿去了。渲染侧拿这个路径去**复制**到扩展目录，
/// 之后运行的是扩展目录里的副本（于是"删除扩展"只要删那个目录，不会动到安装包）。
#[tauri::command]
pub async fn ofm_bundled_dir(app: AppHandle) -> Result<String, String> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| format!("取不到资源目录：{e}"))?
        .join("resources")
        .join("ofm");
    if resource.exists() {
        return Ok(strip_verbatim(resource));
    }
    /* 开发态：资源没有被打进 bundle，回退到仓库里的源路径（`src-tauri/resources/ofm`） */
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("ofm");
    if dev.exists() {
        return Ok(strip_verbatim(dev));
    }
    Err("内置的插件代码不存在（安装包不完整？）".to_string())
}

/// 起服务。**端口由调用方决定**（渲染侧先探一个空闲端口再传进来）——
/// 这样"服务在哪个端口"是确定的，不必去解析子进程的 stdout（那是最脆的一种做法）。
#[tauri::command]
pub async fn ofm_start(
    state: State<'_, OfmState>,
    node_exe: String,
    script: String,
    data_dir: String,
    port: u16,
) -> Result<OfmProcessState, String> {
    let mut guard = state.child.lock().await;
    if let Some(child) = guard.as_mut() {
        /* 已经在跑：**如实返回当前状态**，不重复起第二个（同数据目录只允许一个实例） */
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            let pid = child.id();
            let port = *state.port.lock().await;
            return Ok(OfmProcessState { running: true, pid, port });
        }
    }

    if !std::path::Path::new(&script).exists() {
        return Err(format!("插件入口不存在：{script}（扩展目录被删了？重新启用会重新安装）"));
    }
    let _ = std::fs::create_dir_all(&data_dir);
    /*
     * ★ 第 201 波真机补的一条：**清掉"持有者已经死了"的 `service.lock`**。
     *
     * 插件用 `<dataDir>/service.lock` 做单实例保护（内容形如
     * `{"pid":8144,"product":"our-free-model-standalone"}`）。它只在**正常退出**时删锁 ——
     * 宿主崩溃、`taskkill`、断电之后锁会留下，下一次启动就变成：
     * 「数据目录已被服务占用，请检查 service.lock 中的进程」⇒ **插件永远起不来了**，
     * 而界面只能说"已启用，尚未启动"（上游 README 让人手工确认并删锁，普通用户不会做这件事）。
     *
     * 判定纪律：**只有锁里记的 pid 确实不在跑**才删（`tasklist` 退出码 0 表示找到了该进程）。
     * 别人的进程正好复用了那个 pid 时，最坏结果是"少删一次锁"（退回手工处理），
     * 绝不会把正在运行的实例的锁删掉 ⇒ 不会出现两个实例抢同一个数据目录。
     */
    clear_stale_lock(&data_dir);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("建数据目录失败：{e}"))?;

    let mut cmd = tokio::process::Command::new(&node_exe);
    cmd.arg(&script)
        .arg("--port")
        .arg(port.to_string())
        .arg("--data-dir")
        .arg(&data_dir)
        .current_dir(
            std::path::Path::new(&script)
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .unwrap_or(std::path::Path::new(".")),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    #[cfg(target_os = "windows")]
    {
        /* 让子进程不要闪一个黑框（tokio 的 Command 自带 `creation_flags`，不需要导 trait） */
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动插件进程失败（{node_exe}）：{e}"))?;
    let pid = child.id();

    /*
     * stdout/stderr **必须被读走**（管道写满会阻塞子进程），而且**要落盘**：
     *
     * 第一版把它们 `eprintln!` 了 —— 那在 GUI 里等于丢掉（Windows GUI 进程没有控制台），
     * 于是"进程起来了但服务没就绪"这句话背后**真正的报错看不到**（本波真机就卡在这里：
     * 卡片只能说"没就绪"，而我无从知道是缺文件、端口被占还是 Node 版本不对）。
     * 现在写进 `<data_dir>/plugin.log`（跟着扩展走 ⇒ 删除扩展时一起清掉），
     * 由 `ofm_log_tail` 给界面显示最后几行。
     */
    let log_path = std::path::Path::new(&data_dir).join("plugin.log");
    let _ = std::fs::write(&log_path, b"");
    if let Some(out) = child.stdout.take() {
        let path = log_path.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut f) = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await {
                    let _ = f.write_all(format!("{line}\n").as_bytes()).await;
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let path = log_path.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut f) = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await {
                    let _ = f.write_all(format!("[stderr] {line}\n").as_bytes()).await;
                }
            }
        });
    }

    *guard = Some(child);
    *state.port.lock().await = Some(port);
    Ok(OfmProcessState { running: true, pid, port: Some(port) })
}

/// 停服务（**只杀进程，数据留着** ⇒ 再启用时不用重新登录/重新拉清单）
#[tauri::command]
pub async fn ofm_stop(state: State<'_, OfmState>) -> Result<(), String> {
    let mut guard = state.child.lock().await;
    let Some(mut child) = guard.take() else {
        return Ok(());
    };
    let pid = child.id();
    /* 先让 tokio 杀一次（含它的直接子进程） */
    let _ = child.kill().await;
    let _ = child.wait().await;
    /* Windows：node 会派生 worker ⇒ 整棵树都收掉，避免"停了但端口还占着" */
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        let _ = tokio::process::Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    *state.port.lock().await = None;
    Ok(())
}

/// 读插件自己的运行日志的最后 N 行（**诊断的唯一出口**）。
///
/// 为什么必须由宿主提供：插件是个被 spawn 的子进程，它的 stdout/stderr 没有终端可去；
/// 把它落盘（`ofm_start` 里做）再读出来，用户才能看到"为什么没起来"。
#[tauri::command]
pub async fn ofm_log_tail(data_dir: String, lines: Option<usize>) -> Result<String, String> {
    let path = std::path::Path::new(&data_dir).join("plugin.log");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(String::new()),
    };
    let want = lines.unwrap_or(40).min(500);
    let all: Vec<&str> = content.lines().collect();
    let start = all.len().saturating_sub(want);
    Ok(all[start..].join("\n"))
}

/// 查状态：**只回答"我们自己起的那个进程还在不在"** —— 服务健不健康由渲染侧请求 /health 判定
/// （进程活着但端口没起来是真实形态，不能在这里替它说"健康"）。
#[tauri::command]
pub async fn ofm_state(state: State<'_, OfmState>) -> Result<OfmProcessState, String> {
    let mut guard = state.child.lock().await;
    let port = *state.port.lock().await;
    let Some(child) = guard.as_mut() else {
        return Ok(OfmProcessState { running: false, pid: None, port });
    };
    match child.try_wait().map_err(|e| e.to_string())? {
        None => Ok(OfmProcessState { running: true, pid: child.id(), port }),
        Some(_) => {
            /* 已经退出：把句柄清掉，免得下一次 start 误判"在跑" */
            *guard = None;
            Ok(OfmProcessState { running: false, pid: None, port })
        }
    }
}

/// 应用退出时把插件一起收掉（**不让它变成孤儿进程**）。
///
/// 与 MCP 的 `kill_all_mcp_processes` 同一条纪律：宿主退出 ⇒ 它起的服务也该退。
///
/// 为什么这里是**同步**版本：Tauri 的 `RunEvent` 回调不是 async，里面不能 `.await`
/// （用 `blocking_lock` + `start_kill` + 同步 `taskkill`，语义与异步版逐条一致）。
/// 真机上这条纪律的必要性当场见过：重装之后旧实例还占着 18937，新实例只能换端口。
pub fn shutdown_ofm(state: &OfmState) {
    let mut guard = state.child.blocking_lock();
    let Some(mut child) = guard.take() else { return };
    let pid = child.id();
    /* `start_kill` 是同步的（发信号/结束进程），随后用 taskkill 把整棵树收掉 */
    let _ = child.start_kill();
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}