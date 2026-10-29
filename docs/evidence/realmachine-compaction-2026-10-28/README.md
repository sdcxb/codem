# 自动压缩 / 退出路径 真机实验（2026-10-28）

口径：连 **release 构建的真实窗口**（CDP），模型 `deepseek-flash`，本机数据全为测试数据。

## 1. 自动压缩：**没有触发**，而且原因本身是一个缺陷

两次实验（`_compaction-e2e.mjs` / `_compaction-e2e2.mjs`）：

| 尝试 | 做法 | 结果 |
|---|---|---|
| v1 | 点开侧栏「对话 43/44/42…」找最长会话 | 侧栏都是 5–11 条消息（大文件是更早的会话，默认折叠）⇒ 压力远不到 70% |
| v2 | 新建会话，发一条 **40 万字符** 的用户消息（≈14 万 tokens）再要求「只回答 1」 | 回合正常完成，回执显示 **141K 入 / 18 出**，**没有任何压缩发生**（日志与 console 都没有压缩记录） |

原因（代码级）：`src/core/llm/provider.ts::inferContextWindow` 对**任何**含 `deepseek` 的模型返回
**1,000,000** tokens ⇒ 70% 阈值 = 70 万 tokens ≈ **280 万字符**。也就是说：

- 对 `deepseek-flash` 这个档位，自动压缩**实际上永远不会触发**；
- 而真实 API 的窗口远小于 100 万 ⇒ 长会话会**先撞服务端的上下文上限报错**，而不是被本地压缩接住。

这是一条**真缺陷候选**（不是"没测到"，是"测出它不会发生"）。是否改、怎么改属于产品决策
（见移交单 §11.17）：改窗口推断会影响"多久压缩一次"的体感与成本。

截图：`compaction-pressure.png`（40 万字符那条消息 + 回执 141K 入）、`compaction-after-send.png`。

## 2. 退出路径：`quit_app` → 进程消失 **35 ms**，无残留

托盘物理点击**无法自动化**（两次实测）：
- Codem 托盘图标被折叠进 Windows「隐藏的图标」溢出区；
- 打开溢出区后 Win32 弹出菜单**不暴露给 UIAutomation**（找不到「退出」项）。

因此量的是**真实退出路径的尾部**：`renderer invoke('quit_app')` —— 用户点「退出」或托盘
`quit-requested` 之后调用的就是它（`App.tsx::handleCloseChoice` / `listen("quit-requested")`）。

结果（`_quit-e2e.mjs`）：

```json
{ "ok": true, "quitInvokeToProcessGoneMs": 35, "leftoverCodemProcesses": 0 }
```

「有没有黑框」**无法程序化判定**，未做测量、也不声称。
