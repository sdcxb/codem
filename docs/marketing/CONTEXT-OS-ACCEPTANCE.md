# Context OS 宣传页：承诺追溯与验收门禁

> 页面：`docs/marketing/context-os.html`
> 清单：`docs/marketing/context-os.claims.json`
> 门禁：`tools/marketing/verify-context-os-claims.mjs`

**页面结构**：

- 首页：`context-os.html`（是什么 / 痛点 / 能力 / 四层协作）
- 技术总览：`context-os-details.html`（四张技术线入口 + 完整说明）
- 四条技术线：
  - `context-thread.html`（对话与工作段）
  - `document-os.html`（长文档）
  - `memory-graph.html`（记忆）
  - `agent-delivery.html`（交付对账 / Agent 协作）

首页每个能力块和底部卡片都直接链到对应技术线；claims 门禁只锚定首页的 `data-claim`，详情页不重复声明，避免两套承诺。

## 0. 先说清楚它不是什么

它不是“跑一遍就能证明产品达标”的测试器。它只防一件事：

> **页面上的承诺，没有对应的验收条目和证据。**

真正的功能正确性，仍然靠仓库的测试、变异自证、真机验证和独立复核。宣传页不能代替测试；测试也不能代替用户价值判断。

---

## 1. 为什么不能直接让另一个对话“看 HTML 自己判断”

因为那会变成：

- 它说“看起来实现了”，但没有证据；
- 它改一句文案，页面就“达标”了；
- 它把 `target` 写成 `verified`，但没人能复查；
- 页面改了，旧验收还挂着。

所以采用三层：

```text
HTML 页面（表达）
  ↕ data-claim
claims 清单（承诺 + tier + 验收口径）
  ↕ pageSha256
verification 报告（真实测试/截图/人工验收证据）
```

页面是冻结的。页面一改，哈希变，旧验收自动失效。

---

## 2. 文件职责

| 文件 | 职责 |
|---|---|
| `context-os.html` | 对外表达；每个关键承诺带 `data-claim="Cxx"` |
| `context-os.claims.json` | 承诺清单：id、tier、status、owner、evidence、acceptance |
| `context-os.verification.json` | 实现后填写：每条 claim 的 verified/partial/目标状态 + 证据 |
| `verify-context-os-claims.mjs` | 检查页面/清单/报告是否一致；不跑测试 |
| 本文件 | 使用说明、验收纪律、给新对话的提示 |

---

## 3. 三条命令

在仓库根目录：

```powershell
# 1) 追溯检查：页面与清单是否互相覆盖、证据路径是否存在
node tools/marketing/verify-context-os-claims.mjs --mode traceability

# 2) P0 门禁：清单里 tier=P0 的 claim 必须全部 verified
node tools/marketing/verify-context-os-claims.mjs --mode gate --tier P0

# 3) 全量门禁：所有 claim 必须 verified（最终宣传前）
node tools/marketing/verify-context-os-claims.mjs --mode gate --tier all

# 打印当前页面哈希（冻结/更新时用）
node tools/marketing/verify-context-os-claims.mjs --print-hash
```

退出码：`0` 通过，`1` 失败，`2` 参数错误。

---

## 4. verification 报告格式

实现方在 `docs/marketing/context-os.verification.json` 写：

```json
{
  "schema": "codem.context-os.verification.v1",
  "pageSha256": "<与 claims 清单一致>",
  "generatedAt": "2026-11-06T12:00:00+08:00",
  "claims": {
    "C01": {
      "status": "verified",
      "evidence": [
        "src/test/context-epochs.test.ts",
        "docs/marketing/evidence/thread-continuity.png"
      ],
      "notes": "3 次 switch 后仍为同一 Session；截图见 evidence。"
    }
  }
}
```

规则：

- `verified` 必须有证据；不能只写“已实现”。
- 证据可以是：
  - 测试文件路径；
  - 截图/录屏路径；
  - 真机验收记录路径；
  - 具体命令 + 输出摘要（写进 notes，但 evidence 仍要有可复查文件）。
- `partial` / `target` 不算通过 P0/P1 门禁；只有 `verified` 算。
- 页面哈希不一致时，任何 gate 都失败；必须重新评审页面并更新 `pageSha256`。

---

## 5. 当前 claims 与 tier

以 `context-os.claims.json` 为准。当前：

- **P0**：C01 连续 Thread、C02 原文保留、C03 最小工作集、C04 Manifest、C09 记忆不自动删改、C12 来源/审批/回滚、C13 用户不做上下文管理（**默认关闭时只承诺「开启后 0 次」**）。
- **P1**：C05 文档结构、C06 文档账本、C07 长文档流水线、C08 Memory Graph、C10 Artifact Agents、C11 本地优先。

初始状态曾是 `partial` / `target`，P0 gate 当时**应当失败**（不是 bug，是「还没证明」）。2026-11-06 收口后 P0 七条全部 shipped/verified，P0 gate 通过；P1 未达标项仍如实保留 partial/target。

---

## 6. 页面冻结流程

任何文案/视觉改动后：

1. 重新评审页面；
2. `node tools/marketing/verify-context-os-claims.mjs --print-hash`；
3. 把新哈希写进 `context-os.claims.json` 的 `pageSha256`；
4. 重新生成/更新 `context-os.verification.json`（旧报告自动失效）；
5. 跑 traceability + P0 gate；
6. 由独立复核者看 diff 与证据。

**禁止**：为了让 gate 变绿而删 claim、把 `verified` 改成 `target`、或改页面文案绕开验收。

---

## 7. 给另一个对话的提示（可直接粘贴）

```text
你实现完 Context OS 后，不要只说“完成了”。
请按 docs/marketing/CONTEXT-OS-ACCEPTANCE.md 做宣传页验收：

1. 先跑测试/真机验证，拿到证据；
2. 为每条 claim 写 docs/marketing/context-os.verification.json：
   - status=verified 必须有 evidence；
   - target/partial 如实写，不要冒充 verified；
   - 证据路径必须是仓库里真实存在的文件/截图；
3. 跑：
   node tools/marketing/verify-context-os-claims.mjs --mode traceability
   node tools/marketing/verify-context-os-claims.mjs --mode gate --tier P0
4. 如果失败，修实现或补证据；不要改页面/清单来绕过。
5. 最后交：verification JSON + 测试输出 + 截图 + 仍未达标的 claim 列表。
```

---

## 8. 视觉宣传的边界

页面好不好看、文案有没有打动用户，**不能**由这个脚本判断。

视觉验收单独做：

- 1440 / 1024 / 390 三档截图；
- 深色背景对比度检查；
- 中文字体 fallback；
- `prefers-reduced-motion`；
- 无横向滚动；
- 所有锚点可跳转。

这些属于人工/截图复核，不塞进 claims 的“功能 verified”里，避免把审美问题和功能问题混在一起。
