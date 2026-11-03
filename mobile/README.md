# Codem Mobile（Flutter 原生 Android 客户端）

这是 Codem 的原生手机客户端，复用桌面 Host 协议，不重写 Agent/存储。

- 设计基线：`docs/design/MOBILE-DESIGN.md`
- 架构决策：`docs/architecture/ADR-0007-NATIVE-ANDROID-CLIENT.md`
- 包名：`io.codem.codem_mobile`

## 运行

```powershell
# Flutter 3.47+ / Dart 3.13+
flutter pub get
flutter run -d emulator-5554
```

没有 Host 时进入**演示数据**，方便审 UI。点顶部“我的 PC”或演示横幅可以：
- 粘贴 `https://<pc>.<tailnet>.ts.net`（Tailscale Serve：**零配对码**，按 Tailscale 身份直接登记）；
- Funnel/公网/自定义反代仍需 6 位配对码，或粘贴带 `code=` 的认领链接；
- 连接后读真实会话/消息/工具/审批/改动。

## 当前能力

- 主机列表、添加/删除、切换、连接状态；
- 会话列表、项目筛选、新会话；
- 聊天：流式文本、思考块、工具卡（展开参数/结果）、审批允许/拒绝、停止；
- 改动 Sheet：`session.changes` + `session.change.diff`；
- 图片：相册选择 → `attachment.put` → `prompt.send` 带 `attachmentIds`；
- 通知：审批到达时本地通知；前台服务保活（设置里可关）；
- 分享：系统分享当前会话；
- 深/浅主题（跟随/强制），品牌 tokens 与桌面同源。

## 已知限制

- 本机 Host 的启动/发现还没接（当前主路径是 Tailscale 远程 Host）；
- @ 文件、终端、语音、富媒体预览未做（文件树/预览已做）；
- 零配对码只对 **Tailscale Serve** 生效；Funnel/公网/自定义反代仍需配对码；
- N0 暂用 SharedPreferences 存 cookie，正式发布前迁移 EncryptedSharedPreferences；
- release 仅验证 x86_64 模拟器；arm64 需要另建 ABI。

## 代码结构

```
lib/
  design/         tokens/theme/components（禁止组件内写死色值）
  data/           models / HostClient / HostStore
  state/          CodemAppState（连接、会话、消息、审批）
  features/       sessions/chat/projects/settings/hosts
  platform/       NativeBridge（前台服务/通知/分享）
  utils/
test/             host client、host 输入解析、golden
```
