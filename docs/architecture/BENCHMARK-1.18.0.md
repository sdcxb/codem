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
