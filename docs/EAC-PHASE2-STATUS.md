# EAC 对标 第②③④项 — 实施记录（Phase 2 前半）

> 对标仓库：github.com/zouyuxuan122/DSH-Desktop-EAC（dsh 桌面发行版）。
> 四项顺序按工作量递增：④宠物状态卡（✅）→ ③computer-use（✅）→ ②微信 ClawBot 桥（✅）→ ①手机连接（⏳ 待评估 HTTP 地基）。
> 深度调研报告在 `.eac-analysis/`（gitignore 不入库）：`dafeiyu-report.md` / `computer-user-report.md` / `wechat-ilink-report.md` / `phone-openclaw-report.md`。

## 第④项 宠物大肥鱼式状态卡 — commit 929a0f3

对标 dsh-dafeiyu：真实 Agent 事件驱动的工作状态显示（非定时器假装"在思考"）。

- `pet-types.ts`：`PetCard{project?,phase?,step?{current,total:number|null,title?},message?,visible}`
- `pet-store.ts`：`updateCard(card)` action + 全状态通道（pet-state-update 携带）
- `App.tsx` 汇聚器：事件 → 阶段/步骤映射（llm_status→思考中、step_progress→真实步、tool_*→工具阶段、end→归位）
- `PetWindowApp.tsx`：状态卡 UI（CARD_HEIGHT 44 + 几何并入 resize）
- **不编造**：step.total 为 null 时只显示"当前步"，无 todo 持续通道（Codem 只有一次性 todo_list_created），报告如实标注
- 测试 +3（updateCard/清除/null 步），77 通过

## 第③项 computer-use 电脑操作 — commit c7ad786

对标 EAC computer-user（Codex-style computer use：读屏 + 键鼠自动化）。

- 10 工具：computer_screenshot/click/type/keypress/scroll/drag/move_mouse/wait/get_cursor_position/set_mode
- PowerShell 零依赖后端（EAC capture.ps1/input.ps1 内联为 TS 模板，头注释 MIT 声明）
- 模式 disabled/readonly/manual/auto；**默认 manual 手动批准**（用户决策）+ /computer 会话批准 toggle
- `computer_see`：截图 → Tauri `read_file_base64`（Rust 新命令）→ vision-proxy 视觉模型描述（无本地 OCR，提示词引导输出坐标；局限：无 bbox/云端延迟已标注）
- 注册 KNOWN_PLUGINS/builtin-registry/codem.base.yml + 设置卡「电脑操作」；7 测试

## 第②项 微信 ClawBot 桥 @codem/wechat-bridge（iLink 直连）— 本轮

对标 EAC/OpenClaw 微信通道；协议 = 腾讯官方 @tencent-weixin/openclaw-weixin 2.4.6 公开源码 + 社区实测。

### 架构：Rust 传输层 + TS 引擎桥（双层，报告 §9.1 实现线 A）

```
微信 ClawBot ──iLink──▶ [Rust 传输层] ──events──▶ [TS 引擎桥] ──▶ Codem agent
                       登录/长轮询/收发/配额      peer→会话映射/命令/回复
                       (常驻，WebView 刷新不断)    executeSessionTurn → ilink_send_text
```

### Rust（src-tauri/src/ilink/，零新依赖）

| 模块 | 职责 |
|---|---|
| mod.rs | LinkState 状态机、6 commands（ilink_status/start_login/login_submit_verify/logout/send_text）、5 events（ilink-state/qr/need-verify/inbound/expired）、配额记账、启动自动续连 |
| proto.rs | serde 模型、请求头（AuthorizationType/UIN 随机/iLink-App-Id=bot/ClientVersion 132102）、HTTP 原语（35s 长轮询超时语义）、文本提取/切块 |
| login.rs | 8 态 QR 登录（含配对码、scaned_but_redirect 切 host、binded_redirect 恢复、480s 总超时） |
| poll.rs | getupdates 单循环（epoch 代际 + poke 即时唤醒、游标落盘、401/403/-14→Expired、2s→30s 退避） |
| store.rs | session.json（0600/损坏即未登录/23h 判活）+ tokens.json（≤10 历史，多端互认） |

### TS（src/core/wechat-bridge/ + provider + UI）

- 引擎桥：inbound → 准入（owner=ilink_user_id 自动放行 / 白名单 / 陌生→待批准+引导）→ 命令短路 → `executeSessionTurn` 驱动持久会话（sessions 行先行避 FK；历史只依赖 messages 表，跨轮连续）→ 最终文本回传；每 peer 串行 + message_id 去重
- 命令：/help /status /new /model /clear /attach /reconnect /allow /ignore（主人门禁；/attach 决定 agent 工作区）
- UI：设置「微信 ClawBot」卡——状态徽章/SVG QR（qrcode-generator）/配对码输入/过期提醒/模型与工作区/准入管理/主开关；合规与媒体群聊二期标注
- 注册三件套（默认开启可禁用）+ package.json 依赖 qrcode-generator

### 已知边界（诚实标注，与调研报告一致）

- 10 条/24h 主动配额与 24h token 为**社区实测非官方承诺**：本端软记账、不编造；条款风险已在 UI/文档标注
- 媒体（图片/文件/语音，AES-128-ECB + CDN）与群聊：二期；写媒体代码前必须先核对官方 src/cdn/upload.js（协议唯一缺源码对照环节）
- get_bot_qrcode POST（官方 2.4.6）与早期 GET 版本漂移：按官方 POST + local_token_list 实现
- typing/notifystart 等体验接口：生产加固清单（+2~3 人日）
- 未在本机实扫验证（需真实微信）；Rust 纯逻辑 13 单测 + TS 7 单测已覆盖

## 第①项 手机连接 dsh-phone — commit（本轮）

用户确认全量方案（补 HTTP 地基）后实施，架构沿用 ② 的"Rust 传输层 + TS 引擎半层"双层：

```
手机浏览器 ──HTTP(LAN)──▶ [Rust phone 服务] ──phone-request──▶ [WebView TS phone-link]
  /pair?token=配对        配对门卫+静态页+代理路由            status/sessions/messages/chat
  /api/* (cookie 鉴权)    （0.0.0.0 随机端口，零新依赖）      （executeSessionTurn 真实引擎回合）
```

- Rust `src-tauri/src/phone/`：http.rs（手写 HTTP/1.1 解析/响应）+ lan.rs（UDP-connect 取 LAN IP）+ mod.rs（状态/配对/设备持久化/代理）
  - 配对对标 EAC phone-bridge：token URL 5min 轮换 → 等待页轮询 → 桌面批准 → Set-Cookie（HttpOnly/SameSite=Strict/1y）→ secret 仅存 sha256 落盘 devices.json（重启保配对）
  - 手机端 app.html/pair.html 内嵌 include_str；/api/* 鉴权后事件代理到 TS（reqId 关联，15s 超时）
- TS `src/core/phone-link/phone-link.ts`：路由 /api/status（桌面当前项目/会话）· /api/sessions（全部项目会话真实倒序）· /api/sessions/<id>/messages · /api/chat（续聊，busy 409）· /api/chat/new
- UI 设置卡「连接手机」：QR/复制/批准·拒绝/设备解除/autoStart；合规提示
- **诚实标注**：明文 HTTP + LAN cookie = MVP 安全水位（DSH 同款 http origin）；手机端与桌面同一会话数据，不编造；防火墙/同 Wi-Fi 需放行随机端口
- 测试：Rust phone 12 单测（解析/解码/cookie/配对生命周期/timing-safe/hash 鉴权）；TS phone-link 6（路由/清理/映射/拍平排序/设置/缓存）

## 四项全部落地后的收尾说明

- 全部注册三件套（KNOWN_PLUGINS/builtin-registry/codem.base.yml），默认开启可禁用，risk danger
- 全量 TS 165+ 文件 / 42xx 用例 + tsc 零错误；Rust `cargo test --lib` 全绿
- 实机验证依赖真实环境：②需真机微信扫码；①需第二台设备同 Wi-Fi 访问——本机已覆盖协议/纯逻辑单测与编译级验证，端到端冒烟建议发版前人工执行
- 发版按用户指示执行（RELEASE-GUIDE：版本号三处 + Cargo.lock 单独 commit + gh release）
