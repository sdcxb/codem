# 07 · Rust 后端与 IPC 命令面

> 基线：1.16.330 ｜ 2026-10-26
> 代码：`src-tauri/src` 26 个 `.rs` / 约 2.2 万行；`src-tauri/codem-db/src` 11 个 / 约 1 万行。
> 口径：`#[tauri::command]` 注解 **118**（`get_process_token_info` 在 Windows / 非 Windows 各一份）；不同命令名 **117**；`generate_handler!` 注册 **117**，与注解双向无差集。

---

## 1. 文件地图

| 文件 | 行/KB | 职责 |
|---|---:|---|
| `src-tauri/src/lib.rs` | 7784 / 348 KB | 主入口：66 个命令 + `run()` + 窗口/托盘/宠物 + 文件/命令/PTY/MCP/HTTP/沙箱 + 约 4000 行单测 |
| `src-tauri/src/storage.rs` | 965 / 48 KB | 7 个存储命令薄封装；数据根/隔离根解析 |
| `src-tauri/src/secret.rs` | 290 / 10 KB | DPAPI 裸 FFI 凭据封存（`dsh1:`）；3 命令 |
| `src-tauri/src/runtime_log.rs` | 505 / 18 KB | 按日日志：4 MB×3、目录 24 MB、14 天、脱敏、单行 8 KB |
| `src-tauri/src/crash_evidence.rs` | 604 / 26 KB | 渲染崩溃取证（ProcessFailed/心跳/标记）；3 命令 |
| `src-tauri/src/ofm.rs` | 543 / 25 KB | 免费模型插件 Node 进程生命周期；9 命令 |
| `src-tauri/src/js_sandbox.rs` | 870 / 35 KB | boa_engine 单发沙箱；2 命令 |
| `src-tauri/src/js_sandbox_session.rs` | 1052 / 44 KB | 会话级 JS 沙箱；4 命令 |
| `src-tauri/src/ilink/` | 5 文件 | 微信 iLink 传输层门面；5 命令 |
| `src-tauri/src/phone/` | 13 文件 | Phone Link：TLS 边缘 + 回环上游 + 配对 + AA；19 命令 |
| `src-tauri/src/main.rs` | 5 行 | 只调 `codem_lib::run()` |
| `codem-db/src/migrate.rs` | 3500 / 169 KB | 旧库迁移 + 对账 |
| `codem-db/src/repo.rs` | 2353 / 120 KB | 类型化仓储 |
| `codem-db/src/engine.rs` | 1010 / 47 KB | 连接/WAL/事务/健康 |
| `codem-db/src/crud.rs` | 877 / 38 KB | 通用表/列白名单 CRUD |
| `codem-db/src/{lib,config,audit,schema,error,fts,authorizer}.rs` | — | 命令白名单/配置/删除审计/schema/错误码/FTS/SQL 白名单 |
| `codem-db/sql/{schema.sql,tables.json,migrations.json,fts.json}` | 595 行 / 39 表 | 真源 |

> 旧文档 `docs/HANDOVER-2026-10-17.md:41` 说“`#[tauri::command]` 全在 lib.rs”已不成立：118 个注解里只有 66 个在 lib.rs。

---

## 2. 命令面（117 注册）

| 域 | 数 | 命令 |
|---|---:|---|
| 文件系统 | 22 | `read_file` `read_file_lines` `read_text_window` `read_file_base64` `write_file` `append_file` `list_directory` `list_directory_sandboxed` `delete_file` `rename_file` `make_directory` `path_exists` `file_version` `get_system_temp_dir` `get_app_data_dir` `get_default_cwd` `glob_search` `delete_directory` `delete_directory_permanent` `open_folder_dialog` `open_file_external` `reveal_item_in_dir` |
| 沙箱判定 | 2 | `check_path_in_workspace` `get_process_token_info` |
| 命令执行 / PTY | 6 | `execute_command` `kill_session_processes` `spawn_pty` `write_pty` `resize_pty` `close_pty` |
| 存储 | 7 | `storage_invoke` `storage_batch` `storage_health` `storage_integrity_check` `storage_checkpoint` `storage_capabilities` `storage_info` |
| MCP / HTTP / 解压 | 8 | `mcp_stdio_connect` `mcp_stdio_request` `mcp_stdio_disconnect` `http_get` `http_post` `http_download` `http_download_ext` `extract_zip` |
| 窗口 / 托盘 / 宠物 / 材质 | 13 | `create_pet_window` `show_pet_menu` `close_pet_window` `resize_pet_window` `set_pet_window_geometry` `resize_pet_window_anchored` `hide_to_tray` `show_from_tray` `quit_app` `update_tray_language` `create_browser_window` `close_browser_window` `native_material` |
| 认证 / 密钥 | 6 | `secret_backend_available` `secret_seal` `secret_unseal` `mimo_read_auth` `mimo_delete_auth` `mimo_login` |
| 配置 / provider / 消息桩 | 8 | `get_providers` `add_provider` `remove_provider` `get_default_model` `set_default_model` `get_default_agent` `set_default_agent` `send_message` |
| JS 沙箱 | 6 | `js_run_sandboxed` `jsvm_host_reply` `js_sandbox_open` `js_sandbox_eval` `js_sandbox_call_function` `js_sandbox_close` |
| 微信 iLink | 5 | `ilink_status` `ilink_start_login` `ilink_login_submit_verify` `ilink_logout` `ilink_send_text` |
| Phone Link | 19 | `phone_start` `phone_stop` `phone_status` `phone_decide` `phone_unpair` `phone_respond` `phone_ca_pem` `phone_ca_fingerprint` `aa_account_login` `aa_account_send_code` `aa_account_logout` `aa_account_status` `aa_connect` `aa_connector_start` `aa_connector_stop` `aa_connector_status` `phone_relay_start` `phone_relay_stop` `phone_relay_status` |
| OFM | 9 | `ofm_extension_dir` `ofm_bundled_dir` `ofm_bundled_node` `ofm_stage_node` `ofm_start` `ofm_stop` `ofm_state` `ofm_kill_lock_holder` `ofm_log_tail` |
| 日志 / 崩溃 | 3 | `log_renderer_event` `log_renderer_heartbeat` `take_renderer_crash_marker` |
| 系统 / 安装 / 其它 | 3 | `get_system_info` `get_installer_default_lang` `codegraph_install` |
| **合计** | **117** | |

**分发**：lib.rs 66、phone/mod.rs 16、ofm 9、storage 7、ilink 5、js_sandbox_session 4、crash_evidence 3、phone/connector 3、secret 3、js_sandbox 2。

> **内存桩**：`send_message` 只 `emit` 后返回 `Ok(())`；`get_providers/add_provider/...` 的初始 `api_key` 是空串、默认模型硬编码 `gpt-4o`。不要据这些命令推断后端有 LLM 客户端。

---

## 3. `execute_command`：进程模型

**入参**：`command`、`cwd`、`timeout_ms`、`shell`、`bash_path`、`session_id`。

### 3.1 执行器选择（不静默回退）

- `bash`：走 `-c`；只认显式路径 / 环境变量 `CODEM_SHELL_OPS_BASH` / `CODEM_BASH_PATH` / Git 三个标准位置；找不到返回 `E_SHELL_OPS_NO_BASH`，**不退回 PowerShell**。
- 否则 PowerShell：`-NoProfile -NonInteractive` + `chcp 65001` + 4 条 .NET 编码设置 + `PYTHON*` 三件套。
- `CREATE_NO_WINDOW 0x08000000`（避免黑框）。

### 3.2 超时 / 杀树 / 输出

- 默认超时 600s，夹在 1s–1h；50ms 轮询；
- 超时/取消：`taskkill /T /F` 杀进程树（退出码 128 视为已死）；
- **全仓无 Job Object**：没有 `AssignProcessToJobObject` / `KILL_ON_JOB_CLOSE`；退出路径故意 no-wait，可能有孤儿；
- 输出上限 50,000 / 10,000 字符；**读取阶段**即丢弃超额（不读会堵管道），截断如实标注；
- stdout/stderr 各一读线程，防互等死锁；超时路径 `abandon + 有界 join 2s + WARN`；
- 会话→pid 表 `exec_processes`；`kill_session_processes` 杀树；
- 返回 `{ stdout, stderr, exitCode }`；日志 mask + 截断。

> ⚠️ `execute_command` 函数体内**没有 sandbox/workspace 判定**；`cwd` 任意。写文件有沙箱判定，跑命令没有——这是明确的安全边界差异。

---

## 4. PTY 终端

- `portable-pty 0.8`；`PtyMap = Arc<Mutex<HashMap<String, PtySession>>>`；
- `spawn_pty`：id `pty-<uuid>`；Windows 恒 `cmd.exe`；初始 24×80；
- 读线程 emit `pty-output` / `pty-exit`；
- `write_pty` 直接 `write_all`；`resize_pty` 走 `MasterPty::resize`；
- `close_pty` 先杀树再 `child.kill`；
- 隔离仅按 id；Rust 侧无 TTL / 无每会话上限，回收靠前端；
- `quit_app` 排空全部并 no-wait 杀树。

---

## 5. 存储引擎（Rust 视角）

```text
storage_invoke(command, params)
  → storage.rs 参数解码（不接受 SQL）
  → codem-db COMMANDS 白名单（78 条）
  → dispatch（未登记 = UNSUPPORTED）
  → repo/crud（表/列双白名单）
  → Engine::write_tx / read
```

- 单写者 `Mutex<Connection>`；WAL / NORMAL / busy_timeout 5000 / foreign_keys ON / temp_store MEMORY；
- 分页 5000 行 / 16 MiB；limit 夹住；字节预算截断 + `has_more`；
- authorizer 禁 `ATTACH/DETACH`、`load_extension`、`writable_schema` 读写、12 个危险 PRAGMA 写；
- 错误码 10 个，4 个可重试；authorizer 拒绝 → `UNSUPPORTED`；
- 删除审计触发器（9 张表）；`storage_audit` 每次打开重装。

> 数据模型/表/迁移/维护的完整说明见 `06-DATA-STORAGE.md`。

---

## 6. 安全边界

### 6.1 凭据（`secret.rs`）

- 裸 FFI `CryptProtectData/UnprotectData`；`dwFlags=0` 绑当前用户；
- 格式 `dsh1:<hex>`；失败必 `UNAVAILABLE`，不降级；
- 空串拒绝封存；非 Windows 明确不可用；
- 换机/换账户解不开，但密文保留、不丢数据；调用方若误判“未配置”会丢 Key。

### 6.2 路径沙箱

- 三处共用：`resolve_sandbox_path`（存在 canonicalize；不存在解析最近已存在祖先）+ `path_within_workspace`（逐组件 + Windows 大小写折叠；剥 `\\?\`）；
- `write_file` 缺省按开；`allowed_roots`；三处调用点；
- 原子写：tmp + fsync + rename；
- 删除守卫：空路径/盘根拒绝；
- zip-slip：`enclosed_name`。

### 6.3 CSP / capabilities

- `tauri.conf.json` CSP：无 `unsafe-eval`，含 `wasm-unsafe-eval` / `unsafe-inline`；
- `withGlobalTauri: true`；主窗 `transparent`、`decorations:false`、`devtools:false`；
- `capabilities/default.json`：windows `["main","pet"]`，41 条权限，含 `shell:allow-execute`、`fs:read-all/write-all`；
- **Tauri v2 自定义命令不受 ACL 约束**：pet 窗与主窗共用 capability ⇒ 理论上 pet 页面可调全部命令（推断，未运行验证）。

### 6.4 参数校验

- `execute_command` timeout clamp；
- `glob` limit 1..200000 / 深度 32 / 结果 20000；
- `read_file` 文本分支 50 MB + `E_FILE_TOO_LARGE`；**base64 分支绕过该上限**（全量读再编码）；
- `storage` limit 夹住。

---

## 7. 免费模型插件（OFM）

```text
%APPDATA%\com.codem.app\extensions\our-free-model\
  ├─ settings.json（standalonePort / forwardKey）
  ├─ catalog.json（kiloRows[].vision 模态权威值）
  ├─ stats.json
  ├─ runtime\node.exe（数据目录副本）
  ├─ service.lock
  └─ plugin.log
```

- Rust 侧只负责起停 Node 进程：`ofm_stage_node`（复制 Node 到数据目录）、`ofm_start`（`node cli.mjs --port --data-dir`）、`ofm_stop`、`ofm_state`、`ofm_kill_lock_holder`、`ofm_log_tail`；
- `kill_on_drop(false)`；日志落 `plugin.log`；
- 锁只在 pid 真死时删；`ofm_kill_lock_holder` 有三条安全边界（只结束能证明是本插件的 pid）；
- 端口由调用方给（当前 18937）；宿主退出时收进程；**无看门狗**；
- 坑：路径 `\\?\` 前缀会让 Node EISDIR；所以先转普通路径。

---

## 8. Phone Link / iLink

### 8.1 Phone Link（`phone/`）

- 拓扑：TLS 边缘 `0.0.0.0:0` + 上游 `127.0.0.1:0`；
- 准入：Host 白名单无通配；双跨站判据；每次运行随机 `x-codem-edge`；恒定时间比对；
- 配对：5 分钟窗口、最多 8 设备、cookie 30 天、请求 4 MiB；只存 `sha256(secret)`；
- 引擎缺席返回 502；
- CA 指纹/PEM 各一命令；
- 中继 connector：纯出站、不开 LAN 端口；tokio；心跳 20s / 重连 3s；字段对齐 AA；
- 换环境即失效：自签 CA 无公共兜底，唯一防线是核对指纹。

### 8.2 iLink（`ilink/`）

- 只做传输层：登录/轮询/收发/登出；
- 6 状态；480s 登录上限；入站 200；
- 配额等为社区实测口径；
- 微信桥（renderer 侧 `wechat-bridge.ts`）负责 peer→会话→agent 回合→回复。

---

## 9. JS 沙箱

- `boa_engine 0.22`，动机：CSP 无 `unsafe-eval` + asyncify 只能挂起一次；
- 预算：1e6 循环 / 200 宿主调用；
- 会话级：一线程一 VM；
- 闸门只在 TS 侧（Rust 侧不判）；
- 用于 `run_code` / `workflow`。

---

## 10. 窗口 / 托盘 / 宠物 / 日志 / 更新

- **窗口**：主窗 1200×800，min 800×600；宠物窗透明/无边框/置顶/不入任务栏/无阴影；resizable 用 `setSize`；
- **材质**：Win11 Mica → 失败 Acrylic(18,18,18,100) → 不透明；`native_material` 命令返回类型；macOS vibrancy；
- **托盘**：失败不阻塞；退出 2.5s flush 兜底；主窗 `prevent_close` 交前端，宠物窗直关；
- **日志**：按日、4 MB/段、目录 24 MB、14 天、脱敏、单行 8 KB；`active-run.json` 正常退出删除；
- **崩溃**：`ProcessFailed` → 崩溃标记；`log_renderer_event` / `log_renderer_heartbeat` / `take_renderer_crash_marker`；
- **更新**：GitHub `latest.json` + minisign 公钥；`createUpdaterArtifacts`；NSIS 简中/英。

---

## 11. 风险（按影响排序）

1. **`execute_command` 无沙箱/工作区校验**：安全模式下“写文件被拦、跑命令不受限”。
2. **无 Job Object**：只 `taskkill /T /F`；退出路径 no-wait ⇒ 可能有孤儿。
3. **8 个内存桩命令**：`send_message`、provider 增删/默认模型/默认 agent；不要当真实后端能力。
4. **`read_file` base64 绕过 50 MB 上限**。
5. **任意路径面**：`open_file_external` 直接 `open::that`；`http_download/_ext` 写任意 `dest_path`；`extract_zip` 目标目录任意；均不在沙箱判定内。
6. **宠物窗与主窗共用 capability**：自定义命令不受 ACL 约束 ⇒ pet 页面理论上可调全部命令（推断，未运行验证）。
7. **PTY 无 TTL / 无每会话上限**；退出 no-wait kill ⇒ 可能孤儿 `cmd.exe`。
8. **级联删除闸门只覆盖 5 张根表**；其它表只回报 `affected_rows`。
9. **文档/版本漂移**：HANDOVER 说命令全在 lib.rs；AGENTS 写 1.16.323，实际 1.16.330。
10. **换环境即失效两条**：DPAPI 密文换机/换账户解不开；手机自签 CA 无公共兜底。

---

## 12. 改 Rust / IPC 的检查清单

- [ ] 新命令：`#[tauri::command]` + `generate_handler!` 注册；前端 `invoke` 参数与 Rust 形参数量一致（`TAURI-ARITY-1/2`）。
- [ ] 新存储命令：`codem-db/lib.rs` 的 `COMMANDS` 白名单 + `repo.rs` + `storage.rs` + 前端 `rust-port.ts` + 契约测试。
- [ ] 改数据根：只读 `storage.rs` 的 `resolve_db_path` / `isolated_data_home`；不要新增第二个 `app_data_dir_path()` 调用点。
- [ ] 改凭据：只走 `secret_seal/unseal`；失败不降级；不要把明文写日志。
- [ ] 改执行器：同步 `shell-ops` 策略（拒绝 PowerShell 5.1）、超时 clamp、杀树、输出上限、`CREATE_NO_WINDOW`。
- [ ] 改窗口/宠物：同步 capability、`tauri.conf.json`、前端多页构建 `vite.config.ts`。
- [ ] 跑 `cargo test --lib`（Rust 单测）+ `npm run db:test`（存储金样本）+ `npm run audit:command-parity`。
