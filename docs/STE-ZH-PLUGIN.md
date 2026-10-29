# STE-ZH 汇报插件

`@codem/ste-zh` 是一个独立的 Codem 内置插件，用来把 Agent 的**汇报文字**约束成简化技术中文（参考 ASD-STE100 原则）。

## 使用

- 入口：对话顶部工具栏的「STE 汇报规范」按钮（方形对话图标）。
- 按钮显示 `已开启` / `已关闭`；点击立即切换。
- 只影响**下一轮** Agent 回复；历史消息不重写。
- 设置键：`codem-ste-zh-enabled`（默认关闭）。

## 规则范围

启用后注入主 prompt 的规则只有一组短段，核心是：

- 结论先行，不写“我先…然后…”的过程流水账；
- 工作状态只用固定词，且“已完成”不等于“已验证”；
- 修复效果/运行行为/检查结果写命令、结果、覆盖范围；
- 未执行写“未验证”，缺证据写“未确认”并写确认方法；
- 代码写 `路径:行号`，命令写完整命令；
- 需要用户决定时列编号选项，推荐项放第一；
- 子智能体对主智能体用紧凑字段：`status/scope/changed/verified/unverified/evidence/open`。

明确不改变：

- 代码、注释、commit message；
- Agent 写入项目的文件；
- 用户指定的输出格式（用户格式优先）。

## 插件形态

- 插件名：`@codem/ste-zh`；
- 装配：`config/codem.base.yml` 的 `ste-zh` 条目（`core: true`，保证顶部按钮在关闭时也能重新开启）；
- Cordis provider：`src/core/provider/ste-zh-provider.ts`，提供 `steZh` 服务；
- 规则与设置：`src/core/ste-zh/index.ts`；
- UI：`src/components/SteZhToggle.tsx`，挂在 `ChatPanel` 顶部工具栏。

## 与外部 DSH 插件的关系

Codem 的外部 DSH 插件管理只负责 npm 安装/升级，不执行插件代码，也不给外部插件提供 React 渲染入口。因此本插件采用 Codem 的 Cordis 插件生命周期（与 DSH 插件同构的声明式装配），而不是伪装成一个能注入 Codem 界面的 npm 包。

如果只需要在 DSH 侧使用提示词规范，可以另外使用 ste-zh 的 `SKILL.md`；它不会出现 Codem 的顶部按钮，也不能由 Codem 插件管理器启停。

## 验证

- `src/test/ste-zh.test.ts`：默认关闭、开启后规则段、system prompt 注入/不注入；
- `src/test/ste-zh-provider.test.ts`：provider 服务面与设置一致；
- `src/test/ste-zh-toggle.test.tsx`：按钮 aria 状态与点击开启。

规则是提示词约束，不是验证器；它不能保证 Agent 不编造，关键结论仍要主 agent 或用户复核。
