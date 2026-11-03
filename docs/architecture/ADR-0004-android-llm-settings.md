# ADR-0004 · Android 本机模型设置（base URL / API Key / model）与 Host 热重启

> 状态：**已定** ｜ 日期：2026-11-02
> 相关：`ADR-0002`（Android 运行时）、`ADR-0003`（共享 UI 传输）、`ANDROID-DEVICE-TEST-CASES.md`

---

## 1. 问题

旧实现的 Key 是**明文** `SharedPreferences("codem").llm_key`，并在拉起 Host 时塞进
`CODEM_LLM_API_KEY` 环境变量。这条链有三处真实泄漏面：

1. Host 给工具（bash / git / codem-db）spawn 子进程时继承 `process.env` ⇒ 模型跑一次 `env`
   就把 Key 打进**工具输出**（= 会话消息 / 截图 / 导出）；
2. PRoot 里能读 `/proc/<node>/environ`，而运行时的 `unsetenv` **擦不掉** execve 时的初始环境块；
3. `MainActivity` 是 exported 且接受 `--es llmBase/llmKey/llmModel`：任意 App 可以把 base URL
   改成自己的地址，让 Host 拿**已保存的真 Key**去请求它（不需要额外权限）。

另外，"配置过一次之后"没有任何入口能改配置：启动页只在"没配过且没解压过"时出现。

---

## 2. 决策

### 2.1 Key 只以密文落盘（AndroidKeyStore + AES/GCM）

- 别名 `codem.llm.key.v1`，`AES/GCM/NoPadding`，256-bit，**12B 随机 IV**（由 KeyStore 生成），
  128-bit tag，AAD = `codem.llm.v1|com.codem.remote`（防跨 App/跨用途搬密文）。
- 落盘格式：`Base64( [1B version][12B IV][ciphertext||tag] )`，键名 `llm_key_enc`。
- **不做明文回退**：Keystore 不可用就保存失败并明确提示，而不是悄悄退回明文
  （安全属性不能取决于 ROM）。
- 迁移旧明文：**加密 → 解密回读验证 → 再删明文**（顺序反了就会丢用户唯一的一份 Key）。
  验不过就把状态标成 `legacy` 并保留旧明文（不静默销毁），设置页常驻告警。
- 解不开（换机/恢复备份/Key 被删）：状态 `unreadable`，**保留密文**，Host 以"无 Key"启动，
  设置页提示重新输入。

### 2.2 Key 不进进程环境：`--llm-stdin`

Android 外壳在 `pb.start()` 后立刻向 Host 的 stdin 写**一行** JSON，然后关闭：

```json
{"baseUrl":"…","model":"…","apiKey":"sk-…"}
```

Host 在 `HostRuntime.create` **之前**读它（`--llm-stdin`），失败 fail-closed（不回退 env）。
效果：`CODEM_LLM_*` 从不进入进程环境 ⇒ `/proc/<pid>/environ` 干净，工具子进程也继承不到。

PC/开发机仍可用环境变量（大量 spike 脚本依赖），但 `cli.ts` 解析完立刻 `delete`，
并且 bash/git/codem-db 的 spawn 环境再显式剔除一遍（纵深防御）。

### 2.3 表单是**原生**的；共享 UI 只有"打开"一个按钮

- 原生 `AlertDialog`（`LlmSettingsDialog`）：Key 只经过 Java 内存 → KeyStore，
  **不进 JS / React state / DOM**；密码框、从不回填、禁 autofill、窗口 `FLAG_SECURE`。
- 共享 UI 的入口在 `InfoPanel`（`packages/ui/src/info-panel.tsx`）：**只有
  `window.CodemNative` 存在时**才渲染。桥由 `addJavascriptInterface` 注入，
  而且**只在 loopback 页面**注入（远程 PC 页面 `removeJavascriptInterface`），
  每个桥方法内部再复核当前页面 origin。
- 桥**只有** `openLlmSettings()` / `getLlmSettingsSummary()`（+ `getVersion()`）：
  没有 Key getter、没有 save、没有 URL 能力。摘要按白名单取字段（baseUrl/model/hasKey/keyState），
  原生多返回秘密字段也不会进 DOM。
- 不把入口放 Header：手机窄屏头部已有返回/文件/信息/收起列表，再加一颗按钮会挤压标题。
  放在"连接信息"面板里，并且**错误页也有一个原生「设置」按钮**（Host 起不来时仍能改配置）。

### 2.4 保存后只重启 **Node Host**（不 force-stop）

- `HostSupervisor.restart()`：`SIGTERM`（Host 自己会 `server.close → pairing.close → runtime.close`）
  → 等 `/healthz` 失败且 `/proc` 里没有 host.mjs → 还不死就 `SIGKILL`（**深→浅**）+ `destroyForcibly()`
  → 仍不干净就**报错并拒绝启动第二个 Host**（两个 Host 抢同一个库/`pairing.json.lock` 更糟）。
- 进程发现**不依赖 `Process` 句柄**（Activity 被回收后句柄会丢，但 Host 还活着）：
  按 `/proc/<pid>/cmdline` + **同 UID** 过滤（起点必须是本 App 的 `bin/proot`，或 node 跑
  `/opt/app/host.mjs`，或 `codem_db`），避免误杀模型自己起的同名命令。
- 成功后才清掉旧配置快照/刷新页面：**loopback 页面 reload（保留 `?open=`）**，
  **远程 PC 页面不动**（本机配置不影响远程）。
- 保存失败**不重启**：不允许出现"旧 Host 已停、新配置没落盘"的中间态。

### 2.5 配置类 extras 只对 debuggable 构建生效

`llmBase/llmModel/llmKey` 三个 extra 一律先判 `ApplicationInfo.FLAG_DEBUGGABLE`，
并立刻 `removeExtra`（否则会留在 `dumpsys activity` 的 intent 里）。
release 构建忽略它们 ⇒ 2.1 的"任意 App 改写 base URL 把 Key 送走"通道关闭。

---

## 3. 代价与残余风险（如实记录）

| 项 | 说明 |
|---|---|
| Java `String` 不可擦除 | 从 `EditText` 取出的 Key 至少以 String 形式存在过；byte[]/char[] 用完清零，其余不可控 |
| 首次配置仍需启动页 | 无 Key 时本机页面打不开 ⇒ 首次必须走原生启动页（同一套存储与校验） |
| 重启中断在飞回合 | 保存时没有"正在回答"确认框（P2：可查 `host.diagnostics.runs` 做空闲才重启） |
| WebView reload 丢滚动/草稿 | 保留 `?open=` 能回到原会话；滚动位置与未发送草稿会丢 |
| `--llm-stdin` 依赖 stdin 透传 | PRoot 转发 fd 0；已在 x86_64 模拟器实测可用（见 §4），arm64 未单独验证 |
| 备份关闭 | `allowBackup=false`：换机不再带应用数据（密文本来也解不开），需重填配置 |
| 桥对同页 iframe 可见 | 共享 UI 不允许嵌第三方 frame；方法内 origin 复核是最后一道 |

---

## 4. 验证口径

- vitest：`host-llm-config`（解析/清环境/子进程不继承）、`android-llm-settings`（源码不变量：
  无明文写、迁移顺序、日志不碰 Key、extras 门禁、桥只在 loopback、重启先停后起）、
  `ui-native-settings`（按钮仅 Android 出现、摘要白名单、桌面源码无 `CodemNative`）。
- 真实 Host 集成（PC）：`--llm-stdin` 起 Host → mock provider 收到 `Authorization` 与 `model`；
  env 模式同样可用；Key 不在 stdout/stderr/argv。
- x86_64 模拟器（release APK + root）：
  - 启动页填配置 → `shared_prefs/codem.xml` 只有 `llm_key_enc`（无 `llm_key`）；
  - node 的 `/proc/<pid>/environ` **没有** `CODEM_LLM_*`；cmdline 带 `--llm-stdin` 且无 Key；
  - 页面里 `window.CodemNative.getLlmSettingsSummary()` 返回 `keyState=keystore`、无 Key；
  - 桥 → 原生对话框 → 改 model/Key → 保存：`host.log` 的 ready 行 +1，进程 pid 换新但
    **Activity/WebView 未重启**；下一次请求 provider 收到新 Key 与新 model；
  - 旧明文 prefs → 冷启动：明文消失、密文出现、迁移后的 Key 真的被 provider 收到；
  - 破坏密文 → 冷启动：`key_state=unreadable`、密文保留、Host 仍启动且**不带 Key**；
  - `--es llmBase/llmKey` 打冷启动：prefs 完全不变（release 忽略 extras）；
  - 深链到远程页面：`typeof window.CodemNative === "undefined"`，本机 Host 仍在跑。
