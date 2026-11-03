# 工作队列（按用户 2026-11 的排序）

> 2026-11-03 更新：1.17.0 的远程形态已定稿为 **桌面远程网关（PC 唯一入口）+ Android 本机模式**（ADR-0005）；
> 桌面 Host sidecar 已退役，Host 只服务 Android 本机。

1. **【Android 本机 + PC 桌面远程网关】**（1.17.0 已交付主线）
   - 已完成：桌面网关 M1–M3（只读 → 写/审批/取消/事件流 → 文件树/预览/diff/变更）；共享 UI/能力表；
     一次性 6 位配对码 + HttpOnly cookie + 停止即撤销 + 敏感文件读审批；旧 LAN/TLS/二维码配对与桌面 Host sidecar 删除。
   - 已完成：Android 本机模式（自包含 APK + 设备内 Host + 本机回合 + Keystore 本机模型 + 随机端口/本地鉴权）。
   - 剩余：M2 诚实缺口（`run.guidance`、`session.create`、`attachment.put`、`session.get` 形状）；
     arm64 真机（PRoot/WebView/厂商保活）；单设备撤销 UI；跨网/NAT 通道真机。
   - 明确不做：恢复桌面 Host sidecar、LAN/TLS/二维码配对、桌面与手机共用数据库。
2. **【任务续跑 + 分段滚动压缩】**（排在 1 之后；方案见 `ANALYSIS-CONTINUATION-AND-COMPACTION.md`）
   - P3 熔断按效果 → P2 阶梯 1/3（折叠工具结果）→ P2 段模型 + 同轮 checkpoint → P1 任务级续跑。
   - 判据先行：BRK-1..2、SEG-1..3、CONT-1..3。

> 排序规则：1 未完成前不做 2；1 的 G-9 若因无硬件阻塞，不阻塞 2 的开工（按"1 中可做的先做完"判断）。
