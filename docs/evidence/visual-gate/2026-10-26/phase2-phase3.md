# Phase 2/3 运行态证据（部分）

## 已取证

| 状态 | 截图 | sha256(16) | 条件 |
|---|---|---|---|
| 完成 | C:\temp\visual-gate\phase2-completed.png | $h | 安装版，当前会话显示“任务完成”胶囊；.sidebar-session 47 个 |

## 未取证（unknown）

- 运行中、失败、停止：需要真实回合；本轮全量测试后应用状态被重置，自动触发会消耗真实模型调用，未伪造。
- IME 三态：CDP 直接 dispatch CompositionEvent 不能驱动 React 受控 textarea，读回值仍是 
ihao，不能作为验收证据；已放弃该伪造路径。
- 上下文 chips：当前项目无可匹配文件时 @ 列表为空，未截到真实 chip。

下一步需要在 UI 里手动发一条真实消息并在运行/停止/失败时截图；不得用注入 DOM 代替。
