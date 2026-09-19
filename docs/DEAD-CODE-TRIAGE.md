# 死代码分诊报告（knip「未使用文件」76 项）

> 第 62 轮产出；**只做分诊，未动任何代码**（2026-09-19 用户选择："只出分诊报告，先不动代码"）。
> 复现：`npx knip > .preview-shot/knip.txt`，再 `node .preview-shot/r64-knip-triage.mjs`（脚本与原始数据都在 `.preview-shot/`，不进仓库）。

## 0. 结论先行

> **状态更新（1.16.106）**：下面第 2 节的**两个簇已按你的判断清理完毕**（"旧的遗留物、以后不再走了"）——
> `src/core/capabilities/**` **25 个文件**与 `core/recovery/multi-layer.ts` + `multi-layer-index.ts`
> 共 **27 个文件已删除**，并顺带修掉一处界面假话（恢复面板标题"多层会话恢复"→"会话恢复"）。
> 删前做了三条确认（目录外零 import 说明符 / `provider/` 无反向依赖 / 动态 import 与配置无引用），
> 删后 `tsc` 0、336 文件 5830 通过、10 道门禁 exit 0（未接线扫描 825 文件）。
> 详见 `CHANGELOG.md` 的 1.16.106 条目。第 2 节的文字保留为**当时的判断依据**（历史记录，不改写）。

- knip 报 **76 个未使用文件**（另有 1 项 `Unlisted`/`tasklist` 噪声）。
- **不能按 knip 的字面结论删除**：其中 32 个是 `index.ts` 桶文件、12 个是**全局类型增强**文件
  （`declare module` —— 无需被 import 也生效）、3 个是 Vite 入口/别名、5 个是技能自带脚本
  （由技能在运行期调用）、4 个是构建期 stub。这些在 knip 的模型里"没有静态引用"，
  但在产品里**确实是活的**。
- **真正值得处理的是两个簇**（下面第 2 节，各有证据）：
  ① `src/core/capabilities/**` 12 个文件 —— **全仓零生产引用**；
  ② `src/core/recovery/multi-layer.ts` + `multi-layer-index.ts` —— 只有测试与一个界面文案提到，
  **没有生产代码在用**。
- 其余 40 余个文件需要**逐个读一遍**才能定性（本轮没有做，不许假装做过）。

## 1. 方法与它的局限（先说清证据强度）

对每个文件机械地做三件事，产出可复核的原始数据（`.preview-shot/knip-triage.json`）：

| 手段 | 说明 | 证据强度 |
| --- | --- | --- |
| 全仓文本搜索 | 搜 basename / stem / 相对路径（排除 node_modules、target、dist、两个 `.…-ref` 参考目录） | **弱**：`stem` 匹配会误命中（例如 `local.ts` 的 "local"），所以"有引用"不等于"真被引用" |
| 配置层引用 | `vite.config` 的 entry/alias、`tsconfig` 的 include、`package.json` 的 scripts、`index.html` | 强（配置就是加载依据） |
| 约定式生效 | 全局类型增强（`declare module`，不需 import 也生效） | 强 |
| 零引用 | 上面三条都空 ⇒ 最可能是真死代码 | 中（仍受"弱"那条限制，但方向明确） |

统计：**76** 个文件中，桶文件 **32**、含 `declare module` **12**、Vite 配置命中 **3**、
技能脚本 **5**、构建期 stub **4**、含 `@ts-nocheck` **30**；机械判定"零引用"的只有 **1** 个
（`src/core/recovery/multi-layer-index.ts`）。

> ⚠️ 一条方法教训（同一轮踩到并已记录在 `docs/AUDIT-ZERO-GAP.md` 第 5.2 节）：
> 我曾以为这些 `@ts-nocheck` 的类型增强文件是"假能力"，写探针 A/B 一量才发现
> **`@ts-nocheck` 只抑制本文件内的报错，不影响声明合并** —— 那句注释是对的。
> 所以本报告只给"证据 + 建议"，不给"结论式判决"。

## 2. 有证据的两个簇

### 2.1 `src/core/capabilities/**`（12 个文件）——全仓零生产引用

| 文件 | 证据 |
| --- | --- |
| `extensions/host-runner.ts`、`extensions/tool-cordis.ts`、`extra/tool-extra.ts` | 全仓（`src/`、`tools/`、配置、YAML）搜不到引用；只有本目录内部互相 import |
| `fs/_local-impl.ts`、`fs/local.ts`、`fs/tool-fs.ts` | 同上 |
| `sandbox/local.ts`、`shell/local.ts`、`shell/tool-bash.ts` | 同上 |
| `skill/filesystem.ts`、`skill/tool-skill.ts`、`subagent/in-process.ts` | 同上 |
| `web/search-deepseek.ts`、`web/tool-web.ts` | 同上 |

判据：`Get-ChildItem -Recurse src,tools -Include *.ts,*.tsx,*.mjs | Select-String "capabilities"`
在**该目录之外**只命中无关词汇（`capability-detector.ts` 的模型能力表、`browser-automate.ts` 的 `capabilities: {}`），
没有任何 registry / 插件清单 / 动态 import 指向这些路径。

**建议**（三选一，需产品决策）：
1. 这是对标 DSH 的**能力层雏形**、准备接线 → 在 `docs/PROJECT-GUIDE.md` 登记为"预留未接线"，
   并在 `knip.json` 里显式 ignore（**别让它一直以"看起来是死代码"的形态漂着**）；
2. 确认不做 → 整簇删除（12 个文件，删除前跑全量套件 + 真机冒烟）；
3. 只保留真正要用的那几个（例如 `tool-fs` / `tool-bash`），其余删除。

### 2.2 多层恢复：`multi-layer.ts` + `multi-layer-index.ts`

| 事实 | 证据 |
| --- | --- |
| 生产代码没人 import | 全仓搜 `MultiLayerRecovery` / `getMultiLayerRecovery`：只有 `multi-layer-index.ts` 自己 re-export |
| 界面里有一个**文案** | `src/components/RecoveryPanel.tsx:129` 显示"多层会话恢复" —— 但该面板用的是别的恢复机制 |
| 测试在用 | `src/test/recovery-keys.test.ts` 断言它的 storage 前缀（`codem-recovery`）—— 测的是**没人调用的实现** |

**这条比第 2.1 节更值得处理**：它同时具备"界面文案让用户以为有这功能" + "实现无人调用"，
正是本仓库反复吃的**"说得出来但没接线"**那一类。建议：先在 `RecoveryPanel` 里核对该文案指向的
真实机制（若指向别处 ⇒ 文案要改；若确实无实现 ⇒ 功能要么接线要么删文案与实现）。

## 3. 明确**不要**动的（knip 误报，各类都有依据）

| 类别 | 数量 | 为什么 knip 会报 | 判定依据 |
| --- | --- | --- | --- |
| `index.ts` 桶文件（含 `src/core/*/index.ts`） | 32 | 桶文件只为"按路径 import"服务，没人 import 就"未使用" | 多数是 Cordis 服务/插件的稳定入口；删了会让按路径引用失效 |
| 全局类型增强（`declare module`） | 12 | **无需被 import 也生效**，knip 看不到 | 探针 A/B 已证生效（见 `AUDIT-ZERO-GAP.md` 5.2） |
| 构建期 stub（`src/stubs/*`） | 4 | 通过 Vite alias 在打包时替换 | `vite.config` 命中 |
| 技能自带脚本（`skill-creator/scripts/*`） | 5 | 由**技能在运行期**调用（模型执行 `node …`），不是 import | 属技能包内容 |
| Vite 入口（`pet-main.tsx` 等） | 3 | 入口在 `vite.config` 里声明 | 配置命中 |

## 4. 还没定性的（40 余个）

包括若干**未被引用的界面组件**（`ActivityTimeline.tsx`、`ConversationComposer.tsx`、
`ConversationSession.tsx`、`rich-content/*`、`SkillAuditDialog.tsx`、`overlay-kit.tsx`）
与插件内部文件（`monopoly-game/*`、`library-ops/*`）。

判定它们需要逐个读：**"没被 import"可能是**（a）真死代码；（b）通过动态注册/字符串键加载；
（c）插件被外部按目录加载。本轮**没有**做这件事，也**不声称**做过。

## 5. 建议的处理顺序（若之后要动手）

1. 先做 2.2（多层恢复）——量级最小、且涉及"界面是否在说假话"；
2. 再做 2.1（capabilities 簇）——量级中等，需产品决策；
3. 最后逐类清第 4 节——每一类**单独一个包**，删完跑全量套件 + 真机冒烟（`tsc` 0 / 0 失败 / 真机能开）；
4. 全程**不要**用 knip 的退出码当门禁（它会因为误报长期红着，红久了就没人看了）。
