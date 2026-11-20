# 内置本机 Host —— Android 原生侧补充说明（v1 + 扩展）

配套：`mobile/LOCAL_HOST_CONTRACT.md`（Dart ↔ 原生契约正文）。本文只记**原生侧实现事实**、
**契约 v1 之外的扩展**与**设备验证证据**；Dart 侧可以只用 v1 方法，扩展方法按需接入。

## 1. 代码位置

| 文件 | 作用 |
|---|---|
| `app/src/main/java/com/codem/remote/LocalHostRuntime.java` | 解压运行时、装可执行、工作区/存储授权、start/stop/status/项目/模型配置、调试探针 |
| `app/src/main/java/com/codem/remote/HostSupervisor.java` | PRoot+Node 进程管理（复制自 `android-shell`，除可见性外逻辑未改） |
| `app/src/main/java/com/codem/remote/LlmConfig.java` | 模型配置值对象（`toString` 不输出 Key） |
| `app/src/main/java/com/codem/remote/LlmSecretStore.java` | Key 的 AndroidKeyStore + AES/GCM 密文存储 |
| `app/src/main/java/com/codem/remote/WorkspacePaths.java` | 共享/私有工作区路径 |
| `app/src/main/kotlin/io/codem/codem_mobile/MainActivity.kt` | 注册 MethodChannel（`codem/local_host` + 原有 `codem/native`） |
| `app/src/main/kotlin/io/codem/codem_mobile/LocalHostKeepAliveService.kt` | Host 常驻前台服务 + `PARTIAL_WAKE_LOCK` |
| `tools/stage-local-host.mjs` | 从 `android-shell/build/<abi>/stage` 搬 assets/jniLibs 进 Flutter 工程 |

`com.codem.remote` 包名保持不变（直接复用 android-shell 已验证的类，不引入新依赖）。

## 2. 契约 v1 之外的扩展

### `start` 的返回（扩展字段）

成功（v1 字段不变，新增 `project` / `shared` / `needsPermission` / `logPath`）：

```json
{"needsPermission":false,"url":"http://127.0.0.1:PORT","token":"64hex",
 "workspace":"/storage/emulated/0/codem/workspace","project":"","shared":true,
 "logPath":"/data/user/0/io.codem.codem_mobile/files/host.log"}
```

**未授权共享存储时不会启动 Host，也不回退私有目录**，而是返回：

```json
{"needsPermission":true,"permission":"manage_external_storage",
 "workspace":"/storage/emulated/0/codem/workspace","project":"","storage":{...}}
```

- `permission`：`manage_external_storage`（API≥30）或 `write_external_storage`（API 23..32）；
- `workspace` 是**授权后会用到的共享路径**（不是私有回退路径），Dart 直接拿它提示用户；
- Dart 调 `requestStorageAccess` 引导授权，回到前台后 `storageAccess` 复查，再重试 `start`；
- 用户明确接受「文件管理器看不到项目」时传 `start(..., allowPrivateFallback: true)`，
  返回 `shared:false`，`workspace` 是私有目录真实路径。

### 新增方法

| 方法 | 参数 | 返回 |
|---|---|---|
| `storageAccess` | — | `{granted, permission, manageAllFiles, writeGranted, shared, apiLevel, sharedWorkspace, privateWorkspace, intendedWorkspace, workspace}` |
| `requestStorageAccess` | — | `true` = 现在已可写；`false` = 已跳系统授权页/已弹运行时申请（回前台后自行复查） |

`status` 在 v1 的 `running/url/token/workspace` 之外额外返回 `project` / `shared` / `storage`；
未运行时至少返回 `{"running":false,"storage":{...}}`。

`modelConfig` 额外返回 `configured` / `keyState`（`keystore|legacy|unreadable|none`）/ `insecureHttp`。

### 错误码（`PlatformException.code`）

| code | 含义 |
|---|---|
| `config_error` | 模型配置无法保存（含 AndroidKeyStore 不可用）；message 是人话，**不含 Key** |
| `runtime_failed` | 资产/可执行文件缺失、解压失败（如 ABI 不匹配、磁盘满） |
| `host_failed` | Host 未在 120s 内就绪、端点丢失、旧 Host 停不干净 |

## 3. 启动流程（原生侧）

1. `sharedWritable()`：建 `/storage/emulated/0/codem/workspace` + 写探针文件 + 删除 —— **实际写一次**才算授权（比单看权限标志可靠）；
2. 未授权且未允许私有回退 ⇒ 返回 `needsPermission`（见上，Host 不会启动）；
3. 保存模型配置：Key 走 `LlmSecretStore.saveKey`（AES/GCM，落盘只有密文），base/model 走 SharedPreferences；
4. `ensureRuntimeInstalled()`：首次（或 `versionCode:ABI:host.mjs大小` 指纹变化）解压 rootfs 到
   `files/rootfs`（纯 Java tar 解析，支持 PAX 头/符号链接/硬链接），复制 `host.mjs`/`web/*` 到
   `files/app`，`libtalloc.so.2`/`libandroid-shmem.so` 到 `files/libs`；每次启动都补
   `libstdc++.so.6`/`libtinfo.so.6`/`ca-certificates.crt` 进 rootfs，并覆写 `etc/resolv.conf`；
5. 从 `nativeLibraryDir` 复制 `libproot.so→bin/proot`、`libproot_loader.so→bin/proot_loader`、
   `libcodem_db.so→bin/codem_db`、`libnode.so→bin/node` 并 `chmod +x`；缺失时按 ABI 给出可操作报错；
6. 首次写欢迎会话（走 PRoot 的 `codem_db`；失败只告警，不阻断）；
7. 起前台服务保活；`HostSupervisor.ensureStarted` 拉起
   `proot -0 -r rootfs … node /opt/app/host.mjs serve --data-home … --workspace … --web … --port <随机>`；
8. `/healthz` 探活（最长 120s），返回 `url/token/workspace`。

模型 Key 通过 **stdin** 交给 Host（`--llm-stdin`），不进 argv、不进环境变量；
Host 令牌经环境变量 `CODEM_HOST_LOCAL_AUTH`，只出现在返回值里，**不进日志**。

### 3.1 DNS 必须单独写（踩过的坑）

`writeDnsConfig` 里「写 `resolv.conf`」与「读当前网络 DNS」必须分开：

- `ConnectivityManager.getActiveNetwork()` 需要 `ACCESS_NETWORK_STATE`；缺权限抛 `SecurityException`；
- 早期版本两者同在一个 try 里 ⇒ 异常一跳过，**连文件都没写成**（Host 仍能起来，但 rootfs 内 DNS 不可用，
  模型请求必失败）。现在：写文件（`FileOutputStream`）在前，读 DNS 单独 try，读不到用 `8.8.8.8/1.1.1.1` 兜底。

## 4. 打包（资产来源）

```powershell
# 1) 先在 android-shell 生成 stage（需要 .android-proot/ 与交叉编译产物）
node android-shell/build.mjs --abi x86_64          # 或 --abi arm64

# 2) 搬进 Flutter 工程（每次只铺一个 ABI；换 ABI 会先清空目标目录）
node mobile/android/tools/stage-local-host.mjs --abi x86_64

# 3) 构建（debug 包才有调试 extra；release 包忽略它们）
cd mobile; flutter build apk --debug --target-platform android-x64
```

- `app/src/main/assets/**` 与 `app/src/main/jniLibs/**` 是**生成目录**（脚本整体重建），不要手写文件；
- x86_64 stage 体积：assets ≈ 36 MB + jniLibs ≈ 119 MB（node 单文件 115 MB）；
- `jniLibs` 里的 `lib*.so` 靠 `packagingOptions.jniLibs.useLegacyPackaging = true` 在安装时被系统解出到
  `nativeLibraryDir`（带可执行位），这是 PRoot/Node 能被 exec 的前提；
- **AGP 会解压 `.gz` 资产**：`rootfs.tar.gz` 进 APK 后变成 `assets/rootfs.tar`（实测 AGP 9.1）。
  `LocalHostRuntime` 两个名字都认，并按魔数判断是否 gzip（`hasRootfsAsset` / `extractRootfs`）；
- Flutter 自己的 `assets/flutter_assets/**` 与这里的 `assets/*` 在 APK 里是同级不同名，不冲突；
- 单 ABI debug APK ≈ 251 MB（含未裁剪的 debug 版 `libflutter.so` 372 MB 解压后体积）。

## 5. 调试钩子（仅 debuggable 构建）

```powershell
adb shell am start -n io.codem.codem_mobile/.MainActivity --ez localHostAutostart true
adb shell am start -n io.codem.codem_mobile/.MainActivity --es localHostDebugAction status
adb shell am start -n io.codem.codem_mobile/.MainActivity --es localHostDebugAction stop
adb shell am start -n io.codem.codem_mobile/.MainActivity --es localHostDebugAction cycle
adb shell am start -n io.codem.codem_mobile/.MainActivity --es localHostDebugAction netcheck
```

- `localHostAutostart`：后台 `start(null,null,null,false)`（无模型配置也能起 Host，`/healthz` 可用）；
- `localHostDebugAction`：`start|stop|status|cycle`（cycle = start→stop→start，验证端口轮换）；
  `netcheck` 在 **PRoot 里**跑 Node 探针：`dns.lookup(api.aicodewith.ai)` + `fetch('https://…/v1/models')`
  （不带 Authorization，401/403 也算通），输出形如
  `netcheck host=api.aicodewith.ai exit=0 output=dns=OK 198.18.0.18 https=OK status=200 ms=1654`；
- 第二次 `am start` 走 `onNewIntent`（`singleTop`），所以调试 extra 在 onCreate 之外也生效；
- release 构建忽略以上 extra（`FLAG_DEBUGGABLE` 门禁），日志里**只有 url/workspace，没有 token/Key**。

## 6. targetSdk / Manifest / Gradle

- `targetSdk = 28`：Android 10+ 对 targetSdk≥29 禁止「应用数据目录 exec」与「ptrace 子进程」，
  PRoot 两件都要；改成 29+ 本机 Host 直接起不来。代价：不能上架 Google Play（本项目 sideload）。
- `minSdk = max(flutter.minSdkVersion, 26)`；`compileSdk` 保持 Flutter 默认（36）。
- `ndkVersion = flutter.ndkVersion`（28.2.13676358）：Flutter 3.4x 的 Gradle 插件会为 native assets 建合成
  CMake 工程，NDK 缺失时构建直接失败；钉住版本后由 Flutter 工具做 NDK 供给。
- 权限：`MANAGE_EXTERNAL_STORAGE`、`READ/WRITE_EXTERNAL_STORAGE`（`maxSdkVersion=32`）、
  `WAKE_LOCK`、`ACCESS_NETWORK_STATE`、`FOREGROUND_SERVICE_DATA_SYNC`（保留）、
  `POST_NOTIFICATIONS`、`INTERNET`。
- 新增服务 `LocalHostKeepAliveService`（`foregroundServiceType="dataSync"`）。

## 7. 设备验证（2026-11-06，emulator-5554 / Android 15 / API 35 / x86_64）

| 场景 | 证据 |
|---|---|
| 首次安装解压 | logcat：`installing local runtime (stamp=1:x86_64:3577532)` + `extracting rootfs: … 72 MB`；`files/` 出现 `rootfs/app/bin/libs/data` + `.runtime-ready` |
| 可执行文件 | `files/bin`：`node`(120,177,224B) / `proot` / `proot_loader` / `codem_db`，权限 `-rwx--x--x`；`ps` 里 `proot → node → codem_db` 同属本 App uid |
| Host 就绪 | `host ready port=34873`；`/healthz` → `200 {"ok":true,"hostId":"host-64617461","pid":1320}`（pid 与 `ps` 中 node 一致） |
| rootfs 内 DNS/HTTPS | `resolv.conf` 59B：`nameserver fec0::3 / 10.0.2.3 / 10.0.2.4`；`netcheck` → `dns=OK 198.18.0.18 https=OK status=200 ms=1654` |
| stop | `debugAction stop: stopped=true running=false`；本 App 的 proot/node/codem_db 全部消失，旧端口 `/healthz` 连接被关闭；**另一包 com.codem.remote 的进程未被误杀** |
| start→stop→start | 端口 38287 → 41233 轮换，末次 `/healthz` 200 |
| 存储授权门禁 | `appops set … MANAGE_EXTERNAL_STORAGE deny` 后：`start deferred: storage permission missing (manage_external_storage)`，返回 `needsPermission=true workspace=/storage/emulated/0/codem/workspace`，**不启动 Host**；重新 allow 后下一次 start 立即成功（`shared=true`） |

APK 核对（`flutter build apk --debug --target-platform android-x64`，250.9 MB）：
`assets/{rootfs.tar 80.3MB, host.mjs 3.4MB, web/*, abi.txt, ca-certificates.crt, libstdc++.so.6, libtalloc.so.2, libandroid-shmem.so, libtinfo.so.6}`
+ `lib/x86_64/{libnode.so 114.6MB, libcodem_db.so 4.0MB, libproot.so, libproot_loader.so}`
+ `assets/flutter_assets/*`；`aapt2 badging` → `minSdkVersion:'26' targetSdkVersion:'28' native-code:'x86_64'`。

## 8. 已知风险 / 未验证

1. **arm64 真机未验证**：stage 已能生成（`--abi arm64`），但只在 x86_64 模拟器（Android 15 / API 35）上跑过；
   arm64 需要重新 `stage-local-host.mjs --abi arm64` 再构建（assets 与 jniLibs 都是 ABI 相关的，一次只放一个 ABI）。
2. **真实模型回合未跑**：验证到 `https=OK status=200`（不带 Key 的 `/v1/models`）；
   带 Key 的完整会话由 Dart 侧/端到端用例覆盖。
3. **首次启动耗时**：rootfs 解压 ~30–60s（10k+ 文件）+ Node 启动数秒，`start` 在后台线程执行；
   原生侧已串行化（单线程 MethodChannel executor + `HostSupervisor` 单飞），不会起第二个 Host。
4. **共享目录被别的 uid 占用**：本次测试里 `/storage/emulated/0/codem` 曾被旧安装（另一个 uid）占着，
   未授权/未清理时 `mkdirs` 失败 → 走 `needsPermission`。真机上如遇到「已授权但仍不可写」，
   Dart 应提示用户删掉该目录或改用私有回退（`allowPrivateFallback`）。
5. **前台服务限制**：Android 14+ 对 `dataSync` 类型有配额；targetSdk=28 时按旧行为处理，
   长时间后台仍可能被厂商 ROM 杀掉，Host 由 Dart 侧重新 `start` 拉起（幂等）。
6. **APK 体积**：单 ABI debug 包 ≈ 251 MB；这是「手机不依赖电脑」的代价（rootfs+Node 本体）。
7. **NDK 环境**：本机 SDK 的 NDK 28.2 曾被裁剪成空壳（只有 `source.properties`），已用 sdkmanager
   重装完整 r28c；`flutter build apk` 因此恢复可用。新机器上若报 CMake「CMAKE_C_COMPILER not set」，
   优先检查 NDK 是否完整（`ndk/28.2.13676358/toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe`）。

## 9. arm64 宿主构建与验证（第 10 轮，2026-11-20）

第 8 节第 1 条说「arm64 需要重新 stage 再构建」，本轮把它**真的做完了**：

### 9.1 交叉编译链（一次性）

| 组件 | 版本/位置 | 用途 |
|---|---|---|
| Rust target | `aarch64-unknown-linux-gnu`（`rustup target add`） | 产物要在 **arm64 Ubuntu rootfs** 里跑（glibc） |
| zig | **0.13.0**，解压在 `C:\dev\zig-dl\zig-windows-x86_64-0.13.0`（zip 的 sha256 与官方 index.json 逐字一致） | 当交叉链接器：自带 glibc 的 crt/libc 桩，Windows 上不需要另装 aarch64 sysroot |
| cargo-zigbuild | **0.24.1**（`cargo install cargo-zigbuild --locked`） | 把 `--target` 交给 zig |

### 9.2 构建（可复跑）

```powershell
# 1) codem-db（aarch64 Linux）—— 新脚本会自检产物是 ELF64/AArch64 且解释器为 /lib/ld-linux-aarch64.so.1
npm run db:build:arm64        # = node tools/mobile/build-db-arm64.mjs（内部 cargo zigbuild，CARGO_TARGET_DIR=.linux-target）

# 2) 组装 stage（proot/node/rootfs/共享库 都是现成的 arm64 资产）
node android-shell/build.mjs --abi arm64
node mobile/android/tools/stage-local-host.mjs --abi arm64

# 3) Flutter 出包（release + split-per-abi）
cd mobile; flutter build apk --release --target-platform android-arm64 --split-per-abi
```

产物：`mobile/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk`（**117 MB**）。
实测确认（读 zip + 解压后读 ELF 头）：

| 条目 | 机器 | 解释器 |
|---|---|---|
| `lib/arm64-v8a/libapp.so` | AArch64 | — |
| `lib/arm64-v8a/libflutter.so` | AArch64 | — |
| `lib/arm64-v8a/libproot.so` | AArch64 | `/system/bin/linker64`（Android bionic） |
| `lib/arm64-v8a/libproot_loader.so` | AArch64 | 静态 EXEC |
| `lib/arm64-v8a/libcodem_db.so` | AArch64 | `/lib/ld-linux-aarch64.so.1`（rootfs 内） |
| `lib/arm64-v8a/libnode.so` | AArch64 | `/lib/ld-linux-aarch64.so.1` |
| `assets/rootfs.tar`（101.8 MB 解压后） | arm64 Ubuntu 24.04 | — |
| `assets/abi.txt` | `arm64` | — |

### 9.3 运行时验证（不需要真机的那部分）

`android-shell/verify-arm64.sh` 在 **linux/arm64 容器**（Docker + QEMU binfmt）里跑真 arm64 指令：

```powershell
docker run --rm --platform linux/arm64 -v C:\mimo-gui:/work -w /work ubuntu:24.04 bash /work/android-shell/verify-arm64.sh
```

结果：`ARM64_QEMU_RESULT=PASS`

- `NODE_OK`：arm64 node v22.14.0 起来；
- `APKDB_OK` / `LINUXDB_OK`：APK 里的 `libcodem_db.so` 与交叉编译的 `codem-db-cli` 都能执行；
- `HOST_OK`（两个 db 各一次）：`host.hello` → `session.create` → `session.list` 全部成功（真实 RPC，而非只看进程活着）；
- 另外单独验证过 `codem-db init/health/counts`：59 张表、fts5 可用、WAL 模式、`ready:true`。

### 9.4 仍未验证（只有真机能做）

1. **PRoot 本体**：它是 Android bionic 链接（`/system/bin/linker64`），容器里没有 bionic ⇒ 容器无法执行；
   本轮只核对了它的 ELF/解释器与依赖（libtalloc / libandroid-shmem 都是 AArch64 且随包）；
2. **Android 沙箱/exec 策略**、WebView、厂商保活：需要 arm64 真机或 arm64 系统镜像（x86_64 宿主上 emulator 明确拒绝 arm64 镜像）。

⚠️ `stage-local-host.mjs` **一次只放一个 ABI**（换 ABI 会清空目标目录）。本轮验证完后已恢复 x86_64 stage（模拟器可继续用）；
要再出 arm64 包，重跑 9.2 的第 2 步即可。仓库里附带的 arm64 产物留档在 `.preview-shot/arm64/app-arm64-v8a-release.apk`（不进 git）。
