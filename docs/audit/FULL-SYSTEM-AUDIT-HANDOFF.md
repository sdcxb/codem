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

最后一次**全量**：

```text
737 test files / 8532 passed / 17 skipped / 0 failed
tsc 0
npm run audit exit 0
```

时间点：子代理页签 + BOM 修复之后。  
此后只改了 CSS/测试（Composer 边框、拖拽条、气泡、Composer 宽度、身份块），并跑了：

```text
tsc 0
ui-benchmark-construction 20 passed
css-integrity / style-token-gates 通过
```

因此新会话**必须重新跑全量**，不能直接引用旧的 8532。

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
- 当前没有已知崩溃/红灯；但“全量功能审计”尚未开始，不能把视觉完成当成系统完成。
