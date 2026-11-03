# ADR-0002 · Android 本机运行时（Kotlin 壳 + PRoot + Node + codem-db）

> 状态：**有条件通过（关键假设已核实，端上执行未验证）** ｜ 日期：2026-10-31
> 相关：`ADR-0001`、`ADR-0003`、`SPIKE-REPORT.md`

---

## 1. 目标与硬约束

**目标**：手机独立项目、独立工作区、独立会话；本地 Agent + 工具 + 终端 + 文件 + 审批 + 后台；
安装 APK 即用，**不需要 root、不需要 Termux、不需要 PC、不需要任何环境配置**。

**硬约束（用户明确要求）**：
1. 不依赖 WSL / 虚拟机 / 任何"让用户先装环境"的方案（那会破坏 exe/APK 一键安装的初衷）；
2. 不做 Flutter 重写；
3. 不把现有 Rust（Tauri 壳）直接打进 Android；
4. 不自建云基础设施（模型 API 之外）。

---

## 2. 结论

| 件 | 方案 | 依据 | 状态 |
|---|---|---|---|
| UI | **Kotlin 壳 + WebView** 加载打包进 APK 的 React 资源 | 与桌面同一套 `packages/ui`，见 ADR-0003 | 已定 |
| Linux 用户态 | **PRoot**（ptrace 用户态 syscall 转发）+ 随 APK 打包的 Ubuntu arm64 rootfs | 同内核、无虚拟化、无 root | 已定 |
| 语言运行时 | **Node arm64**（官方 linux-arm64 tarball）放进 rootfs | Host 是 Node/TS（ADR-0001） | 已定 |
| 存储引擎 | **`codem-db` 交叉编译为 `aarch64-unknown-linux-musl` 静态二进制** | 静态链接 ⇒ 不吃 glibc 版本；PRoot 里直接可跑 | 已定，未在 arm64 上执行 |
| 进程模型 | 前台服务持有 Host 进程 + 唤醒锁；关 UI 不停 Host | Android 后台限制 | 已定 |
| 原生桥 | 文件选择/拍照、通知、分享、剪贴板、电量/网络状态 | WebView 无这些能力 | 已定 |

**关键判断**：PRoot 是**随 APK 打包的用户态运行时**，与 WSL 完全不同 —— 它不要求用户开启任何
Windows/系统功能，也不创建第二套内核。用户的动作只有一个：安装 APK。

---

## 3. Android 平台的两个硬门槛（这是可行性的真正风险点）

### 3.1 W^X：Android 10+ 不允许从应用数据目录 `execve`

- 事实：对 `targetSdk >= 29` 的应用，`/data/data/<pkg>/files/**` 里的文件**不可执行**（无论权限位）。
- 通行解法（Termux 等在用）：把可执行文件作为 **native library** 打进 APK
  （`lib/arm64-v8a/libproot.so`、`libnode.so` …），安装时由系统解包到
  `nativeLibraryDir`（该目录可执行），再用它作为入口。
- 影响：打包流程必须把 `proot`、`node`（以及需要直接 exec 的辅助二进制）**改名成 `lib*.so`**
  并放进 `jniLibs`；rootfs 里的其它二进制由 PRoot 转发执行（PRoot 自己已在可执行目录）。
- 判据：APK 里存在 `lib/arm64-v8a/libproot.so` 与 `libnode.so`，且 `nativeLibraryDir` 下可执行。

### 3.2 后台存活

- 前台服务（`foregroundServiceType="dataSync"` 或 `specialUse`，取决于目标 API）+ 常驻通知；
- `PARTIAL_WAKE_LOCK`（只保证 CPU，不保证网络）；
- 电池优化白名单引导（`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 需用户确认，不能静默）；
- 厂商 ROM（小米/华为/OPPO）会额外杀后台 ⇒ 设置页必须给"如何保活"的**可操作指引**，
  不能假装"我们一定活着"。

---

## 4. 安装 / 升级 / 回滚 / 重置

```text
APK assets/
├─ runtime/rootfs-ubuntu-arm64.tar.zst     # 用户态（含 node、codem-host、codem-db）
├─ runtime/host-bundle.mjs                 # 单文件 Host（与 PC 同一份产物）
└─ web/                                    # React 资源（与桌面同一套构建）
```

1. **首次启动**：解包 rootfs 到 `filesDir/runtime/v<version>/`（进度可见、可取消）；
2. **升级**：新版本解到新目录，校验（文件数 + 关键文件 sha256）通过后原子切换 `current` 指针；
   旧版本保留一代用于回滚；
3. **回滚**：指针指回上一代（不需要重新下载）；
4. **重置**：删除 `runtime/`，保留 `data/`（会话/库）—— 或按用户选择连 `data/` 一起清；
5. **安全模式**：连续两次启动失败 ⇒ 不自动启动 Host，只开设置页并提供"导出日志/回滚/重置"。

**数据位置**（与桌面同构）：

```text
filesDir/data/                 ← CODEM_DATA_HOME
├─ codem-db-rust.bin(+wal/shm) ← Linux arm64 codem-db
├─ sessions/<sid>.jsonl        ← 权威日志
├─ attachments/  spill/  host/
└─ runtime/                    ← 运行时（与 data 分离，重置运行时不动数据）
```

---

## 5. 性能预期（必须诚实标注"未实测"）

| 项 | 预期 | 依据 |
|---|---|---|
| PRoot 启动 | 首次数秒（解包），之后 < 1s | ptrace 转发开销小 |
| 工具执行（读写文件） | 比原生慢 1.2–3×（I/O 密集更明显） | PRoot 逐 syscall 转发，业界经验值 |
| Agent 循环 | 与桌面同量级（瓶颈是模型 API） | 循环本身是 IO/网络等待 |
| 内存 | Node + rootfs 常驻约 150–300 MB | Node 基线 + 单文件 bundle |
| 冷启动到可对话 | 目标 < 8s | 未实测 |

> 这些数字**不是结论**，是待真机测量的假设。ADR 要求：阶段 3 的第一件事就是在真机上量这四项，
> 达不到就回头改方案（例如把 rootfs 从 Ubuntu 换成更小的 Alpine + glibc 兼容层）。

---

## 6. 验证状态（**部分验证**）

本机 Android SDK 现状（2026-10-31 本轮已补齐 emulator）：

```text
platform-tools 37.0.1 / build-tools 35.0.0 / platforms 34,35,36  ✅
emulator（WHPX 10.0.26300 可用）                                  ✅ 本轮安装
system-images;android-35;google_apis;x86_64                      ✅ 本轮安装
NDK                                                              ❌ 未安装（交叉编译到 Android 才需要）
```

已在**真实 Android 15 模拟器**上验证（`packages/host/scripts/spike-android.mjs`）：

- [x] 模拟器启动、`adb` 可用、系统版本可读（Android 15 / API 35）；
- [x] 手机侧 Chromium 通过 `10.0.2.2` 访问宿主机 Host，页面加载成功；
- [x] 页面显示「已连接」、会话标题与种子消息（截图见 `evidence/spike-android-emulator.png`）。

仍**未验证**（不假装通过）：

- [x] **真 Android WebView 外壳**（手写 APK，无需 Gradle）：页面加载共享 UI、连上 Host、
  一轮工具调用 + 最终答复（`docs/architecture/evidence/spike-android-shell.png`，
  判据 SH1–SH5 见 `SPIKE-REPORT.md` §5；复跑 `npm run android:build && npm run android:spike`）
- [x] 手机侧**发 prompt 并收到答复**（selftest 由外壳用 `selftest` extra 触发，绕开 `adb input` 的限制）
- [ ] ~~`adb input` 的文本没有进入 WebView 的 `<textarea>`~~（已由外壳自测入口绕过，不再阻塞）
  （uiautomator 只看到占位文字），因此这一步在模拟器上没跑通；
  同一链路在桌面 Chromium（Spike C）已完整跑通，所以缺的是"模拟器输入自动化"，不是协议。
- [ ] PRoot 在真机上的 exec 链路（W^X 规避）—— 需要 Kotlin 壳 + `jniLibs` 打包，本轮未做；
- [ ] Node arm64 在 PRoot 里的启动时间/内存 —— 同上；
- [ ] `codem-db` arm64 二进制的实际运行 —— 本机无 Linux 执行环境（且**不使用 WSL**）；
  已有替代证据：源码可移植性（`codem-db` 无 `cfg(windows)` 分支、仅 `rusqlite bundled` 等纯可移植依赖）
  + 交叉编译检查（当前因缺 `aarch64-linux-gnu-gcc` 失败，见 `SPIKE-REPORT.md` §2.3）。

**解除剩余 blocked 的前置条件**：
1. 一台 arm64 真机（`adb` 可连）—— 唯一能证明 PRoot/Node 性能的路径；
2. 交叉编译工具链（CI 上 `gcc-aarch64-linux-gnu` 或 `cargo-zigbuild`）—— 证明 arm64 二进制可构建。

---

## 7. 明确不做

- 不在手机本地跑 Windows/PowerShell 工具链（`bash` 工具在 Android 上映射到 PRoot 里的 bash）；
- 不做"手机当 PC 的从节点"（那是 ADR-0003 的远程模式，数据仍在 PC）；
- 不把 Tauri Android 目标当捷径（现有 Rust 壳的 117 个命令与窗口逻辑没有 Android 形态）；
- 不用 WSL/虚拟机作为**用户侧**或**开发侧**的运行时前置。

### 6.1 设备内 Host 已验证（2026-11）

在 x86_64 模拟器上跑通：PRoot（Termux proot + Ubuntu 24.04 base）→ Node 22 →
静态 `codem-db`（musl）→ `codem-host` → WebView，全部在设备内。
判据 DH-1..5 见 `SPIKE-REPORT.md` §6；复跑 `npm run android:prepare && npm run android:spike:ondevice`。

同时产出 **arm64 交叉编译二进制**（`aarch64-unknown-linux-gnu`，Docker + `gcc-aarch64-linux-gnu`），
解除 B-2/B-3 的构建阻塞；但**未在 arm64 真机运行**，性能与 W^X 打包仍未验证（B-1 保留）。

### 6.2 自包含 APK（阶段 3 终态，已通过）

**形态**：单个 APK（x86_64 71.8 MB / arm64 70.8 MB）里带 PRoot + Ubuntu rootfs + Node 22 +
静态 `codem-db` + Host + 共享 UI。安装后**首次启动自解压**，随后在本机起 Host，WebView 连 `127.0.0.1`。
**不需要 adb、不需要电脑、不需要额外配置。**

实现要点（都在 `android-shell/`）：
- 可执行文件放 `lib/<abi>/lib*.so`（nativeLibraryDir，系统解出可执行），首启复制到 `files/bin` 并 `+x`；
  数据（rootfs/Host/UI/共享库）走 `assets/`，首启用**纯 Java tar 解析**（含 PAX 头与 padding）解到 filesDir；
- `targetSdk=28`：Android 10+ 对 targetSdk≥29 禁止 app 数据目录 exec / ptrace 子进程，PRoot 依赖这两件事
  （与 Termux 同一取舍，代价是不能上架 Play；本项目 sideload）；
- Ubuntu base 不带 `libstdc++`：随 APK 带 `libstdc++.so.6`，首启放进 guest 的 `usr/lib/<triplet>/`；
- 首次启动用 PRoot 跑一次 `codem-db` 写欢迎会话（原生执行静态 musl 在 app seccomp 下会 SIGSYS，
  PRoot 下正常）；随后起 Host。

**判据** `android-shell/spike-selfcontained.mjs`（SC-1..5，全绿）：
安装 → 首启解压并起 Host → `session.list` 含「欢迎使用 Codem」→ WebView 在前台 → 截图
（`evidence/spike-android-selfcontained.png`、`…-session.png`）。

**仍未做**：arm64 真机（B-6）；Play 上架不在目标内；升级时保留用户数据（当前 `pm clear` 才会重置）。

### 6.3 手机端的可用闭环（2026-11 补齐）

自包含 APK 之后，手机端还缺三件事才"能用"，本轮补齐：

1. **模型服务配置**：启动页可填「服务地址 / API Key / 模型名」，存 SharedPreferences，
   起动 Host 时透传 `CODEM_LLM_BASE_URL` / `CODEM_LLM_API_KEY` / `CODEM_LLM_MODEL`；
   也支持 `--es llmBase/llmKey/llmModel` 注入（自动化用）。
2. **新建会话**：协议新增 `session.create`（Host 运行时 + 服务端 + 传输 + 移动端按钮），
   不再只能看欢迎会话。
3. **深链打开会话**：`launchMode=singleTop` + `onNewIntent` + `pendingUrl` 竞争保护，
   `am start --es url http://127.0.0.1:8787/?open=<id>` 对已在前台的实例也能生效。

判据 `LT-1..5`（SPIKE-REPORT §8）：配置启动 → 新建会话 → 真实回合（工具调用 + 答复）→ 会话页截图。

**仍未做**：桌面端把 Host 作为 sidecar 拉起 + 远程默认常驻（D-4）、bash 工具与审批、
`session_events.seq` 续传、单写者租约——见 `GAP-ANALYSIS.md`。
