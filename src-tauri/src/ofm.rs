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
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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
    if !pid_alive(pid as u32) {
        let _ = std::fs::remove_file(&lock);
    }
}

/// 这个 pid 还在不在跑（`tasklist /FI "PID eq N" /NH`；**问不出来时保守当作还活着**）。
///
/// 抽出来是因为它现在有三处消费者：清陈旧锁、结束卡住的锁持有者、以及"等它真的退出"。
/// 第 214 波的棘轮要求：**任何 spawn 控制台程序都必须带 CREATE_NO_WINDOW**（否则每次启动闪黑框）。
fn pid_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("tasklist")
            .arg("/FI")
            .arg(format!("PID eq {pid}"))
            .arg("/NH")
            .creation_flags(0x0800_0000) /* CREATE_NO_WINDOW：查进程也不许闪黑框 */
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map(|out| {
                /* /NH 关掉表头：还活着时输出里有那一行 pid；不在时输出是「信息: 没有运行的任务匹配指定标准。」 */
                String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
            })
            .unwrap_or(true) /* 问不出来 ⇒ **保守**当作还活着（宁可不删） */
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        true
    }
}

/// 读 `<dataDir>/service.lock` 里的持有者 pid（没有/坏了/没写 pid ⇒ None）
fn lock_holder_pid(data_dir: &str) -> Option<u32> {
    let text = std::fs::read_to_string(std::path::Path::new(data_dir).join("service.lock")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    parsed.get("pid").and_then(|v| v.as_u64()).and_then(|v| u32::try_from(v).ok())
}

/// 一个进程的**命令行**（读不出来 ⇒ `None` = 不知道，调用方必须保守处理）。
///
/// 为什么要问命令行：锁里的 pid **可能已经被系统复用**给了别的进程 ——
/// 陈旧的锁只值得"删锁"，绝不值得"杀掉那个 pid"。只有能证明"它确实是本插件的进程"
/// 才允许结束它（`is_our_plugin_command`）。
fn process_command_line(pid: u32) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        /* 用 CIM 取**结构化字段**（不解析本地化的 tasklist 输出） */
        let script = format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine");
        let out = std::process::Command::new("powershell")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(script)
            .creation_flags(0x0800_0000) /* CREATE_NO_WINDOW */
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        None
    }
}

/// 命令行是不是**本插件**的进程？（只有能证明才允许杀）
///
/// 判据是命令行里出现了**这个数据目录**（唯一标识这一次安装；插件是被这样启动的：
/// `node.exe <...>/cli.mjs --port N --data-dir <dataDir>`）。
/// 归一化：`/` 与 `\` 统一、忽略大小写 —— 真机上插件的命令行里两种分隔符混着出现。
fn is_our_plugin_command(command_line: &str, data_dir: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").to_lowercase();
    let dir = norm(data_dir);
    if dir.is_empty() {
        return false;
    }
    norm(command_line).contains(&dir)
}

/// 结束**卡住的**锁持有者（第 227 波，用户实报）。
///
/// ## 为什么需要它
///
/// 真机形态：上一次运行留下的插件进程**还活着**（甚至还在服务），于是：
/// - `ofm_start` 起的新实例因为"数据目录已被服务占用"**立刻退出**；
/// - `clear_stale_lock` 看到锁里的 pid 还活着 ⇒ **不删锁**（设计如此，怕踩到别人的进程）；
/// - 结果：服务没就绪（30 秒超时）⇒ 用户看到「插件进程起来了，但 18937 上的服务在 30 秒内没有就绪」，
///   而唯一的出路（手工结束那个 node 进程、删 `service.lock`）写在**上游 README** 里 —— 普通用户做不到。
///
/// ## 安全边界（三条，缺一不可）
///
/// 1. **只有能证明是本插件的进程才杀**：命令行里必须出现这个数据目录；读不出命令行 ⇒ **不动手**；
/// 2. **绝不杀调用方自己刚起的那个**（`exclude_pid`）；
/// 3. 命令行不像本插件（pid 被复用）⇒ 只**删锁**（锁确实是陈旧的观测），不碰那个进程。
///
/// 返回被结束的 pid；`None` = 什么都没做（调用方按"没救回来"处理，别假装成功）。
#[tauri::command]
pub async fn ofm_kill_lock_holder(data_dir: String, exclude_pid: Option<u32>) -> Result<Option<u32>, String> {
    let Some(pid) = lock_holder_pid(&data_dir) else { return Ok(None) };
    if exclude_pid == Some(pid) {
        return Ok(None);
    }
    let lock = std::path::Path::new(&data_dir).join("service.lock");
    let Some(command_line) = process_command_line(pid) else {
        /* 读不出来 ⇒ 保守：不动手、也不删锁（交由用户/下一次判） */
        return Ok(None);
    };
    if !is_our_plugin_command(&command_line, &data_dir) {
        /* pid 被复用成别人的进程 ⇒ 锁是陈旧观测：删锁，但**不杀** */
        let _ = std::fs::remove_file(&lock);
        return Ok(None);
    }
    #[cfg(target_os = "windows")]
    {
        /* node 会派生子进程 ⇒ 收整棵树（与 ofm_stop 同一条纪律） */
        let _ = tokio::process::Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .creation_flags(0x0800_0000) /* CREATE_NO_WINDOW */
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await;
        /* 等它真的退出（最多 3 秒）：不等的话下一个实例仍可能撞上"数据目录已被服务占用" */
        for _ in 0..30 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let _ = std::fs::remove_file(&lock);
        Ok(Some(pid))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        Ok(None)
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

/// 内置便携 Node 的绝对路径（第 203 波，方案 A）。
///
/// 有了它，"缺 Node"这件事根本不会发生：渲染侧的解析顺序把**内置**排在最前，
/// 于是插件不依赖用户机器上的 PATH、也不依赖任何下载源（真机上那些源会成片瞬时 404）。
/// 没有内置（开发态没跑过 fetch-node.mjs）时返回 null，让调用方继续用系统/便携 Node。
#[tauri::command]
pub async fn ofm_bundled_node(app: AppHandle) -> Result<Option<String>, String> {
    let candidates = [
        app.path().resource_dir().ok().map(|d| d.join("resources").join("node").join("node.exe")),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("node").join("node.exe")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return Ok(Some(strip_verbatim(candidate)));
        }
    }
    Ok(None)
}

/// 把**内置 Node 复制到数据目录**再运行（第 212 波，用户实报）。
///
/// ## 为什么必须这么做
///
/// 内置的 `node.exe` 在**安装目录**里（`%LOCALAPPDATA%\Codem\resources\node\node.exe`）。
/// 没有够新的系统 Node 时，插件会直接运行它 ⇒ **安装目录被一个活进程占住**
/// ⇒ 升级安装写入该文件时报：`无法打开要写入的文件：…\resources\node\node.exe`（用户实报原文）。
///
/// 复制一份到数据目录（`<data_dir>/runtime/node.exe`）之后：
/// - 安装目录里只剩**只读资源**，升级随时可覆盖 ✓；
/// - 插件用的是可写目录里的副本，被强杀留下的孤儿进程也**不会**再挡住升级 ✓；
/// - 删除插件时随数据目录一起清掉 ✓。
///
/// 幂等：目标已存在且**大小一致**就直接复用（Node 版本变化必然改变大小 ⇒ 能被察觉）；
/// 写入走 `node.exe.new` + 改名，避免"复制到一半的 exe"被执行。
#[tauri::command]
pub async fn ofm_stage_node(bundled: String, data_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&bundled);
    if !src.exists() {
        return Err(format!("内置 Node 不存在：{bundled}"));
    }
    let runtime_dir = PathBuf::from(&data_dir).join("runtime");
    let target = runtime_dir.join("node.exe");
    let src_len = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
    if let Ok(meta) = std::fs::metadata(&target) {
        if src_len > 0 && meta.len() == src_len {
            return Ok(strip_verbatim(target));
        }
    }
    std::fs::create_dir_all(&runtime_dir).map_err(|e| format!("建目录失败：{e}"))?;
    let staging = runtime_dir.join("node.exe.new");
    std::fs::copy(&src, &staging).map_err(|e| format!("复制内置 Node 失败：{e}"))?;
    std::fs::rename(&staging, &target).map_err(|e| {
        let _ = std::fs::remove_file(&staging);
        format!("落位内置 Node 失败：{e}")
    })?;
    Ok(strip_verbatim(target))
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
            .creation_flags(0x0800_0000) /* CREATE_NO_WINDOW */
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
            .creation_flags(0x0800_0000) /* CREATE_NO_WINDOW */
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            /* 第 217 波（用户实报「点右键退出卡了一下、要按两次才退出」）：**发出去就不等** ——
               原来是 `.status()`（同步等 taskkill 收完整棵 node 树），而它跑在**退出路径**上：
               收树要几百毫秒到几秒 ⇒ 界面卡住、退出流程被堵 ⇒ 第一下没退成。
               现在改成 `.spawn()`：回收交给系统继续做（taskkill 是独立进程），万一没做完，
               下次启动还有 `clear_stale_lock`（按 pid 确认"锁的主人确实不在了"）兜底 ✓。
               这笔买卖很划算：**退出必须立刻响应**，而"有没有残留进程"本来就有第二道保障。 */
            .spawn();
    }
}