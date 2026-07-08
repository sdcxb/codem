# Codem 待办事项

## 待开发

### MSI 安装包中文向导
- [ ] 在 `tauri.conf.json` 的 `bundle.windows.wix` 中配置 WiX 多语言（zh-CN + en-US）
- [ ] 重新构建 MSI 安装包，确认安装向导界面支持中英文
- [ ] 更新 Release 中的 MSI 文件

### 版本发布流程备忘
每次发版需完成以下步骤：
1. `git commit` + `git tag vX.XX` + `git push origin master --tags`
2. `gh release create vX.XX --title "..." --notes-file release-notes.md`
3. `npm run tauri build` 构建生产版安装包
4. `gh release upload vX.XX` 上传 exe + msi 到 GitHub Release

## 已完成

### 多语言支持 (2026-07-08)
- [x] 创建 `src/core/i18n/lang.ts` 语言管理模块（getLang/setLang/isZh/isEn）
- [x] 系统提示词 `prompt.ts` 支持双语（Language 段 + 末尾语言规则段按 getLang() 切换）
- [x] 子智能体系统提示词 `index.ts buildSubagentSystemPrompt` 全面双语（身份/语言规则/任务执行/编码规则）
- [x] Agent 定义 `agent.ts` 新增 `promptEn` 字段（plan/explore/general 三个角色英文版）
- [x] 工具返回文本 `tools.ts` 双语（spawn_subagent/wait_for_subagent 所有标签和错误消息）
- [x] `parseTaskResult` fallback 默认值双语
- [x] `spawner.ts` 工具结果标记双语（[工具结果] / [Tool Results]）
- [x] `MessageBubble.tsx` 子智能体状态显示双语
- [x] `SettingsPanel.tsx` 新增语言选择器（中文/English）
- [x] `App.tsx` 启动时检测安装器类型自动设置默认语言
- [x] Rust 后端新增 `get_installer_default_lang` 命令（注册表检测 NSIS=zh / MSI=en）
- [x] `tauri.conf.json` 配置 NSIS 中英文双语 + WiX 英文

### v0.77 (2026-07-07)
- [x] 修复子智能体调用后主任务思考过程变为英文（5 个英语污染源）
- [x] 修复主任务思考过程全英文问题（系统提示词末尾追加强力中文语言规则）
- [x] 修复工具调用窗口子智能体名称显示（正则兼容中英文格式）
- [x] 清理代码注释中所有对标产品名称（Codex、Claude Code 等）
- [x] 修复 prompt.ts 未转义反引号导致编译错误
- [x] 修复测试文件类型安全问题
- [x] Release v0.77 发布，附带 exe + msi 安装包
