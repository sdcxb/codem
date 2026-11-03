# android-shell —— 自包含 Android 外壳

单个 APK 里带着 PRoot + Ubuntu rootfs + Node 22 + 静态 `codem-db` + `codem-host` + 共享 UI。
安装后首次启动自解压，随后在本机起 Host，WebView 连 `127.0.0.1`，**不需要电脑、不需要 adb push**。

## 构建

```powershell
# 前置：JDK 21、Android SDK（build-tools 35、platform 35）
# 前置资产（放在仓库根的 .android-proot/，已 gitignore）：
#   ubuntu-base-24.04.5-base-amd64.tar.gz / -arm64.tar.gz
#   node-v22.14.0-linux-x64.tar.gz / -arm64.tar.gz
#   proot / loader（Termux x86_64 与 aarch64 的 .deb，解出 bin/proot 与 libexec/proot/loader）
#   libtalloc.so.2、libandroid-shmem.so（x86_64 与 arm64 各一份）
#   libstdc++.so.6（Ubuntu 24.04 的 libstdc++6，x86_64 与 arm64 各一份）
#   codem-db：.linux-target/<target>/release/codem-db-cli（Docker 交叉编译，见 docs/architecture/ADR-0002）

npm run android:build          # x86_64（模拟器）
npm run android:build:arm64    # arm64（真机；只构建，未在真机验证）

# 产物：android-shell/build/codem-shell-<abi>.apk（约 71 MB）
# 调试版（spike 脚本需要）：node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk
```

## 验证

```powershell
# 自包含（模拟器）：安装 → 首启解压 → 本机 Host → session.list 有欢迎会话 → 截图
# 需要 debuggable APK（配置类 extras 只在 debug 构建生效）
node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk
npm run android:spike:selfcontained

# 设备内 Host（PRoot + Node + codem-db）就绪 + 端口转发后跑一轮 RPC
# （需要预先 prepare-device + 假模型；见 docs/architecture/SPIKE-REPORT.md §6）
node android-shell/prepare-device.mjs
node android-shell/spike-ondevice-host.mjs

# APK 内的完整回合（WebView 驱动）：npm run android:test:device
```

## 设计取舍

- `targetSdk=28`：Android 10+ 对 targetSdk≥29 禁止 app 数据目录 exec / ptrace 子进程，PRoot 依赖这两件事；
  代价是不能上架 Play（本项目 sideload）。
- 可执行文件放 `lib/<abi>/lib*.so`（安装时由系统解出），首启复制到 `files/bin` 并 `+x`；
  数据走 `assets/`，用纯 Java tar 解析解压（含 PAX 头与 padding）。
- 静态 musl 的 `codem-db` 在 app 进程的原生 exec 会 SIGSYS（seccomp），所以首次播种也走 PRoot。
- 详细背景见 `docs/architecture/ADR-0002-android-runtime.md`。
