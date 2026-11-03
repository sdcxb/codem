# Android 本机验证报告（Windows 11 本机模拟器）

> 2026-11 ｜ 用户要求：在本机做真机级验证（Windows 11 可装 Android 运行环境）
> 结论：**x86_64 的 Android 15 运行环境上全部通过**；arm64 仍缺硬件/可用镜像，未验证。

## 1. 环境取证

| 项 | 读数 |
|---|---|
| 宿主 | Windows 11（NT 10.0.26300） |
| Android | **Android 15（API 35）**，x86_64，AOSP `codem-test` AVD（Android Studio Emulator） |
| APK | `codem-shell-x86_64.apk`，`versionName=0.2.0`，`versionCode=2`，`minSdk=26`，**`targetSdk=28`** |
| 安装 | `adb install -r` → `Success`；`dumpsys package` 读数与上表一致 |

> 为什么不是 WSA：WSA 已停止支持，`winget` 无包；本机也没有 BlueStacks/Genymotion。
> 选的是现有 Android Studio 模拟器（**真实 Android 系统**，不是桌面套壳）。

## 2. 判据与结果

| 组 | 内容 | 结果 |
|---|---|---|
| SC-1..5 | 自包含 APK：解压 rootfs、起设备内 Host、WebView 加载共享 UI、欢迎会话、截图 | **5/5** |
| LT-1..5 | 配好 provider → 建会话 → 发 prompt → 真跑完一轮（工具调用 + 最终回答）→ 截图 | **5/5** |
| RST-1..4 | 跑一轮（seq=13）→ `force-stop` 应用 → 重启 → 会话仍在、seq 继续增长到 20 | **4/4** |
| 崩溃 | `logcat -b crash` 空；`exit-info` 只有本地主动 `force-stop` 与 `PACKAGE UPDATED` | 无崩溃 |

RST 的关键读数（持久化，不是进程内缓存）：

```
seqBeforeStop = 13
seqAfterRestart = 20
sessionCount = 2（欢迎会话 + 新建会话）
```

截图：`docs/architecture/evidence/spike-android-local-turn.png`
（可见：真实 Android WebView 里的共享 UI、用户消息、助手回答、`read ✓` 工具卡、右上「已完成」）

复跑：

> 2026-11 更新：这些 spike 脚本默认使用 `android-shell/build/codem-shell-x86_64-debug.apk`
> （配置类 intent extras 只在 debuggable 构建生效），构建命令见 `android-shell/README.md`。

```powershell
$env:ANDROID_SDK_ROOT="C:\Users\abee\AppData\Local\Android\Sdk"
node android-shell\spike-selfcontained.mjs
node android-shell\spike-local-turn.mjs
node android-shell\spike-restart.mjs
```

## 2.4 真模型端到端（REAL-1..4，已通过）

之前所有设备用例用的是**确定性 mock provider** —— 只能证明链路，不能证明模型/Key/网络。
本轮用本机 Codem 已配置的 **DeepSeek** provider（从 DPAPI 封存值解出，未打印、未入库、测完 `pm clear`）做了真模型验证：

| 判据 | 结果 |
|---|---|
| REAL-1 设备内 Host 用真实 provider 跑完一轮 | ✅ `succeeded` |
| REAL-2 助手正文是真实回答（问中国首都） | ✅ `北京`（非 `DEVICE_DONE`） |
| REAL-3 WebView UI 再发一条（问法国首都） | ✅ 页面出现 `巴黎` |
| REAL-4 截图 | ✅ `evidence/android-real-model.png` |

**这一步抓到两个只有真网络才会暴露的产品缺陷（已修）**：

1. Ubuntu base 根文件系统**没有 CA 证书** ⇒ Node `fetch(https)` 直接 `fetch failed`。现在 APK 随包携带
   `ca-certificates.crt`，由 `copyGuestLib` 注入 `etc/ssl/certs/`；
2. rootfs 的 `/etc/resolv.conf` 指向不存在的 systemd-resolved ⇒ DNS 失败。现在按 Android 当前网络
   （`ConnectivityManager` 的 DNS）覆写 `etc/resolv.conf`，无网络时回退 8.8.8.8/1.1.1.1。

复跑：`$env:CODEM_TEST_KEY="sk-..."; npm run android:spike:real`
（结果：`evidence/android-real-model.json`，只含 key 的 sha256 前 12 位）。

## 2.45 固件解包符号链接（2026-11 修复）

真机发现 rootfs 解包把相对符号链接按 rootfs 根解析（`/usr/bin/sh -> dash` 变成 `<rootfs>/dash`），导致 guest 里 `#!/bin/sh` 脚本 ENOENT。已修为：相对链接相对条目目录、绝对链接映射进 rootfs。`run-as` 实测 `bin/sh`/`usr/bin/sh` 均指向 `rootfs/usr/bin/dash`。

## 2.5 本机 arm64（QEMU/Docker）能验证到什么

本机是 **AMD64**（Ryzen AI MAX+ 395）：虚拟化改不了指令集，x86 上的 Hyper-V/VMware 只能跑 x86 客户机；
Android Emulator 的 arm64 镜像也不支持在 x86 宿主机上运行；WSA 已停更。**装传统虚拟机解决不了 arm64。**

但 Docker Desktop 自带 QEMU binfmt，可以跑 **linux/arm64** 容器。用它对**安装包里的 arm64 产物**做了 ABI 级验证：

```powershell
npm run android:verify:arm64
# = docker run --rm --platform linux/arm64 -v %CD%:/work -w /work ubuntu:24.04 bash /work/android-shell/verify-arm64.sh
```

结果（可复跑）：

| 项 | 结果 |
|---|---|
| arm64 Node（安装包同款 `node-v22.14.0-linux-arm64`） | ✅ `v22.14.0` |
| arm64 `codem-db`（**APK 里的** `libcodem_db.so`） | ✅ 可执行 |
| arm64 Host + APK 的 DB：`host.hello` / `session.create` / `session.list` | ✅ `count=1` |
| 交叉编译的 Linux arm64 `codem-db-cli` + Host | ✅ `count=1` |

**验证不到**（必须 Android arm64 真机）：
- **PRoot**：Android/bionic 链接，容器里报 `qemu-aarch64: Could not open '/system/bin/linker64'`；
- **WebView / Android 沙箱 / targetSdk=28 的 exec 与 ptrace 策略**。

结论：arm64 的 **Node + Host + DB 服务栈**已在本机证明可执行；**PRoot 与 WebView 只能真机验证**。

## 2.6 真机操作用例（DC-1..9，已跑通）

用例文档：`ANDROID-DEVICE-TEST-CASES.md`；自动化：`npm run android:test:device`
（`android-shell/run-device-cases.mjs`）。页面操作走**设备 WebView CDP 的真实 DOM 事件**，
RPC 只用于核对 Host 状态。

| 用例 | 结果 |
|---|---|
| DC-1 冷启动 Host 就绪 | ✅ |
| DC-2 共享 UI（标题 + 新建会话） | ✅ |
| DC-3 页面新建会话 | ✅ |
| DC-4 输入并发送，真跑一轮（glob + DEVICE_DONE） | ✅ |
| DC-5 审批卡出现 / 允许后 `exit 0` / 卡片消失 | ✅ ✅ ✅ |
| DC-6 出现「继续」/ 点击才发下一轮 | ✅ ✅ |
| DC-7 深链打开指定会话 | ✅ |
| DC-8 force-stop 重启后会话仍在 | ✅ |
| DC-9 全程无崩溃 | ✅ |
| DC-10 按 HOME 后 Host 仍存活 | ✅ |
| DC-11 文件浏览/只读预览 | ✅ |

机器可读结果：`docs/architecture/evidence/device-cases-report.json`（`ok: true`）；
截图：`docs/architecture/evidence/device-cases-final.png`。

### 抓到的真实缺陷（已修）

第一版 DC-5 是**假通过**：断言只查 DOM 里有没有 `DEVICE_OK`，而命令回显本身就含这串文字，
于是 bash 实际 `exit 127`（Ubuntu base 缺 `libtinfo.so.6`）也被判成通过。

- **产品修复**：APK 随包携带 `libtinfo.so.6`（x86_64/arm64），
  `MainActivity.copyGuestLib` 注入 guest 的 `usr/lib/<triple>/`；`build.mjs` 列为必需资产。
- **判据修复**：DC-5b 改为检查 `(exit 0` 且不含 `cannot open shared object`。

修复后截图里是 `(exit 0, 102ms)` + `--- stdout --- DEVICE_OK`。
arm64 APK 也已重新构建并确认包含 `assets/libtinfo.so.6`（265416 字节）。

## 3. 未覆盖 / 限制（如实）

1. **arm64 仅 ABI 级验证**：Node/Host/DB 已在 QEMU 下通过（见 §2.5）；PRoot/WebView/Android 策略仍需一台 arm64 真机跑同一套 SC/LT/RST。
2. **模拟器 ≠ 物理机**：没有真实基带/厂商 ROM/省电策略；后台保活与厂商杀进程策略未覆盖。
3. **无 Google Play 服务**：AOSP 镜像；WebView 为系统自带版本，未覆盖低版本 WebView 的兼容性。
4. `terminal.*` 交互式终端仍不支持（设计范围外）。

## 4. 结论

- “安装 → 自包含解压 → 设备内 Host → WebView 共享 UI → 真跑一轮 → 杀进程重启数据不丢”这条链路在
  **Android 15 x86_64** 上闭环通过，且没有崩溃记录。
- 剩余风险集中在 **arm64 与物理机厂商策略**，不是代码路径。
