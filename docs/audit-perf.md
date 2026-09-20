# Codem 性能审计 — 测量部分（只测量，不改源码）

- 仓库：`C:\mimo-gui`（Tauri v2 + React + Vite，应用名 Codem）
- 被测版本：**1.16.109**（`package.json:4` 与 `src-tauri\tauri.conf.json:4` 均为 `"version": "1.16.109"`，且该版本是 bundle 目录中最新的一份）
- 测量时间基准：本次会话（文件 mtime 见第 1 节）
- **单位说明**：本报告所有 `MB` 一律是 **MiB**（1 MB = 1,048,576 B）。所有 MB 由字节数 `/1MB` 得出，可自行复核。
- **方法说明**：全部为静态 / 构建产物测量，命令都为 PowerShell + 文件系统读取。**没有运行应用、没有起服务、没有插桩**，因此本报告不含任何耗时（ms）数字。
- **未修改任何被 git 跟踪的文件**：`git status --porcelain` 输出为空（干净工作树）。本报告写在 `.preview-shot\audit-perf.md`，该目录被 `.gitignore:107` 的 `.preview-shot/` 排除（`git check-ignore` 已确认命中）。

---

## 1. 安装包体积

| 产物 | 路径（相对仓库根） | 字节 | MB (MiB) |
|---|---|---:|---:|
| NSIS 安装包 | `src-tauri\target\release\bundle\nsis\Codem_1.16.109_x64-setup.exe` | 42,347,012 | **40.39** |
| MSI 安装包 | `src-tauri\target\release\bundle\msi\Codem_1.16.109_x64_en-US.msi` | 45,891,584 | **43.77** |

复核命令：

```powershell
Get-Item "C:\mimo-gui\src-tauri\target\release\bundle\nsis\Codem_1.16.109_x64-setup.exe" |
  Select-Object Name,Length,@{n='MB';e={$_.Length/1MB}}
```

**用的是哪个版本**：`1.16.109`。判定依据两条：
1. 目录里存在并排的 200 余个历史安装包（1.2.0 … 1.16.109）。按 `LastWriteTime` 排序，最新一份就是 `Codem_1.16.109_x64-setup.exe`（2026/9/20 0:16:43），MSI 侧同样是 `Codem_1.16.109_x64_en-US.msi`（45,891,584 B，与 1.16.91 起各版同尺寸）。
2. 与 `package.json:4`、`src-tauri\tauri.conf.json:4` 的当前版本号一致。

MSI 比 NSIS 大 3,544,572 B（+3.38 MB）。

### 1.1 安装包里装了什么（解释体积来源，补充项）

`src-tauri\tauri.conf.json:10` → `"frontendDist": "../dist"`，且 `bundle` 段**没有 `resources` 数组**（`tauri.conf.json:34-58`），所以安装包 = Rust 可执行文件 + 整个 `dist/`：

| 组成 | 路径 | 字节 | MB (MiB) |
|---|---|---:|---:|
| 主可执行文件 | `src-tauri\target\release\codem.exe` | 61,541,376 | 58.69 |
| 前端产物 | `dist\`（见第 2 节） | 86,957,709 | 82.93 |
| 合计（未压缩） | — | 148,499,085 | 141.61 |

`codem.exe` 的 mtime 是 2026/9/20 0:16:44，比 NSIS 安装包的 0:16:43 晚 1 秒，与"由这份二进制打出该安装包"一致。未压缩合计 141.61 MB → NSIS 40.39 MB，压缩比约 28.5%。

---

## 2. 前端产物体积

### 2.1 总量

| 指标 | 值 |
|---|---:|
| `dist\` 总字节 | 86,957,709 |
| `dist\` 总 MB | **82.93** |
| `dist\` 文件数 | 565 |

### 2.2 按文件类型汇总（整个 `dist\`）

| 扩展名 | 文件数 | 字节 | MB (MiB) | 占比 |
|---|---:|---:|---:|---:|
| `.wasm` | 1 | 23,567,050 | 22.48 | 27.1% |
| `.onnx` | 1 | 22,972,370 | 21.91 | 26.4% |
| `.js` | 432 | 22,940,163 | 21.88 | 26.4% |
| `.ttf` | 21 | 7,926,196 | 7.56 | 9.1% |
| `.webp` | 44 | 5,861,484 | 5.59 | 6.7% |
| `.mjs` | 2 | 1,302,456 | 1.24 | 1.5% |
| `.css` | 4 | 763,235 | 0.73 | 0.9% |
| `.json` | 5 | 725,119 | 0.69 | 0.8% |
| `.woff2` | 23 | 514,756 | 0.49 | 0.6% |
| `.woff` | 20 | 303,116 | 0.29 | 0.3% |
| `.png` | 1 | 64,889 | 0.06 | 0.07% |
| `.md` | 6 | 10,106 | 0.010 | 0.01% |
| `.txt` | 3 | 4,902 | 0.005 | 0.006% |
| `.html` | 2 | 1,867 | 0.002 | 0.002% |

### 2.3 按子目录汇总

| 子目录 | 文件数 | 字节 | MB (MiB) |
|---|---:|---:|---:|
| `assets\` | 501 | 26,354,890 | 25.13 |
| `models\` | 4 | 23,685,047 | 22.59 |
| `wasm\` | 2 | 23,614,439 | 22.52 |
| `fonts\` | 1 | 7,412,532 | 7.07 |
| `library-ops\` | 55 | 5,888,934 | 5.62 |
| （根文件） | 2 | 1,867 | 0.002 |

根文件：`dist\index.html` 1,304 B、`dist\pet.html` 563 B。

### 2.4 `dist\assets\` 明细

| 扩展名 | 文件数 | 字节 | MB (MiB) |
|---|---:|---:|---:|
| `.js` | 432 | 22,940,163 | 21.88 |
| `.mjs` | 1 | 1,255,067 | 1.20 |
| `.css` | 4 | 763,235 | 0.73 |
| `.woff2` | 23 | 514,756 | 0.49 |
| `.ttf` | 20 | 513,664 | 0.49 |
| `.woff` | 20 | 303,116 | 0.29 |
| `.png` | 1 | 64,889 | 0.06 |
| **合计** | **501** | **26,354,890** | **25.13** |

`assets\*.css` 全部 4 个：

| 文件 | 字节 | KB |
|---|---:|---:|
| `main-TiTDjayv.css` | 696,878 | 680.5 |
| `LibraryOpsViewShell-C3gv90X0.css` | 50,788 | 49.6 |
| `GameView-DHFtVkOd.css` | 14,663 | 14.3 |
| `pet-Cfpv2CYB.css` | 906 | 0.9 |

### 2.5 体积最大的 10 个产物

| # | 文件（相对 `dist\`） | 字节 | MB (MiB) |
|---:|---|---:|---:|
| 1 | `wasm\ort-wasm-simd-threaded.asyncify.wasm` | 23,567,050 | 22.48 |
| 2 | `models\Xenova\all-MiniLM-L6-v2\onnx\model_quantized.onnx` | 22,972,370 | 21.91 |
| 3 | `fonts\AlimamaFangYuanTiVF-Thin.ttf` | 7,412,532 | 7.07 |
| 4 | `assets\main-ClJRtI8l.js` | 4,953,091 | 4.72 |
| 5 | `assets\GameView-DKk_9Mrt.js` | 1,723,301 | 1.64 |
| 6 | `assets\pdf.worker.min-DEtVeC4l.mjs` | 1,255,067 | 1.20 |
| 7 | `assets\emacs-lisp-C_m_b--Z.js` | 790,007 | 0.75 |
| 8 | `assets\cpp-BMRokrvK.js` | 785,490 | 0.75 |
| 9 | `models\Xenova\all-MiniLM-L6-v2\tokenizer.json` | 711,661 | 0.68 |
| 10 | `assets\main-TiTDjayv.css` | 696,878 | 0.66 |

（第 11 位为 `assets\cynefin-VYW2F7L2-DC_a2Ube.js` 691,916 B，与第 10 位仅差 4,962 B。）

前 3 名合计 53,951,952 B = **51.45 MB**，占 `dist\` 的 62.0%。

复核命令：

```powershell
Get-ChildItem C:\mimo-gui\dist -Recurse -File | Sort-Object Length -Descending |
  Select-Object -First 10 @{n='rel';e={$_.FullName.Substring(21)}},Length
```

### 2.6 首屏 eager 载荷（补充项，用于判断"必须先解析多少 JS"）

`dist\index.html:22-24`：

- L22 `<script type="module" crossorigin src="/assets/main-ClJRtI8l.js"></script>`
- L23 `<link rel="modulepreload" crossorigin href="/assets/client-BIggfYms.js">`
- L24 `<link rel="stylesheet" crossorigin href="/assets/main-TiTDjayv.css">`

扫描入口 chunk `main-ClJRtI8l.js` 的相对静态 import 说明符（正则匹配 `from"./xxx.js"`），**只命中 1 条**：

| 组成 | 字节 | MB (MiB) |
|---|---:|---:|
| `assets\main-ClJRtI8l.js`（入口） | 4,953,091 | 4.72 |
| `assets\client-BIggfYms.js`（唯一静态依赖） | 145,549 | 0.14 |
| **eager JS 合计** | **5,098,640** | **4.86** |
| `assets\main-TiTDjayv.css`（`index.html:24` eager 引用） | 696,878 | 0.66 |

即：React 首次渲染前，WebView 必须先解析并执行 **4.86 MB JS + 0.66 MB CSS = 5.52 MB**。其余 400+ 个 chunk 都是动态 `import()`，不在 eager 图上。

（参考值，非传输量）以下为 gzip (`CompressionLevel::Optimal`) 压缩后大小，**仅作压缩比参考**：Tauri 生产环境从磁盘读资源，不走 HTTP 压缩，实际加载量就是上表的原始字节。

| 文件 | raw 字节 | gzip 字节 | 压缩比 |
|---|---:|---:|---:|
| `main-ClJRtI8l.js` | 4,953,091 | 1,532,141 | 30.9% |
| `main-TiTDjayv.css` | 696,878 | 111,389 | 16.0% |
| `GameView-DKk_9Mrt.js` | 1,723,301 | 396,967 | 23.0% |
| `wasm-CG6Dc4jp.js` | 622,336 | 231,159 | 37.1% |
| `transformers.web-Md4jBouO.js` | 572,918 | 166,122 | 29.0% |
| `pdf.worker.min-DEtVeC4l.mjs` | 1,255,067 | 371,078 | 29.6% |

---

## 3. 随包分发的大文件（> 1 MB，阈值 1,048,576 B）

### 3.1 `dist\` — 命中 6 个

| # | 文件（相对 `dist\`） | 字节 | MB (MiB) | 这是什么 / 依据 |
|---:|---|---:|---:|---|
| 1 | `wasm\ort-wasm-simd-threaded.asyncify.wasm` | 23,567,050 | 22.48 | ONNX Runtime Web 的 **SIMD + 多线程 asyncify** WASM 二进制。源码按路径引用：`src\core\knowledge\local-embedding.ts:153` → `wasm: '/wasm/ort-wasm-simd-threaded.asyncify.wasm'`；`local-embedding.ts:143-144` 注释说明"`@huggingface/transformers` v4 导入 onnxruntime-web/webgpu，该构建使用 asyncify 变体"。源文件在 `public\wasm\`。 |
| 2 | `models\Xenova\all-MiniLM-L6-v2\onnx\model_quantized.onnx` | 22,972,370 | 21.91 | 量化后的 **all-MiniLM-L6-v2 句向量（embedding）模型**。`src\core\knowledge\local-embedding.ts:134` 注释："默认模型 all-MiniLM-L6-v2（~22MB）放在 `public/models/`，随安装包打包"。源文件在 `public\models\`。 |
| 3 | `fonts\AlimamaFangYuanTiVF-Thin.ttf` | 7,412,532 | 7.07 | **阿里妈妈方圆体**可变字重中文 TTF（文件名即字体名 `AlimamaFangYuanTiVF-Thin`）。源文件在 `public\fonts\`。 |
| 4 | `assets\main-ClJRtI8l.js` | 4,953,091 | 4.72 | 应用**入口 chunk**（`dist\index.html:22` 直接引用，见 2.6）。 |
| 5 | `assets\GameView-DKk_9Mrt.js` | 1,723,301 | 1.64 | `GameView` 视图的按需 chunk（对应底部标签 `"game"`，`src\App.tsx:374` 的 `type BottomTab = ... \| "game"`）。 |
| 6 | `assets\pdf.worker.min-DEtVeC4l.mjs` | 1,255,067 | 1.20 | **pdf.js 的 worker**（文件名即 `pdf.worker.min`），PDF 解析用。 |

这 4 个最大项（wasm + onnx + 字体）**全部来自 `public\`**，即 Vite 原样拷贝、不经打包：`public\wasm\...`、`public\models\...`、`public\fonts\...` 三个源路径与 `dist\` 下同名同字节。

**一处刻意的去重**：`vite.config.ts:8-20` 有一个 `closeBundle` 插件 `remove-redundant-ort-wasm`，在打包结束时删除 `dist/assets/` 下的 `ort-wasm-simd-threaded*.wasm`（日志写死 `-22.5MB`）。实测吻合：`dist\assets\` 里**没有**任何 `.wasm` 文件（见 2.4 表），22.48 MB 的 wasm 只存在于 `dist\wasm\` 一份。若不删，`dist\` 会是约 105.4 MB。

### 3.2 `src-tauri\` — 必须区分"源码树"与"构建产物"

| 范围 | > 1 MB 文件数 | 合计 MB (MiB) | 说明 |
|---|---:|---:|---|
| `src-tauri\` 排除 `target\`、`node_modules\` | **1** | 1.75 | 唯一命中：`src-tauri\engine.log`（1,830,241 B）。这是一个**运行时日志文件**，不是分发内容 |
| `src-tauri\target\`（构建产物） | 10,316 | 60,929.28 | Rust 编译中间产物 + `bundle\` 下 200 余个历史安装包；不进安装包 |
| `src-tauri\codem-db\`（子 crate 构建产物） | 161 | 759.76 | 最大的是 `codem-db\target\debug\deps\libcodem_db-6a30b51cb41ac114.rlib`（32,249,152 B）；不进安装包 |

结论：`src-tauri\` 的**源码树本身没有任何 > 1 MB 的分发资源**。
- `src-tauri\binaries\` 只有 1 个文件 `server-x86_64-pc-windows-msvc.cmd`，**55 B**（是个 .cmd 垫片，不是大二进制 sidecar）。
- 没有 `src-tauri\resources\` 目录；`tauri.conf.json` 的 `bundle` 段也没有 `resources` 数组（`tauri.conf.json:34-58`），与"证据目录只有 `target\release\resources\icon.ico` 372,526 B"一致。
- 因此第 1 节里安装包的 82.93 MB 前端体积 + 58.69 MB 二进制，**没有额外的 src-tauri 资源贡献**。

复核命令：

```powershell
Get-ChildItem C:\mimo-gui\src-tauri -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\target\\' -and $_.FullName -notmatch '\\node_modules\\' -and $_.Length -gt 1MB } |
  Sort-Object Length -Descending | Select-Object FullName,Length
```

---

## 4. 源码规模

**计数方法（重要，否则数字对不上）**：用 `[System.IO.File]::ReadAllLines($f).Length`，即**统计全部物理行（含空行）**。

> ⚠️ 不要用 `Get-Content $f | Measure-Object -Line`：它**不统计空行**。同一个 `src\App.tsx`，该方法报 4,927 行，真实是 5,183 行（差 256 行 = 256 个空行）。本次审计先用错了方法，已改正，下面全部是 `ReadAllLines` 的结果。

| 范围 | 扩展名 | 文件数 | 总行数 |
|---|---|---:|---:|
| `src\` | `.ts` + `.tsx` | **1,151** | **295,016** |
| ↳ | `.ts` | 911 | 224,455 |
| ↳ | `.tsx` | 240 | 70,561 |
| `src-tauri\src\` | `.rs` | **13** | **7,230** |

按目录拆 `src\`：

| 目录 | 文件数 | 行数 |
|---|---:|---:|
| `src\core\` | 532 | 116,323 |
| `src\test\` | 343 | 98,741 |
| `src\components\` | 180 | 51,685 |
| `src\plugins\` | 72 | 19,717 |
| `src\hooks\` | 8 | 1,443 |
| `src\utils\` | 3 | 568 |
| `src\stubs\` | 6 | 284 |
| `src\lib\` | 1 | 10 |
| `src\types\` | 1 | 8 |
| `src\assets\`、`src\styles\` | 0 | 0（无 .ts/.tsx） |

`src\` 根文件：

| 文件 | 行数 |
|---|---:|
| `src\App.tsx` | 5,183 |
| `src\store.ts` | 960 |
| `src\main.tsx` | 52 |
| `src\pet-main.tsx` | 26 |
| `src\vite-env.d.ts` | 16 |

**扣除测试代码**：`src\test\` 98,741 行是测试，非测试源码为 295,016 − 98,741 = **196,275 行**（占 66.5%）。

`src-tauri\src\` 全部 13 个 `.rs`：

| 文件 | 行数 |
|---|---:|
| `src-tauri\src\lib.rs` | 2,900 |
| `src-tauri\src\phone\mod.rs` | 776 |
| `src-tauri\src\storage.rs` | 714 |
| `src-tauri\src\ilink\mod.rs` | 604 |
| `src-tauri\src\runtime_log.rs` | 497 |
| `src-tauri\src\ilink\proto.rs` | 474 |
| `src-tauri\src\ilink\login.rs` | 305 |
| `src-tauri\src\secret.rs` | 290 |
| `src-tauri\src\phone\http.rs` | 275 |
| `src-tauri\src\ilink\poll.rs` | 212 |
| `src-tauri\src\ilink\store.rs` | 142 |
| `src-tauri\src\phone\lan.rs` | 36 |
| `src-tauri\src\main.rs` | 5 |

前端/后端行数比 ≈ **295,016 : 7,230 ≈ 40.8 : 1**。

复核命令：

```powershell
$fs = Get-ChildItem C:\mimo-gui\src -Recurse -File | Where-Object { $_.Extension -in @('.ts','.tsx') }
$n = 0; foreach($f in $fs){ $n += [System.IO.File]::ReadAllLines($f.FullName).Length }
"files=$($fs.Count) lines=$n"
```

---

## 5. 启动路径上的同步 / 阻塞点（静态分析）

### 5.1 先给一个必须说清的结论：`await` 不阻塞 React 的首次提交

`src\main.tsx` **本身没有任何 `await`**：它是纯静态导入（`main.tsx:3-18`）+ 一次同步 `render`（`main.tsx:46`）。

`src\App.tsx` 里整条启动逻辑都包在 `useEffect` 的 async IIFE 中：

- `App.tsx:1517` → `useEffect(() => {`
- `App.tsx:1526` → `(async () => {`

`useEffect` 在 React 完成提交（commit）**之后**才执行，所以 **React 首次提交/首次绘制之前，await 数量为 0**。这些 `await` 阻塞的是：

1. **启动遮罩的关闭** —— 终点是 `App.tsx:1817` 的 `setBootSplashPhase("ready")`；
2. 所有依赖 `dbReady` / 存储域镜像的界面内容。

遮罩性质：`BootSplash` 是一个**不透明全屏覆盖层**，且与主界面**同级渲染、不包裹 children**：

- `App.tsx:4206-4211`：`<SlotBridge name="app.boot-splash" fallback={BootSplash} visible={bootSplashVisible} phase={bootSplashPhase} … onComplete={() => setBootSplashVisible(false)} />`（注意它是 `<div className="app">` 的第一个子节点，不是 wrapper）
- `src\styles\codem-ui.css:1763` 起，`.boot-splash` 规则：`position: fixed; inset: 0; z-index: var(--z-context-menu-top); background: var(--bg-primary);`（不透明背景色 + 铺满视口 ⇒ 主界面被完全盖住）

所以主界面首帧其实已经渲染在遮罩**之下**，但用户**看到**的第一屏是遮罩，且它一直盖到 `App.tsx:1817` 执行完（之后还有 `BootSplash.tsx:67-73` 的 300 ms 延时 + 400 ms 渐隐）。

**我量到的是代码顺序，不是耗时。** 我没有运行应用、没有插桩、没有 CDP，所以下面**没有任何 ms 数字**。

### 5.2 A 段：React 首次提交之前（真正的"首屏之前"的同步工作）

| # | 位置 | 那一行原文（摘要） | 类型 |
|---:|---|---|---|
| A1 | `index.html:15` | `var t = localStorage.getItem("codem-theme-cache");` | **同步读 localStorage**。同处注释 `index.html:10` 自述："这里同步读一份 localStorage 镜像，在**首屏渲染前**把 `data-theme` 设好"。这是全链路唯一的"首屏渲染前主动读存储"点，读的是 localStorage 镜像而非 SQLite，目的是避免主题闪烁 |
| A2 | `src\main.tsx:3-18` | `import "./stubs/process-polyfill";` … 共 6 条 polyfill / 样式 / CSS 静态导入（含 `@fortawesome/fontawesome-free/css/all.min.css`） | **同步 ESM 求值**。整张静态 import 图必须在 `render` 前执行完；`main.tsx:1-2` 注释说明了顺序约束（"必须最先导入"） |
| A3 | `src\main.tsx:46` | `ReactDOM.createRoot(document.getElementById("root")!).render(` | **同步首次提交**。此调用返回即完成首次渲染 |

A 段可量化的代价就是 2.6 节那两组静态资源：**eager JS 5,098,640 B（4.86 MB）+ CSS 696,878 B（0.66 MB）**。

另有 1 处在渲染期执行的同步调用（非 await，代价未量）：`App.tsx:424` → `setGlobalCwd(currentProject?.path || "");` —— 位于组件函数体（渲染阶段）内，是渲染期副作用。

### 5.3 B 段：`App.tsx` 启动 effect（`App.tsx:1517`–`1819`），按执行顺序

`await` 标记：✅ = await（阻塞遮罩关闭）｜🔄 = 同步（不 await）

| 顺序 | 位置 | 那一行原文（摘要） | 阻塞？ | 备注 |
|---:|---|---|---|---|
| B1 | `App.tsx:1528` | `const { registerRustStoragePort, importSettingsFromLegacyDb, migrateFromLegacyDb } = await import("./core/storage/bootstrap");` | ✅ | 动态 import |
| B2 | `App.tsx:1533` | `boot = await registerRustStoragePort();` | ✅ | **启动链上最重的一步**。内部 `bootstrap.ts:111` → `const health = await port.start();` 是真正的 IPC（打开引擎 + 健康快照 + 预热配置面） |
| B3 | `App.tsx:1552` | `await migrateFromLegacyDb();` | ✅ | 首次启动可能触发整库迁移（`replace: true`） |
| B4 | `App.tsx:1555` | `await (await import("./core/storage/bootstrap")).repairSearchIndexOnce();` | ✅ | 含 2 个 await；可能触发 `fts.rebuild_all` 全量重建搜索索引（`bootstrap.ts:525`） |
| B5 | `App.tsx:1557` | `await importSettingsFromLegacyDb("storage.settings-import", await (await import("./core/storage/bootstrap")).legacyDbPath());` | ✅ | 含 3 个 await（一次嵌套 `await legacyDbPath()`，其内部还会 `await getAppDataDir()` 走 IPC，`bootstrap.ts:756`） |
| B6 | `App.tsx:1569` | `const heal = await verifyUserContentOrRestore(await legacyDbPath());` | ✅ | 含 2 个 await；启动自检，可能从旧库恢复数据 |
| B7 | `App.tsx:1594`、`App.tsx:1597` | `p.warmupEvents?.([activeId]);` / `p.warmupMessages?.(activeId);` | 🔄 | **预热但不 await**（fire-and-forget，返回 `void`，见 `rust-port.ts:2210`/`rust-port.ts:2220`）。触发的 IPC 不阻塞遮罩 |
| B8 | `App.tsx:1603` | `applyStoredUiFont();` | 🔄 | **同步读设置 + 写 DOM**：`ui-font.ts:107-112` 内部是 `migrateLegacyFontKey()`（可能同步写设置）+ `readStoredUiFontPx()` + `applyUiFontScale(px)`。注释 `App.tsx:1600` 说明它必须在此刻（DB 就绪后）执行 |
| B9 | `App.tsx:1608` | `const { getSettingJSON, setSettingJSON, getSetting, setSetting } = await import("./core/storage/settings");` | ✅ | 动态 import |
| B10 | `App.tsx:1610` | `await migrateFromLocalStorage();` | ✅ | localStorage → SQLite 设置迁移（`migration.ts:127`） |
| B11 | `App.tsx:1611` | `setBootSplashPhase("loading-config");` | 🔄 | 遮罩文案推进到"加载配置" |
| B12 | `App.tsx:1612` | `ThemeManager.init();` | 🔄 | 同步：`theme-manager.ts:134` 签名为 `init(): void` |
| B13 | `App.tsx:1617` | `const savedDisplayMode = getSetting("codem-display-mode");` | 🔄 | **同步读设置**（内存镜像：`settings.ts:97-104` 读 `rustConfig().get(...)`，不抛、不 await） |
| B14 | `App.tsx:1635` | `const { prefetchDomainMirrors, HOT_DOMAIN_TABLES } = await import("./core/storage/bootstrap");` | ✅ | 第二次动态 import 同一模块（命中模块缓存） |
| B15 | `App.tsx:1636` | `const pf = await prefetchDomainMirrors();` | ✅ | **19 张热表**（`bootstrap.ts:324-344` 的 `HOT_DOMAIN_TABLES`）。**有界**：单表超时 `perTableMs` 默认 **1200 ms**、总超时 `totalMs` 默认 **2500 ms**（`bootstrap.ts:377-378`，`Promise.race` 在 `bootstrap.ts:428`）。即最坏情况这一步固定吃掉 2.5 s |
| B16 | `App.tsx:1658` | `useProjectStore.getState().loadFromDB();` | 🔄 | **同步读**，且这是把 `dbReady` 置 `true` 的唯一位置（`core\store.ts:92-96` 的 `set({ projects, dbReady: true, … })`）。所有 `dbReady` 门控的 effect（onboarding、model 同步、会话恢复）都在此之后才跑 |
| B17 | `App.tsx:1707` | `const { initDefaultSeams } = await import("./core/seam/types");` | ✅ | 动态 import |
| B18 | `App.tsx:1708` | `await initDefaultSeams();` | ✅ | 注册默认本地 provider |
| B19 | `App.tsx:1711` | `configureEngine();` | 🔄 | 同步。注释 `App.tsx:1709-1710` 说明它此前可能在 DB 就绪前跑过一次，故在此补跑 |
| B20 | `App.tsx:1728` | `const existingLang = getSetting("codem-language");` | 🔄 | **同步读设置** |
| B21 | `App.tsx:1733` | `const installerLang = await invoke("get_installer_default_lang");` | ✅（条件） | **IPC**。仅当 B20 读不到语言时才执行（`App.tsx:1729` `if (!existingLang)`） |
| B22 | `App.tsx:1745` | `const identity = loadAppIdentity();` | 🔄 | 同步：`config\loader.ts:289` 是 `export function loadAppIdentity()`，无 await |
| B23 | `App.tsx:1771` | `await loadInstalledPetsPets();` | ✅ | 桌宠资源 |
| B24 | `App.tsx:1772` | `await getPet().init();` | ✅ | 桌宠初始化 |
| B25 | `App.tsx:1779` | `const loaded = await loadInstalledSkills();` | ✅ | **读磁盘**：`skill\installer.ts:392` `export async function loadInstalledSkills()` |
| B26 | `App.tsx:1817` | `setBootSplashPhase("ready");` | 🔄 | **整条链的终点**。随后 `BootSplash.tsx:64-79` 先等 300 ms 再渐隐、400 ms 后调 `onComplete` 真正卸载遮罩 |

### 5.4 `src\core\storage\bootstrap.ts` 内部：被 `void` 掉的非阻塞派发

`registerRustStoragePort()` 内部有 3 处**刻意不 await** 的派发（所以它们不拖住 B2 返回）：

| 位置 | 那一行原文（摘要） | 是否阻塞 | 内部仍会发生什么 |
|---|---|---|---|
| `bootstrap.ts:139` | `void assertEngineSupportsCriticalCommands(transport, label);` | **不 await** | 内部 `bootstrap.ts:301` → `const caps = await rustCapabilities(transport);` 会**再发一次 IPC**（陈旧二进制守卫，校验 19 条必需命令 `bootstrap.ts:267-287`） |
| `bootstrap.ts:176` | `void import("./data-root")` | **不 await** | 后续链 `bootstrap.ts:177-226` 还会 `await import("./data-home-ledger")`、`await import("../file-api")`、`await getAppDataDir()`（IPC）、`await recordActiveDataHome(...)` |
| `bootstrap.ts:255` | `const { notifyStorageUnavailable } = await import("./health");` | ✅ 但在**失败路径** | 仅当引擎打开失败时执行 |

`prefetchDomainMirrors()`（`bootstrap.ts:373-436`）的内部结构：`bootstrap.ts:415-427` 为 19 张表各建一个 Promise（`domainEnsureLoaded(t, finish)` + `setTimeout(finish, perTableMs)`），`bootstrap.ts:428` → `await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, totalMs))]);`。

### 5.5 阻塞点计数（本报告的口径）

| 口径 | 数量 |
|---|---:|
| React 首次提交（首帧）**之前**的 `await` | **0** |
| `App.tsx` 启动 effect 里必须跑完才能关遮罩的 `await` **语句** | **16**（B1–B6、B9、B10、B14、B15、B17、B18、B21、B23、B24、B25；其中 B21 条件执行） |
| 上述 16 条内部还嵌套的 `await`（B4 内 1 条、B5 内 1 条、B6 内 1 条） | +3 |
| 被 `await` 的 `registerRustStoragePort()` 内部阻塞路径上的 `await`（`bootstrap.ts:111` `port.start()`） | +1 |
| **合计会阻塞"看到主界面"的 `await` 语句** | **17**（16 + 1；不计 3 条嵌套） |
| 刻意不 await 的派发（不阻塞） | 3（`bootstrap.ts:139`、`bootstrap.ts:176`、B7 的 warmup×2 记为 1 组） |
| 渲染期 / 启动链上的**同步**读设置或写 DOM | 5 处：`index.html:15`、`App.tsx:424`、`App.tsx:1603`、`App.tsx:1617`、`App.tsx:1728`（另有 B12 `ThemeManager.init()`、B22 `loadAppIdentity()` 为同步调用但不读设置） |
| 整条链上唯一的**硬性时间下限**（唯一带超时数字的步骤） | B15 `prefetchDomainMirrors()`：`perTableMs=1200`、`totalMs=2500`（`bootstrap.ts:377-378`） |

---

## 6. 没量到的部分（如实列出，原因明确）

| 没量到的东西 | 原因 |
|---|---|
| 真实首屏时间（FCP / 遮罩关闭耗时） | 任务要求只测量、不改源码、不装、不起服务。未运行应用、未插桩、无 CDP 会话。本报告 5 节只给**代码顺序与 await 标记**，不给 ms |
| A 段 / B 段每一步的实际耗时 | 同上。文件内也没有可读的启动耗时埋点（`App.tsx:1638` 会打印 `pf.ms`，但那需要运行应用才能取到） |
| 运行时内存占用、CPU 峰值 | 同上（未运行）。安装包/产物体积已量，但"体积 → 内存"不能靠静态推断，故不填 |
| 安装包内各文件的压缩后占比 | 未解包 NSIS/MSI（解包工具与 `7z`/`msiexec` 调用未执行，属"不改仓库"以外的额外动作，且非 5 项要求）。已量的是**未压缩**组成（1.1 节），可复核 |
| `dist\` 之外其它构建产物目录（如 `dist-server\`）体积 | 不在本次 5 项要求范围内，未测 |
| `src-tauri\target\` 的体积明细（60,929.28 MB > 1 MB 文件合计） | 已给出聚合值与最大文件，但未逐个列举 10,316 个文件（它们是编译中间产物，与分发无关） |

## 7. 全部结论的可复核性索引

| 结论 | 复核方式 |
|---|---|
| 安装包字节数 | `Get-Item <path> \| Select Length` |
| 版本 1.16.109 是当前版本 | `package.json:4`、`src-tauri\tauri.conf.json:4` |
| `dist` 总量 / 分类 / Top10 | `Get-ChildItem C:\mimo-gui\dist -Recurse -File` + `Group-Object Extension` + `Sort-Object Length` |
| wasm / onnx / 字体的用途 | `src\core\knowledge\local-embedding.ts:130,134,143-144,152-153`；文件位于 `public\wasm\`、`public\models\`、`public\fonts\` |
| wasm 去重插件 | `vite.config.ts:8-20`；验证 `dist\assets\` 无 `.wasm` |
| 行数统计方法 | `[System.IO.File]::ReadAllLines($f).Length`（**不是** `Measure-Object -Line`，见第 4 节警告） |
| 首屏 eager 图 | `dist\index.html:22-24` + 正则扫 `main-ClJRtI8l.js` 的相对静态 import |
| 启动顺序与 await | `src\App.tsx:1517-1819`、`src\main.tsx:1-52`、`src\core\storage\bootstrap.ts:74-436` |
| 遮罩是不透明全屏覆盖层 | `src\App.tsx:4206-4211`（同级渲染）+ `src\styles\codem-ui.css:1763` 的 `.boot-splash` 规则 |
| 热表 19 张 / 必需命令 19 条 | `src\core\storage\bootstrap.ts:324-344`（`HOT_DOMAIN_TABLES`，实测 19 项）、`src\core\storage\bootstrap.ts:267-287`（`CRITICAL_ENGINE_COMMANDS`，实测 19 项） |
| `dbReady` 的唯一置真点 | `src\core\store.ts:92-96`（由 `App.tsx:1658` 的 `loadFromDB()` 触发） |
| `getSetting` 是同步内存读 | `src\core\storage\settings.ts:97-104` |
| 本报告未改动被跟踪文件 | `git status --porcelain` 为空 |
