# 16 · 二次对标升级计划（OMP / HTML / Codem）

> 生成时间：2026-10-28。基线：master `b5609891`，Codem 1.16.330。
> 本计划不沿用第一轮结论；三方重新截图、重新量，再按差距排期。
> 纪律：每个数字带来源；测不到的写 unknown；不把「测试绿」当视觉完成。

---

## 0. 采集口径

> 修正（2026-10-28）：上一版把 OMP 的 0.75× 当成它独有，误推出「OMP 1600 / Codem 1280」。
> 实际 OMP 与 Codem 的参考批次**都是 1600×1000 渲染后压到 1200×750**；0.75 是共同的压缩比。
> OMP 没有在本机运行过（无安装/无进程），所以不存在「OMP 在这台电脑上的显示分辨率」。

| 对象 | 来源 | 渲染尺寸 | 落盘图 |
|---|---|---|---|
| HTML mock | `docs/design/ui-benchmark-mock.html`，Edge headless | 1400×875 @1x（另有 1280 断点） | 1400×875 |
| Codem | 安装版 1.16.330，CDP 9223，1280 屏 zoom 后 CSS 1400×735 | 1400×735 CSS，DPR 3 | 归一化到 1400×735 |
| OMP Studio | 本批参考图由 preview harness 渲染；**本机未安装、未运行** | 1600×1000 @1x | 1200×750（0.75×） |
| Codem（同批参考图） | 本批 `codem-main-dark.jpg` 等 | 1600×1000 @DPR2 | 1200×750（0.75×） |

证据：

- `docs/evidence/second-benchmark-2026-10-28/html-1400.png`（sha256 前 16：`8CEA8B95DA71F5C8`）
- `docs/evidence/second-benchmark-2026-10-28/codem-1400-normalized.png`（原图归一化）
- `docs/evidence/second-benchmark-2026-10-28/omp-reference-075.jpg`（sha256 前 16：`C2517E8ECB9DC199`）

三张图不能按 1:1 像素直接比：OMP 是 1600 设计缩到 1200；Codem 是 1400 CSS 渲染在 3× 物理像素。比较一律换算到 **CSS px**。

---

## 1. 三方几何（同口径 CSS px）

| 指标 | HTML @1400 | Codem @1400 | OMP @1600（设计值） |
|---|---:|---:|---:|
| 左栏 | 260 | 260 | 272 |
| 正文/内容列 | 732 | 718 | 848（列） |
| Composer | 732 | 777 | 约 748–751 卡宽 |
| 右栏 | 360 | 363（用户拖后） | 480 |
| 正文 | 14px / 23.8px | 14px / 23.8px | 14px 级 |
| 正文字体族 | Alimama + 中文回退 | Alimama + 系统回退 | 系统 UI |


### OMP 实机复核（2026-10-28）

已在本机从源码运行真实 Electron（`C:\temp\omp-studio`，0.1.12，Electron 43.4.0）：

| 项 | 实测 |
|---|---|
| 窗口客户区 | **1280×672 CSS** |
| outer | 1292×678 |
| DPR | **3** |
| 本机屏幕 | 1280×720，avail 1280 |

截图：`docs/evidence/second-benchmark-2026-10-28/omp-real-1280.png`（sha256 前 16：`B418A17C53BFE3BB`）。

因此要区分两件事：

- **OMP 参考图**来自 1600×1000 harness，压到 1200；
- **OMP 实机**在本机就是 1280×672 @DPR3，和 Codem 的物理窗口一致。

Codem 当前把 1280 屏 zoom 到 1400 CSS，OMP 是原生 1280 CSS；所以“实机显示密度”不能只按参考图的 1600 算。
### 已确认的硬差距

1. **Composer 比正文宽 59px**
   HTML：正文 732、Composer 732（同宽）。
   Codem：正文 718、Composer 777。
   Composer 仍按 `--reading-column`(780) 取宽，没有减去左右 24px gutter；这是「主对话区域显大」的直接来源之一。

2. **正文比 HTML 窄 14px**
   Codem 右栏 363 时可用列 777，减 48 gutter 后 729，再被滚动条占 11 ⇒ 718。HTML 无滚动条占位，732。
   需要把滚动条改成 overlay，或把 gutter 计入滚动条宽度。

3. **右栏宽度不是固定差异**
   Codem 可拖 300–800，HTML 固定 360，OMP 固定 480。不能直接判「谁对」，应比较默认值和断点：
   - >1440：Codem 默认 400；HTML 400。
   - 1281–1440：Codem 360；HTML 360。
   - <=1280：HTML 隐藏；Codem 折叠 24（用户确认保留小条）。

4. **Codem 的 1280 屏通过 zoom 模拟 1400**
   CSS 视口 1400×735，物理截图 3×。这是显示密度差异的来源：OMP 参考图是 1600 设计按 0.75 缩放；Codem 是 1400 CSS 按 3× 物理像素渲染，再归一化。两者清晰度不可直接比。

---

## 2. UI 差距（视觉）

| 区域 | HTML | Codem | 差距 | 优先级 |
|---|---|---|---|---|
| Composer 宽度 | 732 | 777 | 宽 59 | P0 |
| 正文列 | 732 | 718 | 窄 14 | P0 |
| 右栏默认 | 360 | 363 | 基本一致 | — |
| 右栏内容 | 最近一轮 +N/−N、检查、上下文、预览、footer | 最近一轮 +N/−N、预览、上下文、footer；无检查 | 缺检查 | P1 |
| 右栏组织 | 最新一轮平铺 | 按轮 accordion | 信息结构不同 | P1 |
| 设置复杂页 | 分区/卡片 | 独立业务组件卡片 | 非同一信息架构 | P2 |
| 左栏 | 260/32/30 | 260/32/30 | 已对齐 | — |
| 标题栏 | 44 | 44 | 已对齐 | — |

---

## 3. UX / 代码差距

| 维度 | HTML | Codem | OMP | 结论 |
|---|---|---|---|---|
| 交互 | 静态 | 真实 agent、工具、回滚、子代理 | 真实 Electron | Codem 功能最全，不能用 HTML 的静态布局硬套 |
| Composer 行为 | 无 | IME、chips、模型/推理、排队、停止 | 类似 | Codem 行为已覆盖 |
| 右栏检查 | 展示 checks | 无回合级 checks 数据 | 展示 checks | 需数据层扩展，不能 CSS 伪造 |
| 设置 | 静态分区 | 23 tab + 业务组件 | 8 分区 | 信息架构不同，不应强行同构 |
| 分辨率适配 | 1400/1280/900 断点 | 1280 zoom→1400；>1400 不缩 | 1600 设计 | Codem 增加 overlay 滚动条和 composer 宽度修正 |

---

## 4. 二次升级阶段

### Phase A（P0）：内容列与 Composer 同宽

- `--reading-column` 在 <=1440 为 780；正文内容列目标 732。
- Composer 改 `max-width: calc(var(--reading-column) - var(--reading-gutter) * 2)`。
- 滚动条 overlay（`scrollbar-gutter: stable both-edges` 或 overlay 方案），消除正文被占 11px。
- 验收：1400 CSS 下 `doc width == composer width == 732±2`；1280/1600 各一张截图。

### Phase B（P0）：右栏默认宽与断点

- >1440 默认 400；1281–1440 默认 360；<=1280 折叠 24。
- 清除旧的持久化 586 对比干扰，新增「重置宽度」入口。
- 验收：三档实测宽度；拖动后持久化；刷新不变。

### Phase C（P1）：Inspector 信息结构

- 从「按轮 accordion」改为 mock 的「最近一轮 + 历史轮次」：
  - 顶部：`最近一轮 +N −N · N 个文件`
  - 文件平铺 43px 行，路径 + M/A + 每文件 +/−（需要 patch 按文件拆分或扩展记录）
  - 本轮检查区块
  - 上下文、diff 预览、footer
- 数据前置：扩展 `turn_file_changes` 或新增 `turn_checks`；禁止占位假数据。
- 验收：真实会话中 checks 有数据时显示，无数据时明确「无检查记录」。

### Phase D（P1）：设置复杂页

- 单行设置继续 46px 行式。
- 知识/权限/Git/环境/宠物保持卡片，但统一：
  - 标题层级（13px/600）
  - 行内控件右缘 200px
  - 窄容器单列回退
- 验收：每个 tab 一张截图；无横向溢出、无 300px+ 嵌套组。

### Phase E（P2）：分辨率与字体

- 保持 14px 正文字号（与 HTML 一致）。
- 移除 `text-rendering: optimizeLegibility`（与 HTML 仅 antialiased 对齐）。
- 1080/125%/150% 三档截图；不得出现字体模糊或整页缩小后空白。

### Phase F（P2）：OMP 细节

- 右栏 480 宽档（大屏）单独截图，验证不挤压正文。
- OMP 的密度/间距差异只做「不破坏 Codem 功能」的折扣，不追求像素复制。

---

## 5. 验收门禁

每阶段必须同时满足：

1. `npx tsc --noEmit` = 0；
2. 相关测试 + 全量测试无新增红；
3. `npm run audit` exit 0；
4. 真实安装版截图（非浏览器注入）；
5. 证据文档记录 sha256、视口、DOM 读数、unknown。

---

## 6. 当前结论

- 三方不是同一分辨率/缩放：HTML 1400@1x、Codem 1400 CSS@3x、OMP 1600 设计@0.75。
- Codem 与 HTML 的字体、行高、左栏、标题栏已基本一致。
- 最大真实 UI 差距是 **Composer 777 vs 正文 718**，以及右栏 checks 数据缺失。
- 最大 UX 差距不是视觉，而是 Inspector 信息结构（按轮 accordion vs 最近一轮平铺）。

### 实机工作台已可见

在 Electron 43.4.0 中加载 `preview-app-harness.html?preview=1&route=workbench&theme=dark&density=standard&lang=zh`，OMP 真实 renderer 工作台已显示（fixture client，页面带「演示」标记）。

- 窗口客户区：1280×672 CSS
- DPR：3
- 截图：`docs/evidence/second-benchmark-2026-10-28/omp-real-ui-1280.png`
- 结论：OMP 在本机的真实显示就是 1280×672 @3x；1600×1000 只是参考图 harness 尺寸。