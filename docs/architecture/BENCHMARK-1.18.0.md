# 1.18.0 跨实现评测记录（Codem vs DSH）

> 日期：2026-11-04 ｜ 模型：`deepseek-flash`（两侧同模型） ｜ 任务集：`tools/eval/tasks-repo.mjs` 的 12 个真实仓库修复任务
> 原始记录：`.preview-shot/eval-records-repo-control-v118.jsonl`、`.preview-shot/eval-records-codem-repo-v118.jsonl`
> 官方报告：`.preview-shot/repo-paired-v118.txt`

## 结果

| 指标 | Codem 1.18.0 | DSH |
|---|---:|---:|
| 通过任务 | **10 / 12** | **9 / 12** |
| 每任务平均总 token | **11.9M** | 23.2M |
| 每任务平均输入 token | 458,586 | 131,097 |
| 每任务平均输出 token | 44,717 | 26,761 |
| 每任务平均 cache read | 11.4M | 23.1M |
| 每任务平均耗时 | 644s | 415s |
| 平均工具调用 | 80.7 | 80.8 |

逐任务差异：`repo-02` Codem 通过、DSH 未过；`repo-11` / `repo-12` 两侧都未过；其余相同。

## 均值为什么会被拉高

`input` 桶只统计**未命中缓存的输入**，不含 cache read；`total = input + output + cacheRead`。因此 DSH 的总 token 很高（27.7 亿 cache read），但真正未缓存的输入只有 157 万；Codem 反过来：总 token 更低，但 cache read 更少、未缓存输入更多。

均值又被单个长尾任务 `repo-06` 放大：

| 口径 | Codem 输入均值 | DSH 输入均值 | Codem 输出均值 | DSH 输出均值 |
|---|---:|---:|---:|---:|
| 12 任务均值 | 458,586 | 131,097 | 44,717 | 26,761 |
| 去掉 `repo-06` | 114,319 | 128,220 | 30,575 | 25,478 |
| 中位数 | 106,043 | 136,732 | 24,406 | 20,563 |

`repo-06` 本身：Codem 104.5M total / 4.25M 未缓存输入 / 200,280 输出 / **234 次迭代、283 次工具调用**；DSH 35.9M / 162,753 / 40,884 / 114 次工具调用。它是一次真实的长尾反复试错，不是记账错误；但它说明 Codem 在“失败后反复验证”的路径上仍需优化。


## 口径与限制

- **每个任务只跑 1 次**；官方报告标记 `insufficient-repetition`。这是方向性对比，不是统计显著结论。
- DSH 的 `repo-09` 记录因越界读取被标为**污染**，报告按纪律不把它当作加分依据。
- 总 token 更低主要来自 cache read 更低；**输入/输出 token 反而更高**，耗时也更长——不能写成"全面优于"。
- 同一模型的 API 路由不同（Codem 走自身配置；DSH headless 用同一 DeepSeek API key 路由），因此延迟只作参考。

## 命令

```powershell
node tools/eval/repo-paired-report.mjs `
  --control .preview-shot/eval-records-repo-control-v118.jsonl `
  --treatment .preview-shot/eval-records-codem-repo-v118.jsonl
```
