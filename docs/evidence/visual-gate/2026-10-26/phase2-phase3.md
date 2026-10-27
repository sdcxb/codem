# Phase 2/3 运行态证据

## Phase 2

| 状态 | 截图 | sha256(16) | 取证 |
|---|---|---|---|
| 运行中 | `phase2-running.png` | `D07A30A982BFB298` | 真实 sleep 8，显示“处理中”+停止键 |
| 停止 | `phase2-stopped.png` | `D3C0A467169E10CB` | 点击 `.cancel-btn` |
| 完成 | `phase2-completed.png` | `B643DF4EBB67D9E4` | 真实回合结束 |
| 失败 | unknown | — | 退出码 1 只在正文解释，未出现独立失败工具卡 |

## Phase 3

| 项 | 截图 | sha256(16) | 读回 |
|---|---|---|---|
| IME 组合 | `phase3-ime-composing.png` | `215C6D1F583A7BBF` | `nihao` |
| IME 提交 | `phase3-ime-committed.png` | `0B8F7B6027A3E2FC` | `你好` |
| 上下文 chips | `chips-inspector-final.png` | — | `.context-badge` 高 28，accentsurface 背景 |

IME 使用 CDP `Input.imeSetComposition` + `Input.insertText`，受控 textarea 正常，无重复字符。

## Phase 6

- 右栏 tab 行高已从 36 调到 40（`right-sidebar-tabs`）。
- 右栏可拖 300–800，8px 热区，折叠条 24。