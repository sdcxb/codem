# Codem 插件安装手册（权威）

> **给模型看的纪律**：装插件/写插件之前**先读完本文**。本文没有写的步骤**不存在** ——
> 不要靠"试着装一下看看"来摸索（那正是浪费 token 与注意力的模式 ✗）。

## 0. 先分清三种东西（它们机制完全不同，别混）

| 东西 | 是什么 | 装在哪 | 安装方式 |
|---|---|---|---|
| **插件（plugin）** | 向应用注册**服务**（Cordis 机制）：如 `@codem/context-info`、`@codem/shell-ops` | 代码仓内（内置注册表）/ `codem.yml` / `package.json` 的 `codem` 字段 | 见 §2：**加一个 provider 文件 + 注册一行** |
| **技能（skill）** | 一段给模型的**指令 + 可选脚本**，运行时按需加载 | 用户级 `<appData>/.codem/skills/<名>/` 或项目级 `<项目>/.codem/skills/<名>/` | **见 `docs/manuals/SKILLS-INSTALL.md`**（复制目录即可，无需安装器） |
| **MCP 服务器** | 外部进程，经 MCP 协议提供工具 | 应用设置里登记 | 用 MCP 管理界面登记；**不是本手册范围** |

## 1. 插件机制（已证实的事实，附出处）

- **契约**：`Plugin = (ctx) => ctx.provide('<服务名>', <服务对象>)`
  （见 `src/core/provider/context-info-provider.ts` 等既有 provider ✓）
- **注册**：`registerBuiltinPlugin(name, meta, () => provider)`
  （定义在 `src/core/plugin-loader/index.ts` ✓；实际注册清单在 `src/core/plugin-loader/builtin-registry.ts`，约 200 条 ✓）
- **`meta` 字段**：`inject`（依赖的服务）/ `provides`（自己提供的服务名）/ `slots`（UI 槽位）/
  `platform`（如 `['win32']`）/ `hot`（热重载）/ `optional` / `priority`
- **消费**：`getToolContext()?.get('<服务名>')`
  （`src/core/llm/tools.ts` 导出 `getToolContext()` ✓；`dynamic-plugin-tools.ts` 就是这么取 `dynamicCordisRunner` 的 ✓）
- **装配（谁真的跑 apply）**：内置插件由装配清单 **`config/codem.base.yml`**（+ 覆盖层
  `config/codem.desktop.yml`）经 `mergeYamlEntries()` → `loadFromEntries()` → `ctx.plugin()` 真正装配
  （见 `src/core/plugin-loader/index.ts` 顶部注释 ✓）。⚠️ `registerBuiltinPlugin()` **只写注册表**，
  不装配 —— 只注册不声明进清单 ⇒ 服务永远不会被提供，而单测可以全绿。
  另外：`src/core/provider/index.ts::loadDefaultProviders()` **已删除**（全仓无调用者的死代码），
  不要再照着它理解装配。
- **发现外部插件包**：仓库根 `codem.yml`（Vite `?raw` 注入）+ `package.json` 的 `codem` 字段（这是
  "外部插件包的发现层"，与上面内置插件的装配清单是两件事 ✓）
- **启停**：`src/core/plugin-loader/plugin-manager-service.ts` —— 依赖图级联 + 确认回调 +
  持久化（`saveDisabledPlugins`，DB 权威 + localStorage 镜像）。**切换后当前进程立即生效** ✓
- **默认开启**：插件不写"默认开"字段；**是否默认开由你的服务实现自己决定**
  （例：`@codem/shell-ops` 在设置缺失时视为开启 ✓）

## 2. 新增一个插件：唯一被认可的四步 ✓

1. **建目录**：`src/plugins/<插件名>/`（插件全部代码留在自己目录里 ⇒ 删目录即移除 ✓）
2. **写 provider**：`export const <名>Provider: Plugin = (ctx) => ctx.provide('<服务名>', { ...方法 })`
   - 服务对象的方法要**幂等、无副作用**，读设置时**每次现算**（这样启停/改设置立刻生效，
     不要在建对象时读一次就缓存住 ✗ —— `context.ts` 就踩过"构造时读、之后不刷新"的坑）
3. **注册一行 + 声明一行（两步都做，缺一不可）**：
   - 在 `builtin-registry.ts` 里
     `registerBuiltinPlugin('@codem/<插件名>', { provides: ['<服务名>'], inject: [], priority: 0, hot: true, platform: ['win32'] }, () => <名>Provider)`
   - 在装配清单 `config/codem.base.yml` 里声明（否则上面那行只是注册表里的一个名字，**永远不 apply**）：
     ```yaml
     - id: <插件名>
       name: '@codem/<插件名>'
       when: platform == 'win32'   # 可省；平台限定时必须写
       inject: [<依赖的服务名>]     # 可省；有 inject 时必须与注册表一致
     ```
   判据 `SO-6`/`SO-8`（`src/test/plugin-assembly-path.test.ts`）守这两步的对应关系 ✓
4. **接线消费方**：在需要它的**执行入口**用 `getToolContext()?.get('<服务名>')` 取服务；
   **取不到必须回退到旧行为**（插件被禁用/被删除后应用照常工作 ✓）

**验证（不许跳过）**：
- `npx tsc --noEmit` 0 错误；
- 针对"插件开 / 插件关"两个方向各写一条判据（关的那条是**反向对照**，防止把判据做成哑巴全拦 ✗）；
- 真机：插件管理器里能看到它、能启停；启用/停用后行为**当场**变化（不需要重启）。

**卸载**：删掉 `src/plugins/<插件名>/` 目录 + `builtin-registry.ts` 里那一行注册 +
`config/codem.base.yml` 里那一行声明 + 消费方那次取值。
四处都在本手册第 2 步里点名了 —— 这就是"完全独立可启停可删除"的完整含义 ✓。

## 3. 目前**没有**被证实的路径（别去试 ✗）

- 应用内**没有**"输入 URL/npm 包名就安装第三方插件包"的服务：
  在 `src/core` 里搜 `pluginInstaller` / `installPlugin` / `plugin-market` / `marketplace` **零命中**。
  插件的安装面 = 本手册 §2（内置注册表）+ `codem.yml` / `package.json` 的 `codem` 字段（发现层）。
  ⇒ **不要**凭空尝试 `npm install` 到某个"插件目录"、也不要改 `~/.dsh` 或应用数据目录来"装插件" ✗。
- 如果用户要装的是**技能**，那是另一套机制 ⇒ 去读 `docs/manuals/SKILLS-INSTALL.md` ✓。

## 4. 与插件相关的两个已知坑

- **服务名要唯一**：两个插件提供同名服务时按 `priority` 竞争（`PluginMeta.priority`）；
  起新服务名前先在 `builtin-registry.ts` 里搜一遍 ✓。
- **`@ts-nocheck` 的文件**（`plugin-manager-service.ts`、`plugin-loader/index.ts` 等）：类型检查在这些文件里**不生效** ✓
  ⇒ 改它们时判据比类型更可靠（历史上就出过"多传一个被静默忽略的实参"这种错 ✗）。
