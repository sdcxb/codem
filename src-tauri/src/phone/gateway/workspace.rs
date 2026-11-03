// ============================================================
// phone/gateway/workspace.rs — 桌面远程网关的只读工作区命令
//
// ## 为什么需要单独的命令（不能复用 read_file / list_directory）
//
// 桌面那两个命令**没有工作区边界**：
//   - `list_directory` 返回每个条目的**绝对路径**，还跟随符号链接/接合点；
//   - `read_file` 只按路径直读，没有二进制/截断/相对路径语义。
// 而桌面沙箱默认关闭（用户为本机方便会关掉），网关若复用它们，等于把
// "关掉本机沙箱"升级成"手机可读整块磁盘"。所以边界在 Rust 里**无条件**判：
//
//   1. 词法拒绝：绝对路径、盘符/UNC、`..`、NUL/换行、冒号（Windows ADS）；
//   2. `resolve_sandbox_path` 解析符号链接/接合点，逐组件比较是否在根内；
//   3. 列表**跳过**符号链接/重解析点目录（点进去可能是根外目标，也可能成环）；
//      重解析点文件不跳过（云盘占位文件带该属性，读取时仍会解析真实路径）；
//   4. `read` 再算一次真实相对路径并与 `expect_rel` 比对（堵住 stat 之后
//      把普通文件换成 `.env` 的 TOCTOU）。
//
// 错误只回稳定前缀，**不带绝对路径**（渲染层据此转成协议错误码）：
//   E_WORKSPACE_ROOT / E_WORKSPACE_PATH / E_WORKSPACE_TARGET / E_WORKSPACE_IO
//
// ## 只读
//
// 三个命令全是读：list / stat / read。没有写、没有删除、没有执行。
// ============================================================

use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 与渲染层/协议同一条路径长度上限。
const MAX_PATH_CHARS: usize = 1024;
/// 一层目录最多返回的条目数（与 Host 同量级；静默截断是已知限制）。
const MAX_LIST_ENTRIES: usize = 500;
/// 单次读取的字节上限（超出时只读前 N 字节并标 truncated）。
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayEntry {
    pub name: String,
    /// 协议字段名是 `type`（`file` / `dir`）；Rust 侧用 `entry_type` 避开关键字。
    #[serde(rename = "type")]
    pub entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStat {
    /// 真实路径（解析链接之后）相对工作区的 posix 路径；根 = `""`。
    pub rel: String,
    pub size: u64,
    /// `file` / `dir` / `other`
    pub kind: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRead {
    /// 规范化后的工作区相对路径（posix）。
    pub path: String,
    pub rel: String,
    /// **完整文件大小**（不是本次返回的字符数）。
    pub size: u64,
    pub truncated: bool,
    pub text: String,
    /// `utf8` / `binary`（二进制不把字节塞进 JSON）
    pub encoding: String,
}

fn err_root() -> String {
    "E_WORKSPACE_ROOT: 桌面工作区不可用".to_string()
}

fn err_path() -> String {
    "E_WORKSPACE_PATH: 路径不在工作区内".to_string()
}

fn err_target() -> String {
    "E_WORKSPACE_TARGET: 目标不存在或类型不符".to_string()
}

fn err_io(e: &std::io::Error) -> String {
    // io::Error 的 Display 只有错误消息，不含路径；仍然只回稳定前缀。
    format!("E_WORKSPACE_IO: {e}")
}

/// 词法校验工作区相对路径。
///
/// 这一步**不能**替代 `resolve_sandbox_path`（链接逃逸只能靠真实解析），
/// 但它把"一眼越界"的输入挡在磁盘操作之前。
fn validate_rel(path: &str, allow_root: bool) -> Result<(), String> {
    if path.len() > MAX_PATH_CHARS {
        return Err(err_path());
    }
    if path.contains('\u{0000}') || path.contains('\n') || path.contains('\r') {
        return Err(err_path());
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return Err(err_path());
    }
    let mut has_normal = false;
    for component in p.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(err_path())
            }
            Component::CurDir => {}
            Component::Normal(part) => {
                has_normal = true;
                // Windows 备用数据流（`file.txt:secret`）可以绕过普通文件语义；
                // 非 Windows 上冒号是合法文件名字符，但统一拒绝，避免跨平台行为分叉。
                if part.to_string_lossy().contains(':') {
                    return Err(err_path());
                }
            }
        }
    }
    if !has_normal && !allow_root {
        return Err(err_path());
    }
    Ok(())
}

/// 解析工作区根：必须是**已存在的绝对目录**。
fn resolve_root(workspace: &str) -> Result<PathBuf, String> {
    let raw = Path::new(workspace);
    if !raw.is_absolute() {
        return Err(err_root());
    }
    let root = crate::resolve_sandbox_path(raw).map_err(|_| err_root())?;
    let meta = std::fs::metadata(&root).map_err(|_| err_root())?;
    if !meta.is_dir() {
        return Err(err_root());
    }
    Ok(root)
}

/// 解析目标：先词法校验，再真实解析，最后逐组件比较是否在根内。
fn resolve_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    validate_rel(path, true)?;
    let trimmed = path.trim();
    let joined = if trimmed.is_empty() || trimmed == "." {
        root.to_path_buf()
    } else {
        root.join(path)
    };
    let target = crate::resolve_sandbox_path(&joined).map_err(|_| err_path())?;
    if !crate::path_within_workspace(&target, root) {
        return Err(err_path());
    }
    Ok(target)
}

/// 真实路径 → 工作区相对 posix 路径（解析链接之后的规范形式）。
fn relative_posix(root: &Path, target: &Path) -> Result<String, String> {
    let rel = target.strip_prefix(root).map_err(|_| err_path())?;
    let mut parts: Vec<String> = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return Err(err_path()),
        }
    }
    Ok(parts.join("/"))
}

fn kind_of(meta: &std::fs::Metadata) -> &'static str {
    if meta.is_file() {
        "file"
    } else if meta.is_dir() {
        "dir"
    } else {
        "other"
    }
}

/// 重解析点（符号链接 / 接合点）。列表一律跳过：点进去的目标不在根内时，
/// 只会得到一条"路径越界"，不如根本不展示。
#[cfg(target_os = "windows")]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_REPARSE_POINT
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(target_os = "windows"))]
fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    false
}

fn list_impl(workspace: &str, path: &str) -> Result<Vec<GatewayEntry>, String> {
    let root = resolve_root(workspace)?;
    let target = resolve_target(&root, path)?;
    let meta = std::fs::metadata(&target).map_err(|_| err_target())?;
    if !meta.is_dir() {
        return Err(err_target());
    }
    let dir = std::fs::read_dir(&target).map_err(|e| err_io(&e))?;
    let mut entries: Vec<GatewayEntry> = Vec::new();
    for entry in dir {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        let Ok(link_meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if link_meta.file_type().is_symlink() {
            continue;
        }
        /*
         * 重解析点**目录**（接合点 / 云盘占位目录）跳过：点进去可能是根外目标，
         * 也可能自指成环（既有 `glob` 判据踩过）。重解析点**文件**不跳过 ——
         * OneDrive 等云盘占位文件带这个属性，跳过会把正常项目文件藏起来；
         * 真要读它时，`read`/`stat` 仍会解析真实路径并做根内判定。
         */
        if is_reparse_point(&link_meta) && link_meta.is_dir() {
            continue;
        }
        if link_meta.is_dir() {
            entries.push(GatewayEntry {
                name,
                entry_type: "dir".to_string(),
                size: None,
            });
        } else if link_meta.is_file() {
            entries.push(GatewayEntry {
                name,
                entry_type: "file".to_string(),
                size: Some(link_meta.len()),
            });
        }
    }
    // 先排完再截断：Host 旧实现是"先截断后排序"，大目录会随机丢条目。
    entries.sort_by(|a, b| {
        let rank = |t: &str| if t == "dir" { 0 } else { 1 };
        rank(&a.entry_type)
            .cmp(&rank(&b.entry_type))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    entries.truncate(MAX_LIST_ENTRIES);
    Ok(entries)
}

fn stat_impl(workspace: &str, path: &str) -> Result<GatewayStat, String> {
    let root = resolve_root(workspace)?;
    let target = resolve_target(&root, path)?;
    let meta = std::fs::metadata(&target).map_err(|_| err_target())?;
    Ok(GatewayStat {
        rel: relative_posix(&root, &target)?,
        size: meta.len(),
        kind: kind_of(&meta).to_string(),
    })
}

fn same_rel(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_matches('/').to_string();
    let (a, b) = (norm(a), norm(b));
    if cfg!(target_os = "windows") {
        a.eq_ignore_ascii_case(&b)
    } else {
        a == b
    }
}

fn read_impl(
    workspace: &str,
    path: &str,
    expect_rel: &str,
    offset: u32,
    limit: u32,
) -> Result<GatewayRead, String> {
    let root = resolve_root(workspace)?;
    let target = resolve_target(&root, path)?;
    let meta = std::fs::metadata(&target).map_err(|_| err_target())?;
    if !meta.is_file() {
        return Err(err_target());
    }
    let rel = relative_posix(&root, &target)?;
    // TOCTOU：stat 判完敏感之后，这里必须仍是同一个文件（Windows 大小写不敏感）。
    if !same_rel(&rel, expect_rel) {
        return Err(err_target());
    }

    let size = meta.len();
    /*
     * 只读"这次窗口够用"的字节数：协议是字符 offset/limit，UTF-8 一个字符最多
     * 4 字节；多读 4 字节兜住截断边界。上限仍是 MAX_READ_BYTES，避免大文件把
     * 8 MB 全灌进 WebView。
     */
    let window_bytes = ((offset as u64).saturating_add(limit.max(1) as u64))
        .saturating_mul(4)
        .saturating_add(4)
        .min(MAX_READ_BYTES)
        .max(1);
    let mut file = std::fs::File::open(&target).map_err(|e| err_io(&e))?;
    let mut bytes: Vec<u8> = Vec::new();
    file.by_ref()
        .take(window_bytes)
        .read_to_end(&mut bytes)
        .map_err(|e| err_io(&e))?;
    let byte_limited = size > window_bytes;

    if bytes.contains(&0) {
        return Ok(GatewayRead {
            path: rel.clone(),
            rel,
            size,
            truncated: false,
            text: String::new(),
            encoding: "binary".to_string(),
        });
    }
    let mut text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => {
            // 截断可能切在 UTF-8 编码中间：最多退 3 个字节再试一次；
            // 仍失败就是真的非 UTF-8（按 binary 处理，不塞替换字符）。
            let mut bytes = e.into_bytes();
            let mut decoded = None;
            for _ in 0..3 {
                if bytes.pop().is_none() {
                    break;
                }
                if let Ok(text) = String::from_utf8(bytes.clone()) {
                    decoded = Some(text);
                    break;
                }
            }
            match decoded {
                Some(text) => text,
                None => {
                    return Ok(GatewayRead {
                        path: rel.clone(),
                        rel,
                        size,
                        truncated: false,
                        text: String::new(),
                        encoding: "binary".to_string(),
                    })
                }
            }
        }
    };
    // offset=0 剥 BOM（与桌面 read_file 一致）；文件中间不会出现 BOM。
    if let Some(stripped) = text.strip_prefix('\u{feff}') {
        text = stripped.to_string();
    }
    let total_chars = text.chars().count();
    let offset_usize = offset as usize;
    let limit_usize = limit.max(1) as usize;
    let sliced: String = text.chars().skip(offset_usize).take(limit_usize).collect();
    let returned = sliced.chars().count();
    let truncated = byte_limited || offset_usize.saturating_add(returned) < total_chars;
    Ok(GatewayRead {
        path: rel.clone(),
        rel,
        size,
        truncated,
        text: sliced,
        encoding: "utf8".to_string(),
    })
}

#[tauri::command]
pub async fn gateway_workspace_list(
    workspace: String,
    path: String,
) -> Result<Vec<GatewayEntry>, String> {
    tokio::task::spawn_blocking(move || list_impl(&workspace, &path))
        .await
        .map_err(|e| format!("E_WORKSPACE_IO: {e}"))?
}

#[tauri::command]
pub async fn gateway_workspace_stat(
    workspace: String,
    path: String,
) -> Result<GatewayStat, String> {
    tokio::task::spawn_blocking(move || stat_impl(&workspace, &path))
        .await
        .map_err(|e| format!("E_WORKSPACE_IO: {e}"))?
}

#[tauri::command]
pub async fn gateway_workspace_read(
    workspace: String,
    path: String,
    expect_rel: String,
    offset: u32,
    limit: u32,
) -> Result<GatewayRead, String> {
    tokio::task::spawn_blocking(move || read_impl(&workspace, &path, &expect_rel, offset, limit))
        .await
        .map_err(|e| format!("E_WORKSPACE_IO: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_root(name: &str) -> TempRoot {
        let dir = std::env::temp_dir().join(format!("codem-gw-ws-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建测试目录");
        TempRoot(dir)
    }

    fn arg(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn assert_prefix(err: String, prefix: &str) {
        assert!(
            err.starts_with(prefix),
            "错误前缀必须是 {}（实际 {}）",
            prefix,
            err
        );
        assert!(
            !err.contains("codem-gw-ws-"),
            "错误文案不能泄露绝对路径：{}",
            err
        );
    }

    /// 造一个目录链接/接合点。失败返回 false（环境不支持 ⇒ 判据跳过链接断言）。
    fn try_make_dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            let cmdline = format!(
                "/c mklink /J \"{}\" \"{}\"",
                link.display(),
                target.display()
            );
            let ok = std::process::Command::new("cmd")
                .raw_arg(&cmdline)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            return ok && std::fs::symlink_metadata(link).is_ok();
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn rejects_lexical_escapes_before_touching_disk() {
        let root = temp_root("escape");
        for bad in ["../secret.txt", "a/../../secret.txt", "/etc/passwd"] {
            let err = list_impl(&arg(&root.0), bad).expect_err("越界路径必须被拒");
            assert_prefix(err, "E_WORKSPACE_PATH:");
        }
        #[cfg(target_os = "windows")]
        {
            for bad in [
                "C:\\Windows\\win.ini",
                "\\\\server\\share",
                "file.txt:secret",
            ] {
                let err = list_impl(&arg(&root.0), bad).expect_err("Windows 特殊路径必须被拒");
                assert_prefix(err, "E_WORKSPACE_PATH:");
            }
        }
        // 根是允许的（列表根目录）；read 不允许目录/根。
        assert!(list_impl(&arg(&root.0), "").is_ok());
        let err = read_impl(&arg(&root.0), "", "", 0, 1).expect_err("不能读目录/根");
        assert_prefix(err, "E_WORKSPACE_TARGET:");
    }

    #[test]
    fn list_sorts_dirs_first_and_skips_links() {
        let root = temp_root("list");
        std::fs::create_dir_all(root.0.join("src")).unwrap();
        std::fs::write(root.0.join("b.txt"), "b").unwrap();
        std::fs::write(root.0.join("A.txt"), "a").unwrap();
        let linked = try_make_dir_link(&root.0.join("src"), &root.0.join("z-link"));
        let entries = list_impl(&arg(&root.0), "").expect("列根目录");
        assert_eq!(entries[0].entry_type, "dir", "目录必须在前");
        assert_eq!(entries[0].name, "src");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"A.txt"));
        assert!(names.contains(&"b.txt"));
        assert!(
            !names.iter().any(|n| n.to_lowercase().contains("link")),
            "符号链接/接合点不得出现在列表里（实际 {:?}）",
            names
        );
        if !linked {
            eprintln!("环境不允许创建目录链接，跳过链接存在性断言");
        }
        // 文件大小必须来自真实元数据
        let a = entries.iter().find(|e| e.name == "A.txt").unwrap();
        assert_eq!(a.size, Some(1));
    }

    #[test]
    fn links_that_escape_the_root_are_invisible_and_unreadable() {
        let root = temp_root("escape-link");
        let outside = temp_root("outside-target");
        std::fs::write(outside.0.join("secret.txt"), "SECRET").unwrap();
        let linked = try_make_dir_link(&outside.0, &root.0.join("jump"));
        if !linked {
            eprintln!("环境不允许创建目录链接/接合点，跳过越界链接判据");
            return;
        }
        let entries = list_impl(&arg(&root.0), "").expect("列根目录");
        assert!(
            !entries.iter().any(|e| e.name == "jump"),
            "越界链接不得出现在列表里"
        );
        let err = stat_impl(&arg(&root.0), "jump").expect_err("越界链接必须拒绝");
        assert_prefix(err, "E_WORKSPACE_PATH:");
        let err = read_impl(&arg(&root.0), "jump/secret.txt", "jump/secret.txt", 0, 100)
            .expect_err("越界链接里的文件必须拒绝");
        assert_prefix(err, "E_WORKSPACE_PATH:");
    }

    #[test]
    fn relative_path_comparison_follows_platform_case_rules() {
        assert!(same_rel("src\\a.ts", "src/a.ts"), "分隔符必须归一");
        if cfg!(target_os = "windows") {
            assert!(same_rel("src/A.ts", "src/a.ts"), "Windows 路径大小写不敏感");
        } else {
            assert!(
                !same_rel("src/A.ts", "src/a.ts"),
                "非 Windows 保持大小写敏感"
            );
        }
    }

    #[test]
    fn read_is_char_based_and_strips_bom() {
        let root = temp_root("read");
        std::fs::write(root.0.join("a.txt"), "\u{feff}你好abc").unwrap();
        let got = read_impl(&arg(&root.0), "a.txt", "a.txt", 1, 2).expect("读取文本");
        assert_eq!(got.encoding, "utf8");
        assert_eq!(got.text, "好a");
        assert!(got.truncated, "没有读到文件末尾必须标 truncated");
        assert_eq!(
            got.size,
            std::fs::metadata(root.0.join("a.txt")).unwrap().len()
        );
        let all = read_impl(&arg(&root.0), "a.txt", "a.txt", 0, 200_000).expect("整读");
        assert_eq!(all.text, "你好abc");
        assert!(!all.truncated);
    }

    #[test]
    fn read_binary_reports_encoding_without_bytes() {
        let root = temp_root("binary");
        std::fs::write(root.0.join("blob.bin"), [0u8, 1, 2, 0xff]).unwrap();
        let got = read_impl(&arg(&root.0), "blob.bin", "blob.bin", 0, 10).expect("读取二进制");
        assert_eq!(got.encoding, "binary");
        assert_eq!(got.text, "");
        assert!(!got.truncated);
        assert_eq!(got.size, 4);
    }

    #[test]
    fn read_rejects_changed_target_between_stat_and_read() {
        let root = temp_root("toctou");
        std::fs::write(root.0.join("a.txt"), "a").unwrap();
        let err =
            read_impl(&arg(&root.0), "a.txt", "b.txt", 0, 10).expect_err("expect_rel 不符必须拒绝");
        assert_prefix(err, "E_WORKSPACE_TARGET:");
    }

    /// 造一个**文件**符号链接。失败返回 false（Windows 非管理员/未开开发者模式会失败）。
    fn try_make_file_link(target: &Path, link: &Path) -> bool {
        #[cfg(target_os = "windows")]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn stat_reports_the_resolved_target_for_sensitive_judgement() {
        let root = temp_root("stat-link");
        std::fs::write(root.0.join(".env"), "SECRET=1").unwrap();
        let linked = try_make_file_link(&root.0.join(".env"), &root.0.join("notes.txt"));
        if !linked {
            eprintln!("环境不允许创建文件符号链接，跳过 stat 别名判据");
            return;
        }
        let got = stat_impl(&arg(&root.0), "notes.txt").expect("stat 别名");
        assert_eq!(got.rel, ".env", "敏感判定必须按真实目标，而不是别名");
        assert_eq!(got.kind, "file");
        // 用别名去读时，read 会解析到 .env 并发现 expect_rel 不符 ⇒ 拒绝（TOCTOU 收口）。
        let err = read_impl(&arg(&root.0), "notes.txt", "notes.txt", 0, 10)
            .expect_err("别名指向敏感目标时必须拒绝");
        assert_prefix(err, "E_WORKSPACE_TARGET:");
    }

    #[test]
    fn missing_root_is_not_a_silent_empty_list() {
        let root = temp_root("missing");
        let missing = root.0.join("gone");
        let err = list_impl(&arg(&missing), "").expect_err("根不存在必须报错");
        assert_prefix(err, "E_WORKSPACE_ROOT:");
        let err = stat_impl(&arg(&missing), "").expect_err("根不存在必须报错");
        assert_prefix(err, "E_WORKSPACE_ROOT:");
    }

    #[test]
    fn target_kind_is_checked() {
        let root = temp_root("kind");
        std::fs::create_dir_all(root.0.join("dir")).unwrap();
        std::fs::write(root.0.join("file.txt"), "x").unwrap();
        let err = list_impl(&arg(&root.0), "file.txt").expect_err("文件不是目录");
        assert_prefix(err, "E_WORKSPACE_TARGET:");
        let err = read_impl(&arg(&root.0), "dir", "dir", 0, 10).expect_err("目录不能当文件读");
        assert_prefix(err, "E_WORKSPACE_TARGET:");
    }
}
