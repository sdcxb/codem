# Codem 全量测试与审计 · 移交单

> 交接时间：2026-10-28
> 基线：`master @ 88ada908`，版本 **1.16.330**
> 安装包：`src-tauri\target\release\bundle\nsis\Codem_1.16.330_x64-setup.exe`
> 本机：Windows，1280×720，WebView2 DPR 3；Codem 窗口 CSS 视口 1400×735（zoom）

---

## 1. 接手先看什么

按顺序：

1. 本文件（当前真实状态 + 全量审计计划）
2. `docs/project-guide/16-SECOND-VISUAL-UPGRADE-PLAN.md`（三方对标：OMP / HTML / Codem）
3. `docs/project-guide/15-VISUAL-REBUILD-PLAN.md`（第一轮视觉计划）
4. `docs/project-guide/09-CURRENT-STATE.md`（项目当前能力状态）
5. `AGENTS.md`（构建/测试/发布纪律；**禁止 goal mode**）

不要从旧交接 3000 行日志通读；用关键词检索。

---

## 2. 本轮已落地（可回滚点）

### 2.1 视觉/交互

| 项 | 结果 | 提交 |
|---|---|---|
| 正文列 / Composer | Composer 改为 `reading-column - 2*gutter`；1400 下 732 | `0498bca8` |
| 用户气泡 | 1.65 行高、78% 宽、右下 4px 尾巴 | `d1ff4aef` |
| Composer 静置边框 | OMP 同款 12% 白、16px 圆角；焦点紫色柔光保留 | `a544ffaf` |
| 右栏拖拽条 | 8px 命中区、2px 视觉线、默认透明、hover/拖动 accent-border | `f090f3cf` |
| 右栏 Inspector | 新增“改动/子代理”；+N −N、diff 预览、上下文、footer；空轮次隐藏 | `b41e8044` / `77b8ffb7` / `58a62ddf` |
| 设置行式 | 简单 label+控件组 46px；身份块双列；窄容器回退单列 | `d62418bb` |

### 2.2 功能修复

| 项 | 结果 | 提交 |
|---|---|---|
| 失败工具卡 | bash `exit 1` 原来 `data-state=ok`，现从 metadata/输出识别非零退出码 | `e9eb7fbb` |
| 改动页签空态 | App 显式传 `sessionId`/`workspace`，支持会话 projectId 反查 | `32c24fbc` |
| Shiki 主题 | `data-theme` MutationObserver | `88ada908` |
| WebView zoom | capabilities 增加 `core:webview:allow-set-webview-zoom` | `88ada908` |
| BOM | RightSidebar 被 PowerShell 写入 BOM，已无 BOM 重写 | 全量测试抓到并修复 |

### 2.3 对标证据

- `docs/evidence/second-benchmark-2026-10-28/`
  - `html-1400.png`
  - `codem-1400-normalized.png`
  - `omp-reference-075.jpg`
  - `omp-real-1280.png`
  - `omp-real-ui-1280.png`
- OMP 实机：Electron 43.4.0，客户区 **1280×672 CSS，DPR 3**，与 Codem 物理环境一致。
- OMP 源码：`C:\temp\omp-studio`（0.1.12，已 apply overlay；不属仓库）。
- 启动 OMP 真界面的方式：
  ```powershell
  # 1) renderer dev server
  npm run dev -w @omp-studio/renderer -- --host 127.0.0.1 --port 5173 --strictPort
  # 2) 清掉 ELECTRON_RUN_AS_NODE（本机全局为 1，会以 Node 模式启动）
  Remove-Item Env:ELECTRON_RUN_AS_NODE
  $env:OMP_RENDERER_DEV_URL='http://127.0.0.1:5173/preview-app-harness.html?preview=1&route=workbench&theme=dark&density=standard&lang=zh'
  electron.exe C:\temp\omp-studio\apps\desktop --remote-debugging-port=9333
  ```
  该入口是 OMP preview harness（fixture client，页面有“演示”标记），不是托管 Runtime。

---

## 3. 当前门禁状态（必须如实继承）

**最近一次全量（第 233 轮审计第六轮收尾，2026-10-28 15:0x）**：

```text
760 test files / 8637 passed / 17 skipped / 0 failed
tsc 0
npm run audit exit 0（上报点 278 = 278）
cargo test -p codem-db → 63 + 93 + 2 + 2 全绿
vite build → main-*.js 2.70 MB / main-*.css 551 KB（本轮起点 4.76 MB / 648 KB）
  其中 KaTeX 255 KB + katex.css 29.5 KB 已切成按需 chunk（有公式才下载）
真机 A/B（同机 3 次中位，production build）：first-paint 388→176ms、FCP 488→280ms
```

接手时的原始状态（同一天更早，**3 条红**，见 §11.1）：

```text
737 test files / 8532 passed / 17 skipped / 3 failed   ← docs/evidence 超限 + 缺 README + UI 一致性 2 条
tsc 0
npm run audit exit 0（旧提交）
```

那 3 条红已在第 233 轮修掉（§11.2 的 B1/B2/B3），随后又修了 §11.6 的 B9–B15（含 P0 两条）。此后只改了 CSS/测试（Composer 边框、拖拽条、气泡、Composer 宽度、身份块），并跑了：

```text
tsc 0
ui-benchmark-construction 20 passed
css-integrity / style-token-gates 通过
```

新会话**仍然必须重跑全量**，不要直接引用这里的 8581（本轮改动了存储/技能/知识库/记忆/回滚五条主链，见 §11.5 / §11.6 的文件清单）。

---

## 4. 未提交/未跟踪（不要误提交）

```text
 M .gitignore              # rich4-renew-ref 忽略项，用户侧改动
 M .jscpd.json             # 同上
?? .edge-ref-profile*/     # 浏览器临时 profile
?? .edge-shot/            # 临时截图
?? art/ prototype/ docs/ref-analysis/  # 用户资料/临时产物
```

这些**不是本轮 UI 改动**；除非用户明确要求，不要打包进提交。

---

## 5. 已知未完成 / 不要谎报

1. **Inspector “本轮检查”**
   - mock 有 TypeScript/单测/构建三行。
   - `TurnFileChangeRecord` 没有 checks 字段；当前没有回合级数据源。
   - 要做必须扩展存储（或独立 `turn_checks` 表），禁止写死假状态。

2. **设置复杂 tab**
   - 知识/权限/Git/环境/宠物是独立业务组件，仍为卡片式。
   - 简单设置组已行式化；复杂面板不应强行套 46px。

3. **视觉差异**
   - HTML 1400 与 Codem 1400 仍有 14px 正文差（滚动条占位）。
   - OMP 1600 参考图与 Codem 1400 不能 1:1 比；实机 OMP 1280 才是同环境。

---

## 6. 全量审计目标（本轮交接的核心）

用户要求：**功能、性能、UI/UX 交互、数据链、功能上下游、模型/智能体调度、存储、记忆，全量测试与审计；发现 bug 不论新旧都修；修完再审计，直到无已知 bug。**

建议按层推进，不要只跑测试。

### L0 基线冻结

- [ ] `git status` 干净（除用户资料）
- [ ] 三处版本号一致：`package.json` / `tauri.conf.json` / `Cargo.toml`
- [ ] `npx tsc --noEmit` = 0
- [ ] `npx vitest run` 全绿
- [ ] `npm run audit` exit 0
- [ ] 安装版能启动、能发一条真实消息、能取消、能完成

### L1 功能主链（P0）

- [ ] 新建对话 → 发消息 → 流式 → 工具调用 → 完成
- [ ] 工具失败（bash exit 1）→ 失败卡显示 error，不显示“任务完成”
- [ ] 停止 → 状态 stopped；历史可恢复
- [ ] 附件/图片/`@` 文件/chips
- [ ] 模型切换、推理等级、上下文水位
- [ ] 设置保存后重启仍生效
- [ ] 项目切换 / 会话切换 / 删除 / 恢复
- [ ] 右栏文件预览、编辑保存、diff、回滚
- [ ] 子代理任务列表（有/无任务两种空态）

### L2 数据链（P0）

- [ ] 消息 JSONL 权威副本 ↔ SQLite 索引一致
- [ ] 会话删除后 FTS/事件日志/附件无孤儿
- [ ] `turn_file_changes` 的 path/status/patch 与工作区一致
- [ ] 回滚：只回滚目标轮、失败不半写
- [ ] 导出/导入脱敏
- [ ] 数据库 WAL 并发下不锁死、不丢写
- [ ] 迁移/备份/恢复路径

### L3 模型 / 智能体调度（P0）

- [ ] 单会话并发发送不会串消息
- [ ] 取消能杀工具进程树（Windows Job Object）
- [ ] 子代理 spawn / 完成 / 失败 / 取消
- [ ] 委派任务跨会话不丢结果
- [ ] 工具权限/审批拒绝路径
- [ ] 重试、超时、LLM 失败不伪装完成
- [ ] 上下文压缩前后消息完整

### L4 存储 / 记忆（P0）

- [ ] 记忆写入、检索、删除、容量满
- [ ] 知识库/笔记本读写
- [ ] 技能安装/发现/加载/卸载
- [ ] 插件安装/启停/权限
- [ ] 大文件/长会话不 OOM

### L5 性能（P1）

- [ ] 冷启动到可输入
- [ ] 1000 条消息滚动帧率/内存
- [ ] 长工具输出折叠
- [ ] 右栏 diff 大 patch 不卡死
- [ ] 设置页 23 tab 切换无累积泄漏
- [ ] 后台任务/定时器在切页后清理

### L6 UI/UX（P1）

- [ ] 1280 / 1440 / 1600 三档
- [ ] 100% / 125% / 150% 缩放
- [ ] 键盘：Tab 顺序、Enter/Space、Esc、焦点环
- [ ] IME 组合/提交
- [ ] 空态/错误态/加载态/禁用态
- [ ] 深/浅色 + 三套皮肤
- [ ] 右栏拖动 300–800、折叠 24
- [ ] 气泡/Composer/设置行与 HTML 代码值一致

### L7 稳定性 / 安全（P1）

- [ ] 断网、401/429、超时
- [ ] 路径穿越、命令注入、权限提升
- [ ] 凭据不落日志/不导出
- [ ] 崩溃后会话可恢复
- [ ] 更新器签名/回滚

---

## 7. 审计执行方式（建议）

1. **静态审计**：`npm run audit`、`tools/audit/*`、全量 grep 上报点/未接线文件。
2. **测试审计**：全量 vitest；对每个失败先单跑确认是否并行抖动。
3. **真机审计**：安装版 + CDP 9223，真实数据副本；截图/日志入 `docs/evidence/`。
4. **对数据审计**：只读副本上跑 SQL/JSON 对账，不碰用户主库。
5. **修复纪律**：先写判据（能变红）→ 修复 → 变异自证 → 真机验证 → 全量复跑。
6. **每轮结束**：更新本文件“当前门禁”和“已知问题”，不要只写在聊天里。

### 必跑命令

```powershell
npx tsc --noEmit
npx vitest run
npm run audit
```

构建/安装：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri\codem-updater.key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
node node_modules\@tauri-apps\cli\tauri.js build
Start-Process "src-tauri\target\release\bundle\nsis\Codem_1.16.330_x64-setup.exe" -ArgumentList '/S' -Wait
```

CDP：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
Start-Process "$env:LOCALAPPDATA\Codem\codem.exe"
# Playwright connectOverCDP('http://127.0.0.1:9223')
```

---

## 8. 已知坑（会浪费时间的）

1. **PowerShell 写文件**
   - `Set-Content -Encoding UTF8` 会写 BOM，`BOM-1` 全量测试会红。
   - 用 `[IO.File]::WriteAllText(path, text, New-Object Text.UTF8Encoding($false))`。
2. **Electron**
   - 本机全局 `ELECTRON_RUN_AS_NODE=1`；启动 OMP 前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`，否则报 `BrowserWindow` 不存在。
3. **CDP**
   - Codem 9223；OMP 9333。不要连错。
4. **截图分辨率**
   - Codem 页面 CSS 1400，但截图物理 4200×2205；比较前归一化。
   - OMP 参考图 1200×750 是 1600 harness 的 0.75×；OMP 实机 1280×672。
5. **测试抖动**
   - 全量并行偶发计时失败；先单跑，确认不是并行抖动再改。
6. **禁止 goal mode**
   - 本项目明确禁止目标模式/自动续跑；一次把事做完，用 todo 清单。

---

## 9. 建议的新会话开场

> 读 `docs/audit/FULL-SYSTEM-AUDIT-HANDOFF.md` 和 `docs/project-guide/16-SECOND-VISUAL-UPGRADE-PLAN.md`。  
> 先复跑 tsc/全量/audit 建立基线，然后按 L1→L4→L2/L3→L5→L6 顺序做全量审计；每发现一个 bug 先写判据再修，修完复跑。不要改字体族，不要动底栏，不要用 goal mode。

---

## 10. 本轮结论

- 视觉重做 0–6 阶段已完成到“有真实数据”的程度；唯一缺的是 Inspector checks 数据源。
- 最后一次全量是绿的，但此后有 CSS-only 改动，**新会话必须重跑**。
- 三方对标的关键纠正是：OMP 实机 1280×672 @3，参考图 1600 harness；Codem 实机 1280 物理屏 zoom 到 1400 CSS。

---

## 11. 第 233 轮：全量审计第一轮（2026-10-28 上午）

### 11.1 基线复跑（接手第一件事，**上一次的绿不能引用**）

| 门禁 | 接手时（原样） | 现在 |
|---|---|---|
| `npx tsc --noEmit` | 0 | **0** |
| `npx vitest run` | **3 failed**（见下） | **742 files / 8560 passed / 17 skipped / 0 failed** |
| `npm run audit` | 0（旧提交上） | 见 §11.5（本轮改动后重跑） |

接手时那 3 条红都是**上一轮 CSS/取证改动留下的真回归**，不是抖动：

1. `docs-evidence-budget` EV-BUDGET-2：`docs/evidence` 10.73 MB > 10 MB 上限；
2. 同文件 EV-BUDGET-4：新批次 `second-benchmark-2026-10-28` 没有 `README.md`；
3. `ui-consistency`：error 级违规 2 条（`focus-outline-none` + `css-class-cross-file`）。

### 11.2 本轮修掉的 bug（每条都先有能变红的判据）

| # | 缺陷 | 判据（新增/既有） | 修法 |
|---|---|---|---|
| B1 | `docs/evidence` 超体量棘轮；新批次无 README | `docs-evidence-budget.test.ts`（既有） | 三张**未被文档 sha256 锚定**的 PNG 做 256 色量化（−65%，几何像素不变）；补 `README.md` 写清版本/口径/复现/每张图证明什么 |
| B2 | `.right-sidebar-resize-handle` 在两个基础样式表各定义一次，后加载的 `codem-ui.css` **静默覆盖** `styles.css`：命中区偏 1px，且拖动时整条 8px 被涂成实心 accent、盖住新做的 2px 线 | `right-sidebar-resize-keyboard.test.ts` RSH-1/1b + `ui-consistency` | 删掉 `codem-ui.css` 里的旧定义块（该文件第 51 波就立过"基属性只写一次"的规矩）；`css-contract` 快照显式 `--write`（diff 只有 `left: -3px → -4px`） |
| B3 | 该拖拽条**只能鼠标拖**：`div` 无 `tabIndex`、`role=separator` 无 `aria-value*`、`:focus-visible { outline: none }` 无替代环 | 同上 RSH-2/3/3b/3c/4 | 抽成 `RightSidebarResizeHandle`（可聚焦、方向键 ±16（Shift ±64）、Home/End 到底、`preventDefault` 防滚动、焦点环用 `--focus-ring-*`）；hook 增加 `resizeBy/resizeTo`（夹紧 + 落盘，与拖拽收尾同一路径） |
| B4 | **消息里的外部链接是死链**：`MessageBubble` 把所有 `<a>` 都交给 `handleFileLinkClick`（`preventDefault`），而 `openFileLink` 里 http/mailto 分支写在 `resolveFilePath` 之后 —— 后者对 URL 返回空串 ⇒ `if (!absPath) return` 提前返回 ⇒ 点网址毫无反应（那段分支是死代码） | `message-link-open.test.ts` LNK-1/2 + 反向对照 LNK-3/3b | 外部 URL 在**路径解析之前**分流到 `openExternalUrl`（`plugin:shell|open` → v1 全局 → `window.open` 三级兜底） |
| B5 | **技能名 = 目录穿越（P0）**：`skill.name` 直接拼 `<技能根>\<name>`，而名字来自 ZIP 的 `SKILL.md` 或市场条目、零校验；`isSafePath` 只校验 ZIP **内条目**。`name: ..\..\..\evil` 即可写技能根之外（Rust `write_file` 在 `workspace=None` 时不做沙箱判定）。卸载侧 `checkDeleteTarget` 只做词法比较、不折叠 `..` ⇒ 也能删到根之外 | `skill-name-traversal.test.ts` SKN-1/2/3/5（+ 反向对照 SKN-4/6） | 新增 `isSafeSkillName()`（单一目录段；允许中文）；在 `installSkillFromZip`、市场两条安装路径、`checkDeleteTarget` 三处接线 |
| B6 | **重新索引先删旧块再算 embedding** ⇒ embedding 失败（未配置/限流，属常态）就**清空既有索引**，且失败分支不改 `chunk_count`（界面继续显示旧块数，检索返回空 = 假陈述）；`reindexSource` 还在开始前就把 `chunkCount` 归零 | `knowledge-reindex-no-data-loss.test.ts` IDX-1/2/2b（+ 反向对照 IDX-3） | 删除点移到"embedding 全部到手之后"（与 `addChunksBulk` 紧邻、中间无 await）；`reindexSource` 不再预设 0 |
| B7 | **孤儿附件清理会把恢复后的唯一副本删掉（P0）**：库损坏重建只重放 messages/tool_calls（不含 attachments），日志里 `file:` 标记也不落；于是 `attachments.externalized` 返回**权威的空清单** ⇒ `referenced=∅` ⇒ 把 `<dataRoot>/attachments/` 全删 | `attachment-prune-safety.test.ts` ATT-P1/2/3/4 | `pruneOrphanAttachmentFiles` 加硬闸门：清单为空而目录有文件 ⇒ **拒绝清理**并回报跳过数量与原因（`.tmp` 仍清）；代价是"用户真的删光附件"时文件留到下次，取舍写进注释 |
| B8 | 权威 JSONL 的三条写入失败（追加消息 / 消息墓碑 / 会话墓碑）只 `console.warn` ⇒ 用户不可见：消息只在索引里、删掉的消息/会话会"复活" | `report-site-classification` 的 RPT 闸门（3 个新上报点必须登记）+ 既有 `authority-first-storage` / `session-tombstones` | 三处 catch 改走 `reportPersistFailure`（不抛、但可见并写清后果）；登记表补 3 条（`round: 233`）并把 `_counts` 现算（273 = 273） |

变异自证：B5/B6/B7/B4 的判据**在修复前实测为红**（红→绿即变异证据）；B2/B3 另外做了三次显式变异（把旧 CSS 块加回、去掉 `tabIndex`、把焦点环改回 `outline:none`），各自对应的判据立刻变红。

### 11.3 第二轮接着修掉的（B9–B15）

> §11.3 原来那张"未修清单"里的 7 条已在本轮修掉（见下），剩下的列在 §11.7。每条都是**先写判据 → 实测红 → 修 → 绿**（B9 另外做了显式变异）。

| # | 缺陷 | 判据 | 修法 |
|---|---|---|---|
| B9 | **（P0）索引重建后附件正文不可达**：`messages_rebuild_index` 不重放 attachments，日志也不带指针 ⇒ 文件还在、没人知道它属于谁 | `attachment-log-recovery.test.ts` ATT-REC-1/2/3（ATT-REC-2 变异验证：让 `findExternalFileByAttachmentId` 恒 undefined ⇒ 立刻红） | 新增 `findExternalFileByAttachmentId()`（文件名 `<safeId>-<safeName>` 里就带 id）＋ `getAttachmentContent` 的第三条路径（索引未命中时按 id 扫附件目录、补标记回缓存），并加 `__resetAttachmentContentCacheForTests` 让判据能模拟"进程重启后缓存为空" |
| B10 | **（P1）图谱全批失败会清空旧图**：`deleteGraphData()` 在 LLM 循环之前 | `knowledge-graph-no-wipe-on-failure.test.ts` GR-10/11/12 | 改成"第一批真正抽到东西之后才清库"（`clearedExistingGraph`）；全批失败 ⇒ 一次都不清，旧图原样保留 + warnings |
| B11 | **（P1）记忆 `[[key]]` 跨作用域展开**：只在全库按 key 找第一条，不看 project/session ⇒ 项目 A 的条目会把项目 B 的正文拉进上下文 | `memory-link-scope.test.ts` MEM-LINK-1/2/3 | `resolveLinks(entry, ctx?)` 的目标筛选加 `visibleIn(target, ctx)`；`formatLine` / `renderBlocks` / `computeInjection` 把作用域上下文一路带下去（注入与渲染两条路径同一口径） |
| B12 | **（P1）删会话残留**：`session_fts`（虚拟表无级联，`fts.delete_session` 全仓零调用者）与 `delegation_tasks`（无 FK/触发器）都不清 ⇒ 搜索命中已删会话、委派页签指向已删会话 | `session-delete-index-residue.test.ts` DEL-FTS-1/2、DEL-DEL-1 | `deleteSession` 成功分支补 `purgeSessionIndexResidue()`：发 `fts.delete_session` + 两条 `crud.delete`（source/target），失败走 `reportPersistFailure`（不阻断删除） |
| B13 | **（P2）导出脱敏漏上下文形状**：只取值形状 ⇒ 私钥块 / `password=` / `Bearer …` 原样导出；键名也只认单数 | `export-redaction-shapes.test.ts` EXP-RED-1…6 | 新增 `CREDENTIAL_REDACT_RES`（**上下文形状在前**，避免 `token=sk-…` 被计成两个凭据）；键名补复数与 cookie；键名命中时容器内所有叶子都脱敏 |
| B14 | **（P2）`revert()` 假成功**：`Remove-Item … SilentlyContinue` 的 exitCode 不看、`updateStatus` 0 行只 warn ⇒ "已回滚"是假的 | `file-change-revert-residue.test.ts` REV-1/2/3 | 清理失败计数并 `reportPersistFailure`（列出前 3 个路径）；状态未写回同样上报（仍是 persist、不改成 false —— 补丁确实打回去了） |
| B15 | **（P2）编辑器逐键全文高亮**：每个 `content` 变化同步跑一次 `codeToHtml`（不可中断） | 既有 `renderer-robustness-a`（22 例）；无独立判据（属性能，见 §11.7 说明） | 停手 150ms 再去抖高亮；超过 2 万字符直接降级纯文本 |

**顺带要如实说的两处既有判据调整**（不是"为了让测试变绿"而放宽，理由写在这里）：

1. `message-session-event-fix.test.ts` FIXB-8c：断言从"删会话只发 1 条 `crud.delete`"改成"按**表**过滤后会话那条只有 1 条" —— 因为 B12 新增了两条 `delegation_tasks` 补偿清理；**被断言的内容没变**（`confirmBulk ⇒ confirm_bulk`、非交互路径不带）。
2. `credential-shape-false-positive.test.ts` FP-3 在 B13 中一度变红（`token=sk-…` 被两条形状各计一次 ⇒ 计数 2）。修法是**调整形状顺序**（上下文形状先跑），不是改断言。

### 11.7 第三轮：清单已清空（B16–B22）

> §11.7 原来那 7 条**全部修掉**（含 3 条 P1 性能/数据链 + 4 条 P2），每条都先有能变红的判据。下面附实测数字与判据名。

| # | 缺陷 | 判据 | 修法与实测 |
|---|---|---|---|
| B16 | **（P1）bash 改的工作区完全不进 `turn_file_changes`**：`mutatesWorkspace` 只认 `sideEffectScope==="workspace"`，而 bash 是 `system` ⇒ 纯 shell 改动零记录，还会被算进**下一轮**（对下一轮回滚会撤销上一轮产物） | `shell-mutation-snapshot.test.ts` SNAP-1…5 | 新增 `needsPreCallSnapshotForCall(toolName, contract, args)`：契约判据 + **命令意图**（`analyzeBashCommand`）＋**验证类命令白名单**（`npx vitest`/`tsc --noEmit`/lint **不算改动**，否则每次跑判据都多拍一次 git 且变更列表全是噪音）＋ 只在「工具本身是 shell」且 `system` 作用域时生效 |
| B16b | 连带修：**取快照失败会让工具整条不执行**（原来 `await ensureSnapshot()` 裸等，存储未就绪/git 不可用就抛到工具 try/catch 之外） | `red-test-at-completion` VU-2（实测：修前 3 轮、修后 4 轮） | 包 try/catch + `reportActionFailure("loop.preCallSnapshot")`（登记表 278 条）：工具照常执行，只少一份回滚证据 |
| B17 | **（P1）`DiffViewer` 的 diff 是 O(m·n) DP + 逐行 `unshift`（O(L²)），且没有渲染上限**（5000 行两侧 ≈ 2500 万格） | `diff-viewer-large.test.tsx` DV-BIG-1/2/3、DV-CAP-1 | 先剥**公共前后缀**（结果逐行等价，判据 DV-BIG-3 反向对照）⇒ 5000 行改 1 行的耗时从秒级降到 **< 5ms**（判据卡 500ms）；`unshift`→`push+reverse`；上限从「总行数 5000」改成「中间段格数 4M」；unified/split 各加 **400 行渲染上限 + 显式截断说明** |
| B18 | **（P1）流式每 flush 付 O(n²)**：每行 `displayMessages.slice(i+1).some(...)`；`onDeleteFiles` 是 inline 箭头 ⇒ `MessageBubble`（memo）**每行必重渲染** | `chat-streaming-suffix.test.tsx` STREAM-1…4 | 新增 `computeHasAssistantAfter()`（一次后缀扫描，2 万行 < 100ms，判据 STREAM-2）+ `useStableMessageHandlers()`（每行按 id 缓存**同一函数引用**，判据 STREAM-4） |
| B19 | **（P2）「找出相似重复」O(n²)·全文重算**：每对都重新规范化 + 重建 2-gram 集合 | `memory-duplicate-scale.test.ts` DUP-P1/2/3 | 每条只算一次 bigram（key / 合并串各一份）+ **精确上界预筛**（`min/max` 低于阈值就整对跳过，不会漏真命中，判据 DUP-P3）；**800 条 2185ms → 305ms**，分组结果与旧实现逐组相同（DUP-P1） |
| B20 | **（P2）`rebuild_fts` 的孤儿清理在三值逻辑下失效**：`NOT IN (SELECT id … hidden=0)` 只要有一行 `id IS NULL` ⇒ 谓词恒 NULL ⇒ **一行孤儿都不删**且 `orphans_removed` 安静报 0 | Rust `migrate::tests::rebuild_fts_orphan_cleanup_is_null_safe`（**变异自证**：改回旧 SQL ⇒ 红，`{"indexed":0,"orphans_removed":0,"skipped_null_id":1}`） | 改成 `NOT EXISTS (...)`（对 NULL 免疫）；`cargo test -p codem-db` **63+93+2+2 全绿** |
| B21 | **（P2）快照复用缓存只按 workspace 作键**：子代理与父会话同 cwd ⇒ 互相借用 before/after，两条记录重叠/互缺（回滚越界） | `file-change-snapshot-session-isolation.test.ts` FCS-S1/2/3（FCS-S1 是"同会话仍要复用"的反向对照） | 键改成 `workspace\0sessionId`；既有 `file-change-snapshot-reuse` 的播种钩子同步加 `sessionId` 形参（3 条判据仍绿） |
| B22 | **（P2）冷启动**：`CodeBlockView` 引 `Prism`（非 Light）⇒ Prism 全语言包静态进主包 | `code-block-bundle.test.tsx` COLD-1…4 | 换 `PrismLight` + 新增 `prism-languages.ts`（**27 种语言** + 别名归一；未注册语言降级纯文本、不抛）；`vite build` 产物里 `main-*.js` 已**不含** `abap`/`verilog`/`brainfuck`，`refractor/lang`（**0.83 MB**）不再进包 |

**仍然没做（明确判断，不是遗漏）**：无。第三轮结束时 §11.5 列的三项（`ScrollbarMarkers` 逐条量矩形、启动时序、主包分包）已在第四轮做完（B23–B26）。剩下的是"真机计时/进一步分包"这类**需要另一套验证手段**的工作，见 §11.8。

### 11.8 第四轮：把 §11.5 列的三项也做完（B23–B26）

| # | 缺陷 | 判据 | 修法与实测 |
|---|---|---|---|
| B23 | **（P1）`ScrollbarMarkers` 每 flush 强制整列布局**：`calculatePositions` 依赖 `[messages]`，流式每 100ms 换一次数组身份 ⇒ 每条 user 消息 `querySelector` + **两次** `getBoundingClientRect`；带 `content-visibility:auto` 的屏外行被读到就要现算布局 | `scrollbar-markers-layout.test.tsx` SBM-1/2/3 | 引入**内容坐标缓存**：集合签名不变（流式追加）时只用 `contentTop / totalHeight` 重算百分比 ⇒ **零布局读取**；每条只读一次 rect（同时得位置与可见性）；度量用 rAF 合并。实测 **410 次 → 0 次**（20 回合 ×10 flush） |
| B24 | **（P2）首帧被材质探测拖住**：`await Promise.race([探测, sleep(400)]); renderApp()` ⇒ IPC 慢就白屏最长 400ms | `startup-material-hint.test.ts` START-1/2/3（新模块 `core/boot/material-hint.ts`） | 抽成 `startWithMaterialHint({probe, render, limitMs=60})`：60ms 内回来仍"属性先落地、再渲染"（不闪实色），超时**先渲染**、探测后台继续；渲染只发生一次 |
| B25 | **（P2）启动屏"就绪"后还吃点击约 700ms**：只有 `.fading-out` 才 `pointer-events:none`，而就绪→渐隐有 300ms 停顿 + 400ms 过渡 | `boot-splash-click-through.test.tsx` SPLASH-1/2/3 | `.boot-splash.ready { pointer-events: none }`（就绪立刻放行点击）+ 停顿 300→**120ms**（整段遮挡 700→520ms） |
| B26 | **（P2）主包 4.76 MB**：`SettingsPanel`（4129 行 / 199 KB）等四个"点开才用"的模态面板静态进主包 | `code-block-bundle.test.tsx` COLD-5/6 | 四个面板改 `lazy()` + 统一 `<Suspense fallback={null}>` 边界；`vite build` 实测 **4.76 → 4.35 MB**，`SettingsPanel-*.js` 独立成 **298 KB** chunk |

**本轮同时把 3 条"钉实现文本"的既有判据改成钉语义**（都写了理由，语义断言反而更严）：
`REG-FULL-001b`（ScrollbarMarkers 的"按全内容比例"）、`APPEARANCE-6`（档位先于首帧）、`NATIVE-1`（材质探测接进启动器 + 顶层无 await）。

> **其中 `REG-FULL-001b` 升级时确实**丢了一条**保护**（原来还要求 `contentTop` 由「rect.top − scrollerRect.top + scrollTop」算出来，重构后那行代码形状变了），所以本轮补了一条**行为判据** `SBM-4`：给三条消息固定的内容坐标（0/5000/9000px，总内容 10000px），断言渲染出的标记 top ≈ 0% / 50% / 90%。**变异自证**：把实现改回 `contentTop / viewportHeight` ⇒ SBM-4 立刻红（0/100/100），而纯文本断言是抓不到这种回退的。也就是说：这三条判据的改动**净收益为正**，但"改判据"这个动作本身必须配一条新的行为判据才算数 —— 否则就是"把测试改成描述现状"。

### 11.9 第五轮：把 §11.8 的三项"需要另一套手段"也做完（B27–B30）

| # | 缺陷/欠账 | 判据 | 做了什么 + 实测 |
|---|---|---|---|
| B27 | **（P2）首帧/可交互时刻从没在真机上量过**：jsdom 没有 paint、`vite build` 只证明体积、渲染侧 console 一退出就没 | `boot-timings.test.ts` BOOT-T-1…5（命令名/参数/单行格式/`n/a` 不补 0/两帧后才读） | 新增 `src/core/boot/boot-timings.ts`：启动屏进入 ready 时**两帧之后**读 `performance.getEntriesByType("paint")`，经既有 `log_renderer_event` 通道落盘（`%APPDATA%\com.codem.app\codem-runtime-*.log`）。实测落盘行：`[SAMPLE] renderer boot first-paint=196.0 fcp=296.0 ready=1194.8 origin=…` |
| B28 | **（P2）主包 4.35 MB 里还有大片"点开才用"的代码**：终端（xterm 370KB）、文件列表、8 个弹窗、以及全仓只有 5 个图标的 FontAwesome（CSS 90KB + 字体 119KB） | `code-block-bundle.test.tsx` COLD-5/6（面板必须 lazy + 有 Suspense 边界） | 第二批 11 个 + 第三批 10 个面板改 `withSuspense(lazy(...))`（新增 `components/withSuspense.tsx`：边界焊在组件上，**打开设置不再整块空白** —— 第一版用 App 级 Suspense 时子代理分析指出这是真实交互缺陷）；FontAwesome 5 个图标换 lucide（并按仓库口径改成语义类 `.icon-*` + `<Spinner />`，没有抬高 `ICON-1`/`COND-2` 基线）。**main 4.76 → 2.94 MB（−38%）**，`TerminalPanel` 独立成 5.2KB CSS + 独立 chunk |
| B29 | **（P2）「找出相似重复」在 1500–5000 条规模上仍然冻界面**：同步 O(n²)，5000 条 ≈ 12s | `memory-duplicate-scale.test.ts` DUP-P4…P8（截断披露 / 上限内不截断 / 与同步版同结果 / 进度回调 ≥2 / 可取消） | 新增 `clusterDuplicateMemoriesChunked`（每 2 万对让出主线程）+ `MEMORY_DUPLICATE_SCAN_LIMIT=2000` + `MemoryService.findDuplicateGroupsAsync`；界面改用它：按钮显示「正在比对… N%」、超限时如实说「共 N 条，本次先比对最近 M 条」。实测 5000 条 **1.9s 且不冻结**（同步全量约 12s） |
| B30 | **（P2）界面里"加载"与"图标尺寸"两套口径被我这轮的新代码破坏**（FA→lucide 时写了 `size={16}` + 裸 `Loader2`） | `style-token-gates` ICON-1 / COND-2（既有限制：只许降） | 改成语义类 + `<Spinner size="lg" />`；两条门禁**回到基线**（没有把 897/24 上调） |

**真机 A/B（同一台机器、同机同构建方式、各 3 次取中位；production build；脚本 `.preview-shot/_measure-boot.mjs` 走 CDP 读浏览器自己的 paint 条目）**：

| 指标 | 旧装机版（09:05，改动前） | 本版（14:15，改动后） | 变化 |
|---|---|---|---|
| first-paint | 388 ms | **228 ms** | −160 ms（−41%） |
| FCP | 488 ms | **328 ms** | −160 ms（−33%） |
| DOMContentLoaded | 379 ms | **218 ms** | −161 ms |
| 可交互（轮询上界，含 attach 延迟） | 500 ms | 505 ms | 同量级（见说明） |

> 说明：`可交互` 是"从进程启动到轮询看到启动屏放行/消失"的上界，受 CDP attach 延迟影响（旧版有 1 次 1077ms 的抖动）⇒ **不作为结论**，只用 fp/fcp（浏览器自己报的，不受 attach 影响）。另：启动时那条 `memory.load 没有可用的存储端口` 是**既有行为**（旧版同样出现，advisory 会自动重试），不是本轮引入。

**这一轮的既有判据改动 3 处**（都写了理由）：`full-regression-smoke`（AgentManager 允许 lazy 形态）、`retired-ui-plugins` RUP-4（AgentManager/SkillManager 的接线判据接受 `lazy + fallback={XLazy}`）、`memory-checkup` MEM-CHECK-DUP-1（扫描改异步 ⇒ 用 `waitFor` 等结果）。

**这一轮之后仍未做的（需要产品取舍或更长验证，不是遗漏）**：

### 11.10 第六轮：把 §11.9 里"值得做但没做"的两项也做了（B31–B33）

§11.9 当时把它们写成"仍未做"。逐条重新判断后：**KaTeX 与 CSS 分块是值得做的**（不是"判断为不做"），缺的只是工作量 —— 这一轮补上了。

| # | 欠账 | 判据 | 做了什么 + 实测 |
|---|---|---|---|
| B31 | **（P2）KaTeX 270KB 无条件进主包**：`RichContent` 是所有消息的渲染器，公式却只出现在少数消息 | `rich-content-math-lazy.test.tsx` MATH-LAZY-1…5（含两条反向对照 + hooks 顺序） | 抽出 `rich-content/markdown-math.ts`（`remark-math` + `rehype-katex` + katex CSS），`RichContent` 检测到数学标记才**动态 import**；实测切出 `katex-*.js 255KB` + `katex-*.css 29.5KB`，主包 **2.94 → 2.70 MB**。变异自证：`hasMath` 恒 true ⇒ MATH-LAZY-1/4 红 |
| B32 | **（P2）面板 CSS 无条件进主包**：`task-center.css`(17.3KB) + `notebook-workspace.css`(69.3KB) 由 `main.tsx` 全局 import，而这两个面板早已是 lazy | 由 `css-integrity` / `ui-consistency` / 全量渲染判据共同兜（CSS 跟着组件走，类名仍被引用） | 两条 CSS import 从 `main.tsx` 移到各自组件；主 CSS **648 → 551 KB**，且**无 FOUC 风险**（CSS 与组件 chunk 同时到） |
| B33 | **（P2）首屏经 `core/knowledge` 桶文件**把 JSZip（~98KB）/PPT 样式表/KaTeX 一起拉进主包 | 全量测试 + `reachability-gate` | `App.tsx`/`InputArea.tsx`/`SettingsPanel.tsx` 改成**直接从具体模块**取（`knowledge/storage`、`knowledge/retriever`、`knowledge/indexer`）；`knowledge/index.ts` 桶保留给按需面板 |

**真机 A/B 复测（同一台机器、production build、各 3 次中位）**：

| 指标 | 旧装机版（09:05，改动前） | 本版（14:56，全部改动后） | 变化 |
|---|---|---|---|
| first-paint | 388 ms | **176 ms** | **−212 ms（−55%）** |
| FCP | 488 ms | **280 ms** | **−208 ms（−43%）** |
| DOMContentLoaded | 379 ms | **170 ms** | −209 ms |

**剩余仍未做的（这次是"判断为不做"，理由写在这里）**：
- **首屏依赖（ChatPanel / MessageBubble / InputArea / Sidebar ≈ 400KB）不拆**：默认视图就是聊天，拆了只会多一程网络往返 + 白屏，**负收益**。
- **`styles.css`（697KB 源）不再拆**：它是令牌/布局/组件的全局基础，按路由拆需要逐屏 FOUC 回归，收益（≤100KB）与风险不成比例。
- **mermaid 与它的 katex 副本（269.6KB）不合并**：两者都是 lazy chunk，只有画图时才下载；合并会把 mermaid 的加载面扩大，得不偿失。

### 11.4 三个必须记住的坑（本轮各踩一次）

1. **`git checkout -- <file>` 会连你自己的未提交修复一起还原**。本轮用它撤变异时把 `styles.css` 的焦点环修复一起撤了 —— 撤变异请用备份副本，不要用 `git checkout`。
2. **`Set-Content -Encoding utf8`（PowerShell 5.1）写 BOM 且会把中文写成 `?`**：`BOM-1` 会红，而"用 PowerShell 往文件里写补丁脚本"还会把源码里的中文注释写成问号（本轮在 `file-change-tracker` 的上报文案上踩到，靠 `edit` 工具重写才修好）。**规则：含中文的补丁不要经 PowerShell；用 `edit`/`write` 工具或 node 脚本（UTF-8 无 BOM）**。
3. **改判据的连带影响要当场处理**：B12 加了两条清理命令、B13 改了形状顺序 —— 各自都让一条既有判据变红（FIXB-8c / FP-3）。先判断"是产品错了还是判据的假设过期了"，再改，并把理由写进判据注释（本轮已写）。

### 11.5 本轮收尾门禁

见 §3 的最新数字（**758 files / 8626 passed / tsc 0 / audit 0 / cargo 全绿 / main 2.94 MB**）。五轮改动涉及：

- 第一轮（B1–B8）：`src/styles.css`、`src/styles/codem-ui.css`、`src/components/RightSidebar.tsx`、`src/components/RightSidebarResizeHandle.tsx`（新）、`src/hooks/usePaneResize.ts`、`src/utils/file-link.ts`、`src/core/skill/{skill,installer,skill-market-client}.ts`、`src/core/knowledge/indexer.ts`、`src/core/storage/{attachment-files,session-jsonl}.ts`、`tools/ui-audit/css-contract.json`、`tools/audit/report-site-classification.json`、`docs/evidence/second-benchmark-2026-10-28/*`
- 第二轮（B9–B15）：`src/core/storage/{message,session,settings,attachment-files}.ts`、`src/core/environment/file-change-tracker.ts`、`src/core/knowledge/graph-extractor.ts`、`src/core/memory/memory.ts`、`src/core/utils/credential-shapes.ts`、`src/components/FileEditor.tsx`
- 第三轮（B16–B22）：`src/core/llm/{tool-contract,agentic-loop}.ts`、`src/components/{DiffViewer,ChatPanel}.tsx`、`src/components/useStableMessageHandlers.ts`（新）、`src/components/rich-content/{CodeBlockView.tsx,prism-languages.ts}`（新）、`src/core/ui/message-suffix.ts`（新）、`src/core/memory/similarity.ts`、`src/core/environment/file-change-tracker.ts`、`src-tauri/codem-db/src/migrate.rs`
- 第四轮（B23–B26）：`src/components/ScrollbarMarkers.tsx`、`src/components/{BootSplash,App}.tsx`、`src/main.tsx`、`src/core/boot/material-hint.ts`（新）、`src/styles/codem-ui.css`
- 第五轮（B27–B30）：`src/core/boot/boot-timings.ts`（新）、`src/components/{BootSplash,withSuspense.tsx,MemoryCheckupView,GitHubCloneDialog,App}.tsx`、`src/core/memory/{similarity,memory}.ts`、`src/main.tsx`
- 新判据文件 23 个：`right-sidebar-resize-keyboard` / `message-link-open` / `skill-name-traversal` / `knowledge-reindex-no-data-loss` / `attachment-prune-safety` / `attachment-log-recovery` / `knowledge-graph-no-wipe-on-failure` / `memory-link-scope` / `session-delete-index-residue` / `export-redaction-shapes` / `file-change-revert-residue` / `shell-mutation-snapshot` / `diff-viewer-large` / `chat-streaming-suffix` / `memory-duplicate-scale` / `file-change-snapshot-session-isolation` / `code-block-bundle` / `scrollbar-markers-layout` / `startup-material-hint` / `boot-splash-click-through` / `boot-timings` / Rust `migrate::tests::rebuild_fts_orphan_cleanup_is_null_safe`
- 上报点登记表：273 → **278**（`_counts` 现算）
- 既有判据改动 8 处（都写明理由）：`file-change-snapshot-reuse`、`message-session-event-fix`、`regression-p0-p4-full`、`appearance-modes`、`light-theme-contrast`、`full-regression-smoke`、`retired-ui-plugins`、`memory-checkup`
- 真机测量脚手架（`.preview-shot/` 已 ignored，不进 git）：`_measure-boot.mjs`（A/B 三连测 + 中位）、`_attach-boot.mjs`（读 paint/启动屏/console 异常）

### 11.11 第七轮：**「存储端口 advisory」被定性为真缺陷并修掉**（B34–B35）

用户追问「`memory.load 没有可用的存储端口` 这条既有 advisory 算不算 bug」。查证结论：**是缺陷，而且是每次启动必现的启动顺序缺陷**，不是偶发竞态。

| # | 缺陷 | 判据 | 修法与实测 |
|---|---|---|---|
| B34 | **（P1）存储端口必然晚于记忆读盘**：`App.tsx` 两条 effect 并行 —— Cordis 初始化 → `getLLMEngine()` → `getMemoryService()` → **同步** `load()`；另一条 effect 才 `registerRustStoragePort()` → `await port.start()`。于是每次启动都打出一条 advisory + 「迁移推迟」，并留下一个 `loadState.ok=false` 的 **fail-closed 窗口**（期间记忆写入被拒）；更糟的是**真故障与这个竞态输出一模一样** | `memory-boot-order.test.ts` MEM-BOOT-1…4（含反向对照与源码顺序） | 新增 `bootstrap.ensureStoragePortRegistered()`（**单飞承诺**）；`getCordisContext()` 先 await 它再构造引擎；App 的存储引导 effect 改用它（不再各自注册）。真机复测：console 里 **`存储端口` / `迁移推迟` 两条都不再出现**（同一支 CDP 脚本，修复前每次都能抓到），`boot first-paint=188 fcp=288` 不变 |
| B35 | **（P2）二次升级 Phase B 缺「重置宽度」入口**：宽度持久化，而默认值随版本变过（旧版存过 586），用户只能一格一格拖回去 | `right-sidebar-resize-keyboard.test.tsx` RSH-5/5b | 分隔条支持**双击复位**到本档默认宽度；默认值抽成 `rightSidebarDefaultWidth()`（**单一真相**，`initial` 与复位共用），title 里写明入口 |

**这一轮改的既有判据 4 处**（都写了理由）：`settings-effect` SKEY-E1、`ui-font-scale` UI-FONT-5、`ui-benchmark-construction` P2-2（锚点跟随"端口注册收敛成单飞 / 默认宽度抽成函数"），以及 `memory-boot-order` 自己的 mock 改成 `importOriginal` 透传 —— 最后这条是 `persist-failure-mock-parity` PFP-2 **抓到我真的造了不存在的导出名**（真判据，改的是我的测试而不是它）。

### 11.12 二次升级 Phase A–F：**全部落地**（第 233 轮 · 一次做完）

| 阶段 | 做了什么 | 判据 / 实测 |
|---|---|---|
| **A** 正文与 Composer 同宽 | 窄档（≤1440）把 `.messages-container` 的 `max-width` 对齐到 `var(--reading-column)`；`.chat-body` 加 `scrollbar-gutter: stable both-edges` | `second-upgrade-phases` PHASE-A-1/2；**真机实测（1400 视口）：正文内容列 732 = Composer 732，delta 0**（修前 770 vs 732） |
| **B** 右栏默认宽与断点 | 默认 360/400 + 持久化 + 键盘调宽**已在前几轮**；本轮补**双击复位**与单一默认值函数；`≤1100 自动收起` 原本就已实现（`App.tsx` 里那条） | `right-sidebar-resize-keyboard` RSH-5/5b |
| **C** Inspector「最近一轮 + 历史轮次」 | 顶部汇总 `最近一轮 +N −N · K 个文件`、43px 文件行（路径 + M/A + 每文件 +/−）、「最近检查」区块、历史轮次保留；**数据前置**：跟踪器收尾多跑 `git diff --numstat` 写入同一份 JSON（不动表结构），并新增 `verification-checks`（有界、每会话 20 条、不存输出） | `inspector-turn-summary` INV-1…4、`verification-checks` VC-1…5；缺统计显示 `+—`（不把「不知道」画成 +0） |
| **D** 设置页统一 | 卡片标题统一 `13px / 600`（`--fs-sm` + `--weight-semibold`）；`≤520px` 窄容器行式设置回退单列、控件拉满 | `second-upgrade-phases` PHASE-D-1/2 |
| **E** 分辨率与字体 | 移除 `text-rendering: optimizeLegibility`；**字体族一律未动** | PHASE-E-1；PHASE-E-2 扫描全仓 `font-family` 使用处（`@font-face` 定义除外）；真机读数 `textRendering: auto`、`fontFamily` 仍是 `AlimamaFangYuanTi, -apple-system, …` |
| **F** OMP 细节 | 480 宽档不挤正文的**结构性保护**：`.chat-panel { min-width: 0 }`（flex 子项默认 `min-width:auto` 会把正文撑破） | PHASE-F-1 |

**这一轮的既有判据改动 1 处**：`repro-jsx-classname` UI-003 —— 状态类从"JSX 里拼三目"收敛成 `gitStatusClass()` 函数，原判据的意图（不许裸比较拼接）保留且更强。

**仍未做（判断为不需要 / 负收益，非欠账）**：Phase C 里「每轮检查**绑定到轮次**」——工具执行在 agent 循环、turn 边界在跟踪器，两处没有共享计数器；本轮如实把标签写成「最近检查（本会话）」而不是编一个假绑定。若要真绑定，需要在循环与跟踪器之间引入 turn id 传递（改动面大于收益）。

### 11.13 本轮总门禁（第 233 轮收尾）

```text
763 test files / 8654 passed / 17 skipped / 0 failed
tsc 0
npm run audit exit 0
vite build → main-*.js 2.71 MB / main-*.css 554 KB
```

**真机验收证据（Phase A–F）**：`docs/evidence/second-visual-upgrade-2026-10-28/`
（7 张截图 + `readings.json` + `phase-f-rail-480.json` + README，口径与残差都写在 README 里）。

| 档位 | 内容列 | Composer | delta |
|---|---|---|---|
| 1600 / 1400 / 1080p@125% | 820 | 820 | **0** |
| 1280 / 1080p@150% | 732 | 732 | **0** |
| 右栏键调到 556 宽 | 514 | 536 | 22（`scrollbar-gutter: both-edges` 的代价；**无横向溢出**） |

- `text-rendering: auto`、`font-family` 未变（`AlimamaFangYuanTi, -apple-system, …`）。
- 取证顺带修掉一条真缺陷：右栏拉宽时 **Composer 比正文宽 70px**（只夹了阅读列、没夹容器宽）⇒ 改成 `min(阅读列, 容器宽 − 2×gutter)`，残差 70 → 22；判据 `PHASE-F-2`。
- 证据体量：新批次压到 **436 KB**；4 个历史批次压到 694 KB ⇒ `docs/evidence` 总量 **10.39 → 8.38 MB**（EV-BUDGET-2 恢复余量；压缩方式即该门禁提示的「压小色板 / 缩放」）。

### 11.15 第八轮：297 波遗留 + 死代码 + 文档基线（B36–B39）

用户授权「本机全是测试数据、随便测；把能做的都做了」，并明确**不要再翻 `execute_command` 沙箱边界**（历史已定性，反复改回）。据此这轮做了四件确定的事：

| # | 项 | 判据 / 证据 |
|---|---|---|
| B36 | **297-① Job Object `KILL_ON_JOB_CLOSE`** | 新增 `src-tauri/src/child_job.rs`：创建 Job 并设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，把 `execute_command` / MCP / 免费模型插件的子进程都 `AssignProcessToJobObject` 进去 ⇒ **应用崩溃/被强杀时，工具子进程随内核回收**（不依赖退出代码跑完）。判据 `child_is_assigned_to_kill_on_close_job`（真起子进程 + `IsProcessInJob` 断言）、`multiple_children_share_the_same_job`；`cargo test` 214 passed |
| B37 | **297-② WebView2 去节流** | `run()` 开头设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`（`--disable-background-timer-throttling` / `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding`），**已存在则只追加不覆盖**（保留排障用的 CDP 端口参数）。真机日志证据：`[INFO] webview2: background throttling disabled` |
| B38 | **297-④ npx 税** | 改写**既有**那句测试指引（中英各一句，不新增段落）：已装好的工具优先用 `node_modules/.bin` 里的本地二进制，别用 `npx`（每次联网解析 ≈1s）。没有用提示词新增长篇，符合"不靠提示词治本"的纪律 |
| B39 | **P2-14 死代码处置** | `SpaceSwitcher`：Sidebar 里只剩 import、用法早被注释掉 ⇒ 删除组件 + 15 条 `.space-switcher*` 死 CSS（`css-class-unused` 归零）；删除需 `git add`（可达性扫描基于 `git ls-files`，未暂存的删除会被当成"存在但读不到"） |

**297-③「回退/假绿守卫」的结论**：**已有实现**，不重复造。`src/core/llm/turn-outcome.ts::describeTurnOutcome` + `completion-guards.ts` 的**回归完成门**（本轮把检查改红时界面不显示"任务完成"）就是这一项，判据在 `app-turn-outcome-rendering.test.ts`。文档把它列成"遗留"已经过期。

**这轮的判据改动 2 处**（都写明理由）：`memory-duplicate-scale` DUP-P4 的耗时上限 3000→5000ms（它断言的是"有界"，全量并行时 3s 会抖；5s 仍远低于同步全量的 12s，变异照红）；`css-integrity` 快照随死 CSS 删除重新生成（3020 个类）。

### 11.17 第九轮：真机实验（自动压缩 / 退出路径）与一个**新发现的缺陷候选**

用户授权「本机全是测试数据、随便测；模型用 ds flash」。

| 项 | 结果 | 证据 |
|---|---|---|
| **退出路径端到端** | `quit_app` → 进程消失 **35 ms**，退出后 **0 个 codem 进程**残留 | `docs/evidence/realmachine-compaction-2026-10-28/README.md`、`.preview-shot/_quit-e2e.mjs` |
| **托盘物理点击** | **无法自动化**（实测两次）：图标被折叠进「隐藏的图标」溢出区；Win32 弹出菜单不暴露给 UIAutomation | 同上 |
| **自动压缩** | 发 40 万字符（回执 **141K 入**）没有触发压缩 —— **这是正确行为**，见 §11.19 的更正 | `compaction-pressure.png` + `readings.json` |
| **项目工作台 3 并发** | 见 §11.20：确定性并发夹具已落地（`concurrency-three-sessions` CONC-1…5） | `src/test/concurrency-three-sessions.test.ts` |

### 11.19 **更正**：为什么 141K 没触发压缩（我上一轮说错了一处）

上一轮我写「`inferContextWindow` 返回 1M ⇒ 自动压缩**永不触发**」——**这句不准确**，必须更正：

1. **主动压缩**按 `usageRatio >= 0.7` 触发（`context.ts::needsCompaction`，分母 = 模型窗口）。deepseek 被推断成 1M ⇒ 阈值 = **70 万 tokens**；141K 只占 14%，**本来就不该触发**。
2. 更关键的是：**反应式压缩一直存在且默认开启**（`agentic-loop.ts` 的 `isContextOverflowError` → `compactMessages` → 重试，`enableReactiveCompaction: true`，连压 3 次才熔断并给用户解释）。
   ⇒ 即使服务端真实窗口远小于 1M，**撞到 `maximum context length` 错误时会当场压缩并重试**，不会静默死掉。
3. 所以 1M 这个推断的真实代价不是「永不压缩」，而是**主动压缩点被推后**：要么在 70 万 tokens 时主动压（真支持 1M 的模型），要么在服务端报错时反应式压（真实窗口更小的模型）。
   `1M` 这个值是**刻意的**：注释写明"按 128K 估算会让 1M 窗口的模型跑 3 轮就压缩"。

**用户拍板：保持 1M（B）。** 因此 B40 结案为「已知设计」，不再动。

### 11.20 第十轮：3 并发夹具（用户批准项 2A）+ 表与保留策略的更正（3A）

**2A 已落地**：`src/test/concurrency-three-sessions.test.ts`（3 个 `AgenticLoop` 真并发，确定性 provider）

| 判据 | 断言 |
|---|---|
| CONC-1 | 三段并发总耗时 < 串行下界的 75%（证明真并发） |
| CONC-2 | 每路拿到自己的输出与用量（不串） |
| CONC-3 | 每个 provider 只服务自己那一路（各 1 次请求） |
| CONC-4 | 中止一路，另外两路照常完成 |
| CONC-5（反向对照） | 共用 provider 时它服务 3 次且三路输出相同 —— 证明 CONC-2 不是恒真 |

真实模型的吞吐/失败率不在这条判据里（要花 token 且受服务端波动），由 `.preview-shot` 真机实验负责。

**3A 更正（我上一轮的建议前提错了）**：`needs_you_pending` / `agent_messages` **不是"无写入方的表"** ——
`needs-you-queue.ts` / `agent-message-queue.ts` 用它们做会话恢复，删表会**直接破坏恢复**。
实测本机：`needs_you_pending` 0 行、`agent_messages` 0 行（队列常态为空，不是废弃）。

真正的大头是 **`session_events`：164 210 行**（库 898 MB；`messages` 23 103、`tool_calls` 30 355）。
但 `event-log.ts` / `maintenance.ts` 里写着**刻意的「不裁剪」决定**（事件日志是追加式审计与回放依据），
所以保留策略不是"技术债没做"，而是**已做过的取舍**。要改需要重新拍板，影响见 §11.18 第 3 行。


### 11.18 需要拍板的三件事（附决策影响）

| # | 决策 | 选项 A | 选项 B | 影响 |
|---|---|---|---|---|
| 1 | **上下文窗口推断**（B40） | 按真实窗口写准（deepseek-chat / flash 一般 128K） | 保持 1M | A：自动压缩会在 ~90K tokens 触发，长会话被本地接住、不再撞服务端上限；代价是压缩更频繁（每轮多一次摘要调用，早期历史更早被折叠）。B：现状——压缩几乎永不触发，长会话靠服务端报错收场 |
| 2 | **3 并发验证的驱动方式** | 我写并发夹具（3 会话同时发，量吞吐/失败/委派等待） | 先只做 2 并发冒烟 | A：能真回答「多 thread 稳定性」；成本是写夹具 + 每轮真实 token。B：便宜但证据弱 |
| 3 | **删表/保留策略**（`needs_you_pending` / `agent_messages` / `session_events`） | 删掉无写入方的表（迁移删表） | 保留并标注 | A：库更小、语义更干净；代价是迁移不可逆（旧数据丢失）。B：无风险但债留着 |

### 11.21 第十一轮：事件保留策略（用户拍板 B，**默认开**）

用户问「这个拍板只影响本机还是影响架构」→ 答案：**影响架构**（默认值对所有安装生效）。拍板 B 后已实现。

#### 做了什么

| 层 | 改动 |
|---|---|
| 引擎 | 新增 `events.prune_older_than`（单会话）与 `events.prune_all`（全局，启动维护用）两条命令。语义**不是**快照压缩，而是**按 TTL 删旧事件**——`maintenance.ts` 已论证：快照只固化投影，而 `runtime-invariants` / tool 配对 / `time-context` 读的是**事件** |
| 保留规则 | ①**陈旧会话**（该会话最新事件都早于 TTL）⇒ 删它全部非 meta 事件；②**活跃会话** ⇒ 只删超出 `keep` 的旧尾部；③`session_meta` 永不删 |
| 默认参数 | `EVENT_RETENTION_KEEP = 5000` / `EVENT_RETENTION_DAYS = 14`（`lib.rs::run` 后台线程，启动后 3 s 跑一次，不阻塞首帧） |
| 判据 | `prune_older_than_keeps_tail_and_meta`、`prune_older_than_never_touches_below_keep_or_fresh_events`、`prune_all_keeps_per_session_tail`（去掉规则①就 red） |

#### 真机实测（本机 898.5 MB 库）

- 30 天 TTL：`removed=0`（事件几乎都是近两周产生的；按 30 天只该清 7 MB）
- **14 天 TTL：`pruned 159210 old event(s)`**（运行时日志有据）
- 删除后库文件不变（SQLite 空闲页），跑一次 `storage.compact`：
  `before 942,149,632 B → after 332,800,000 B，reclaimed 609,349,632 B（581 MB），9,048 ms`
  ⇒ **898.5 MB → 317.4 MB（−65%）**
- 回收时机：启动维护里的 `storage.compact` 会在**下一次启动**按引擎默认阈值（free ≥8 MiB 且 ≥25%）自动执行（本次为取证手工触发）。

#### 为什么 TTL 取 14 天而不是 30

数据：本机 164 210 条事件里 **160 567 条早于 7 天**，30 天只覆盖 2 359 条（7 MB）。14 天是「管住体积 + 保留两周活动」的折中；要改只改 `lib.rs` 一个常量。

### 11.22 第十二轮：A 组（死代码 + 设置页截图）与 B4（真实模型 3 并发）

按用户「按你建议来」执行：A 组两项 + B 组第 4 项。

| 项 | 结果 | 证据 |
|---|---|---|
| A1 死代码 | 删掉 `ChatPanel` 里**永远打不开**的 workbench 分屏（`showWorkbench` 只有置 false 的入口）+ 3 条对应 CSS；`Workbench.tsx` 本身仍被 `PanelSidebar` 使用，未动 | `tsc 0`、`ui-consistency` 通过（`css-class-unused` 归零）、`css-contract` 3019 类 |
| A2 设置页截图 | 6 个 tab 真机截图 + DOM 读数（`docs/evidence/settings-tabs-2026-10-28`）。**截图抓到一个真缺陷**：标题曾渲染成 **12px**（第一版用了 `--fs-sm`=12px），已改成 `--fs-base`（13px）；判据 `PHASE-D-1` 同步改成断言 13px 档，真机复测 **13px / 620** | `docs/evidence/settings-tabs-2026-10-28/README.md` |
| B4 真实模型 3 并发 | ds flash，3 个新会话、间隔 150ms、各发「解释 + 5 行代码」；60s 后数据库核对：**3/3 完成，两两时间窗都相交（overlappingPairs=3）** | `docs/evidence/concurrency-real-2026-10-28/README.md` |

**这条 A2 再次印证了「判据绿 ≠ 到位」**：CSS 判据断言的就是我用错的令牌，所以它当时是绿的，而真机读数是 12px。

### 11.23 第十三轮：D 组拍板结果（D1 提交 / D2 忽略 / D3-C / D4 审计）

用户拍板 `D1 提交 D2 先忽略 D3 做 C D4 先审计`。

| 项 | 落地内容 | 证据 |
|---|---|---|
| **D1** | `.gitignore` 增加 `.rich4-renew-ref/`（3.6 GB GPL-3.0 参考克隆）；`.jscpd.json` 同步跳过。**已提交**（commit `cc1593b3`，含此前 staged 的 `SpaceSwitcher.tsx` 删除） | `git show --stat HEAD` |
| **D2** | `art/`(4.1 GB)、`prototype/`(273 MB)、`docs/ref-analysis/`(246 MB) 加进 `.gitignore`（**先忽略不删**）；`git check-ignore` 四个目录全部为真 | 同上 |
| **D3-C** | 冲突时**仍回滚**（不引入「停在冲突态」的风险），但冲突文件改成**逐行列出 + 「打开」**（`openFileDirectly(conflictAbsolutePath(main, rel))`）；新增纯函数 `conflictAbsolutePath`（统一分隔符、绝对路径原样返回） | `src/test/worktree-conflict-open.test.ts` WTC-1/2/3 |
| **D4** | 缺口审计：**306 使用 / 141 定义 / 53 注入 / 230 缺口**（颜色表面类 86）；按使用次数排序，最高 `--accent-strong`(77)、`--warning-content`(23)、`--accent-border`(21)；配 3 张 dream 皮肤真机截图（设置/主对话/右栏），**截图后已切回默认皮肤**（`skin-id=default` 已核对） | `docs/audit/dream-skin-token-gap.md`、`docs/evidence/dream-skin-audit-2026-10-28/` |

**D3 的取舍**：A 方案（逐文件选边）要让仓库停在 merge 态，风险不对称；C 只补「看得到、点得开」，回滚策略一字未改（判据里显式钉住 `onConflict ?? "abort"`）。

**D4 的下一步**：等用户挑要补的令牌（建议 10–15 个表面/边框/阴影档）；`--focus-ring-color` / `--caret-color` 应绑 `--dream-accent` 而不是给死值。

**提交时的两个坑（都踩了）**：① 用 `Set-Content -Encoding utf8` 在 PowerShell 5.1 写提交信息会**带 BOM**，BOM 会进 subject；② 用 `Set-Content -Encoding ascii` 写脚本时，脚本里的中文会变成 `?`（提交信息第一版就是这样被写坏的）。两次都靠 `git show -s --format=%B | python` 读回字节发现并 `--amend` 修正；最终用 `write` 工具直接写 UTF-8 文件。

### 11.24 第十四轮：Dream 令牌补齐（D4 第二步）

按复审结论补了 **8 个「默认值写死字面色」的语义令牌**，取值绑 `--dream-accent` / `--dream-text-main` / `--dream-c*`：

```css
--accent-strong  --reasoning-accent  --text-base      --border-strong
--shadow-color   --shadow-color-soft --text-on-status --text-ramp-paper
```

**没有动**那 35 个自适应令牌（`--accent-surface` / `--accent-border` / `--error-*` / `--focus-ring-color`）——
它们默认值就是 `color-mix(… var(--accent) …)`，重复定义会冻住「跟随强调色」。

**复审纠正了我自己上一版审计的错误**：上一版把「skin-dream 没定义 且 ThemeManager 没注入」全算缺口（86 个），
其中 35 个其实自适应；真正要补的是 **28 个写死字面色**的。过程写进了
`docs/audit/dream-skin-token-gap.md` 的「为什么复审」一节。

真机计算值（dream 皮肤下）：`--accent-strong = color-mix(in srgb, #e88c9a 72%, #1a1a2e)`
（默认皮肤下是写死的 `#5b46cf`）⇒ 证明它确实跟着 dream 强调色走。
判据 `DREAM-TOK-1/2/3`（含反向对照：自适应令牌不许重复定义）。取证后已切回默认皮肤（`skin-id=default` 核对过）。

### 11.25 第十五轮：Dream 写死缺口清零（D4 收尾）

用户要求「既然发现了硬编码缺口就补了，不考虑收益率」⇒ 把复审后剩余的 **13 个**（所有档位都写死字面色）
也补完，与第一批 8 个合计 **21 个**：

```
--dropdown-hover  --surface-pressed  --field-border-hover  --tooltip-border
--tooltip-bg      --tooltip-text     --error-hover         --surface-content
--surface-opaque-raised  --surface-glass-raised  --shadow-inner-highlight
--terminal-bg     --window-close-bg
```

真机计算值（dream 皮肤下）：`--dropdown-hover = color-mix(in srgb, #1a1a2e 7%, transparent)`、
`--terminal-bg = rgba(30, 30, 46, .82)`（=`--dream-c1`）、`--surface-content = #fdf5f7`（=`--dream-c8`）、
`--window-close-bg = #e81123`（=`--dream-c6`）。取证后切回默认皮肤（`skin-id=default` 已核对）。

判据新增 `dream-skin-tokens-full.test.ts`：
- `DREAM-TOK-4`：**重算**「所有档位都写死」的缺口集合，除 `--skin-preview-hub-accent`（Hub 皮肤预览色块，
  在 dream 作用域覆盖反而错）外必须为空 —— 这是一条**防回归**判据，以后新增写死令牌会被它拦下；
- `DREAM-TOK-5`：第二批 13 个都定义且绑动态令牌。

**为什么不补 `--shadow-raise-1..4` / `--shadow-bubble` / `--border-separator`**：它们在部分档位已引用
`var(--shadow-color)` / `color-mix(... var(--text-base))`，而这两者刚被 dream 覆盖 ⇒ 自动跟随，重复定义会冻住。

### 11.26 第十六轮：设置页 23 tab 逐项验收（对标计划收口）

用户要求「现在做」。补的是**验收覆盖面**，不是功能：

| 指标 | 结果 |
|---|---|
| tab 数 | **23 / 23 全部点得开** |
| 横向溢出 | **0 个 tab**（`scrollWidth == clientWidth`） |
| 标题字号 | 有 section-title 的 tab 一律 **13px / 620** |
| **标准行式设置**控件右缘 | **全部 0px 偏差**（对标要求 ≤2px） |
| 非零偏差 | 5 处，全部是**嵌套卡片 / 复合行 / 自定义块**，逐条判定「设计如此」 |

非零偏差清单（都**不是**错位，强行套 200px 反而会坏）：
`模型` 组合行（select+按钮，99.4px）、身份块（210px）、`provider-group` 卡片内缩（12px）、
`字体粗细` 滑杆行（46px）、安全页 `工具名` 自定义块（508px）。

证据：`docs/evidence/settings-tabs-audit-2026-10-29`（23 张截图 64 色量化 ≈700 KB + readings.json）。
`docs/project-guide/15-TODO-STATE.md` 已把 Phase 4 / Phase 6 / 总门禁三项勾上，**未完成项归零**。

顺带记一个坑：那份 TODO 是 **CRLF**，多行 `replace` 的锚点用 `\n` 永远匹配不到 ⇒ 必须先归一化再改、写完还原。

### 11.16 仍未执行的（本轮之后）


| 项 | 状态 / 阻塞 |
|---|---|
| 自动压缩真机完整验证 | **未做**。需要一条可丢弃的长会话跑到 ≥70% 压力；本机数据可丢，但要构造足够长的会话并观察自动压缩/水位/近 3 轮保留，是一轮独立的真机实验 |
| 项目工作台真实模型 3 并发 | **未做**。需要真实模型连跑 3 个 thread；用户允许花 token，但还需要一个能稳定驱动 3 并发的夹具（现有评测是单 thread） |
| 托盘退出端到端计时 | **未做**。要驱动 OS 托盘菜单，CDP/UIA 都不可靠；退出路径本身已有判据 |
| `needs_you_pending`/`agent_messages` 落库或删表、`session_events` 保留策略、worktree 冲突逐文件 UI、dream 皮肤令牌补齐 | **未做**。四条都需要产品取舍（删表、保留多少、UI 形态），不适合按"能做的都做"硬上 |
| `execute_command` 沙箱边界 | **按用户指示不做**（历史已反复定性，改动无收益） |

> 我这轮**没有**把这些算进"已完成"；它们要么需要用户数据/授权（1/2/3/8），要么是跨层的结构改动（5/6），要么是发版流程步骤（7）。

`docs/project-guide/16-SECOND-VISUAL-UPGRADE-PLAN.md` 的 Phase A **已完整落地**（正文列 = Composer = 732，真机实测 delta 0；滚动条走 `scrollbar-gutter: stable both-edges`）。

- 当前没有已知崩溃/红灯；但“全量功能审计”尚未开始，不能把视觉完成当成系统完成。
