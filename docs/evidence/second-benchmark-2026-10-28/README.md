# 二次视觉对标取证（2026-10-28）

本批只证明**几何与观感**（正文列 / Composer 宽度、右栏、正文排版），不证明功能等价，
也不证明「像素级复制」——三方分辨率与缩放口径不同，见下面的「怎么读」。

- 基线：`master`，Codem **1.16.330**（安装版，非 dev server）
- 采集日：2026-10-28（本机 Windows，1280×720 屏，WebView2 DPR 3）
- 相关计划：`docs/project-guide/16-SECOND-VISUAL-UPGRADE-PLAN.md`（本批就是它的证据区）

## 文件与「这张图证明了什么」

| 文件 | 尺寸 | 证明了什么 |
|---|---|---|
| `html-1400.png` | 1400×875 | HTML mock 在 1400×875 @1x 的排版基准：正文列 732、Composer 732、右栏 360。**判定「Codem 差多少」的分子分母都来自这张。** |
| `codem-1400.png` | 4200×2205 | Codem 安装版在 CDP 9223 下的**原始物理截图**（1400 CSS × DPR 3）。只用于证明「CSS 视口 1400 但物理 4200」这个口径，不用于像素比对。 |
| `codem-1400-normalized.png` | 1400×735 | 上一张归一化到 CSS px 的结果（**与 HTML 同口径**，用来量正文/Composer 宽度差）。 |
| `omp-real-1280.png` | 1280×672 | OMP 实机（从源码运行的 Electron 43.4.0）客户区，证明它在本机是 **1280×672 CSS @DPR3**，与 Codem 的物理窗口一致。 |
| `omp-real-ui-1280.png` | 3840×2016 | 同一 OMP 实机的工作台界面（preview harness，页面带「演示」标记）。用来纠正「OMP 是 1600 设计、Codem 1280」这个误判。 |
| `omp-reference-075.jpg` | 1200×750 | OMP 参考图批次（1600×1000 渲染后压到 0.75×）。**不能**与本机 Codem 1400 CSS 直接 1:1 比。 |

## 怎么读（三个口径，别混）

- **HTML mock**：1400×875 **@1x**（CSS px 就是像素）。
- **Codem**：CSS 视口 1400×735（1280 物理屏 + webview zoom），**DPR 3** ⇒ 原始截图 4200×2205，
  比之前必须归一化到 CSS px。
- **OMP**：参考图是 1600×1000 harness 的 0.75×；**实机**是 1280×672 @DPR3。
  0.75 是参考批次的压缩比，不是 OMP 独有。

结论口径：三方一律换算到 **CSS px** 再比；清晰度不可直接比（渲染像素密度不同）。

## 复现

```powershell
# 1) HTML mock：Edge headless 按 1400×875 渲染（@1x）
msedge --headless --disable-gpu --screenshot=html-1400.png --window-size=1400,875 `
  "file:///<repo>/docs/design/ui-benchmark-mock.html"

# 2) Codem：安装版 + CDP（隔离数据副本，别碰用户主库）
$env:CODEM_DATA_HOME='C:\temp\codem-ui-bench\data'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
Start-Process "$env:LOCALAPPDATA\Codem\codem.exe"
# Playwright connectOverCDP('http://127.0.0.1:9223') → 截图 4200×2205 → 归一化到 1400×735

# 3) OMP 实机（源码 C:\temp\omp-studio，不属仓库）
Remove-Item Env:ELECTRON_RUN_AS_NODE   # 本机全局为 1，不清会以 Node 模式启动
$env:OMP_RENDERER_DEV_URL='http://127.0.0.1:5173/preview-app-harness.html?preview=1&route=workbench&theme=dark&density=standard&lang=zh'
electron.exe C:\temp\omp-studio\apps\desktop --remote-debugging-port=9333
```

DOM 读数（不要靠肉眼估）：`document.querySelector('.messages-container')` 与输入卡的
`getBoundingClientRect().width` 就是表里的 718 / 777 / 732。

## 归档说明（2026-10-28 审计）

三张 PNG（`codem-1400.png`、`codem-1400-normalized.png`、`omp-real-ui-1280.png`）
在 **2026-10-28 全量审计**里做过一次 256 色量化（无损几何，体积约 −65%），
为的是让 `docs/evidence` 总量回到 10 MB 棘轮以内（判据 `EV-BUDGET-2`）。
量化只改调色板，不改尺寸与布局像素 ⇒ 上表所有 CSS px 读数依然成立。

**带 sha256 的三张**（`html-1400.png` / `omp-reference-075.jpg` / `omp-real-1280.png`）
**未改动**，`16-SECOND-VISUAL-UPGRADE-PLAN.md` 里记录的哈希仍然对得上。
