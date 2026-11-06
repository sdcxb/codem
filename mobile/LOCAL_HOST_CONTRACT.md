# Flutter 本机 Host 集成契约（v1）

目标：Flutter Android 客户端不依赖电脑，内置 PRoot/Ubuntu/Node/Codem Host，本机模型设置保存在手机上。

## Android 侧 MethodChannel

Channel: `codem/local_host`
Methods:

### `start`
参数：
```json
{"baseUrl":"https://api.aicodewith.ai/v1","model":"deepseek-v4-flash","apiKey":"sk-acw-..."}
```
返回（成功）：
```json
{"url":"http://127.0.0.1:PORT","token":"64hex","workspace":"/storage/emulated/0/codem/workspace"}
```
失败：`PlatformException(code, message)`，不让 Key 进入 message/log。

### `stop`
返回 `true`。

### `status`
返回：
```json
{"running":true,"url":"http://127.0.0.1:PORT","token":"64hex","workspace":"..."}
```
未运行：`{"running":false}`。

### `listProjects`
返回字符串数组（`/storage/emulated/0/codem/workspace` 下的目录名，含根 `""`）。

### `setProject`
参数 `{"name":"my-app"}`；空字符串 = 根。只记录选择，下一次 `start` 生效；返回 `true`。

### `saveModel`
参数同 `start`，保存模型配置但不启动 Host；返回 `true`。

### `modelConfig`
返回 `{"baseUrl":"...","model":"...","hasKey":true}`；不返回 Key 明文。

### `importProject`
系统文件选择器导入，返回 `{"name":"...","files":N}`；取消返回 `{"cancelled":true}`。
（可选，第二阶段）

## Dart 侧约束

- 本机 Host 作为 `HostProfile(kind: local)` 加入主机列表；`baseUrl` 用返回的 loopback URL，`cookie` 存 token。
- 连接时 `HostClient(bearerToken: token)`；远程 Host 仍用 cookie。
- 本机模型设置只在 Android 本机 host 的编辑页显示，调用 `saveModel` + `start`，成功后把返回 url/token 写入 HostStore。
- 失败要显示可操作错误，不打印 Key。

## 安全

- Key 只通过 MethodChannel 字符串传递，不进 URL、日志、SharedPreferences 明文（Android 侧用 Keystore 加密）。
- token 每次 Host 启动随机；只存手机本地。

## 扩展（Android 原生实现，v1 兼容）

`start` 成功还返回 `project` / `shared` / `needsPermission` / `logPath`；`shared:false` 表示应用私有回退。

未授权共享存储时**不启动 Host**，返回：

```json
{"needsPermission":true,"permission":"manage_external_storage","workspace":"/storage/emulated/0/codem/workspace",
 "project":"","storage":{"granted":false}}
```

`permission` 为 `manage_external_storage`（API>=30）或 `write_external_storage`（API 23..32）。Dart 调 `requestStorageAccess` 引导授权；回前台后 `storageAccess` 复查并重试。

新增方法：

| 方法 | 返回 |
|---|---|
| `storageAccess` | `{granted, permission, manageAllFiles, writeGranted, shared, apiLevel, sharedWorkspace, privateWorkspace, workspace}` |
| `requestStorageAccess` | `true` = 已可写；`false` = 已打开系统授权页/运行时申请，回前台复查 |

`status` 额外返回 `project` / `shared` / `storage`；`modelConfig` 额外返回 `configured` / `keyState` / `insecureHttp`。

错误码：`config_error`（Key/Keystore 保存失败，文案不含 Key）、`runtime_failed`（资产/ABI/磁盘）、`host_failed`（120s 未就绪/停不干净）。

### 安全与限制

- Key 只经 MethodChannel 交给原生，AndroidKeyStore AES/GCM 落盘；Host 通过 stdin 接收，不进 argv/环境变量/日志。
- Host token 每次启动随机，只存手机本地。
- targetSdk=28：PRoot 需要应用数据目录 exec + ptrace 子进程，不能上架 Google Play。
- 单 ABI APK 约 250MB（rootfs + Node）；arm64 需重新 stage。