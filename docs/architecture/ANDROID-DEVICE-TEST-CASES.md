# Android 真机操作用例（设备内 Host / 共享 UI）

> 执行环境：Android 15（API 35）x86_64 AVD（Windows 11 本机）。
> 自动化入口：`npm run android:test:device`（`android-shell/run-device-cases.mjs`）。
> 每次执行的机器可读结果：`docs/architecture/evidence/device-cases-report.json`；
> 最终界面截图：`docs/architecture/evidence/device-cases-final.png`。

## 0. 前置

1. `npm run android:build`（产出 `android-shell/build/codem-shell-x86_64.apk`）；
2. 模拟器已启动（`ANDROID_SDK_ROOT` 指向 SDK）；
3. 自动化会在设备上**清空应用数据**后从冷启动开始，不依赖上一次的状态。

所有“页面操作”都是设备 WebView 里真实的 DOM 事件（点击/输入/发送），
不是用 RPC 代替用户操作；RPC 只用来核对 Host 的真实状态。

## 1. 用例

| ID | 操作步骤 | 期望 | 自动化判据 |
|---|---|---|---|
| **DC-1** 冷启动 | 安装 APK → `pm clear` → 带 `llmBase` 启动 | 设备内 Host 在 180s 内 READY | `host.hello` 返回 `hostId` |
| **DC-2** 共享 UI | 等 WebView 加载 | 页面标题 `Codem Remote`，正文含「新建会话」 | DOM 标题 + `body.innerText` |
| **DC-3** 新建会话 | 页面点「＋ 新建会话」 | Host 会话数 +1 | `session.list` 数量增加且新 id 出现 |
| **DC-4** 发消息跑一轮 | 点输入框 → 输入 `hello device` → 点「发送」 | 真跑一轮：工具卡（glob）+ 最终回答 `DEVICE_DONE` | 运行 `succeeded`，DOM 含 `DEVICE_DONE` 与 `glob` |
| **DC-5a** 审批卡出现 | 输入 `please run bash` → 发送（模型请求 bash） | 页面出现审批卡，显示工具名 `bash` 与 `echo DEVICE_OK` | DOM `.decision-tray` 文本（第 3 步起审批卡与桌面共用同一张卡；旧手机卡 `.approval` 已删） |
| **DC-5b** 批准并执行 | 点审批卡「批准」 | 命令**真的执行**：`exit 0` + stdout `DEVICE_OK`，无 stderr | DOM 匹配 `(exit 0` 且不含 `cannot open shared object` |
| **DC-5c** 卡片清理 | 答复后观察 | 审批卡消失 | DOM 无 `.decision-tray` |
| **DC-6a** 继续出现 | 上一轮正常结束 | 出现「继续」按钮 | DOM 含「继续」 |
| **DC-6b** 点击继续 | 点「继续」 | 才发下一轮（新 `runId`），不自动续跑 | `runId` 变化且 `succeeded` |
| **DC-7** 深链打开 | `am start --es url …?open=<id>` | 页面打开指定会话（标题可见） | DOM 含会话标题 |
| **DC-8** 杀进程重启 | `force-stop` → 重新启动 | 会话仍在（数据持久化） | `session.list` 仍含该 id |
| **DC-9** 无崩溃 | 全程 | `logcat -b crash` 为空 | crash buffer 为空 |
| **DC-10** 退到后台 | 按 HOME 后等待 8s | 设备内 Host 仍存活（前台服务 + 唤醒锁） | `host.hello` 成功 + `dumpsys activity services` 含 `KeepAliveService` |
| **DC-11** 文件浏览/预览 | 点「文件」→ 打开 `index.html` | 文件弹层列出工作区，点文件出只读预览 | `.file-browser:not(.inline) .file-browser-preview` 含 `<html`/`<!doctype` |
| **DC-12** 宽屏双列 | 视口 900×800 | 侧栏与对话同时可见 | 两者 `getComputedStyle().display` 均非 `none` |
| **DC-13** 宽屏三列 | 视口 1200×800 | 第三列可见、有文件行、**默认停在「文件」页签** | `.detail-pane` 非 none + `#detail-panel-files .file-entry`>0 + 选中 tab 文本=「文件」（只数行会在 diff 页签激活时假通过） |
| **DC-14** 附件全链路 | `attachment.put` → `prompt.send`（引用附件） | 模型收到附件内容、工作区出现 `.codem-attachments` | 回合回执含 `ATTACHMENT_OK` 且 `workspace.list` 含该目录 |
| **DC-15** 手机窄屏不变 | 视口 599×800（未选会话） | 看列表、聊天区不占位、**没有折叠入口** | `.sidebar`=`flex`、`.chat-pane`=`none`、`.sidebar-collapse-toggle` 不存在 |
| **DC-16** 平板列表可折叠 | 视口 900×800 → 点会话进入 → 点「收起列表」→ 再点「列表」；随后回 599 复查 | 侧栏 `display:none` 且列表仍在 DOM（不丢滚动/搜索）；恢复后可见；599 行内会话下按钮不可见 | `.sidebar` display + `.layout.sidebar-collapsed` + 按钮文案「列表」；599 下按钮 `display:none`/不存在 |
| **DC-18** 变更页签 | 1200px 点「变更」 | 只读列表或诚实空态，无回滚按钮 | tab selected + 文案，DOM 无回滚 |
| **DC-17** 第三列切换 | 视口 1200×800 → 选中一个文件 → 点「差异」→ 返回清空选择 → 点「去选择」 | 显示该文件的 diff（或明确的"不是 git 仓库/没有未提交改动"）；清空后回「先选文件」空态；「去选择」回文件页签 | `#detail-panel-diff` 文本 + `#detail-panel-files` 的 `hidden` + 二次空态文案 + `aria-selected` 回「文件」 |

## 2. 本用例集抓到的真实缺陷（已修）

**DC-5 第一版是假通过**：断言只查 DOM 里有没有 `DEVICE_OK`，而命令回显本身就含这串文字，
于是 **bash 实际 `exit 127`（缺 `libtinfo.so.6`）也被判成通过**。截图里能看到：

```
$ echo DEVICE_OK
(exit 127, 21ms)
--- stderr ---
/bin/bash: error while loading shared libraries: libtinfo.so.6: cannot open shared object file
```

修复两件事：

1. **产品缺陷**：Ubuntu base 不带 `libtinfo.so.6`，bash 起不来。APK 现在随包携带
   `libtinfo.so.6`（x86_64/arm64 各一份），由 `MainActivity.copyGuestLib` 放进 guest 的
   `usr/lib/<triple>/`；`build.mjs` 也把它列为必需资产。
2. **判据缺陷**：DC-5b 改为检查 `(exit 0` **且** 不含 `cannot open shared object`，不再被回显骗过。

修复后同一用例的截图（`device-cases-final.png`）：`(exit 0, 102ms)`、`--- stdout --- DEVICE_OK`。

## 3. 复跑

```powershell
$env:ANDROID_SDK_ROOT="C:\Users\abee\AppData\Local\Android\Sdk"
npm run android:build
npm run android:test:device
# 结果：docs/architecture/evidence/device-cases-report.json（ok=true 才算通过）
```

## 4. 与 SC/LT/RST 的关系

| 套件 | 关注点 |
|---|---|
| SC-1..5 | 自包含解压、设备内 Host、WebView 首屏 |
| LT-1..5 | 配置 provider 后真跑一轮 |
| RST-1..4 | 杀进程重启后的会话/事件序号持久化 |
| **DC-1..17（本文件）** | **按用户视角的真实操作顺序**（新建/输入/发送/审批/继续/深链/重启/后台/文件预览/两列三列/列表折叠/第三列切换/崩溃） |

四套互补；DC 是唯一覆盖**审批 UI、「继续」按钮、宽屏三列与平板列表折叠**的用例集。
