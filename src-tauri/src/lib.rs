use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

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
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
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
async fn execute_command(command: String, cwd: Option<String>) -> Result<serde_json::Value, String> {
    let work_dir = cwd.unwrap_or_else(|| std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default());

    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", &command]).current_dir(&work_dir);

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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        // App closed
    });
}
