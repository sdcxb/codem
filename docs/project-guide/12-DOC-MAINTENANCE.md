# 12 · 文档维护：让文档跟得上每个版本

> 基线：1.16.331 ｜ 2026-10-26
> 目标：文档不是“有空再补”的附属品，而是**发版物的一部分**。版本号一变，文档没跟上，CI/发版门禁就红。

---

## 1. 一句话

**发版前跑 `npm run docs:sync`，按提示手改 6 处，再跑 `npm run audit:docs`。**
`verify` / `audit` / CI 都接了这道门禁；不做就会在发版前被挡。

---

## 2. 为什么不能“发版后再补”

- 发版后补，文档与安装包/latest.json/CHANGELOG 的版本号会短暂不一致；下一个接手的人正好看到这段窗口。
- 发布说明是**用户视角**，不该写“更新文档”这种内部事务；把它放进**发版规程 + CI 门禁**，而不是 Release Notes。
- 文档漂移是渐进的：每次只落后一点，半年后就变成“PROJECT-GUIDE 停在 1.16.305”这种局面。门禁的价值是**每次只差一步就红**。

---

## 3. 发版时的固定动作（10 分钟）

```powershell
# 0. 版本号三处 + CHANGELOG（见 docs/RELEASE-GUIDE.md）
# 1. 刷新机器基线
npm run docs:sync

# 2. 按输出清单手改：
#    README.md             版本 / 发布 / HEAD / 测试基线 / 文档清单
#    00-AGENT-HANDBOOK.md  基线表
#    01-PRODUCT-OVERVIEW.md 版本 / 规模 / 版本历程
#    09-CURRENT-STATE.md   §1 版本与发布、§3 测试基线、§5 未完成项、§7 文档债
#    CHANGELOG.md          面向用户的版本段
#    docs/PROJECT-GUIDE.md 版本历史表（VERSION-4 判据）

# 3. 门禁
npm run audit:docs

# 4. 再跑常规门禁（verify 已包含 audit:docs）
npm run verify
```

> 测试数字（764 / 8674）来自**全量跑批**，`docs:sync` 不会替你编；把最近一次 `npx vitest run` 的真实结果写进 `09-CURRENT-STATE.md §3`，并注明日期。

---

## 4. `docs:sync` 到底做什么、不做什么

**做**：

- 读 `package.json` / `tauri.conf.json` / `Cargo.toml` 的版本；
- 静态统计：测试文件数、`src/core` 子域数、`schema.sql` 表数、`#[tauri::command]` 注解数；
- 写 `docs/project-guide/BASELINE.json`；
- 打印“仍需手工更新”的 6 处清单。

**不做**：

- 不改叙述性正文（版本亮点、未完成项、测试通过数、根因分析）；
- 不跑全量测试（避免把发版流程拖到 3 分钟以上）；
- 不自动改写 `CHANGELOG.md` / `PROJECT-GUIDE.md`；
- 不删除历史文档。

---

## 5. `audit:docs` 检查什么

**硬错误（exit 1）**：

1. `package.json` / `tauri.conf.json` / `Cargo.toml` / `BASELINE.json` 版本不一致；
2. `README.md` / `00` / `01` / `09` 没有当前版本号；
3. 必读文档缺失（`README` + `00`–`12`）；
4. 文档带 BOM（`no-bom.test.ts` 同款规则）；
5. `README.md` 没有索引所有必读文档（含 `11-HANDOFF-PROMPT.md`）；
6. `09-CURRENT-STATE.md` 缺少 `## 1. 版本与发布` 或 `## 5. 未完成 / 未验证`。

**警告（不阻塞）**：

- `BASELINE.json` 的 `testFiles` / `coreDirs` / `sqliteTables` / `tauriCommandAnnotations` 与实际不符。
- 开发期每天都会变，发版时 `docs:sync` 刷新即可；警告会打印在输出里。

---

## 6. 接到哪些地方

| 位置 | 作用 |
|---|---|
| `package.json` → `docs:sync` | 发版第一步刷新基线 |
| `package.json` → `audit:docs` | 单独检查 |
| `npm run verify` | 覆盖 + knip + jscpd + **文档门禁** |
| `npm run audit` | 结构审计整链 + **文档门禁** |
| `.github/workflows/ci.yml`（可选） | 若仓库启用 CI，可在 push/PR 时跑 `npm run audit:docs`；**注意本仓 `.github/` 目前被 `.gitignore` 忽略，不是仓库保证** |
| `docs/RELEASE-GUIDE.md` | 发版规程第 1 步（版本号 + 文档基线） |
| `AGENTS.md` §7 | 发版摘要第 2 步（版本号之后） |
| `docs/project-guide/08-ENGINEERING-GATES.md` | 构建发布章节的固定动作 |
| `docs/project-guide/11-HANDOFF-PROMPT.md` | 新 Agent 接手时先跑一次 `audit:docs` |

> 本地门禁的含义：**版本号改了、文档没更新，`npm run verify` / `npm run audit` 会红**。这不是“文档洁癖”，而是防止发布物与说明不一致。若以后把 `.github/` 纳入仓库，再把 `audit:docs` 接到 CI 即可。

---

## 7. 什么变化该更新哪份文档

| 变化 | 必须更新 |
|---|---|
| 版本 / 发布 | `README`、`00`、`01`、`09`、`CHANGELOG`、`PROJECT-GUIDE` 版本表 |
| 新增/删除 core 子域、关键文件 | `02-CODE-MAP` |
| 主链路（发送/工具/流式/压缩/审批/子代理/项目） | `03-RUNTIME-FLOWS` |
| 用户可见功能 | `04-FEATURE-MODULES` + `CHANGELOG` |
| 设置分区 / 布局 / 皮肤 / 令牌 | `05-UI-UX` + `docs/ui-spec.md` |
| 表 / 列 / 迁移 / 数据根 | `06-DATA-STORAGE` + `docs/STORAGE-INVENTORY.md` |
| Tauri 命令 / 执行器 / 安全边界 | `07-BACKEND-IPC` |
| 门禁 / 构建 / 发布命令 | `08-ENGINEERING-GATES`、`12`、`RELEASE-GUIDE` |
| 未完成项 / 新坑 | `09-CURRENT-STATE` + `docs/HANDOFF-NEXT-SESSION.md` |
| 新 Agent 交接方式 | `11-HANDOFF-PROMPT` |

---

## 8. 历史文档怎么处理

- 已过期的 `docs/PROJECT-GUIDE.md`、`docs/GAP-LIST.md`、`docs/TODO.md` 等**不删除**；在顶部加指针/历史横幅即可。
- 新文档只写“当前事实”；历史版本故事留在 `CHANGELOG` 与 `docs/HANDOFF-NEXT-SESSION.md`。
- 游戏线的 `docs/MONOPOLY-*`、`ART-*`、`docs/ref-analysis/` 属实验内容，不要混进主文档集；它们导致的 BOM/横幅失败单独处理。

---

## 9. 常见问题

**Q：发版频繁，每次都要改 6 处，太麻烦？**
A：`docs:sync` 已经把能机器算的（版本/计数）做完了；真正要手写的只有“这版改了什么、哪些没做完”两段。相比事后花半天找回状态，10 分钟是便宜的。

**Q：CI 因为我加了一个测试文件就红，合理吗？**
A：不会。测试文件数只是**警告**，不阻塞。硬错误只有版本/必读文档/BOM/索引/章节。

**Q：能不能让脚本自动改 README/09 的正文？**
A：不建议。叙述性内容（哪些没验、下一步）必须人判断；自动改写会把“没验”写成“已验”，比过期更糟。

**Q：Release Notes 里要不要写“更新文档”？**
A：不写。Release Notes 是用户视角；文档更新是维护者流程，写进 `RELEASE-GUIDE` 与 CI 门禁即可。用户不需要知道我们改了几份 md。

---

## 10. 第一次接入时怎么验证

```powershell
npm run audit:docs          # 应打印「文档门禁通过：version=1.16.331」
# 故意把 package.json 版本改成 9.9.9（不要提交），再跑：
npm run audit:docs          # 应红，并指出 README/00/01/09/BASELINE 版本不一致
# 改回后：
npm run audit:docs          # 应恢复通过
```

这就是“门禁真的会红”的变异自证。
