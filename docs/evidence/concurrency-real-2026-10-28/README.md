# 真实模型 3 并发（2026-10-28 · 用户批准项 B4）

模型：`deepseek-flash`。口径：release 构建的真实窗口（CDP 驱动 UI），
连开 3 个新会话、每个发一个「要几秒」的任务（解释 + 5 行代码），间隔 150 ms，等 60 s 后从数据库核对。

## 读数（`readings.json`）

| 会话 | user 消息 | assistant 消息 | 回合时间窗（相对首条发送） |
|---|---|---|---|
| `…h2bp0qlxc` | 1 | 1 | [538, 2086] ms |
| `…1w8f099hq` | 2 | 3 | [1249, 8790] ms |
| `…33nqat271` | 2 | 4 | [1967, 17797] ms |

- 3 个会话**全部完成**（assistant 回复都落库）。
- **两两时间窗都相交**（`overlappingPairs = 3`）⇒ 三个回合确实在并行跑，不是排队。

## 这条证据的边界（别夸大）

- 它证明的是「3 个**不同会话**的回合并行完成」；
- 同一条会话内多路并发的**状态隔离**（用量/中止信号/事件流不串）由
  `src/test/concurrency-three-sessions.test.ts` 的 CONC-1…5 钉住（确定性夹具）；
- 真实模型的**长期稳定性**（连续几十轮、失败率）不在这次范围内。

复现：`node .preview-shot/_concurrency-real2.mjs docs/evidence/concurrency-real-2026-10-28`
（需要设置 `$env:PYTHON` 指向可用的 Python；脚本只读数据库做核对）。
