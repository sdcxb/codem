# 凭据封存：改造面清单与回退方案（先方案、后动手）

> ⚠️ **历史文档（不再维护）** —— 这是某一轮的记录，**不是当前的缺口清单**。
>
> 当前缺口与状态**只有一份**：[`docs/GAP-LIST.md`](./GAP-LIST.md)（第 72 轮起维护）。
> 本文里的"待办 / 未实现 / 缺口 / 未完成"类结论都是**按当时的事实**写下的，
> 之后可能已经完成、已经改口径、或者已经被别的做法取代 ——
> 引用本文之前，请在 `GAP-LIST.md` 与**代码**里各复核一次。
>
> 保留本文的理由：它是那一轮的取证记录（当时的数字、现场形态、判断依据），
> 删掉就等于把"我们当时为什么这么做"一起删掉。



> 结论先行：**值得做，但不能直接换存储**。下面把"现状证据 → 目标 → 两阶段方案 → 改造面 → 迁移与回退 → 验收判据 → 风险"逐条写清；
> 本轮**只出方案、不动代码**。对标依据见文末（`anywhere-labs/dsh-desktop` 的 `safeStorage` 用法）。
> 编写时间：2026-09-19（对应已发布 v1.16.98）

## 1. 现状（有证据，不是印象）

| 事实 | 证据 |
| --- | --- |
| API key **明文**存在 `codem-settings` 这个设置项里（`providers[].apiKey`） | 真机普查：`codem-settings.providers[3].apiKey`（DeepSeek，`sk-` 形状，长 35） |
| 读取方**很多**，且都是**同步**读设置 | `ContextMonitor.tsx:42-46`（余额查询直接用 `p.apiKey`）、`ModelProfilePanel.tsx:77`、`MultimodalPanel.tsx:86/98`（TTS/多模态选 provider）、`CorrectionModelConfig.tsx:66/90`、`MessageBubble.tsx:274`、`App.tsx` 的 `configureEngine` |
| **设置可以被导出**，导出会带走密钥 | `settings.ts:529 exportSettings()` + `LayeredSettingsPanel.tsx:104`（界面上的导出按钮） |
| ~~还有**第二份明文副本**：`localStorage`~~ ⚠️ **这条我写错了，已核实并更正** | 我最初引的是 `src/plugins/library-ops/store.ts:134` —— 复查后确认那是**library-ops 面板自己的 UI 状态**（场景图 id/缩放等），**不含 API key**；`src/core/settings` 与 `src/core/storage` 里**没有任何**把设置镜像进 localStorage 的写入点（`InputArea.tsx:1213-1215` 的注释还明确写着 `setItem("codem-settings")` **0 次**、权威副本在 DB）⇒ **不存在这份副本**（结论：这一条从清单里划掉） |
| Rust 侧**没有任何**加密/凭据依赖 | `src-tauri/Cargo.toml`：只有 `dirs / tauri-plugin-{shell,dialog,fs,notification,updater,process} / serde / tokio / reqwest / zip / futures-util / uuid` |
| 旧库与备份里可能还有旧值 | 真机计数：`codem-db.bin` 里 4 处 `sk-` 形状（1.11.0 时代快照） |

因此"改一行换存储"是行不通的：**读写点分散 + 至少两处落盘（settings 值 + localStorage）+ 导出路径 + 同步读取**，任何一处漏掉，就会出现"界面显示已配置、请求却无 key"或"封存了但导出文件里还是明文"。

## 2. 目标（按可靠性排序）

1. **明文不再落盘**（settings 值、localStorage、导出文件三处都要处理）；
2. **不可用时不静默降级**：拿不到系统加密后端就**显式报不可用**并保持明文 + 界面可见提示（对标 `dsh-desktop`：`safeStorage.isEncryptionAvailable()` 为假时直接返回 false）；
3. **密钥不会因为迁移而出不来**：解封失败时**保留密文**，绝不删除；
4. **可回退**：一条明确开关回到明文路径，且回退动作本身要用户可见。

## 3. 方案（两个阶段，阶段 1 可独立交付）

### 阶段 0：凭据普查 + 残留清单（零架构风险，建议先做）
- 维护里加一条"凭据形状普查"：只统计 **表/键名 + 命中数量**，**从不打印值**（与现有 `[PersistFailure]` 纪律一致）；
- 命中即在界面上给一条可处置提示（"检测到疑似密钥，建议轮换"）；
- 生成"旧值还残留在哪些文件"的计数清单（新库 / 旧库 / WAL / `<db>.corrupt-*` / 备份），供轮换后核对。

### 阶段 1：封存（DPAPI），向后兼容
- **Rust 侧**新增两个命令（Tauri command，与现有 `storage_*` 同层）：
  - `secret_seal(plaintext) -> { sealed }`；`secret_unseal(sealed) -> { plaintext }`；
  - Windows 用 DPAPI（`CryptProtectData/CryptUnprotectData`，用户域绑定），**不加运行时服务依赖**；
  - 失败返回**明确错误码** `UNAVAILABLE`（与既有错误码语义对齐：不可重试、要用户看见）。
- **存储形状**：`providers[i]` 增加 `apiKeySealed: "<base64>"`；`apiKey` **仅在没有封存时存在**；
  读取优先级：`apiKeySealed`（解封后的内存缓存） > `apiKey`（明文，兼容旧数据）。
- **启动解封一次**：`unsealAll()` 在端口就绪后执行，把结果放进**内存 Map**（不落盘、不写 localStorage、不进导出）；
  所有同步消费者改读这个 Map（`configureEngine`、余额查询、TTS/多模态 provider 选择、纠错模型配置）。
- **localStorage 副本**：`store.ts:134` 那条整体序列化必须**剔除**密钥字段（只留非敏感设置）；这是"第二份明文"必须一起关。

### 阶段 2（可选，进一步）：把密钥移出 settings
- 用系统凭据库（Windows Credential Manager，`keyring` crate）存密钥，settings 只留 `keyRef`；
- 好处：**备份/导出/同步 settings 天然不带密钥**，且与"便携模式"兼容（换机器解不开属预期）。

## 4. 迁移与回退（必须能说清"出事怎么办"）

**迁移（首次启动，顺序写死）**
1. 检测 `providers[i].apiKey` 明文存在且 `secret_seal` 可用；
2. 逐条封存 → **原子写** settings（`apiKeySealed` 写成功才清 `apiKey`）；
3. 清理 localStorage 里的密钥字段；
4. 任何一步失败 → **不改动**（保明文）+ 上报 + 界面提示；下次启动重试。

**回退（用户/staff 可执行）**
- 开关：设置项或环境变量 `CODEM_SECRETS_PLAINTEXT=1` → 走明文路径；
- 回退动作：用 `secret_unseal` 把密文解回明文写进 settings、清 `apiKeySealed`；**需要用户显式确认**（因为明文会再次落盘）；
- **绝不删除密文**：解封失败只上报（"这台机器解不开（可能换了机器/账户）"），避免"迁移把密钥弄丢"。

## 5. 验收判据（每条都能在真机上量）

| 判据 | 怎么量 |
| --- | --- |
| 封存后磁盘上不再有明文 | 对库文件/`localStorage`/导出文件做**计数**扫描（`sk-` 形状 = 0） |
| 迁移前后功能等价 | 迁移前记录 `configureEngine` 生效的 provider/model；迁移后一致；余额查询/TTS 仍可用 |
| 导出不含密钥 | `exportSettings()` 结果里 `apiKey`/`apiKeySealed` 均被剔除或置换为 `<sealed>` |
| 后端不可用时行为正确 | 桩掉 seal 命令 → 界面显式提示"不可用"、**保持明文**、不产生半迁移状态 |
| 换机器解不开（阶段 2 特性） | 把库拷贝到另一台机器/账户 → 解封失败并如实报错，**不覆盖**原密文 |
| 回退可用 | 打开 `CODEM_SECRETS_PLAINTEXT=1` → 明文路径可用，且提示明确 |

## 6. 风险与取舍（如实写）

- **新增依赖**：阶段 1 需要 `windows`（或等价的 DPAPI 封装）crate → 构建产物与 CI 会变；阶段 2 的 `keyring` 更重。**这是我建议先做阶段 0 的原因**（零依赖、立刻降风险）。
- **同步读取改缓存**：所有消费者要改一行；漏改一处就会出现"界面说有、请求没有" —— 必须用"真机余额查询 + 一次真实对话"两条端到端验证，而不是只看类型检查。
- **便携介质**：DPAPI 密文在别的机器/账户下解不开是**安全特性**，但会让"拷 U 盘继续用"失效 ⇒ 便携文档必须显式说明（与数据目录账本那条一起）。
- **不做会怎样**：明文继续落在 **库文件 + localStorage + 导出文件** 三处；本会话已经出现过一次"库被误提交"的近事故（GitHub push protection 拦下），说明这不是理论风险。

## 7. 对标依据（`anywhere-labs/dsh-desktop`，源码级）

- `dsh-plugin-desktop/src/main.ts:236-242`：
  `if (!safeStorage.isEncryptionAvailable()) return false` → `seal/open = safeStorage.encryptString/decryptString`（Windows=DPAPI / macOS=Keychain）
  ⇒ **"用系统后端封存 + 不可用时显式不可用"** 正是上面阶段 1 的形态；
- `dsh-plugin-desktop/src/desktop-data-directory.ts`：数据目录用 `{activeHome, previousHome, generation}` 记账、**切换不复制旧 Home**、状态文件 `0600`/目录 `0700`
  ⇒ 与本方案"阶段 2 + 数据目录账本"配套（密钥不在数据目录里随包搬走，而是与**本机/本账户**绑定）。


## 8. 执行状态（滚动更新）

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| 阶段 0-a：**导出脱敏** | ✅ **已完成**（1.16.99） | `export-credential-redaction.test.ts` 4 条（含对照组）；`exportSettings()` 已接 `redactCredentialShapes()` |
| 阶段 0-b：**导出结果的真机核对**（导出文件里 `sk-` 形状 = 0） | ⏳ **未做成** | 打包版设置面板里找不到导出入口（只有"关闭设置/保存设置"），导出按钮在**插件面板**内；下一轮先找到入口再核对 |
| 阶段 0-c：维护期凭据普查（只报表/键名+数量） | ✅ **已完成**（1.16.100 → 修缺陷 → 1.16.101） | 真机复量：27 个设置项命中 2 处（codem-settings 的 shape 与 field）；测试见 credential-census.test.ts（含「返回值不许含密钥文本」）。⚠️ 1.16.100 曾因用域镜像读设置而打出「0 个设置项，未命中」，被 1.16.101 修掉，教训写进代码注释 |
| 阶段 0-d：旧库/备份/WAL 的残留计数清单 | ✅ **已定位到"在哪"（1.16.102 真机）** | 脚本 `.preview-shot/survey-credential-paths.mjs`（字节级计数）+ `.preview-shot/r64-residue-where.mjs`（带上下文、值掩掉）。**改造后**：新库 `sk-` **0**、新库 WAL `sk-` **0**（封存前是 1 / 27）；旧库 `codem-db.bin` 仍有 `sk-×4`（`"apiKey":"…"` 的历史行副本）与 `gho_×3`、旧 WAL 0。**新库里剩下的 3 处 `gho_` 已定位**：上下文是 `protocol=https host=github.com username=sdcxb password=gho_…` —— 即 **git 凭据助手（`git credential fill`）的输出被记进了工具结果/记录**，还有一处形如 `… token … GCM … token …`；它们**不是** provider 的 API key，属会话/工具数据（封存管的是"设置里的密钥"）。⚠️ 旧库是**只读遗留文件**，删或清洗属于破坏性操作 —— **等用户决定**，本轮不擅自处理 |
| 阶段 1：DPAPI 封存 + 启动解封缓存 | ✅ **代码、单测、真机验证都完成**（1.16.102） | `src-tauri/src/secret.rs`（裸 FFI `CryptProtectData`/`CryptUnprotectData`，5 条 Rust 用例含**真往返**与"两次封存不同"）；`secret-cache.ts`/`secret-store.ts`；`settings.ts` 唯一水合点；`ensureSecretsHydrated()` 单飞 + `configureEngine` 前的 await；界面开关在「设置 → 安全」。渲染侧 SEAL-1…14 + WGUARD-0…6 + 渲染测试 2 条 |
| 阶段 1 的**写回闸门**（真机首跑抓到的缺陷） | ✅ 1.16.102 | 全项目 14 处「读整份（水合⇒明文）→ 改一个字段 → 整份写回」会把明文重新写回磁盘 ⇒ 真机上出现 `apiKey` 与 `apiKeySealed` **并存**。修在唯一写收口 `secret-write-guard.ts`：同密钥同步换回密文、新密钥先落盘再异步补封存、用户选明文/后端不可用不动、损坏库恢复的裸写也过闸门；并把已存在的脏行收拾掉 |
| 阶段 1 的残留回收（字节级） | ✅ 1.16.102 | 真机字节级计数：`codem-db-rust.bin` sk- **1→0**、`-wal` sk- **27→0**（库 19.51 MB → 18.01 MB）。做法：封存成功后 `checkpoint`（折 WAL 并截断）→ `storage.compact{force}`（整库重写）→ 再 `checkpoint`。⚠️ **不声称**逐页擦除：引擎没有 `secure_delete`（`authorizer.rs` 拒绝它的写），SSD 磨损均衡/快照层仍可能留物理残留 |
| 阶段 1 的回退（第 4 节要求"可回退"） | ✅ **本版才真正存在** | 🔴 此前 `codem-secrets-plaintext` **只有读点、没有写入方** ⇒ `skippedByChoice` 分支永不可达、界面上没有任何入口，"可回退"只是方案里的一句话；被门禁 SKEY-2 报出后补上写入方（勾选框）+ 动作 `revertSealedKeysToPlaintext`（SEAL-8/9） |
| 阶段 2：密钥移入系统凭据库 | ⏳ 未做（可选） | — |

### 阶段 1 的验证口径（如实）

- **对照测量（改造前，已安装 1.16.101）**：`codem-settings` 27 个设置键；
  `providers[deepseek].apiKey` = 明文 `sk-` 形状（长 35）；`sealedCount = 0`；整串 JSON 命中 `sk-` 形状。
- **改造后（已安装 1.16.102 真机复量）**：
  - 启动日志：`清理了 1 个 provider 的重复明文` + `已回收旧明文的字节残留（WAL 折叠 + 整库重写）`；
  - **CLI 直读库文件**（不经渲染侧）：`has apiKey=False  has apiKeySealed=True（长 529）`，整串 JSON 不再命中 `sk-` 形状；
  - 字节级：`codem-db-rust.bin` sk- **1→0**、`-wal` sk- **27→0**、库 **19.51 MB → 18.01 MB**；
  - 密钥**真的能用**：渲染侧读到的密钥调 DeepSeek `/user/balance` → **HTTP 200、is_available=true、有余额信息**；
  - 界面「设置 → 安全 → API 密钥存储」：勾选框未勾选（默认加密）、状态行「已用系统加密保存（1 个 provider）」。
- **未在本机做过的（不许当成已做）**：
  1. **跨 Windows 账户解封失败**的现场复现（只能靠单测 `SEAL-7/9`；要真机复现需另建本地账户）；
  2. 回退开关的**真机往返**（勾上→解回明文→再关掉→重新封存）：本机只验证了开关**存在且默认关闭**，
     往返行为由 `SEAL-8/9` 与 `WGUARD-3/5` 覆盖；
  3. `codem-db.bin`（**旧库，只读遗留**）里仍有 `sk-×4 / gho_×3`，旧 WAL 为 0 ——
     那是历史数据文件，**没有用户同意不动它**（删/清洗遗留库属于破坏性操作，需用户决定）。

> ⚠️ 另有一条**已更正**的记录：本方案初稿把 `src/plugins/library-ops/store.ts:134` 当成"设置被镜像进 localStorage"的证据，
> 复查后确认那是该插件自己的 UI 状态、**不含 API key**，且 `src/core` 下没有任何把设置写进 localStorage 的地方
> （`InputArea.tsx:1213-1215` 注释明确写着 `setItem("codem-settings")` 0 次）⇒ 该条已从清单划掉。
