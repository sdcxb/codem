# Phase 2/3 运行态证据

## Phase 2 四态

| 状态 | 截图 | sha256(16) | 取证 |
|---|---|---|---|
| 运行中 | `phase2-running.png` | `D07A30A982BFB298` | 真实 sleep 8，显示“处理中”+停止键 |
| 停止 | `phase2-stopped.png` | `D3C0A467169E10CB` | 点击 `.cancel-btn` |
| 完成 | `phase2-completed.png` | `B643DF4EBB67D9E4` | 真实回合结束 |
| 失败 | `phase2-failed.png` | `1CD9A2555533D380` | 真实 `exit 1`，工具卡 `data-state="error"` |

失败态修复：`ToolCallCard` 原来只看 `status==="error"`，bash 非零退出码仍画成功；已补 metadata/输出退出码识别。

## Phase 3

| 项 | 截图 | sha256(16) | 读回 |
|---|---|---|---|
| IME 组合 | `phase3-ime-composing.png` | `215C6D1F583A7BBF` | `nihao` |
| IME 提交 | `phase3-ime-committed.png` | `0B8F7B6027A3E2FC` | `你好` |
| 上下文 chips | `phase3-chips.png` | `213C9264CD1E91BE` | `.context-badge` 高 28，accent-surface |

## Phase 6

- 右栏 tab 高 40。
- 右栏可拖 300–800，8px 热区，折叠条 24。