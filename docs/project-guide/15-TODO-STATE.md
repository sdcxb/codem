# 15 视觉重做 · 持久 Todo

> 全量功能/性能/数据/记忆审计的交接与执行清单见 `docs/audit/FULL-SYSTEM-AUDIT-HANDOFF.md`。

> 这份文件是 UI todo 被会话投影吞掉时的权威副本。每完成一项就改这里。

## 未完成

- [x] Phase 4：其余设置 tab 行式化 + 控件右缘对齐（2026-10-29 逐 tab 验收）
  - [x] 外观 7 行
  - [x] 通用模型行 / 身份块（身份块是 `--identity-options` 多列布局，不是 200px 列）
  - [x] 模型/工具/知识/设备 tab：**标准行式设置的控件右缘偏差全部 0px**，23 tab 无横向溢出
  - 证据：`docs/evidence/settings-tabs-audit-2026-10-29`（23 张截图 + readings.json）
  - 例外（**设计如此，不改**）：`模型` 组合行（select+按钮）、身份块、`provider-group` 卡片内缩 12px、
    `字体粗细` 滑杆行、安全页 `工具名` 自定义块 —— 逐条写在证据 README 里
- [x] Phase 2：运行/停止/完成/失败四态均已真实取证
- [x] Phase 3：IME 组合/提交 + 真实 chips 取证
- [x] Phase 1：40 行滚动 + 键盘 focus；会话行已补 role/tabindex/Enter
- [x] Phase 0：OMP 三列表落盘 `phase0-phase1.md`（OMP 0.75× 已更正）
- [x] Phase 5：1600/1280/1024 + 真实 125%/150% 主界面/设置页 + 折扣台账
- [x] Phase 6：右侧 Inspector（改动/文件/子代理、文件行、检查行、上下文、diff 预览、footer）对标 400px
  - 2026-10-29 核对：`RightSidebar` 已有 文件/改动/子代理/浏览器 四 tab、`inspector-context`、`inspector-foot`、
    子代理列表、点文件开 diff 预览；默认 400（≤1440 为 360）。此前 Phase C 补了「最近一轮 + 检查行」
- [x] 全部验收物齐后：全量测试 + `npm run audit` + 修复 + 复审计
  - 2026-10-29：`tsc 0`、767 文件 / 8665 用例通过、`npm run audit` exit 0（本轮已反复跑到绿）

## 已完成提交

- `200f154a` 通用/外观直系行式
- `80b2a6ea` 125/150 设置页证据
- `ccfb1b69` 外观 7 行
- `eb32ae92` 工具组左缘 x=347
- `2389ad48` 运行模式 46px 行式
- `6c931133` 6 组设置 IA
