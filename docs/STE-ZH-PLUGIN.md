# STE-ZH 汇报插件

`@codem/ste-zh` 是一个独立的 Codem 内置插件，用来把 Agent 的**汇报文字**约束成简化技术中文（参考 ASD-STE100 原则）。

## 使用

- 入口：对话顶部工具栏的「STE 汇报规范」按钮（方形对话图标）。
- 三态循环：**关 → 智能 → 全量 → 关**。
- 只影响**下一轮** Agent 回复；历史消息不重写。
- 设置键：`codem-ste-zh-mode`（`off|smart|full`，默认 `off`）；旧键 `codem-ste-zh-enabled` 仅作兼容。

| 模式 | 行为 |
|---|---|
| 关 | 不注入任何规则 |
| 智能 | 按回合结构自动选最小/完整/子 agent 字段 |
| 全量 | 始终注入完整规则 |

### 智能模式怎么选

- 子 agent 向主 agent 汇报 → 注入「必须调用 `report` 工具」的字段契约；runtime 校验坏报告，缺报告按 `unknown` 结算，不再默认 success；
- 用户说「简短 / 简要 / 一句话」→ 最小规则；
- 用户说「汇报 / 总结 / 排查 / 结论 / 决定 / 验收」→ 完整规则；
- 普通短请求（≤120 字）→ 最小规则；
- 其余 → 完整规则。

`prompt` 在工具执行前构造，所以智能模式**不猜**“这轮会不会跑测试”。`已验证` 是否成立由回复后校验处理。

## 规则范围

启用后注入的规则只约束汇报文字，核心是：

- 结论先行，不写“我先…然后…”的过程流水账；
- 工作状态只用固定词，且“已完成”不等于“已验证”；
- 修复效果/运行行为/检查结果写命令、结果、覆盖范围；
- 未执行写“未验证”，缺证据写“未确认”并写确认方法；
- 代码写 `路径:行号`，命令写完整命令；
- 需要用户决定时列编号选项，推荐项放第一；
- 子 agent 调用 `report` 工具，参数 `status/summary/changed/verified/unverified/open`；`verified` 每项含 `{command, ok, source}`，`source=caller` 表示调用方提供，不能算 agent 验证。

明确不改变：

- 代码、注释、commit message；
- Agent 写入项目的文件；
- 用户指定的输出格式（用户格式优先）。

## 回复后告警

只提示，不改写正文。当前抓一种高价值错位：

- 正文声称“已验证”，但本轮没有任何 `bash/pwsh` 测试、构建、类型检查命令 → 显示黄色告警，要求核对证据或改成“未验证/未确认”。

它不能证明其他事实为真；主 agent 仍应抽查命令输出。

## 插件形态

- 插件名：`@codem/ste-zh`；
- 装配：`config/codem.base.yml` 的 `ste-zh` 条目（`core: true`，保证顶部按钮在关闭时也能重新开启）；
- Cordis provider：`src/core/provider/ste-zh-provider.ts`，提供 `steZh` 服务；
- 规则与策略：`src/core/ste-zh/index.ts`；
- UI：`src/components/SteZhToggle.tsx`（三态开关）、`SteZhReportNotice.tsx`（回复后告警）。

主 agent 的 `buildSystemPromptAsync` 和子 agent 的 `buildSubagentSystemPrompt` 都已接入。子 agent 的最终结算以 `report` 结构化结果为准；没有 `report` 时 `parseTaskResult` 返回 `unknown`，不默认成功。

## 与外部 DSH 插件的关系

Codem 的外部 DSH 插件管理只负责 npm 安装/升级，不执行插件代码，也不给外部插件提供 React 渲染入口。因此本插件采用 Codem 的 Cordis 插件生命周期（与 DSH 插件同构的声明式装配），而不是伪装成一个能注入 Codem 界面的 npm 包。

如果只需要在 DSH 侧使用提示词规范，可以另外使用 ste-zh 的 `SKILL.md`；它不会出现 Codem 的顶部按钮，也不能由 Codem 插件管理器启停。

## 验证

- `src/test/ste-zh.test.ts`：三态、智能选模、prompt 注入、假验证告警；
- `src/test/ste-zh-provider.test.ts`：provider 服务面；
- `src/test/ste-zh-toggle.test.tsx`：三态按钮；
- `src/test/ste-zh-report-notice.test.tsx`：回复后告警显示/隐藏；
- `src/test/subagent-report-contract.test.ts`：报告契约/信封往返；
- `src/test/subagent-report-tool.test.ts`：report 工具拒绝坏报告、旧 output 兼容。

规则是提示词约束，不是验证器；`verified` 字段仍要主 agent 复核。
