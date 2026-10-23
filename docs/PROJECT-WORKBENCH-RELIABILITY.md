# 项目工作台可靠性：并发与进程回收（2026-10-23）

## 1. 事故：并发把电脑压死

真机现象：

- 多个 thread / 自动化会话同时进入 `runAgenticLoop`；
- 每个回合都可能起工具子进程、模型流、浏览器/WebView；
- 同时删会话时，loop 还在写消息，出现：
  - `FOREIGN KEY constraint failed`（会话已删，消息还在插）；
  - `消息列表归属不一致`（A 会话的列表被要求写进 B）。

根因：

1. **只有同会话并发守卫，没有全局并发上限**；
2. 删除会话只删数据，没有先 abort 正在跑的 loop；
3. 自动化 timer 的 `trigger` 是 start 时快照，`lastTriggered` 永远不更新 ⇒ cooldown 形同虚设，同一 trigger 会连建会话；
4. 测试并发（vitest 727 文件）本身也吃 CPU/内存，和 app 同时跑会放大问题。

## 2. 修法

### 2.1 机器感知的硬上限

`src/core/session/executor.ts`：

```ts
getConcurrencyLimit():
  内存 <= 4GB → 1
  16 核以上 → 3
  8–15 核 → 2
  其它 → 1
```

`runAgenticLoop` 在 `startSessionExecution` 前检查活跃回合数；
超限时拒绝并写进归属会话：

```
[Error] 同时运行的回合已达上限（N/N）。为避免拖垮电脑，请等一个回合结束再发。
```

并登记 `app.concurrency` 上报点（action）。

### 2.2 删除会话先 abort loop + 墓碑短路

- `src/core/session-abort-registry.ts`：按 sessionId 登记 AbortController；
- App 启动 loop 时注册，finally 注销；
- `store.deleteSession` 先 `abortSessionLoop(sessionId)`，再删；
- `src/core/storage/session-tombstones.ts`：删除后进程内标记；
- `MessageStorage.createMessage` 对“已删除且 DB 里确实没有”的会话直接跳过，
  `telemetry.flush` 也过滤这些会话的事件 —— 不再撞 `message.createMessage.index` / `telemetry.flush` 的 FK；
- `saveMessages` 同样跳过。

### 2.3 自动化冷却

`TimerEngine.fire` 每次从最新配置取 trigger，而不是用闭包里的旧快照；
`lastTriggered` 真正生效，同一 trigger 在 cooldown 内不会重复建会话。

## 3. 测试浏览器回收

### 3.1 测试脚本杀进程树

`site/e2e.mjs` / `site/shot.mjs` 原来只 `edge.kill()`，Edge 子进程会残留。
改为：

```
taskkill /PID <pid> /T /F
```

### 3.2 清理孤儿 dev server

强杀 Codem 后 Vite 可能还占着 1420，下一次 `tauri dev` 直接失败：

```bash
node tools/maintenance/clean-orphan-dev.mjs          # 只在 codem.exe 不在时动手
node tools/maintenance/clean-orphan-dev.mjs --apply
```

### 3.3 清理遗留无头 Edge

新增：

```bash
node tools/maintenance/clean-orphan-test-browsers.mjs          # 只打印计划
node tools/maintenance/clean-orphan-test-browsers.mjs --apply  # 杀进程树
```

只匹配测试标记（`codem-site-e2e-` / `codem-shot-` / `remote-debugging-port=933`），
不碰用户正常 Edge。

## 4. 真机验证（2026-10-23 重启后）

- 复现：创建会话 → 发 `ping` 长命令 → 4 秒后删除；
- 修复后：**无 `FOREIGN KEY`、无 `数据保存失败` 横幅、无遗留 ping 进程**；
- 清理：旧 cooldown bug 留下的 **37 个自动化测试会话**及其 thread 全部删除；
- 自动化 trigger 已加“并发满则跳过”，避免再堆会话；
- 全量 `--maxWorkers=2`：**729 文件 / 8485 通过 + 17 skipped**。

## 5. 本机复查（重启后）

- 当前无 Codem 进程，无测试遗留 Edge；
- 唯一大体量后台是用户自己的 Edge/QQ/DSH/REA watchdog，不是测试残留；
- 全量测试改用 `npx vitest run --maxWorkers=2`：728 文件 / 8483 通过 + 17 skipped；
- 默认并行下 `CLI-1` 仍有已知 libuv 抖动（单独跑 18/18），不再用默认并行压机器。

## 5. 后续

- 并发上限做成设置项（按机器/项目调）；
- 自动化触发保留“排队”而不是直接拒绝；
- 增加内存水位（>85% 时暂停新回合）；
- 测试批次与 app 不同时跑（构建/评测互斥）。
