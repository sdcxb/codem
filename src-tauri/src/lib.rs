use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri::WindowEvent as WinEvent;
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::menu::{MenuBuilder, MenuItemBuilder};

// ========== Types ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub agent_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub message_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInfo {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostStats {
    pub total_cost: f64,
    pub today_cost: f64,
    pub total_sessions: u32,
    pub total_tokens: u64,
}

// ========== App State ==========

struct AppState {
    providers: Mutex<Vec<ProviderConfig>>,
    default_model: Mutex<String>,
    default_agent: Mutex<String>,
}

// ========== Commands ==========

#[tauri::command]
async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ChatRequest,
) -> Result<(), String> {
    let _model = request.model.clone().unwrap_or_else(|| state.default_model.lock().unwrap().clone());
    let _cwd = request.cwd.clone().unwrap_or_else(|| std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default());

    // Emit event that frontend will handle
    app.emit("chat-message", &request)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn get_providers(state: State<'_, AppState>) -> Result<Vec<ProviderConfig>, String> {
    let providers = state.providers.lock().unwrap().clone();
    Ok(providers)
}

#[tauri::command]
async fn add_provider(
    state: State<'_, AppState>,
    provider: ProviderConfig,
) -> Result<(), String> {
    let mut providers = state.providers.lock().unwrap();
    providers.push(provider);
    Ok(())
}

#[tauri::command]
async fn remove_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), String> {
    let mut providers = state.providers.lock().unwrap();
    providers.retain(|p| p.id != provider_id);
    Ok(())
}

#[tauri::command]
async fn get_default_model(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.default_model.lock().unwrap().clone())
}

#[tauri::command]
async fn set_default_model(
    state: State<'_, AppState>,
    model: String,
) -> Result<(), String> {
    *state.default_model.lock().unwrap() = model;
    Ok(())
}

#[tauri::command]
async fn get_default_agent(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.default_agent.lock().unwrap().clone())
}

#[tauri::command]
async fn set_default_agent(
    state: State<'_, AppState>,
    agent: String,
) -> Result<(), String> {
    *state.default_agent.lock().unwrap() = agent;
    Ok(())
}

#[tauri::command]
async fn read_file(path: String, encoding: Option<String>) -> Result<String, String> {
    match encoding.as_deref() {
        Some("base64") => {
            // Read binary file and encode as base64
            use base64::Engine;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
        }
        _ => {
            // Read as UTF-8 text, strip BOM if present
            let mut content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            // Strip UTF-8 BOM (EF BB BF) — some Windows tools (Notepad, VS Code) add it
            if content.starts_with('\u{FEFF}') {
                content = content.trim_start_matches('\u{FEFF}').to_string();
            }
            Ok(content)
        }
    }
}

#[tauri::command]
async fn write_file(path: String, content: String, encoding: Option<String>, workspace: Option<String>) -> Result<(), String> {
    // S5: Sandbox path whitelist — if workspace is provided, restrict writes to workspace
    if let Some(ref ws) = workspace {
        let ws_canonical = canonicalize_path(ws);
        let target_canonical = canonicalize_path(&path);
        if !target_canonical.starts_with(&ws_canonical) {
            return Err(format!(
                "Sandbox: Write to '{}' is outside the workspace '{}'. Set the workspace directory or disable sandbox mode in settings.",
                path, ws
            ));
        }
    }

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    match encoding.as_deref() {
        Some("base64") => {
            // Decode base64 content and write as binary
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&content)
                .map_err(|e| format!("Base64 decode error: {}", e))?;
            std::fs::write(&path, bytes).map_err(|e| e.to_string())
        }
        _ => {
            // Write as UTF-8 text
            std::fs::write(&path, content).map_err(|e| e.to_string())
        }
    }
}

/// S5: Canonicalize a path for comparison (resolve . and .. without requiring the path to exist)
fn canonicalize_path(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('\\') {
        if part == "" || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    let result = parts.join("\\");
    // Preserve drive letter prefix
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        result
    } else if normalized.starts_with("\\\\") {
        format!("\\{}", result)
    } else {
        result
    }
}

#[tauri::command]
async fn append_file(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<serde_json::Value>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') || name == "node_modules" {
            continue;
        }

        result.push(serde_json::json!({
            "name": name,
            "path": entry.path().to_string_lossy(),
            "isDirectory": metadata.is_dir(),
        }));
    }

    result.sort_by(|a, b| {
        let a_dir = a["isDirectory"].as_bool().unwrap_or(false);
        let b_dir = b["isDirectory"].as_bool().unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")),
        }
    });

    Ok(result)
}

#[tauri::command]
async fn delete_directory(path: String) -> Result<(), String> {
    std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let mut dir_str = path.to_string_lossy().to_string();
    if !dir_str.ends_with(std::path::MAIN_SEPARATOR) {
        dir_str.push(std::path::MAIN_SEPARATOR);
    }
    Ok(dir_str)
}

#[tauri::command]
async fn get_default_cwd() -> Result<String, String> {
    // Return user's home directory as default working directory
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory")?;
    Ok(home)
}

#[tauri::command]
async fn get_installer_default_lang() -> Result<String, String> {
    // Detect installer type via Windows registry:
    // - NSIS installer (Chinese .exe) → default "zh"
    // - MSI installer (English .msi) → default "en"
    // - Dev mode (no installer) → default "zh"
    #[cfg(target_os = "windows")]
    {
        // NSIS creates: HKCU\Software\Codem with UninstallString value
        let nsis_check = std::process::Command::new("reg")
            .args(["query", "HKCU\\Software\\Codem"])
            .output();
        
        if let Ok(output) = nsis_check {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.to_lowercase().contains("codem") {
                    return Ok("zh".to_string());
                }
            }
        }

        // MSI creates: HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{...}
        // Check for MSI uninstall entries containing "Codem" or "com.codem.app"
        for hive in &["HKLM", "HKCU"] {
            let path = format!("{}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", hive);
            if let Ok(output) = std::process::Command::new("reg")
                .args(["query", &path, "/s", "/f", "Codem"])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.to_lowercase().contains("codem") {
                    // Found Codem in uninstall registry — check if it's MSI
                    if stdout.contains("MsiExec") || stdout.contains(".msi") {
                        return Ok("en".to_string());
                    }
                }
            }
            // Also check WOW6432Node for 32-bit MSI entries
            let path_wow64 = format!("{}\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", hive);
            if let Ok(output) = std::process::Command::new("reg")
                .args(["query", &path_wow64, "/s", "/f", "Codem"])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.to_lowercase().contains("codem") {
                    if stdout.contains("MsiExec") || stdout.contains(".msi") {
                        return Ok("en".to_string());
                    }
                }
            }
        }

        // Default: Chinese (covers dev mode and NSIS)
        Ok("zh".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok("en".to_string())
    }
}

#[tauri::command]
async fn glob_search(pattern: String, path: String) -> Result<Vec<String>, String> {
    let search_path = std::path::Path::new(&path);
    eprintln!("[glob_search] pattern: {}, path: {}, exists: {}", pattern, path, search_path.exists());
    if !search_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    let mut results = Vec::new();
    glob_search_recursive(search_path, &pattern, &mut results)?;
    eprintln!("[glob_search] found {} files", results.len());
    Ok(results)
}

fn glob_search_recursive(dir: &std::path::Path, pattern: &str, results: &mut Vec<String>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        
        // Skip hidden files and directories
        if name.starts_with('.') {
            continue;
        }
        
        let is_dir = path.is_dir();
        
        // Check if file matches pattern
        if !is_dir {
            let matches = pattern == "*" || name_matches_glob(&name, pattern);
            if matches {
                eprintln!("[glob_search] MATCH: {} against pattern: {}", name, pattern);
                results.push(path.to_string_lossy().to_string());
            }
        }
        
        // Recurse into directories
        if is_dir {
            glob_search_recursive(&path, pattern, results)?;
        }
    }
    
    Ok(())
}

fn name_matches_glob(name: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    // Handle {a,b,c} patterns - check each alternative
    if let Some(start) = pattern.find('{') {
        if let Some(end) = pattern[start..].find('}') {
            let prefix = &pattern[..start];
            let suffix = &pattern[start + end + 1..];
            let alternatives = &pattern[start + 1..start + end];
            eprintln!("[name_matches_glob] expanding braces: prefix={}, suffix={}, alternatives={}", prefix, suffix, alternatives);
            for alt in alternatives.split(',') {
                let expanded = format!("{}{}{}", prefix, alt.trim(), suffix);
                eprintln!("[name_matches_glob] trying expanded: {}", expanded);
                if name_matches_glob(name, &expanded) {
                    return true;
                }
            }
            return false;
        }
    }
    // Handle **/filename patterns - extract the filename part
    let effective_pattern = if let Some(idx) = pattern.rfind("**") {
        let after = &pattern[idx+2..];
        if after.starts_with('/') || after.starts_with('\\') {
            &after[1..]
        } else {
            pattern
        }
    } else if let Some(idx) = pattern.rfind('/') {
        &pattern[idx+1..]
    } else if let Some(idx) = pattern.rfind('\\') {
        &pattern[idx+1..]
    } else {
        pattern
    };
    
    if effective_pattern == "*" {
        return true;
    }
    // Simple glob matching with multiple wildcards
    let result = glob_match(effective_pattern, name);
    eprintln!("[name_matches_glob] matching '{}' against '{}': {}", name, effective_pattern, result);
    result
}

fn glob_match(pattern: &str, name: &str) -> bool {
    let pat_chars: Vec<char> = pattern.chars().collect();
    let name_chars: Vec<char> = name.chars().collect();
    let pat_len = pat_chars.len();
    let name_len = name_chars.len();
    
    // Dynamic programming approach for wildcard matching
    let mut dp = vec![vec![false; name_len + 1]; pat_len + 1];
    dp[0][0] = true;
    
    // Handle leading wildcards
    for i in 0..pat_len {
        if pat_chars[i] == '*' {
            dp[i + 1][0] = dp[i][0];
        }
    }
    
    for i in 0..pat_len {
        for j in 0..name_len {
            if pat_chars[i] == '*' {
                dp[i + 1][j + 1] = dp[i][j + 1] || dp[i + 1][j];
            } else if pat_chars[i] == '?' || pat_chars[i] == name_chars[j] {
                dp[i + 1][j + 1] = dp[i][j];
            }
        }
    }
    
    dp[pat_len][name_len]
}

#[tauri::command]
async fn execute_command(command: String, cwd: Option<String>) -> Result<serde_json::Value, String> {
    let work_dir = cwd.unwrap_or_else(|| std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default());

    // Always use PowerShell for consistent UTF-8 handling
    let mut cmd = std::process::Command::new("powershell");
    // Strip powershell prefix if present
    let ps_body = if command.starts_with("powershell ") {
        command.strip_prefix("powershell ").unwrap_or(&command)
    } else {
        &command
    };
    // Strip -Command prefix if present
    let ps_body = ps_body.strip_prefix("-Command ").unwrap_or(ps_body);
    // Prepend comprehensive UTF-8 encoding setup
    // chcp 65001: Set console code page to UTF-8 (affects native commands like ipconfig, dir, etc.)
    // [Console]::OutputEncoding: .NET stdout encoding for PowerShell
    // [Console]::InputEncoding: .NET stdin encoding (for commands that read from stdin)
    // $OutputEncoding: PowerShell pipeline encoding between cmdlets
    // $PSDefaultParameterValues: Default encoding for Out-File, redirections
    let utf8_prefix = "chcp 65001 | Out-Null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; ";
    let full_command = format!("{}{}", utf8_prefix, ps_body);
    cmd.arg("-Command").arg(&full_command).current_dir(&work_dir);
    // Python encoding: PYTHONIOENCODING for stdin/stdout, PYTHONUTF8 for UTF-8 mode (3.7+)
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONLEGACYWINDOWSSTDIO", "0");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Truncate very long output to prevent context overflow
    let stdout = if stdout.len() > 50000 {
        let truncate_at = stdout.char_indices()
            .filter(|(i, _)| *i <= 50000)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        format!("{}...(truncated, {} bytes total)", &stdout[..truncate_at], stdout.len())
    } else {
        stdout.to_string()
    };
    let stderr = if stderr.len() > 10000 {
        let truncate_at = stderr.char_indices()
            .filter(|(i, _)| *i <= 10000)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        format!("{}...(truncated)", &stderr[..truncate_at])
    } else {
        stderr.to_string()
    };

    Ok(serde_json::json!({
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": output.status.code(),
    }))
}

#[tauri::command]
async fn open_folder_dialog() -> Result<String, String> {
    // Use rfd (Rusty File Dialog) for native folder picker
    let handle = rfd::AsyncFileDialog::new()
        .set_title("选择项目路径")
        .pick_folder()
        .await;

    match handle {
        Some(path) => Ok(path.path().to_string_lossy().to_string()),
        None => Err("No folder selected".to_string()),
    }
}

#[tauri::command]
async fn open_file_external(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_system_info() -> Result<serde_json::Value, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "hostname": hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default(),
        "home": home,
    }))
}

#[tauri::command]
async fn mimo_read_auth() -> Result<serde_json::Value, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory")?;
    let auth_path = std::path::Path::new(&home).join(".local").join("share").join("mimocode").join("auth.json");
    let content = std::fs::read_to_string(&auth_path)
        .map_err(|e| format!("Cannot read {}: {}", auth_path.display(), e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON in auth.json: {}", e))
}

#[tauri::command]
async fn mimo_delete_auth() -> Result<(), String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory")?;
    let auth_path = std::path::Path::new(&home).join(".local").join("share").join("mimocode").join("auth.json");
    if auth_path.exists() {
        std::fs::remove_file(&auth_path).map_err(|e| format!("Failed to delete auth.json: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {}", path, e))
}

#[tauri::command]
async fn mimo_login() -> Result<serde_json::Value, String> {
    eprintln!("[mimo_login] Starting...");

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let auth_path = std::path::Path::new(&home).join(".local").join("share").join("mimocode").join("auth.json");
    eprintln!("[mimo_login] auth_path: {}", auth_path.display());

    // If auth.json already exists with a key, just return it
    if auth_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&auth_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if json["xiaomi"]["key"].as_str().is_some() {
                    eprintln!("[mimo_login] auth.json already exists, returning");
                    return Ok(serde_json::json!({ "success": true, "auth": json }));
                }
            }
        }
    }

    let mimo_path = which_mimo().ok_or("mimo.exe not found. Please install mimocode first.")?;
    eprintln!("[mimo_login] mimo_path: {}", mimo_path);

    // Run mimo providers login
    let mut cmd = std::process::Command::new(&mimo_path);
    cmd.args(["providers", "login", "-p", "xiaomi"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn()
        .map_err(|e| format!("Failed to start mimo login: {}", e))?;
    eprintln!("[mimo_login] spawned mimo, waiting for auth.json...");

    // Wait for auth.json (timeout 5 min)
    let start = std::time::Instant::now();
    loop {
        if start.elapsed().as_secs() > 300 {
            return Err("Login timeout after 5 minutes".to_string());
        }
        if auth_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&auth_path) {
                eprintln!("[mimo_login] auth.json found, content length: {}", content.len());
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(key) = json["xiaomi"]["key"].as_str() {
                        eprintln!("[mimo_login] key found, length: {}", key.len());
                        return Ok(serde_json::json!({ "success": true, "auth": json }));
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

fn which_mimo() -> Option<String> {
    let candidates = vec![
        "D:\\mimo\\mimo.exe".to_string(),
        "mimo.exe".to_string(),
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.clone());
        }
    }
    if let Ok(output) = std::process::Command::new("where").arg("mimo").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let first_line = stdout.lines().next().unwrap_or("").trim();
        if !first_line.is_empty() && std::path::Path::new(first_line).exists() {
            return Some(first_line.to_string());
        }
    }
    None
}

// ========== System Tray & Window Close ==========

#[tauri::command]
async fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_from_tray(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

fn build_tray_menu(app: &AppHandle, lang: &str) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let (show_label, quit_label) = if lang == "en" {
        ("Show Codem", "Quit")
    } else {
        ("显示 Codem", "退出")
    };
    let show_item = MenuItemBuilder::with_id("show", show_label).build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", quit_label).build(app)?;
    MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()
}

#[tauri::command]
async fn update_tray_language(app: AppHandle, lang: String) -> Result<(), String> {
    let menu = build_tray_menu(&app, &lang).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ========== Main Entry ==========

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            providers: Mutex::new(vec![
                ProviderConfig {
                    id: "openai".to_string(),
                    name: "OpenAI".to_string(),
                    api_key: String::new(),
                    base_url: Some("https://api.openai.com/v1".to_string()),
                },
                ProviderConfig {
                    id: "anthropic".to_string(),
                    name: "Anthropic".to_string(),
                    api_key: String::new(),
                    base_url: Some("https://api.anthropic.com/v1".to_string()),
                },
            ]),
            default_model: Mutex::new("gpt-4o".to_string()),
            default_agent: Mutex::new("build".to_string()),
        })
        .invoke_handler(tauri::generate_handler![
            send_message,
            get_providers,
            add_provider,
            remove_provider,
            get_default_model,
            set_default_model,
            get_default_agent,
            set_default_agent,
            read_file,
            write_file,
            append_file,
            list_directory,
            delete_directory,
            execute_command,
            open_folder_dialog,
            open_file_external,
            get_system_info,
            mimo_read_auth,
            mimo_delete_auth,
            mimo_login,
            delete_file,
            glob_search,
            get_app_data_dir,
            get_default_cwd,
            get_installer_default_lang,
            hide_to_tray,
            show_from_tray,
            quit_app,
            update_tray_language,
        ])
        .setup(|app| {
            // Apply window vibrancy (frosted glass effect) on Windows
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let result = window_vibrancy::apply_mica(&window, Some(true));
                    if result.is_err() {
                        let _ = window_vibrancy::apply_acrylic(&window, Some((18, 18, 18, 120)));
                    }
                }
            }

            // Build system tray
            let app_handle = app.handle().clone();
            let menu = build_tray_menu(&app_handle, "zh").expect("Failed to build tray menu");
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("no default window icon").clone())
                .tooltip("Codem")
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: WinEvent::CloseRequested { api, .. },
                ..
            } => {
                // Always prevent the default close
                api.prevent_close();
                // Notify frontend to handle close behavior
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.emit("close-requested", ());
                }
            }
            _ => {}
        }
    });
}
