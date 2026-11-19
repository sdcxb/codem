# Android 模拟器验证（Batch 6B 续）

> **口径**：用户授权用**安卓虚拟机**验证。设备是 AVD `codem-x86`（x86_64 / API 35 / 1080×2400），
> 不是真机 —— 下面每条都标了「在什么上跑的」，不把模拟器结论冒充真机结论。

## 环境

| 项 | 值 |
|---|---|
| 模拟器 | AVD `codem-x86`（另有 `codem-arm64` / `codem-test` 未用） |
| ABI / API | x86_64 / 35 |
| 分辨率 | 1080×2400（≈412×915 CSS px） |
| adb | `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` |
| 首启状态 | 原 `emulator-5554` 只有 67 个系统服务（`pm`/`wm` 全挂）⇒ `emu kill` 后用 `-no-snapshot-load` 冷启 `emulator-5556`，290 个服务正常 |

## 结果一：桌面 Web UI 在 Android Chrome 里能起来（但缺 Tauri IPC）

在模拟器 Chrome 打开 `http://10.0.2.2:1420/?ui=v2`（宿主机静态服务）：

- 页面**正常渲染**：标题栏、`?ui=v2` 生效（琥珀主色、发丝线、28px 控件都正确）；
- 因为没有 `window.__TAURI__`，应用落进**首次引导**（`BootstrapWizard`：嘿，你好 → 继续），
  拿不到本地数据 —— 这不是移动端形态，只是"iOS/Android 浏览器打开桌面 Web 包"的兼容性观察；
- 截图：`.preview-shot/unslop/android/02-app.png`、`03-main.png`。

**由此抓到并修掉一条窄屏真问题**：标题栏窗口按钮（最小化/最大化/关闭）在 ≤768 时改成绝对定位后，
压住了右侧动作图标（齿轮与最小化叠在一起，截图里能直接看到）。
修法：`.titlebar-nav-actions` 在 ≤768 留出 `calc(var(--space-12) * 4 + var(--space-1) * 3)` 的占位。

## 结果二：Flutter 原生客户端能在模拟器上装起来并跑

`Codem-Mobile-1.1.0-x86_64.apk`（124 MB）→ `adb install -r` **Success** →
`am start -n io.codem.codem_mobile/.MainActivity` → 首页正常：

- 暗色主题、会话列表（3 条演示数据）、项目筛选 chip、`+ 新会话` 主按钮、底部三页签（会话/项目/设置）；
- 截图：`.preview-shot/unslop/android/04-flutter.png`。

**一致性发现（未改，需要决策）**：移动端用的是**靛蓝**强调色，与桌面 v2 的琥珀不是一套：

| | 桌面 v2 | 移动端（`mobile/lib/design/tokens.dart`） |
|---|---|---|
| accent | `#C6A15B` | `0xFF7C6CF0`（暗） / `0xFF6555E0`（亮） |
| pressed | `#B08E4B` | `0xFF6555E0` / `0xFF5546C8` |
| userBubble | accent 10% | `0x1A7C6CF0` / `0xFFF1EFFE` |

改成同一支琥珀只需改 `CodemPalette.dark/light` 的 3 个值，但**这台机器没有 Flutter SDK**
（`flutter` 不在 PATH，也没有独立安装）⇒ 改完无法重建 APK 验证 ⇒ 本轮**只记不改**。
需要时：装 Flutter 3.47+ → 改 tokens → `flutter build apk --release --target-platform android-x64`
→ 重跑本节的两条验证。

## 未做 / 限制

- **真机**（arm64 实体机）：仍 blocked，这台机器没有设备。
- `android-shell`（WebView + PRoot + 本机 Host）没有重跑：它打包的是 `packages/host/web` 那套 UI，
  与本次重构的 `src/` 桌面 UI 不是同一份代码；重跑需要完整的 `.android-proot` 资产与
  `codem-db` 交叉编译产物（Docker）。
- 模拟器上的桌面 UI 没有 Tauri IPC ⇒ 只能验证"样式与窄屏布局"，不能验证数据/交互。
