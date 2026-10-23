# 审计报告：真实 PR + 删除运行中会话杀进程树

日期：2026-10-23
范围：Codem 主仓 `b1da8b46` + 生命周期项目 `site-lifecycle-r1`

## 一、本轮改动

### 1. 真实项目 PR

- 私库：`https://github.com/sdcxb/codem-site-lifecycle`
- 真实 PR：[#1](https://github.com/sdcxb/codem-site-lifecycle/pull/1)
- base `main`（基线 `a656450`）/ head `feature/use-cases`
- 项目报告 `pull_request` 指向该 PR，`syncPullRequests` 用 `gh pr view` 真读：

```json
{
  "url": "https://github.com/sdcxb/codem-site-lifecycle/pull/1",
  "state": "open",
  "checks": "none",
  "error": null
}
```

### 2. 删除运行中会话立即杀命令树

- Rust `execute_command` 新增 `session_id`，spawn 后登记 `session → pid`；
- 新命令 `kill_session_processes(session_id)` 用 `kill_process_tree` 收整棵树；
- bash abort 时动态调用 kill；
- 删除会话时 store 再兜一次；
- 修复 registry 清理竞态：只有 `map.get(sid) == 当前 pid` 才删除；
- 事件墓碑短路：`markSessionDeleted` 后 `EventLog.append/appendBatch` 返回 `seq=0`，不再写 `session_events`，消除 `FOREIGN KEY constraint failed`。

真机复验：

```text
启动 ping 127.0.0.1 -n 60（pid 768）
右键删除运行中会话
1 秒内 ping 进程消失
界面无 FOREIGN KEY、无“数据保存失败”
runtime log: session abort: killed exec tree session=... pid=768
```

## 二、第一次全面审计发现并修复的问题

| # | 失败 | 根因 | 修复 |
|---|---|---|---|
| 1 | `TAURI-ARITY-1/2` 红 | `execute_command` 从 5 参变 6 参，测试仍按 5 参断言；Rust 三条 `#[tokio::test]` 仍按 5 参调用 | 同步 6 参断言与三条 Rust 测试调用 |
| 2 | `TAURI-ARITY-2` 仍红 | 只改了描述，`toBe(5)` 未改 | 改 `toBe(6)` |
| 3 | `ABT-002` 超时 | abort 监听静态引用 `killSessionProcesses`，测试 mock 没有该导出 → 抛错，未 reject | 改为动态 `import("../file-api").then(m => m.killSessionProcesses?.(...))` |
| 4 | `LOOP-015` "No killSessionProcesses export" | 同上 | 动态 import |
| 5 | 变异产物闸门红 | `tauri-arity-230` 的锚点还停在 5 参；签名/测试已变 | 更新 spec 锚点并重跑 `node tools/mutate/run.mjs tauri-arity-230`，三条变异均验证红 |
| 6 | 删除会话仍 FK | ① JS 传 `session_id`，Tauri 命令实际要 `sessionId`，进程从未登记；② 迟到事件没有墓碑短路；③ registry 清理可能删掉同会话新命令 | ① 改 camelCase `sessionId`；② `EventLog.append/appendBatch` 墓碑短路；③ 按 pid 条件删除 |

## 三、第二轮审计（全绿）

```text
npx tsc --noEmit                                          exit 0
npx vitest run --maxWorkers=2                             732 files / 8493 passed + 17 skipped
cargo test --manifest-path src-tauri/Cargo.toml --lib     212 passed / 0 failed / 2 ignored
node tools/audit/scan-report-sites.mjs --check            270/270 triaged, 0 pending
```

生命周期项目：

```text
node site/build.mjs   PASS 8 pages
node site/check.mjs   27/27
node site/audit.mjs   32/32
node site/e2e.mjs     PASS 8 页 / SEO / a11y / 375px / 预算
node site/smoke.mjs   PASS 8 页 + 资产 + SEO + 安全头 + 404
```

## 四、判据

- `src/test/session-delete-event-guard.test.ts` DEL-1/DEL-2：墓碑命中时 append/appendBatch 不写端口；
- `src/test/tauri-command-test-arity.test.ts` TAURI-ARITY-1/2：6 形参与 3 处调用同步；
- `tools/mutate/specs/tauri-arity-230.mjs` 三条变异仍能红，说明判据不是恒真。

## 五、产物

- Codem 修复提交：`b1da8b46`
- 生命周期项目：`.preview-shot/coordinator-lab/site-lifecycle-r1`
- PR：https://github.com/sdcxb/codem-site-lifecycle/pull/1
- 门禁日志：`.preview-shot/coordinator-lab/site-lifecycle-r1/docs/evidence/lifecycle-gates.log`
- 手册：[docs/manuals/PROJECT-MODE.md](../manuals/PROJECT-MODE.md)
