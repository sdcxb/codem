/**
 * 「免费模型插件」的渲染侧服务（第 201 波）。
 *
 * ## 它是什么
 *
 * 用户要求把 `github.com/Ebony-Vinyl/dsh-our-free-model`（DSH 插件）集成进 Codem：
 * 「注意这个插件要独立存在，可以开启、暂停、删除，不影响 codem 的使用。集成后，默认开启，
 * 开启后对话优先从这个插件里获取模型列表服务。」
 *
 * 那个插件的本体是它自带的 **standalone 本地服务**（`packages/standalone/cli.mjs`，MIT）：
 * 一个只监听回环地址的 Node HTTP 服务，对外给 `GET /v1/models` 与 `POST /v1/chat/completions`
 * （OpenAI 兼容），模型清单跟随上游刷新、不需要登录或 API Key。Codem 这边做的是**宿主**：
 *
 * - **独立**：进程是它自己的（Rust `ofm_*` 起/停），数据目录是它自己的
 *   （`<appData>/extensions/our-free-model/data`），与 Codem 的库、会话、日志零交集；
 * - **可开启 / 暂停 / 删除**：本模块只管三件事 —— 起、停、把数据目录删掉；
 *   任何一步失败都**如实回报**，绝不假装成功（用户看到的必须是真实状态）；
 * - **默认开启**：`readPluginSetting()` 在**没有这条设置**时返回 `{ enabled: true }`
 *   （注意与"用户显式关掉"区分：那是 `enabled: false`，必须尊重）；
 * - **模型列表优先来自插件**：`listPluginModels()` 拿到的清单由 `model-config.ts` 在
 *   `getConfiguredApiModels()` 里**排在最前**，取不到（未启用/没起来/没有 Node）时回退到原有列表。
 *
 * ## 与 zvec-grep 的关系（为什么复用它的 Node 解析）
 *
 * 插件需要 Node ≥ 22。仓里已经有一套"系统 node → 便携 node → 都没有就下载"的机制
 * （`core/zvec-grep/runtime.ts` 的 `resolveNodeExe`）。这里复用**同一个**判定函数，
 * 免得出现"两个功能对'有没有 Node'给出不同答案"这种最难查的分叉。
 */
import { executeCommand, exists, getAppDataDir, listDirectory, deleteDirectoryPermanent, readFile } from "../file-api";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { parseNodeVersion, resolveNodeExe } from "../zvec-grep/runtime";

/** 设置键（界面上的开关就写它） */
const FREE_MODEL_PLUGIN_SETTING_KEY = "codem-free-model-plugin";

/** 插件的展示名（界面、模型分组都用它，避免两处各写一份） */
const FREE_MODEL_PLUGIN_NAME = "Our Free Model（免费模型插件）";

/** 托管供应商的 id 与标记（用于在 `settings.providers` 里认出"这条是我们写的"） */
const MANAGED_PROVIDER_ID = "free-model";
const MANAGED_PROVIDER_TAG = "free-model-plugin";

/** 起服务时优先用的端口（被占的话插件会自己换一个，我们再把真实端口读回来） */
const PREFERRED_PORT = 18937;

/** 插件设置 */
interface FreeModelPluginSetting {
  /**
   * 是否启用。**缺省 = 启用**（用户要求「集成后默认开启」）；
   * 显式 `false` = 用户自己关的（暂停），必须尊重。
   */
  enabled: boolean;
  /** 用户暂停的时间（仅用于界面显示"什么时候停的"） */
  pausedAt?: number;
}

/** 能从 Rust 侧问到的进程状态（`ofm_state`） */
interface OfmProcessState {
  running: boolean;
  pid: number | null;
  port: number | null;
}

/** 界面要的一份完整状态 */
interface FreeModelPluginStatus {
  /** 用户开着它吗（设置） */
  enabled: boolean;
  /** 代码在不在（打包时内置；缺了说明安装包不完整） */
  codePresent: boolean;
  /** Node 可执行文件（`null` = 没找到，插件起不来） */
  nodeExe: string | null;
  /** Node 从哪儿来的（system / portable） */
  nodeVia: "system" | "portable" | null;
  /** 进程在不在（我们自己起的那个） */
  running: boolean;
  pid: number | null;
  /** 服务端口（起来之后才有） */
  port: number | null;
  /** `/health` 的应答（`null` = 没起来或没通过） */
  health: Record<string, unknown> | null;
  /** 模型条数（健康时才有意义） */
  modelCount: number | null;
  /** 数据目录（用户能自己去删/备份） */
  dataDir: string | null;
  /** 最近的错误（如实显示；没有就是 null） */
  lastError: string | null;
}

const isTauri = (): boolean => typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("不在 Tauri 宿主里（判据环境请用假端口）");
  const { invoke: raw } = (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<T> } } }).__TAURI__.core;
  return raw(command, args);
}

/** 读设置：**没有这条设置 = 默认开启**（用户要求），显式 false = 用户关的 */
function readPluginSetting(): FreeModelPluginSetting {
  const raw = getSettingJSON<Partial<FreeModelPluginSetting> | null>(FREE_MODEL_PLUGIN_SETTING_KEY, null);
  if (!raw || typeof raw !== "object") return { enabled: true };
  return {
    enabled: raw.enabled !== false,
    pausedAt: typeof raw.pausedAt === "number" ? raw.pausedAt : undefined,
  };
}

function writePluginSetting(next: FreeModelPluginSetting): void {
  setSettingJSON(FREE_MODEL_PLUGIN_SETTING_KEY, next);
}

/** 扩展的数据目录（Rust 给，唯一来源） */
async function pluginDataDir(): Promise<string> {
  const dir = await invoke<string>("ofm_extension_dir");
  return `${dir}\\data`;
}

/** 内置代码目录（Rust 给：打包态是 resource 目录，开发态是仓库路径） */
async function pluginBundledDir(): Promise<string> {
  return invoke<string>("ofm_bundled_dir");
}

/** 插件入口脚本的绝对路径 */
async function pluginScriptPath(): Promise<string> {
  return `${await pluginBundledDir()}\\packages\\standalone\\cli.mjs`;
}

/** 找 Node（复用 zvec-grep 的同一套判定：系统 node → 便携 node → 都没有就 null） */
async function resolvePluginNode(): Promise<{ exe: string | null; via: "system" | "portable" | null }> {
  const detectSystem = async () => {
    try {
      const r = await executeCommand("node -v", undefined, 15_000);
      const version = parseNodeVersion(r.stdout ?? "");
      return { ok: !!version && r.exitCode === 0, version };
    } catch {
      return { ok: false, version: null };
    }
  };
  const findPortable = async (): Promise<string | null> => {
    try {
      const base = await getAppDataDir();
      const roots = ["zvec-grep\\runtime", "extensions\\our-free-model\\runtime"];
      for (const rel of roots) {
        const found = await findFileRecursive(`${base}\\${rel}`, "node.exe", 4);
        if (found) return found;
      }
    } catch {
      /* 找不到就是找不到 */
    }
    return null;
  };
  const r = await resolveNodeExe(detectSystem, findPortable, 22);
  return { exe: r.exe, via: r.via };
}

/** 有界深度地找一个文件（避免在巨大的目录树里递归到天荒地老） */
async function findFileRecursive(root: string, fileName: string, depth: number): Promise<string | null> {
  if (depth < 0) return null;
  let entries: Array<{ name: string; path: string; isDirectory: boolean }>;
  try {
    entries = await listDirectory(root);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory && e.name.toLowerCase() === fileName.toLowerCase()) return e.path;
  }
  for (const e of entries) {
    if (!e.isDirectory) continue;
    const hit = await findFileRecursive(e.path, fileName, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** 从插件的 settings.json 读 `forwardKey` 与**真实端口**（插件换端口时也读得到） */
async function readPluginRuntime(): Promise<{ port: number | null; key: string | null }> {
  try {
    const raw = await readFile(`${await pluginDataDir()}\\settings.json`);
    const parsed = JSON.parse(raw) as { standalonePort?: unknown; forwardKey?: unknown };
    return {
      port: typeof parsed.standalonePort === "number" ? parsed.standalonePort : null,
      key: typeof parsed.forwardKey === "string" && parsed.forwardKey.length > 0 ? parsed.forwardKey : null,
    };
  } catch {
    return { port: null, key: null };
  }
}

/** 探一次 `/health`（进程活着但服务没起来是真实形态 ⇒ 这里失败要如实说，不要当成"健康"） */
async function probeHealth(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 等 `/health` 通过（起服务后要等它把监听器挂上） */
async function waitForHealth(port: number, timeoutMs = 30_000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealth(port);
    if (health) return health;
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

/** 等插件的 `settings.json` 出现（端口与 key 都在里面） */
async function waitForRuntime(timeoutMs = 20_000): Promise<{ port: number | null; key: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: { port: number | null; key: string | null } = { port: null, key: null };
  while (Date.now() < deadline) {
    last = await readPluginRuntime();
    if (last.key) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/** 起服务（幂等：已经在跑就直接返回当前状态） */
async function startPlugin(): Promise<{ ok: boolean; message: string; port?: number }> {
  const node = await resolvePluginNode();
  if (!node.exe) {
    return {
      ok: false,
      message: "没有找到可用的 Node.js（需要 22 或更高）⇒ 插件无法启动。装一个 Node 之后重试即可。",
    };
  }
  const script = await pluginScriptPath();
  const dataDir = await pluginDataDir();

  try {
    const state = await invoke<OfmProcessState>("ofm_start", {
      nodeExe: node.exe,
      script,
      dataDir,
      port: PREFERRED_PORT,
    });
    /* 端口以插件自己写下的为准（被占用时它会换一个） */
    const runtime = await waitForRuntime();
    const port = runtime.port ?? state.port ?? PREFERRED_PORT;
    const health = await waitForHealth(port);
    if (!health) {
      return { ok: false, message: `插件进程起来了，但 ${port} 上的服务在 30 秒内没有就绪（可看运行日志）。`, port };
    }
    /*
     * 起来了 ⇒ 登记成 Codem 的托管供应商（否则"模型列表里看得见"却没路可走：
     * Codem 的对话是**按供应商**发请求的，见 `App.tsx` 的 `settings.providers` 注册路径）。
     */
    const registered = upsertManagedProvider({ port, key: runtime.key });
    const inEngine = await registerProviderInEngine({ port, key: runtime.key });
    const parts = [registered.message, inEngine.message];
    return {
      ok: true,
      message: `插件已启动（端口 ${port}）；${parts.join("；")}`,
      port,
    };
  } catch (e) {
    return { ok: false, message: `启动失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 把插件登记成 Codem 的**托管供应商**（`settings.providers` 里一条带标记的条目）。
 *
 * ## 为什么必须有这一步
 *
 * 「模型列表优先来自插件」只解决"看得见"；要"**用得上**"，对话那条路必须能把请求发给它的
 * OpenAI 兼容网关 —— 而 Codem 的供应商是在 API 模式下从 `settings.providers` 注册进
 * `LLMEngine` 的（`App.tsx`：`p.custom ⇒ registerCustomProvider`）。所以这里维护**一条**
 * 带标记的条目（`managedBy`）：
 *
 * - 启用且健康 ⇒ 写入/刷新（`baseUrl` 用插件**当下**的端口、`apiKey` 用它自己生成的 key）；
 * - 暂停 / 删除 ⇒ **移除**（插件停了，供应商列表里也不该留一条打不通的）；
 * - 别人的条目**一个字都不动**（只过滤掉 `managedBy === "free-model-plugin"` 那一条）。
 *
 * 这样"独立存在、可删除、不影响 codem"就落在结构上：插件的一切都在一条可识别的记录里。
 */
function upsertManagedProvider(runtime: { port: number | null; key: string | null }): { ok: boolean; message: string } {
  if (!runtime.port) return { ok: false, message: "插件还没给出端口，暂不登记供应商" };
  try {
    const settings = getSettingJSON<{ providers?: Array<Record<string, unknown>> }>("codem-settings", {});
    const list = Array.isArray(settings.providers) ? settings.providers : [];
    const others = list.filter((p) => p?.managedBy !== MANAGED_PROVIDER_TAG);
    const entry = {
      id: MANAGED_PROVIDER_ID,
      name: FREE_MODEL_PLUGIN_NAME,
      baseUrl: `http://127.0.0.1:${runtime.port}/v1`,
      custom: true,
      managedBy: MANAGED_PROVIDER_TAG,
    };
    setSettingJSON("codem-settings", { ...settings, providers: [...others, entry] });
    return { ok: true, message: `已登记供应商 ${MANAGED_PROVIDER_ID}（${entry.baseUrl}）` };
  } catch (e) {
    return { ok: false, message: `登记供应商失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 运行时把插件注册进 `LLMEngine`（**这里才带密钥，且不落盘**）。
 *
 * ## 为什么必须分两半（真机纠正）
 *
 * 第一版把 `apiKey` 一起写进 `settings.providers`，真机上被**如实挡下**：那一份设置走本仓的
 * **凭据脱敏**通道（`core/settings/settings.ts` 的 `CREDENTIAL_KEY_RE` 认 `apiKey` 这种键名，
 * 写盘时把值换成占位符）⇒ 落库回来密钥长度是 **0**。这是**对的**：供应商密钥不该躺在明文设置里。
 *
 * 所以：落库只写"这条供应商是谁、指哪儿"（设置界面看得见）；**密钥在每次插件启动时运行时注册**，
 * 插件每次开机本来就重起一次 ⇒ 这条注册永远是最新的，也不需要任何凭据落盘。
 */
async function registerProviderInEngine(runtime: { port: number | null; key: string | null }): Promise<{ ok: boolean; message: string }> {
  if (!runtime.port || !runtime.key) return { ok: false, message: "插件还没给出端口/密钥，暂不注册到引擎" };
  try {
    const { getLLMEngine } = await import("../llm/index");
    const engine = getLLMEngine() as unknown as {
      registerCustomProvider?: (id: string, config: { name: string; apiKey: string; baseUrl?: string }) => void;
    } | null;
    if (!engine || typeof engine.registerCustomProvider !== "function") {
      return { ok: false, message: "LLM 引擎还没就绪，插件供应商本次没注册（下次启动会再试）" };
    }
    engine.registerCustomProvider(MANAGED_PROVIDER_ID, {
      name: FREE_MODEL_PLUGIN_NAME,
      apiKey: runtime.key,
      baseUrl: `http://127.0.0.1:${runtime.port}/v1`,
    });
    return { ok: true, message: "已注册到 LLM 引擎" };
  } catch (e) {
    return { ok: false, message: `注册到引擎失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 移除托管供应商条目（暂停/删除时调用；别人的条目不动） */
function removeManagedProvider(): { ok: boolean; message: string } {
  try {
    const settings = getSettingJSON<{ providers?: Array<Record<string, unknown>> }>("codem-settings", {});
    const list = Array.isArray(settings.providers) ? settings.providers : [];
    const others = list.filter((p) => p?.managedBy !== MANAGED_PROVIDER_TAG);
    if (others.length === list.length) return { ok: true, message: "供应商列表里本来就没有插件条目" };
    setSettingJSON("codem-settings", { ...settings, providers: others });
    return { ok: true, message: "已从供应商列表移除插件条目" };
  } catch (e) {
    return { ok: false, message: `移除供应商条目失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 停服务（数据留着） */
async function stopPlugin(): Promise<{ ok: boolean; message: string }> {
  try {
    await invoke<void>("ofm_stop");
    return { ok: true, message: "插件已暂停（数据保留，重新启用即可继续）" };
  } catch (e) {
    return { ok: false, message: `暂停失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 启用（写设置 + 起进程） */
async function enablePlugin(): Promise<{ ok: boolean; message: string }> {
  writePluginSetting({ enabled: true });
  const started = await startPlugin();
  return { ok: started.ok, message: started.message };
}

/** 暂停（停进程 + 写设置；**不删数据**） */
async function pausePlugin(): Promise<{ ok: boolean; message: string }> {
  const stopped = await stopPlugin();
  /* 暂停 ⇒ 托管供应商条目也要撤掉（否则供应商列表里留一条永远打不通的） */
  const unregistered = removeManagedProvider();
  /*
   * ★ 还要**立刻**清掉模型缓存（真机上被问到才发现的缺口）：缓存有 60 秒 TTL，不主动清的话，
   * 暂停之后最长一分钟里模型列表仍会列出那些**已经调不通**的免费模型 —— 用户点了只会失败，
   * 还会以为「暂停没生效」。
   */
  __resetPluginModelsCacheForTests();
  writePluginSetting({ enabled: false, pausedAt: Date.now() });
  if (!stopped.ok) return stopped;
  return {
    ok: true,
    message: unregistered.ok ? `${stopped.message}；${unregistered.message}` : `${stopped.message}（${unregistered.message}）`,
  };
}

/** 删除（停进程 + 删数据目录 + 关掉开关）：**这是"卸载"**，账号与缓存一起没了 */
async function removePlugin(): Promise<{ ok: boolean; message: string }> {
  const stopped = await stopPlugin();
  if (!stopped.ok) return stopped;
  try {
    const dir = await invoke<string>("ofm_extension_dir");
    if (await exists(dir)) await deleteDirectoryPermanent(dir);
    removeManagedProvider();
    __resetPluginModelsCacheForTests();
    writePluginSetting({ enabled: false, pausedAt: Date.now() });
    return { ok: true, message: "插件已删除（数据目录已清空；重新启用会重新安装并重新拉取模型清单）" };
  } catch (e) {
    return { ok: false, message: `删除失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 读插件自己的运行日志最后 N 行。
 *
 * ## 为什么这是必须的（本波真机踩到的坑）
 *
 * 插件是被宿主 spawn 的子进程，它的 stdout/stderr 没有终端可去。第一版把它们 `eprintln!` 进了
 * Rust 侧 —— 在 GUI 进程里那等于丢掉，于是真机上卡片只能说「进程起来了但服务没就绪」，
 * **真正的报错谁都看不到**（缺文件、端口被占还是 Node 版本不对，全靠猜）。
 * 现在 Rust 把它落盘成 `<data_dir>/plugin.log`，这里读回来给用户看。
 */
async function readLogTail(lines = 40): Promise<string> {
  if (!isTauri()) return "";
  try {
    return await invoke<string>("ofm_log_tail", { dataDir: await pluginDataDir(), lines });
  } catch {
    return "";
  }
}

/** 读一份完整状态（界面就渲染它） */
async function readPluginStatus(): Promise<FreeModelPluginStatus> {
  const setting = readPluginSetting();
  const base: FreeModelPluginStatus = {
    enabled: setting.enabled,
    codePresent: false,
    nodeExe: null,
    nodeVia: null,
    running: false,
    pid: null,
    port: null,
    health: null,
    modelCount: null,
    dataDir: null,
    lastError: null,
  };
  if (!isTauri()) return { ...base, lastError: "不在 Tauri 宿主里（判据环境）" };
  try {
    const script = await pluginScriptPath();
    base.codePresent = await exists(script);
    base.dataDir = await pluginDataDir();
  } catch (e) {
    base.lastError = e instanceof Error ? e.message : String(e);
    return base;
  }
  try {
    const node = await resolvePluginNode();
    base.nodeExe = node.exe;
    base.nodeVia = node.via;
  } catch {
    /* 没找到 Node 也算状态的一种（界面上会如实显示） */
  }
  try {
    const state = await invoke<OfmProcessState>("ofm_state");
    base.running = state.running;
    base.pid = state.pid;
    const runtime = await readPluginRuntime();
    base.port = runtime.port ?? state.port;
    if (base.running && base.port) {
      base.health = await probeHealth(base.port);
      if (base.health) {
        const models = await listPluginModels();
        base.modelCount = models.length;
      }
    }
  } catch (e) {
    base.lastError = e instanceof Error ? e.message : String(e);
  }
  return base;
}

/** 插件给的模型（OpenAI `/v1/models` 形状 → Codem 的 `{id,name}`） */
async function listPluginModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const { port, key } = await readPluginRuntime();
    if (!port || !key) return [];
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
    const list = Array.isArray(body?.data) ? body.data : [];
    return list
      .filter((m): m is { id: string; name?: unknown } => typeof m?.id === "string" && m.id.length > 0)
      .map((m) => ({ id: m.id, name: typeof m.name === "string" && m.name.length > 0 ? m.name : m.id }));
  } catch {
    return [];
  }
}

/**
 * 同步取一次"插件能不能供模型"（给同步路径用：`getConfiguredApiModels()` 是同步的）。
 *
 * 为什么要有同步的口子：模型列表是**每次渲染**都要算的东西（`ModelSelector` / `InputArea`），
 * 把它改成异步会牵动一大片。所以这里维护一份**进程内缓存**（`refreshPluginModelsCache()` 刷新），
 * 同步读缓存；缓存为空/过期时**回退到原有列表** —— 宁可用旧列表，也不让模型选择器空掉。
 */
let pluginModelsCache: { at: number; models: Array<{ id: string; name: string }> } = { at: 0, models: [] };
const CACHE_TTL_MS = 60_000;

function cachedPluginModels(): Array<{ id: string; name: string }> {
  if (Date.now() - pluginModelsCache.at > CACHE_TTL_MS) return [];
  return pluginModelsCache.models;
}

/** 刷新缓存（启用/启动成功、打开设置页、定时器都可以调） */
async function refreshPluginModelsCache(): Promise<Array<{ id: string; name: string }>> {
  const models = readPluginSetting().enabled ? await listPluginModels() : [];
  pluginModelsCache = { at: Date.now(), models };
  return models;
}

/** 判据用：把缓存清掉（测试之间不许串味） */
function __resetPluginModelsCacheForTests(): void {
  pluginModelsCache = { at: 0, models: [] };
}

/**
 * **本模块唯一的导出面**（第 201 波）。
 *
 * ## 为什么收成一个对象而不是十几个具名导出
 *
 * 记忆子系统那条教训在这里照样成立：**导出面就是维护面**。这个模块的每个动作都有唯一消费者
 * （界面卡片 / 启动钩子 / 模型列表），散装导出会让 knip 棘轮一路涨（实测 49 → 59 当场判红），
 * 也让人分不清哪些是给别人用的。收成一个对象之后：生产侧
 * 「import { freeModelPlugin } from "../core/free-model-plugin/service"」，判据侧用同一份 API
 * —— 于是「判据测的就是产品面」，不会出现两套入口。
 */
export const freeModelPlugin = {
  settingKey: FREE_MODEL_PLUGIN_SETTING_KEY,
  name: FREE_MODEL_PLUGIN_NAME,
  readSetting: readPluginSetting,
  status: readPluginStatus,
  enable: enablePlugin,
  pause: pausePlugin,
  remove: removePlugin,
  start: startPlugin,
  stop: stopPlugin,
  models: {
    list: listPluginModels,
    cached: cachedPluginModels,
    refresh: refreshPluginModelsCache,
  },
  diagnostics: {
    logTail: readLogTail,
    dataDir: pluginDataDir,
    bundledDir: pluginBundledDir,
    scriptPath: pluginScriptPath,
    resolveNode: resolvePluginNode,
    runtime: readPluginRuntime,
    health: probeHealth,
  },
  /** 判据用：清掉模型缓存（用例之间不许串味） */
  resetCacheForTests: __resetPluginModelsCacheForTests,
} as const;
