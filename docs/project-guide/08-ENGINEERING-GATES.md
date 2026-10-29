# 08 · 工程质量、门禁、构建发布与改造配方

> 基线：1.16.330 ｜ 2026-10-26
> 这是“怎么证明改对了、怎么发出去”的文档。命令以 Windows PowerShell 为准；所有脚本相对仓库根 `C:\mimo-gui`。

---

## 1. 环境与常用命令

### 1.0 从零把仓库跑起来（干净机器）

1. **系统**：Windows 10/11 x64；WebView2 Runtime（Win11 自带）。
2. **Node**：24.x（本项目实测 24.19.0）；npm 11.x。
3. **Rust**：1.97.x + `x86_64-pc-windows-msvc` target；Visual Studio Build Tools（C++ 桌面开发）。
4. **安装依赖**：

   ```powershell
   git clone https://github.com/sdcxb/codem.git C:\mimo-gui
   cd C:\mimo-gui
   npm install
   ```

5. **只跑前端**（无 Tauri IPC，部分功能不可用）：`npm run dev`。
6. **完整桌面开发**：`npm run tauri:dev`（Vite + Rust）。
7. **构建签名**：需要 `.tauri/codem-updater.key`（私钥）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；没有私钥可以跑测试/开发，但**不能产出可自动更新的安装包**。
8. **首次启动**会创建 `%APPDATA%\com.codem.app\`（库、日志、sessions、attachments、spill、extensions）。

> 如果 `npm install` 后 `tauri:dev` 报找不到 `cargo`/`link.exe`，先确认 Rust 与 VS Build Tools 的 PATH 与组件；这是环境问题，不是仓库问题。

### 1.1 当前工具链（实测）

| 工具 | 版本 |
|---|---|
| Node | **24.19.0** |
| npm | **11.17.0** |
| rustc | **1.97.1** |
| cargo | **1.97.1** |
| Tauri CLI | `node_modules/@tauri-apps/cli`（v2） |
| WebView2 | Windows 运行时（Win11 自带） |

### 1.2 开发 / 检查 / 测试

```powershell
npm run dev                 # Vite 前端（浏览器调试；没有 Tauri IPC）
npm run tauri:dev           # 完整桌面开发（Vite + Tauri）
npx tsc --noEmit            # 类型检查（必须 0 错误）
npx vitest run              # 全量（约 2.5 分钟；当前 764 文件 / 8674 用例）
npx vitest run src/test/<某个>.test.ts   # 单跑
npm run test:e2e            # vitest.e2e.config.ts
npm run test:snapshot       # vitest.snapshot.config.ts
npm run test:coverage       # 覆盖率
npm run verify              # 覆盖率 + 按文件地板 + knip + jscpd（较慢）
npm run audit               # 结构审计整链（含 eval 臂，约 40 分钟）
```

### 1.3 存储 / 数据库

```powershell
npm run db:build            # 构建 codem-db
npm run db:test             # Rust 金样本契约（wire-fixtures）
npm run db:cli -- <命令>     # CLI（注意：--db 是读写打开）
npm run bench:db            # 10 万行基准
npm run bench:mem           # 内存基准
npm run migrate:plan        # 只读计划
npm run migrate:apply       # 执行迁移
npm run migrate:verify      # 对账
```

### 1.4 清理 / 维护

```powershell
node tools\maintenance\clean-dev-artifacts.mjs          # 只打印计划
node tools\maintenance\clean-dev-artifacts.mjs --apply  # 执行（可能释放几十 GB）
node tools\maintenance\clean-orphan-dev.mjs             # 只在 codem.exe 不在时动手
node tools\maintenance\clean-orphan-test-browsers.mjs   # 清测试遗留 Edge
```

---

## 2. 测试体系

### 2.1 规模与层次

| 层 | 位置 | 说明 |
|---|---|---|
| 单元 / 行为 | `src/test/*.test.ts` | 绝大多数；每个文件通常对应一个机制/契约 |
| 组件 / 真 DOM | `src/test/*.test.tsx` | `@testing-library/react` + happy-dom/jsdom |
| 真渲染探针 | `src/test/fixtures/*-probe.html` + `helpers/browser-probe.ts` | 无头 Edge/CDP，测弹窗几何、标签墙行数、窄容器、主题首帧 |
| Rust 单测 | `src-tauri/src/**` 的 `#[cfg(test)]` | `cargo test --lib` |
| Rust 存储契约 | `src-tauri/codem-db/tests/*.rs` | `wire-fixtures.json` 金样本；`WIRE-0` 检查最近是否真跑过 |
| 快照 / E2E | `vitest.snapshot.config.ts` / `vitest.e2e.config.ts` | 少量 |

### 2.2 当前基线（2026-10-26 实测）

```text
Test Files  2 failed | 731 passed (733)
Tests       2 failed | 8497 passed | 17 skipped (8516)
Duration    148.65s
```

**两条失败不是产品代码回归**：

1. `no-bom.test.ts`：18 个**未跟踪**游戏文档带 BOM（`art/wealth-island/README.md`、`docs/2.5D-SCENE.md`、`docs/REBUILD-SPEC.md`、`prototype/*/README.md` 等）。新文档必须 UTF-8 无 BOM。
2. `docs-current-gap-list.test.ts`：`MONOPOLY-GODOT-PLAN.md` / `MONOPOLY-REBUILD-PLAN.md` 缺“历史文档（不再维护）”横幅。修法是 `node .preview-shot/banner-historical-docs.mjs --apply`（该脚本在 gitignored 目录，干净 clone 上不可用）。

> 如果你新增了文档，先确认它没有 BOM；如果新增了 `*PLAN*` / `*GAP*` / `*TODO*` 文件，要么加历史横幅，要么改名。

### 2.3 判据纪律

**先写判据 → 变异自证 → 真机验证**：

1. 新行为先写一个会因缺陷而红的用例；
2. 修 bug 先让用例复现红；
3. 把实现改坏，用例必须红；还原后必须绿；
4. 只写用例不做变异 = 没测；
5. 判据只许收紧，不许放宽（删白名单要说明理由）。

**计时敏感用例**：全量并行满载时会抖动；先单跑确认，不要急着改代码。

---

## 3. 门禁清单（提交前至少跑这些）

| 门禁 | 命令 | 当前基线/期望 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | 0 错误 |
| 文档新鲜度 | `npm run audit:docs` | 版本/必读文档/BOM/索引/章节；版本变了文档没跟上会红 |
| 全量测试 | `npx vitest run` | 8497 通过 / 17 跳过 / 2 未跟踪失败 |
| 上报点分诊 | `node tools/audit/scan-report-sites.mjs --check` | 267 = 267（三数相等：扫描/登记/缓存） |
| 变异产物 | `node tools/mutate/check-artifacts.mjs` | 65+ 波、`restored=true`、未过期 |
| 未使用导出 | `node tools/audit/knip-gate.mjs` | 不增长（历史基线 exports 49 / types 21 / entry 20，以脚本为准） |
| 重复代码 | `npx jscpd` | 不高于基线（历史约 171 clones） |
| 覆盖率 | `node tools/audit/coverage-baseline.mjs --check`、`coverage-per-file.mjs --check` | 不低于基线；按文件地板以脚本为准 |
| 可达性 | `node tools/audit/reachability-scan.mjs --check` | 新增未接线文件必须登记 |
| 静默写 / 假成功 / 守卫绕过 | `node tools/audit/scan-silent-write.mjs`、`scan-false-success.mjs`、`scan-guard-bypass.mjs` | 0 未登记 |
| 存储边界 | `node tools/audit/scan-storage-boundary.mjs` | 渲染侧不许裸 SQL |
| schema parity | `node tools/audit/gen-schema-sql.mjs --check` | schema 与 SQL 一致 |
| 命令 parity | `node tools/audit/check-command-parity.mjs` | 前端 invoke / Rust 命令一致 |
| 行构造器 / 写返回 | `node tools/audit/check-row-builders.mjs`、`check-write-return.mjs` | 0 未登记 |
| token 卫生 / 样式字面量 / 颜色角色 | `node tools/audit/scan-token-hygiene.mjs --check`、`scan-style-literals.mjs --check`、`scan-color-roles.mjs --check` | 不超基线 |
| 正则 Unicode | `node tools/audit/scan-regex-unicode.mjs --strict` | 0 |
| 控制字节 | `node tools/audit/scan-control-bytes.mjs` | 0 |
| 文档缺口清单 | `node tools/audit/check-gaplist.mjs` | 通过 |
| 无 eval | `node tools/audit/no-eval.mjs` | 通过 |
| 节点语法 | `node tools/audit/check-node-syntax.mjs` | 通过 |
| probe-guard 自证 | `node tools/audit/probe-guard.selftest.mjs` | 通过 |
| CSS 契约 | `node tools/ui-audit/css-contract.mjs` | 无意外变化（改 CSS 后先 `--write`） |
| 未定义类名 | `node tools/ui-audit/scan-ui.mjs` | error 0 / warn 0 |
| Rust 单测 | `cargo test --release --lib`（在 `src-tauri`） | 通过 |
| Rust 存储契约 | `npm run db:test` | 通过；`WIRE-0` 检查真跑过 |

> `npm run audit` 是整链（含 eval 臂，约 40 分钟）。急用时逐条跑非 eval 步骤；**不要**在跑评测批期间构建。

---

## 4. 评测体系（能力对标）

- **12 个真实仓库修复任务**：`repo-01` … `repo-12`，判定由任务自带判据脚本给出；
- 对照臂：DSH 命令行 agent，记录在 `.preview-shot/eval-records-repo-control*.jsonl`；
- 官方口径：`node .preview-shot/_collect.mjs --apply`（内部先跑 `tools/eval/dedupe-runs.mjs --apply`）；中间态数字不算结论；
- 当前结论：Codem 10/12，DSH 9/12；工具调用约一半、输出 token 更少；时延约慢 1.5×（服务端/账号因素，已定性，不再投入）。

**纪律**：

- 跑评测批期间**不要构建**（构建抢 CPU 会抬高自己这一侧的时延 = 自我美化）；
- 不要把长跑进程接进会提前结束的管道（`| Select-Object -First N` 会杀进程）；
- 评测结论只认官方口径。

---

## 5. 构建与发布

### 5.1 版本号（四处一致）

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `[package] version`
- `src-tauri/Cargo.lock`（对应包版本）

另有 `latest.json`（发布清单）与 `CHANGELOG.md` 顶部段。

### 5.2 构建（必须带签名变量）

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri\codem-updater.key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
node node_modules\@tauri-apps\cli\tauri.js build
```

- 退出码 **1 是预期的**（stderr 有 warning）；以产物为准；
- 产物：`src-tauri\target\release\bundle\nsis\Codem_<版本>_x64-setup.exe`（+ `.sig`）；
- MSI 同目录。

### 5.3 更新清单

```powershell
node .preview-shot\_audit\make-latest-json.mjs <版本> "<一句话说明>"
node tools\release\verify-update-manifest.mjs          # 本地四项
node tools\release\verify-update-manifest.mjs --remote # 比对 GitHub 上的 sha256
```

### 5.4 发布

> **发版前先同步文档**（在版本号三处改完之后）：`npm run docs:sync` → 按输出清单手改 `README/00/01/09` 与 `CHANGELOG/PROJECT-GUIDE` → `npm run audit:docs`。
> `verify` / `audit` 已包含 `audit:docs`；版本变了文档没跟上会直接红。详见 `12-DOC-MAINTENANCE.md`。
> （本仓 `.github/` 目前被 `.gitignore` 忽略；若以后启用 CI，把 `npm run audit:docs` 加进去即可。）

```powershell
gh release create vX.Y.Z --title "Codem vX.Y.Z" --notes-file <说明文件>
# 上传 5 个资产：nsis exe + sig、msi + sig、latest.json
gh release edit vX.Y.Z --latest
node tools\release\verify-update-manifest.mjs --remote
```

**规则**：

- **只发稳定版**：1.0 之前全部 + `v1.16.43` + `v1.16.210` + 最新稳定版；
- 重建旧 release 会抢走 `Latest` ⇒ 建完必须 `--latest` 抢回并复核远端清单；
- 发布说明用标准样式：发布日期/类型/下载 → 本版要点 → 对标结果 → 健壮性 → 变更 → 升级说明 → 已知问题 → 校验；
- **不许**出现：测试轮数/对数/通过率、“采样波动”、服务端占比、波次号、内部任务编号；
- **发版前先问用户**。

### 5.5 静默安装（真机验证）

```powershell
Start-Process "<setup.exe 路径>" -ArgumentList '/S' -Wait
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
Start-Process "$env:LOCALAPPDATA\Codem\codem.exe"
node .preview-shot/cdp.mjs "<js>" [waitMs]
```

- 安装路径 `%LOCALAPPDATA%\Codem\codem.exe`；数据 `%APPDATA%\com.codem.app\`；
- 只按 PID 杀自己 spawn 的进程；不要 `taskkill /IM codem.exe`；
- 真机/构建持锁 `.preview-shot/_realmachine.lock`，用完删；超过 30 分钟可接管。

### 5.6 真机取证：日志与 CDP

**Rust 侧日志**（`exec start/end`、存储、窗口、崩溃）：

```text
%APPDATA%\com.codem.app\codem-runtime-YYYY-MM-DD.log
%APPDATA%\com.codem.app\codem-crash.log
%APPDATA%\com.codem.app\active-run.json     # 正常退出会删除
```

**渲染侧 console**：Rust 日志收不到；必须用 CDP：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
Start-Process "$env:LOCALAPPDATA\Codem\codem.exe"
# 列出目标 / 执行 JS / 截图（.preview-shot 是 gitignored 的本机脚手架）
node .preview-shot/cdp.mjs "document.title"
```

- 评测驱动会把 console 落到 `.preview-shot/<case>.r<N>.console.jsonl`；
- 真机取证要记录：应用版本、构建时间、PID、窗口尺寸、是否静默安装、操作序列、观测值；
- **不要**只截一张图就宣称“修好了”；至少要有 DOM/console/DB 三处之一的可复核读数。

### 5.7 只读检查数据库

`tools/maintenance/read-only-db.mjs` 是**库**（导出 `withReadOnlyDb` / `openReadOnlyDb`），不是 CLI。它把 `.bin` + `-wal` + `-shm` 复制到临时目录再读，不动真库的 `-shm` mtime：

```js
import { withReadOnlyDb } from "../../tools/maintenance/read-only-db.mjs";
const { result, changes } = await withReadOnlyDb(REAL_DB, (db) =>
  db.prepare("select count(*) as n from messages").all()
);
```

临时手工查看：先把三件套复制到临时目录，再对**副本**跑 `codem-db-cli`。不要直接 `sqlite3` 打开真库，更不要用 `codem-db-cli --db` 指旧库（读写打开，可能毁唯一回滚副本）。

---

## 6. 改造配方（照着做，少踩坑）

### 6.1 加一个 LLM 工具

1. `src/core/llm/tools/<name>.ts`：`ToolDef`（`id/description/parameters/execute`）；
2. `src/core/llm/tools.ts::createDefaultToolRegistry` 里 `registry.register(createXxxTool())`；
3. 若要并发：`concurrency-policy.ts` 的 `CONCURRENCY_SAFE_TOOL_IDS`（只读、无副作用）；
4. 输出契约：`outputSchema` + `renderOutput` 共用同一个渲染函数；
5. 延迟加载：大 schema 工具加进 `DEFERRED_BIG_TOOLS`；
6. 上报点：在 `tools/audit/report-site-classification.json` 登记；
7. 测试：工具行为 + 参数校验 + 输出契约 + 并发名单交叉核对。

### 6.2 加一个设置项

1. 键名：扁平键 `codem-xxx`，或塞进 `codem-settings` JSON；
2. 写方：`setSetting` / `setSettingJSON`（**唯一收口**）；
3. 读方：`getSetting` / `getSettingJSON`；
4. 面板：`SettingsPanel.tsx` 对应分区；保存走 `handleSave`；
5. 判据：`SKEY-2`（每个键既有写方又有读方）；`SAVE-REFRESH-1/2`（保存按钮必须走规范路径 + 真刷新）；
6. 若改 CSS：登记 `tools/ui-audit/css-contract.json`。

### 6.3 加一个设置分区 / 面板

1. `SettingsPanel.tsx` 的 `activeTab` 联合类型 + 导航按钮 + 搜索索引 + 渲染分支；
2. 三皮肤都检查（默认/hub/dream）；
3. 面板壳：`role="dialog"` / `aria-modal` / 可访问名；
4. 关掉后状态复位；
5. 判据：`SETTINGSORDER-*`、`BOTTOM-TAB-*`（若同时是底部成员）。

### 6.4 加一张表 / 一列

1. `src-tauri/codem-db/sql/schema.sql`；
2. `migrations.json` 加幂等 `ALTER`；
3. `tables.json` 同步；
4. `schema.rs` 种子/回填（如需）；
5. `repo.rs` 仓储方法 + `codem-db/lib.rs` `COMMANDS` 白名单；
6. `src/core/storage/rust-port.ts` 端口方法 + 类型；
7. 契约测试：`npm run db:test`；`gen-schema-sql.mjs --check`；
8. 检查 `scan-unrouted-db.mjs`（表有没有人读/写）与 `storage-boundary`。

### 6.5 加一个 Rust 命令

1. 在对应模块写 `#[tauri::command]`；
2. `lib.rs` 的 `generate_handler!` 注册；
3. 前端 `invoke("<name>", { ... })` 参数与 Rust 形参数量一致（`TAURI-ARITY-1/2`）；
4. Rust 单测（至少覆盖参数校验/错误路径）；
5. `npm run audit:command-parity`。

### 6.6 加一个 provider / 服务

1. `src/core/provider/<svc>-provider.ts`：`const p: Plugin = (ctx) => ctx.provide("<service>", {...})`；
2. `builtin-registry.ts` 注册；
3. `config/codem.base.yml` 加条目（`id/name/inject/core`）；
4. 消费者用 `getCtxService("<service>")` 或 `getToolContext()?.get(...)`；
5. 判据：`SO-6/8`、`plugin-assembly-path.test.ts`；
6. 确认 `settleActivation` 后是 ACTIVE，而不是只 assembled。

### 6.7 加一个技能

1. 用户技能目录或 `src/core/skills/<name>/SKILL.md`；
2. 顶部 YAML：`name/description/...`；
3. `load_skill` 未命中会重扫；安装后无需重启；
4. 技能市场：`skill-market-client.ts` / Trees API；
5. 判据：`load_skill` 行为 + 技能环境事实。

### 6.8 加一个 MCP 能力

1. 设置里加服务器配置（`mcp_servers` 表 / `codem-mcp-servers`）；
2. `core/mcp/mcp.ts` 连接/工具同步；
3. `mcp-resources-tool.ts` 资源；
4. 审批：MCP 工具走统一管线；
5. 外部进程沙箱/权限边界要显式。

### 6.9 发布

见 §5；另外：

- 先跑 `npx tsc --noEmit` + 相关判据 + 全量；
- 需要真机：构建 + 静默安装 + CDP 取证；
- 更新 `docs/project-guide/09-CURRENT-STATE.md` 与 `docs/PROJECT-GUIDE.md` 的版本表（`VERSION-4` 判据）；
- 提交分主题、只 `git add` 显式路径。

---

## 7. 影响范围速查（改什么 → 必须同步什么）

| 你改的东西 | 必须同步 | 会红的门禁 |
|---|---|---|
| 新工具 | `tools.ts` 注册；并发白名单；`outputSchema/renderOutput`；上报点登记；测试 | `output-schema-ratchet`、`scan-report-sites --check`、`knip-gate` |
| 改 `#[tauri::command]` 签名 | 同文件调用点 + 前端 `invoke` + Rust 测试 | `TAURI-ARITY-1/2`、`cargo test --lib` |
| 改设置项 | 读方 + 写方；扁平键两处；面板走 `handleSave` | `SKEY-2`、`SAVE-REFRESH-1/2` |
| 改面板/入口 | `bottom-tab-entries.ts` + 三皮肤 | `bottom-tab-entry-ratchet`、`css-class-unused` |
| 改 CSS | `css-contract.json`（`--write`）；不新增裸值族 | `css-integrity`、`scan-style-literals --check`、`ui-consistency` |
| 改 Rust 存储/SQL | `codem-db` 金样本、`wire_contract.rs`、`schema.sql`/`migrations.json` | `rust-port-wire`、`storage-boundary`、`schema-parity`、`command-parity` |
| 改记忆语义 | 引擎 + 面板 + 判据三件套；口径只许一处 | `MEMP-*`/`MEMC-*`/`MEM-DEMOTE-*`/`MPS-231-*` |
| 改系统提示/引导 | 优先写进 `docs/manuals/*` 让模型读文档 | `ENV-*`、`INST-*`、`MEM-PLACE-*` |
| 删除文件/插件 | 注册表 + YAML + 可达性白名单 + `knip.json` + 覆盖率基线只删不增 | `reachability-gate`、`knip-gate` |
| 加/改真机证据图 | `docs/evidence/<批次>/` 必须有 `README.md` | `docs-evidence-budget`（总量≤10 MB、单批≤3 MB） |
| 新增未接线文件 | `tools/audit/reachability-allowlist.json` + 文件头 `@unwired` 理由 | `reachability-gate` |
| 新增上报点 | `report-site-classification.json` 登记 | 三数相等 |

---

## 8. 工程纪律（违反会被判据或用户挡住）

1. **判据先行 + 变异自证**：见 §2.3。
2. **评测只认官方口径**：`_collect.mjs --apply` 之后才算数。
3. **结构优先于提示词**：真机验证过提醒不是分水岭。
4. **跑评测批期间不要构建**。
5. **长跑进程不要接会提前结束的管道**。
6. **中文引号一律 `「」`**；写脚本先 `node --check`。
7. **回退一律 `git checkout -- <file>`**；不要用行号 + 花括号计数删代码。
8. **日志的真相**：`%APPDATA%\com.codem.app\codem-runtime-*.log` 只收 Rust 侧；渲染侧 `console.*` 只能靠 CDP 抓。
9. **禁止目标模式 / 自动续跑**（用户明确要求）；一次把事做完，多步用 `todo_write`，岔路直接问。
10. **只读钻取用副本**：`tools/maintenance/read-only-db.mjs`；不要直接只读打开真库。
11. **只按 PID 杀自己 spawn 的进程**；禁止整树 git 操作。
12. **文档关键项要入库**：`docs/*.md` 白名单 + `DOCSKEY-1..3`；新子目录已验证不被忽略。

---

## 9. 交付前自检（复制即用）

```powershell
npx tsc --noEmit
npx vitest run <相关判据>       # 先单跑
npx vitest run                 # 全量；知道 2 条未跟踪失败
node tools/audit/scan-report-sites.mjs --check
node tools/mutate/check-artifacts.mjs
node tools/audit/knip-gate.mjs
node tools/ui-audit/css-contract.mjs      # 改 CSS 时先 --write
node tools/audit/scan-style-literals.mjs --check
```

交付说明必须写：

- 改了什么、为什么；
- 判据文件/用例名；变异做了哪几条；
- 哪些是**真机验证**、哪些只有判据层证据；
- 没做的、已知风险、下一步；
- 是否需要用户拍板（发版/产品取舍）。
