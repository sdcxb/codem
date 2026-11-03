# 与设计目标的偏差清单（2026-11 本轮收口）

> 判定规则沿用 `OPEN-DECISIONS.md` §0：**用户零负担**、**稳健优先于功能**。
> 结论先行：**有三处"优于设计"，有六处"不如设计"**；本轮补齐了其中四项（标 ✅ 已补），
> 剩余两项（桌面 sidecar、bash/审批）是阶段 4 的范围，未假装完成。

---

## 1. 优于设计的地方（保留）

| # | 能力 | 设计预期 | 实际 |
|---|---|---|---|
| B-1 | Android 形态 | 设计只要求"PRoot + Node 跑起来"（Spike 级） | 已做成**自包含 APK**：安装即用、首启自解压、本机 Host + 共享 UI，不需要 adb/电脑 |
| B-2 | 端上验证 | 只要求模拟器加载页面 | 已跑通**设备内真实回合**（配置模型服务 → 建会话 → 工具调用 → 答复，截图存证） |
| B-3 | Linux 构建 | 设计把 arm64 构建记为阻塞 | Docker 交叉编译已产出 x86_64-musl 与 aarch64 两个 `codem-db`，B-2/B-3 阻塞解除 |

## 2. 不如设计的地方（本轮处理）

| # | 设计承诺 | 现状 | 本轮 |
|---|---|---|---|
| G-1 | 远程客户端应能**新建会话**（否则手机只能看不能开始） | `packages/protocol` 没有 `session.create`，手机端无入口 | ✅ 已补：协议 + Host 运行时 + 服务端 + 传输 + 移动端「＋ 新建会话」按钮；LT-3 通过 |
| G-2 | Android 本机 Host 应能**真正对话** | 只带欢迎会话；没有模型服务配置入口，`prompt.send` 报"没有配置模型" | ✅ 已补：启动页可填「服务地址 / API Key / 模型名」，落 SharedPreferences，透传 Host 环境变量；LT-4 通过 |
| G-3 | 深链/远程通知打开指定会话 | `am start --es url` 对已在顶部的实例不生效（非 singleTop、且 setup 会用根路径覆盖） | ✅ 已补：`launchMode=singleTop` + `onNewIntent` 处理 + `pendingUrl` 竞争保护；探测截图通过 |
| G-4 | 设备也能**连接电脑上的 Host** | 自包含改造后只剩本机模式，远程客户端入口丢失 | ✅ 已补：启动页「连接电脑」+ 地址持久化（远程模式） |
| G-5 | 事件序号应从 `session_events.seq` 取（ADR-0001 §6.5） | 单调时钟 seq，跨重启续传不可靠 | ✅ 已补：先落库再通知、从 `events.list` 补发、`prompt.send` 等落库后返回；SEQ-1..5 跨重启补发 21 条 |
| G-6 | 桌面用 **Tauri sidecar** 拉起 Host、远程默认常驻 + 一次提示 + 一键关闭（ADR-0001 §6.6、D-4） | 手动起 Host、无开关 | ✅ 已补：`host_cmd.rs` 启停 + 安装包资源（复用内置 Node）+ 启动自启 + 设置卡；RB-1..3 与 Rust 单测通过；安装包已构建并静默安装验证（Host 自启 + `host.hello` + `host_stop` 进程归零） |
| G-7 | 工具迁移应含 `bash`（同 id/schema）与审批（ADR-0001 §6.3） | Host 只迁了 read/glob/grep/write/edit；`terminal.*` 显式 unsupported，远程不能跑命令 | ⏳ 未补（阶段 4；没有审批 UI 前不放开 bash，属于安全边界） |
| G-8 | 单写者租约「后到者接管 + 二次确认」（D-5） | 固定 `holder=none` | ✅ 已补：`LeaseManager`（TTL/续期/接管确认/释放）+ `host.lease.takeover` + `prompt.send` 的 `LEASE_HELD` 拒绝；LSE-1..4 全绿 |
| G-9 | arm64 真机验证 | 本机 x86_64，无 arm64 设备 | 🟡 x86_64：SC/LT/RST + **DC-1..9 真机操作**全绿；arm64：Node/Host/DB 已 QEMU 验证，PRoot/WebView 待真机 |

## 3. 本轮新增判据

| 判据 | 覆盖 | 证据 |
|---|---|---|
| LT-1..5 | 配置启动 → 建会话 → 真实回合 → 会话页截图 | `evidence/spike-android-local-turn.png`（`read ✓` + 答复） |
| SC-1..5 | 自包含 APK 首启解压 + 本机 Host + 欢迎会话 | `evidence/spike-android-selfcontained*.png` |
| DH-1..5 | 设备内 Host 走 PC 假模型 | `evidence/spike-android-ondevice-host-run.png` |
| SH-1..5 | PC Host + 手机 WebView | `evidence/spike-android-shell.png` |

## 4. 结论

- **功能完备性**：手机端现在具备"装 → 配模型 → 新建会话 → 对话（含工具卡）"的完整闭环；
  这是本轮之前**不具备**的（当时只能看欢迎会话）。
- **与设计对齐**：剩余偏差集中在**桌面侧**（sidecar/默认常驻/审批/bash）与**跨重启续传**，
  都属于阶段 4，已在 ADR 中保留，不用"看起来完成"掩盖。

---

## 5. 设计对标

见 `COMPLIANCE-AUDIT.md`（ADR-0001/2/3 逐条状态与偏差）。主要负向偏差：终端/设置/多主机仍属阶段项；
配对已由 Host `PairingService` 完成（旧 phone-link LAN 配对已删除）。

## 6. 后续队列

- 先完成 G-7 / G-8 / G-9（本文件 §2）；
- 之后执行 `ANALYSIS-CONTINUATION-AND-COMPACTION.md` 的 P3→P2→P1（已按用户要求排期）。
