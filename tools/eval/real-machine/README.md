# 真机验证（打包 exe + 隔离副本）

这套脚本回答两个**只能真机回答**的问题：

1. 自动压缩在**打包应用**里会不会触发、横幅/标记/刷新是否一致；
2. 协作路由能不能让模型**真的调用**对应工具（不是"提示写好了"）。

## 铁律：只动副本

```powershell
# 1) 准备副本（checkpoint WAL、删 -shm、可选隔离工作区）
node tools/eval/real-machine/prepare-copy.mjs C:\Temp\codem-real
# 2) 用副本数据根 + 独立 WebView2 profile 启动打包 exe
$env:CODEM_DATA_HOME = "C:\Temp\codem-real\data"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222 --user-data-dir=C:\Temp\codem-real\wv2"
Start-Process "<repo>\src-tauri\target\release\codem.exe"
# 3) 驱动
node tools/eval/real-machine/verify.mjs C:\Temp\codem-real\data compaction "对话 5" "继续：把进度压缩成三条结论。"
node tools/eval/real-machine/verify.mjs C:\Temp\codem-real\data routing 1 "开个团队，把这件事按角色拆开做完"
```

**为什么必须 `checkpoint + 删 -shm`**：直接复制带 `-shm`/`-wal` 的库再启动，SQLite 可能以为旧进程仍持锁，
真机实测会出现 `fts.upsert` / `messages.upsert_index` / `events.append` 超过 60 秒的 IPC 超时，
写入被放弃（副本丢消息）并弹"只存在内存、重启会丢"的提示。那是**复制方式**的问题，不是产品缺陷；
`prepare-copy.mjs` 已经把这一步做掉。

## compaction

- 用**真实会话**（推荐）或 `--seed N` 造的合成会话来触发；合成会话必须同时写 `messages` 表与
  `sessions/<id>.jsonl`，否则压缩的隐藏状态/事件投影可能不一致；
- 想在小窗口下确定性触发：`--window 200000`（只改副本里的模型目录，不动产品默认值）；
- 输出：横幅文本 + 截图（`real-compact-banner.png`）、console 里的 `[compact] usage`、
  副本 DB 的 visible/hidden/压缩标记。
- 真机判据：`before.visible → after.visible` 变少、`hidden` 增加、`markers=1`，刷新后仍如此。

## routing

- 每个 prompt 新建会话，等"消息数 + 工具数 12 秒不变"再统计（否则会把还在继续的回合当成结束）；
- 输出每条的 `tool_calls` 计数；判定标准是**出现了该场景的路由工具**（`squad_list` / `subagent` /
  `list_sessions`+`handoff_to_new_session`），不是"回复里提到了它"；
- 建议 `--workdir` 准备隔离工作区，避免模型改动真实仓库；
- 每类跑多次才是转化率，单次只能证明"能转化"。
