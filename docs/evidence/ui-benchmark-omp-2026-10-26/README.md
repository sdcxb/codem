# UI benchmark：OMP Studio vs Codem（2026-10-26）

本批截图只证明**视觉/布局/组件形态**，不证明功能等价。

## 来源

- OMP Studio：`https://github.com/the-snowpear/omp-studio`，`main` @ `6c823154963451074a36feb4cfd992cb7bf2e021`，`package.json` 0.1.10。
  - 用仓库自带的 **renderer harness**：`apps/renderer/preview-app-harness.html?preview=1&route=...&theme=...&density=...&lang=zh`。
  - 数据是 fixture（页面有「演示」标记）；DOM / CSS / 组件是生产 renderer 的真实实现。
  - Edge headless 1600×1000，DPR 1。
- Codem：本机安装版 1.16.330，隔离数据副本（`CODEM_DATA_HOME` 指向 `C:\temp\codem-ui-bench\data`），WebView2 CDP 9223。
  - 1600×1000；WebView2 实际 DPR 2（原图 3200×2000，本目录压到 1200 宽）。
  - 默认皮肤 dark / light；Hub / 梦幻皮肤各一张。

## 文件

| 文件 | 内容 |
|---|---|
| `omp-workbench-dark.jpg` | OMP 工作台：三栏 + 右 Changes + 底部 OMP Logs + Composer |
| `omp-settings-dark.jpg` | OMP 设置：整页、左侧 8 分区、右侧分组行 |
| `omp-cmdk.jpg` | OMP 命令面板（Ctrl+K） |
| `omp-model-menu.jpg` | OMP 模型角色菜单 |
| `codem-main-dark.jpg` | Codem 默认皮肤 dark 主界面 |
| `codem-light.jpg` | Codem 默认皮肤 light 主界面 |
| `codem-settings-dark.jpg` | Codem 设置弹窗（dark） |
| `codem-cmdk.jpg` | Codem 搜索/命令弹窗（Ctrl+K） |
| `codem-model-menu.jpg` | Codem 模型下拉（免费模型列表） |
| `codem-hub.jpg` | Codem Hub 皮肤 |
| `codem-dream.jpg` | Codem 梦幻皮肤 |

## 复现

```powershell
# OMP：仓库根 npm install && npm run build:packages
# npm run dev -w @omp-studio/renderer -- --port 5174
# 打开 http://[::1]:5174/preview-app-harness.html?preview=1&route=workbench&theme=dark&density=standard&lang=zh

# Codem：安装版 + CDP
$env:CODEM_DATA_HOME='C:\temp\codem-ui-bench\data'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
Start-Process "$env:LOCALAPPDATA\Codem\codem.exe"
```

> 注意：OMP 的 `preview-app-harness.html` 是本地 fixture 入口，不是打包产品；截图里的「演示」标签就是证据。Codem 的截图来自真实数据副本，但只用于 UI 对照，不作为功能验证。

## 体量

11 张 JPEG，约 0.58 MB；符合 `docs/evidence` 单批 ≤3 MB、总量 ≤10 MB。
