import { getPersistFailures, reportPersistFailure } from "./persist-failure";
import { cachedSealedKey } from "./secret-cache";
import { gateSettingsWrite } from "./secret-write-guard";
import { getStoragePort, hasStoragePort } from "./port";
import { domainDelete, domainReadMany, domainReadOne, domainWrite, reportWriteNotAccepted } from "./domain-store";

// ========== Settings Storage (replaces localStorage) ==========
//
// 第 92 波 P3：**配置面切到存储端口**（迁移期按引擎分流）。
//
// ## 为什么这组函数必须保持同步
//
// `getSetting` / `getSettingJSON` 有近 500 个调用点，遍布同步上下文（React 渲染、
// 模块初始化、快捷键处理、主题引导）。把它们改成 `Promise` 会波及整条启动链，
// 风险远大于收益。所以端口里的"配置面"就是**唯一允许同步读**的形态：
// 启动时一次性预热进内存（`settings` 表极小，实测 24 行），之后读永远同步。
//
// ## 分流规则（迁移期 → 第 19 轮：只剩一条路）
//
// - 端口已注册 → 读走端口的内存缓存（同步），写走"内存即时生效 + 写穿队列"；
// - 端口未注册（**唯一**的"没有可用存储"形态）→ 返回该配置的默认值，**不抛**。
//
// 第 19 轮收紧：原来的"否则 → 完全维持 WASM 行为"那条路已随旧引擎删除；
// `kind` 也已是常量 `"rust"`，因此本文件里所有 `kind` 判据都删掉了。
//
// ## 硬约束
//
// `settings` 是**唯一**允许进内存镜像的数据（配置的量级是几十行）。
// 消息语料绝不进渲染进程 —— 见 port.ts 的硬约束 4。

/** 端口可用时用端口（**唯一实现**：rust），否则返回 null 表示"没有配置源" */
function rustConfig() {
  if (!hasStoragePort()) return null;
  // 第 19 轮：`port.kind === "rust" ? port.config : null` 收成 `port.config`
  // —— `kind` 是常量 "rust"，那个三元里"另一条路"永不可达。
  return getStoragePort().config;
}

/**
 * 端口是否可用（配置面扩展域的分流判据）。
 *
 * 第 19 轮：原来是 `hasStoragePort() && getStoragePort().kind === "rust"` ——
 * `kind` 收成常量后，后半句恒为真，等于只是 `hasStoragePort()`。
 */
function isRust(): boolean {
  return hasStoragePort();
}

/** 配置面**扩展域**的内存镜像（quick_phrases / mcp_servers / memory） */
function rustConfigDomain() {
  if (!hasStoragePort()) return null;
  // 第 19 轮：`if (port.kind !== "rust") return null;` 已删（恒不成立）。
  const port = getStoragePort();
  return (port as { configDomain?: unknown }).configDomain as
    | {
        isWarmed(): boolean;
        read<T>(pick: (s: unknown) => T, fallback: T, scope: string): T;
        patch(p: unknown): void;
      }
    | null
    ?? null;
}

/**
 * 内存镜像里**统一用线协议的行形状（snake_case）**。
 *
 * 这一点必须严格：镜像的读写两侧要用同一种形状。早先 `saveQuickPhrase` 往镜像里写
 * camelCase（`usageCount`），而 `loadQuickPhrases` 按 snake_case（`usage_count`）解析，
 * 结果"存完立刻读"拿到的是 0 —— 契约测试当场抓到（CFG-2/3/4）。
 * 统一到线协议形状后，预热拉到的行与本地改动的行就是同一种东西。
 */
function phraseToRow(p: QuickPhrase, now: number): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    content: p.content,
    category: p.category,
    usage_count: p.usageCount,
    created_at: p.createdAt || now,
    updated_at: p.updatedAt || now,
  };
}

function mcpToRow(s: McpServerConfig): Record<string, unknown> {
  return { id: s.id, name: s.name, config: s.config, enabled: s.enabled };
}

/** 写穿：失败走统一上报（绝不静默吞掉） */
function writeThrough(command: string, params: Record<string, unknown>, scope: string, note: string): void {
  if (!hasStoragePort()) return;
  const port = getStoragePort() as { data?: { execute(c: string, p?: Record<string, unknown>): Promise<{ written: number }> } };
  void port.data
    ?.execute(command, params)
    .catch((e) => reportPersistFailure(scope, e, note));
}

export function getSetting(key: string): string | null {
  const cfg = rustConfig();
  if (cfg) {
    // 端口未预热时 `get` 会返回 fallback 并留痕（不抛、不假装有值）
    return cfg.get<string | null>(key, null);
  }
        return null;
}

export function setSetting(key: string, value: string): void {
  const cfg = rustConfig();
  if (cfg) {
    cfg.set(key, value);
    return;
  }
    reportWriteNotAccepted("settings.setSetting", "设置未保存");
    return;
}

export function removeSetting(key: string): void {
  const cfg = rustConfig();
  if (cfg) {
    cfg.remove(key);
    return;
  }
    reportWriteNotAccepted("settings.removeSetting", "设置未删除");
    return;
}

/**
 * 写入并**确认落库**，返回是否真的写进去了（第 184 波存储审计 S4）。
 *
 * ## 为什么需要它
 *
 * `setSetting` 是 `void`（内存即时生效 + **异步**落库），失败只走上报通道 ——
 * 调用方拿不到"这次到底写进去了没有"。而设置键迁移（`migration.ts`）的动作是
 * "复制到新键 → 删掉旧键"，于是复制那条 IPC 失败（重试耗尽 / 磁盘满 / 引擎忙）时
 * **源键已经被删掉**：键表第一行 `mimo-settings → codem-settings` 就是整份设置
 * （含 provider 配置）丢失，既没有回滚也没有重试。
 *
 * 这与 `secret-store` 里明写的纪律恰好相反 —— 那条是"封存成功 → 一次原子写回 →
 * **才**清明文"。本函数就是把同一条纪律给设置迁移用：
 * **先确认落库成功，才允许调用方删源**。
 *
 * ## 返回 `false` 的三种情形（都**不**删源，下次启动自然重试）
 *
 * 1. 没有配置源（端口未注册）；
 * 2. 端口没有 `setConfirmed` 能力（如实回绝，**不许**退化成"先删了再说"）；
 * 3. 落库失败（引擎报错 / 重试耗尽）。
 */
export async function setSettingConfirmed(key: string, value: string): Promise<boolean> {
  const cfg = rustConfig();
  if (!cfg) {
    reportWriteNotAccepted("settings.setSettingConfirmed", "设置未保存（没有可用的配置源，源键保持不动）");
    return false;
  }
  const setConfirmed = cfg.setConfirmed;
  if (typeof setConfirmed !== "function") {
    reportWriteNotAccepted(
      "settings.setSettingConfirmed",
      "设置未保存（配置面不支持确认式写入：本次**不删源键**，下次启动重试）",
    );
    return false;
  }
  return await setConfirmed.call(cfg, key, value);
}

/**
 * 把"从持久化里读出来的**部分**配置"合并到默认值上，**跳过显式 `undefined`**。
 *
 * ## 为什么不能直接用 `{ ...DEFAULT, ...partial }`（第 181 波，对标 Pi `cd60a5b99`）
 *
 * 对象展开会把**值为 `undefined` 的自有属性也复制过去**，于是默认值被"清成 undefined"：
 *
 * ```ts
 * const DEFAULT = { a: 100, b: 200 };
 * const saved   = JSON.parse('{"b": 500}');   // 正常
 * { ...DEFAULT, ...saved }                    // { a: 100, b: 500 } ✓
 *
 * const saved2  = { b: 500, a: undefined };   // 键在、值是 undefined
 * { ...DEFAULT, ...saved2 }                   // { a: undefined, b: 500 } ✗ a 的默认值没了
 * ```
 *
 * 后果是**静默**的：拿到 `undefined` 的地方通常写成 `setTimeout(f, undefined)`（等价 0ms）、
 * `Math.max(undefined, x)`（NaN）之类，于是"节流失效 / 间隔变 0 / 阈值变 NaN"，
 * 而没有任何地方会报错。Pi 1.0.4 修的就是这个形态（他们的 `progress` 字段）。
 *
 * ## 语义
 *
 * - **键存在但值是 `undefined`** ⇒ 保留默认值（这就是本函数存在的理由）；
 * - **键存在且值是 `null`** ⇒ **保留 `null`**（调用方显式要 null 是合法意图）；
 * - 嵌套对象**不做深合并**（只解决顶层这一层；深合并需要每层各自的默认值语义，
 *   盲目递归会把"整块替换"的意图改掉）。
 */
/**
 * 约束**刻意用 `T extends object`**（不是 `Record<string, unknown>`）：生产里的配置类型
 * 都是普通 `interface`（没有索引签名），用后者会让它们**无法传参**（实测 TS2740）。
 */
export function mergeDefaults<T extends object>(defaults: T, partial?: Partial<T> | null): T {
  if (!partial || typeof partial !== "object") return { ...defaults };
  const merged: T = { ...defaults };
  const target = merged as Record<string, unknown>;
  for (const key of Object.keys(partial)) {
    const value = (partial as Record<string, unknown>)[key];
    if (value !== undefined) target[key] = value;
  }
  return merged;
}

/**
 * 配置面的内存镜像**是否已预热**（第 182 波，真机取证）。
 *
 * `getSetting` / `getSettingJSON` 在**未预热**时按设计返回 fallback（不抛、不假装有值），
 * 但那个 fallback 与"真的没有这个键"**长得一模一样**。于是任何"启动早期读一次就缓存下来"
 * 的模块会把**空表当成结论**固定住整个会话 —— 真机现场就是 `MCPRegistry`：
 * 引擎读得到 `codem-mcp-servers`，面板却永远显示「暂无 MCP 服务器」。
 *
 * 有了这个判据，这类模块就能区分：未预热 ⇒ **不把这次读当结论**；已预热 ⇒ 读到的就是真值。
 */
export function isSettingsMirrorReady(): boolean {
  if (!hasStoragePort()) return false;
  try {
    return getStoragePort().config.stats().warmed === true;
  } catch {
    return false;
  }
}

export function getSettingJSON<T>(key: string, defaultValue: T): T {
  const raw = getSetting(key);
  if (raw === null) return defaultValue;
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
  /**
   * ## 第 62 轮：`codem-settings` 的**凭据水合**（唯一水合点，显式规则）
   *
   * 生产代码里直接读这个键的地方有 **18 处**（见 `secret-cache.ts` 的说明）且全是同步读；
   * 密钥封存（`docs/CREDENTIALS-PLAN.md` 阶段 1）之后，磁盘上只有密文 —— 若让每个读点
   * 自己解封，**漏掉的那一处**就会表现成"界面显示已配置、请求却没有 key"（静默失真）。
   *
   * 所以规则写在这里、只对这一个键生效：读出来的 `providers[].apiKey`
   * **是内存里解封好的明文**（有密文时），磁盘内容**不被改动**。
   * 代价（如实写）：这个键有了"会水合"的额外语义 —— 由 `credential-seal.test.ts` 守着
   * "只对这个键生效、其它键一个字都不许动"。
   */
  if (key === "codem-settings") {
    return hydrateProvidersFromSealCache(parsed);
  }
  return parsed;
}

/** 把 provider 的密文换成内存里的明文（同步；缓存没命中就原样返回，**不猜**） */
function hydrateProvidersFromSealCache<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const providers = (value as { providers?: Array<Record<string, unknown>> }).providers;
  if (!Array.isArray(providers)) return value;
  const next = providers.map((p) => {
    const id = String((p as { id?: unknown })?.id ?? "");
    const plain = id ? cachedSealedKey(id) : undefined;
    return plain ? { ...p, apiKey: plain } : p;
  });
  return { ...(value as Record<string, unknown>), providers: next } as T;
}

export function setSettingJSON(key: string, value: unknown): void {
  /**
   * ## 第 62 轮：`codem-settings` 的**写回闸门**（读语义与写语义必须对称）
   *
   * 读这个键时会把 `providers[].apiKey` 水合成明文（为了 18 个同步读点，见上面 `getSettingJSON`）。
   * 而全项目有 **14 处**「读整份 → 改一个字段 → 整份写回」的读改写（`App.tsx` 3 处、
   * `SettingsPanel.tsx` 11 处）—— 那些写回会**把明文重新写到磁盘上**，
   * 也就是"改一下模型名 = 撤销凭据封存"。真机复量坐实过：
   * 封存成功、残留也回收了，可库里 `apiKey`（明文 35 字符）与 `apiKeySealed` **同时存在**。
   *
   * 修法放在**唯一写收口**这里，而不是去改那 14 个调用点（改一处、下一个新增设置项又会踩进来）：
   * 同步地把"还是原来那把密钥"的明文换回**它自己那份密文**（缓存里有，零 IPC）；
   * 新填/改过的密钥先照原样落盘（**绝不丢用户输入**），再异步补封存。
   *
   * 规则与边界见 `secret-write-guard.ts` 的文件头（含"没有注册钩子时什么都不改"）。
   */
  if (key === "codem-settings") {
    setSetting(key, gateSettingsWrite(key, value));
    return;
  }
  setSetting(key, JSON.stringify(value));
}

// ========== 落库确认（第 45 轮 D-21：「已保存」不许是许愿）==========
//
// ## 为什么需要它
//
// `setSetting` / `setSettingJSON` 的契约是**内存即时生效 + 异步落库**（见文件头），
// 所以它们返回 `void`：调用方拿到的是"已经交给存储"，**不是**"已经写进磁盘"。
// 而界面上的"✅ 已保存"是**无条件的**——只要 setSettingJSON 没抛就显示。
// 真实失败路径（磁盘满 / 引擎 BUSY 重试耗尽）走的是旁路上报
// （`persist-failure.ts` → `codem:persist-failed` → App 的 guidance 提示），
// 于是用户可能**先看到"已保存"、再看到"设置未保存，重启后会丢失"**两条相反的提示。
//
// ## 做法
//
// 端口自己知道"还有几条写在途"（`StorageConfigPort.stats().pendingWrites`）与
// "已经失败了几条"（`.failures`），所以这里不去改写入路径（那 500 个调用点全部
// 依赖它是同步的），而是给**要显示"已保存"的那几处**提供一次可等待的确认：
//
// ```ts
// const probe = beginSettingsWriteProbe();
// setSettingJSON("codem-settings", settings);
// const report = await flushSettingsWrites(probe);
// if (report.settled) setSaved(true); else setSaveFailure(report);
// ```
//
// 判据三条，缺一不可：**写入被接受**（端口在）、**写队列排空**（在途 = 0）、
// **这段窗口内没有新增失败**。

/** 一次写入窗口的起点快照 */
export interface SettingsWriteProbe {
  /** 起点时配置面是否可用（端口未注册 ⇒ 写入根本没被接受） */
  accepted: boolean;
  /** 起点时配置面的累计失败数 */
  portFailures: number;
  /** 起点时已上报过失败的区域（只看**新增**区域，避免把别人的历史失败算到自己头上） */
  areas: string[];
}

export interface SettingsWriteReport extends SettingsWriteProbe {
  /** 等待窗口结束时仍在途的写条数（>0 = 没等到落库确认） */
  pending: number;
  /** 本次窗口内配置面新增的失败数 */
  newFailures: number;
  /** 本次窗口内新出现的失败区域（人可读的诊断） */
  newAreas: string[];
  /** 是否可以作为"已保存"的依据 */
  settled: boolean;
}

/** 读配置面的写队列状态；端口不可用或实现没有 stats 时返回 null（= 无法确认） */
function configWriteStats(): { pending: number; failures: number } | null {
  if (!hasStoragePort()) return null;
  try {
    const s = getStoragePort().config.stats();
    return { pending: Number(s?.pendingWrites ?? 0), failures: Number(s?.failures ?? 0) };
  } catch {
    return null;
  }
}

/** 开始一次写入窗口（在任何 setSetting 之前调用） */
export function beginSettingsWriteProbe(): SettingsWriteProbe {
  const stats = configWriteStats();
  let areas: string[] = [];
  try {
    areas = getPersistFailures().map((f) => f.area);
  } catch {
    areas = [];
  }
  return { accepted: stats !== null, portFailures: stats?.failures ?? 0, areas };
}

/**
 * 等待写入落库并给出可判断的结果。
 *
 * @param probe `beginSettingsWriteProbe()` 的快照
 * @param timeoutMs 等待上限（默认 2s；超时即"没确认"，**不**当成成功）
 */
export async function flushSettingsWrites(
  probe: SettingsWriteProbe,
  timeoutMs = 2000,
): Promise<SettingsWriteReport> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let stats = configWriteStats();
  // 写是异步落库的，只有 `pendingWrites` 归零才谈得上"已经交给引擎"
  while (stats && stats.pending > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    stats = configWriteStats();
  }

  const after = stats;
  const newFailures = Math.max(0, (after?.failures ?? probe.portFailures) - probe.portFailures);
  let newAreas: string[] = [];
  try {
    const known = new Set(probe.areas);
    newAreas = [...new Set(getPersistFailures().map((f) => f.area))].filter((a) => !known.has(a));
  } catch {
    newAreas = [];
  }

  const accepted = after !== null;
  const pending = after?.pending ?? -1; // -1 = 读不到（不能当成"排空了"）
  const settled = accepted && pending === 0 && newFailures === 0 && newAreas.length === 0;
  return { ...probe, accepted, pending, newFailures, newAreas, settled };
}

// ========== Quick Phrase Storage (P2) ==========

export interface QuickPhrase {
  id: string;
  title: string;
  content: string;
  category: "coding" | "review" | "test" | "debug" | "other";
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export function saveQuickPhrase(phrase: QuickPhrase): void {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    const now = Date.now();
    // 内存镜像同步更新（界面立刻可见），写穿到 Rust
    const current = dom.read<Array<Record<string, unknown>>>(
      (s) => (s as { quickPhrases: Array<Record<string, unknown>> }).quickPhrases,
      [],
      "quick_phrases",
    );
    const existing = current.find((q) => q.id === phrase.id);
    const next = existing
      ? current.map((q) =>
          q.id === phrase.id
            ? phraseToRow(
                { ...phrase, usageCount: Number(q.usage_count ?? 0) + 1, createdAt: phrase.createdAt || now },
                now,
              )
            : q,
        )
      : [...current, phraseToRow({ ...phrase, usageCount: phrase.usageCount + 1 }, now)];
    dom.patch({ quickPhrases: next });
    // 注意：usage_count 的自增语义在 Rust 侧实现（`quick_phrases.save` 用
    // `quick_phrases.usage_count + 1`），两边必须一致 —— 这是迁移的动机之一。
    writeThrough(
      "quick_phrases.save",
      {
        id: phrase.id,
        title: phrase.title,
        content: phrase.content,
        category: phrase.category,
        usage_count: phrase.usageCount,
        created_at: phrase.createdAt || now,
        updated_at: now,
      },
      "storage.saveQuickPhrase",
      "快捷短语未保存，重启后会丢失",
    );
    return;
  }
    reportWriteNotAccepted("settings.saveQuickPhrase", "快捷短语未保存");
    return;
}

export function loadQuickPhrases(): QuickPhrase[] {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    const rows = dom.read<Array<Record<string, unknown>>>(
      (s) => (s as { quickPhrases: Array<Record<string, unknown>> }).quickPhrases,
      [],
      "quick_phrases",
    );
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      title: String(r.title ?? ""),
      content: String(r.content ?? ""),
      category: String(r.category ?? "other") as QuickPhrase["category"],
      usageCount: Number(r.usage_count ?? 0),
      createdAt: Number(r.created_at ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    }));
  }
        return [];
}

export function deleteQuickPhrase(phraseId: string): void {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    const current = dom.read<Array<Record<string, unknown>>>(
      (s) => (s as { quickPhrases: Array<Record<string, unknown>> }).quickPhrases,
      [],
      "quick_phrases",
    );
    dom.patch({ quickPhrases: current.filter((q) => q.id !== phraseId) });
    writeThrough("quick_phrases.delete", { id: phraseId }, "storage.deleteQuickPhrase", "快捷短语未删除，重启后还会出现");
    return;
  }
        reportWriteNotAccepted("settings.deleteQuickPhrase", "快捷短语未删除");
        return;
}

export function incrementQuickPhraseUsage(phraseId: string): void {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    const now = Date.now();
    const current = dom.read<Array<Record<string, unknown>>>(
      (s) => (s as { quickPhrases: Array<Record<string, unknown>> }).quickPhrases,
      [],
      "quick_phrases",
    );
    dom.patch({
      quickPhrases: current.map((q) =>
        q.id === phraseId ? { ...q, usage_count: Number(q.usage_count ?? 0) + 1, updated_at: now } : q,
      ),
    });
    writeThrough("quick_phrases.touch", { id: phraseId, updated_at: now }, "storage.incrementQuickPhraseUsage", "快捷短语使用次数未累加");
    return;
  }
        reportWriteNotAccepted("settings.incrementQuickPhraseUsage", "快捷短语使用次数未更新");
        return;
}

// ========== MCP Server Storage ==========

export interface McpServerConfig {
  id: string;
  name: string;
  config: string;
  enabled: boolean;
}

export function loadMcpServers(): McpServerConfig[] {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    const rows = dom.read<Array<Record<string, unknown>>>(
      (s) => (s as { mcpServers: Array<Record<string, unknown>> }).mcpServers,
      [],
      "mcp_servers",
    );
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      config: String(r.config ?? ""),
      enabled: r.enabled === true,
    }));
  }
        return [];
}

export function saveMcpServer(id: string, name: string, config: string, enabled: boolean): void {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    const current = dom.read<McpServerConfig[]>((s) => (s as { mcpServers: McpServerConfig[] }).mcpServers, [], "mcp_servers");
    const next = current.some((s) => s.id === id)
      ? current.map((s) => (s.id === id ? { id, name, config, enabled } : s))
      : [...current, { id, name, config, enabled }];
    dom.patch({ mcpServers: next });
    writeThrough("mcp_servers.save", { id, name, config, enabled }, "storage.saveMcpServer", "MCP 服务器配置未保存");
    return;
  }
    reportWriteNotAccepted("settings.saveMcpServer", "MCP 服务未保存");
    return;
}

export function removeMcpServer(id: string): void {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    const current = dom.read<McpServerConfig[]>((s) => (s as { mcpServers: McpServerConfig[] }).mcpServers, [], "mcp_servers");
    dom.patch({ mcpServers: current.filter((s) => s.id !== id) });
    writeThrough("mcp_servers.remove", { id }, "storage.removeMcpServer", "MCP 服务器未删除");
    return;
  }
    reportWriteNotAccepted("settings.removeMcpServer", "MCP 服务未删除");
    return;
}

// ========== Memory Storage ==========

export function loadMemory(): string {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    return dom.read<string>((s) => (s as { memory: string }).memory, "", "memory");
  }
        return "";
}

export function saveMemory(content: string): void {
  /**
   * I1（硬要求）：**所有写路径都要检查预热状态**。
   *
   * 未预热时 `read()` 返回 fallback（空串），而 `patch()` **不检查**预热状态 ——
   * 于是"把兜底空串整份写回 `memory` 字段"这件事真的会发生；而 `MemoryService.save()` 是
   * 全量重写、`finalizeBatch()` 每回合都调它 ⇒ **预热失败后的下一个回合就把全部历史记忆清空**。
   * 这里直接拒绝写（并如实上报），绝不把 fallback 派生出的值写回磁盘。
   */
  if (!isMemoryDomainReady()) {
    reportWriteNotAccepted(
      "settings.saveMemory",
      `记忆未保存：${MEMORY_DOMAIN_NOT_WARMED}（拒绝把兜底值写回库，库内容保持原样）`,
    );
    return;
  }
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    dom.patch({ memory: content });
    writeThrough("memory.set", { content }, "storage.saveMemory", "记忆内容未保存");
    return;
  }
    reportWriteNotAccepted("settings.saveMemory", "记忆未保存");
    return;
}

// ========== 记忆读写的**就绪判据**与确认式写入（第 187 波 I1 / I6）==========
//
// ## I1：为什么写路径必须自己判「预热好了没有」
//
// `config_warmup` 一次抓三个域（`quick_phrases` / `mcp_servers` / `memory`），
// **任一域失败整条预热失败**，而 `RustStoragePort.start()` 对扩展域失败是「只上报不抛」
// ⇒ 端口照常注册，但 `RustConfigDomainCache.warmed` 恒为 false ⇒ `read()` 返回 **fallback**。
//
// 危险的是**写**那一侧：`patch()` 不看预热状态，`saveMemory("")` 于是把「兜底空串」当成
// 真实内容整份写回 `memory` 字段 —— 而 `MemoryService.save()` 是**全量重写**，
// `finalizeBatch()` 每回合都调它 ⇒ **预热失败后的下一个回合就把全部历史记忆清空**。
//
// 所以写路径与读路径用**同一个判据**：`isMemoryDomainReady()` 为假 ⇒ 拒绝写并如实上报，
// **绝不允许**把 fallback 派生出来的值写回磁盘。

/** 记忆域读不到时的原因文案（**用户可读**；调用方要把它如实带到界面上） */
export const MEMORY_DOMAIN_NOT_WARMED = "配置面记忆域尚未预热（读到/写回的都会是兜底值，不是真实数据）";
export const MEMORY_DOMAIN_NO_PORT = "没有可用的存储端口（本次既读不到也写不了记忆）";

/**
 * 记忆域（`memory` 字段所在的那个配置扩展域）**是否已经预热**（第 187 波 I1）。
 *
 * 判据取两层，缺一不可：
 * - 设置面镜像已预热（`isSettingsMirrorReady()`：迁移标记这类键得**真的写得上磁盘**）；
 * - 扩展域自己也已预热（`configDomain.isWarmed()`：`memory` 字段的镜像**不是**兜底值）。
 *
 * 只判第一层是不够的：`config_warmup` 是「一把抓三个域」，设置面成功、扩展域失败是**真实形态**，
 * 而那时 `loadMemory()` 返回的正是兜底空串。
 */
export function isMemoryDomainReady(): boolean {
  if (!hasStoragePort()) return false;
  if (!isSettingsMirrorReady()) return false;
  const dom = rustConfigDomain();
  if (!dom) return false;
  try {
    return dom.isWarmed() === true;
  } catch {
    return false;
  }
}

/** 一次记忆读取的结果：**必须能区分「读不到」与「本来就空」** */
export type MemoryReadResult = { ok: true; data: string; bytes: number } | { ok: false; reason: string };

/**
 * 记忆读取（**带就绪判据**的那一版）。
 *
 * `loadMemory()` 在未预热时返回 `""`，与「这个库里真的一条记忆都没有」**长得一模一样**。
 * 任何据此判断「记忆为空」的调用方（尤其是一次性迁移）都必须改用本函数。
 */
export function loadMemoryChecked(): MemoryReadResult {
  if (!hasStoragePort()) return { ok: false, reason: MEMORY_DOMAIN_NO_PORT };
  if (!isMemoryDomainReady()) return { ok: false, reason: MEMORY_DOMAIN_NOT_WARMED };
  try {
    const data = loadMemory();
    if (typeof data !== "string") {
      return { ok: false, reason: `memory 字段不是字符串（实际是 ${typeof data}）：库内容不是本模块能解释的形状` };
    }
    return { ok: true, data, bytes: data.length };
  } catch (e) {
    return { ok: false, reason: `记忆读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 记忆写入的**确认式**版本（第 187 波 I6）。
 *
 * 与 `saveMemory` 的差别是「能等到结果」：`writeThrough` 只 `.catch(上报)`，
 * 于是 `MemoryService.save()` 的返回值**只反映有没有抛同步异常** —— IPC 失败 / 重试耗尽 /
 * 磁盘满都不会让它变成 false，界面因此永远显示「保存成功」。
 *
 * 返回 `{ ok:false, reason }` 的四种情形（都**不**改镜像、**不**发写穿）：
 * ① 没有端口；② 记忆域未预热（I1）；③ 端口没有 `execute` 能力；
 * ④ 引擎报错（`memory.set` 被拒 / 重试耗尽）。
 */
export async function saveMemoryConfirmed(content: string): Promise<{ ok: boolean; reason?: string }> {
  const result = await writeMemoryConfirmed(content);
  if (result.ok) rustConfigDomain()?.patch({ memory: content });
  return result;
}

/**
 * **只更新内存镜像**（同步；"内存即时生效"这一半）。
 *
 * 第 187 波 R1 把记忆写入拆成两半，因为"两件事必须能分别确认"：
 * - `patchMemoryMirror()`：同步改镜像（保证同一 tick 之后的读路径看得到新内容，
 *   例如迁移后立刻 `new MemoryService()` 要读到迁移后的形态）；
 * - `writeMemoryConfirmed()`：异步写穿并**等引擎答复**（不碰镜像）。
 *
 * 未预热时**拒绝**（I1）并如实上报 —— 绝不把 fallback 派生出的内容写回磁盘。
 */
export function patchMemoryMirror(content: string): void {
  if (!isMemoryDomainReady()) {
    reportWriteNotAccepted("settings.patchMemoryMirror", `记忆镜像未更新：${MEMORY_DOMAIN_NOT_WARMED}`);
    return;
  }
  rustConfigDomain()?.patch({ memory: content });
}

/**
 * **只写穿并等确认**（不改镜像；R1/F6）。
 *
 * 与 `saveMemoryConfirmed` 的差别：后者在成功后顺带更新镜像（"写一份完整记忆"用），
 * 本函数只负责"磁盘上落定了没有"（写路径自己已经在同步那半改过镜像）。
 *
 * 返回 `{ ok:false, reason }` 的四种情形：① 没有端口；② 记忆域未预热；
 * ③ 端口没有 `execute` 能力；④ 引擎报错（`memory.set` 被拒 / 重试耗尽）。
 */
export async function writeMemoryConfirmed(content: string): Promise<{ ok: boolean; reason?: string }> {
  if (!hasStoragePort()) return { ok: false, reason: MEMORY_DOMAIN_NO_PORT };
  if (!isMemoryDomainReady()) return { ok: false, reason: MEMORY_DOMAIN_NOT_WARMED };
  const port = getStoragePort() as { data?: { execute(c: string, p?: Record<string, unknown>): Promise<{ written: number }> } };
  if (typeof port.data?.execute !== "function") {
    return { ok: false, reason: "存储端口不支持确认式写穿（拒绝写入，避免把内存态当成已落库）" };
  }
  try {
    await port.data.execute("memory.set", { content });
  } catch (e) {
    return { ok: false, reason: `记忆落库失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}

// ========== Recovery Data Storage ==========

// P5 第 8 段：`recovery_data` 与 `cost_records` 接入端口。
// 原实现**没有端口分支** —— 也就是说这两张表的读写一直只走旧库，
// 属于 L3 清单里"回退分支其实就是实现"的那一类（不是"回退"，是唯一实现）。
// 不补上它们，删掉旧引擎时这两个域会真的失效（崩溃恢复数据、成本统计）。
const RECOVERY_TABLE = "recovery_data";
const COST_TABLE = "cost_records";

export function loadRecoveryData(sessionId: string): string | null {
  const rust = domainReadOne(RECOVERY_TABLE, { session_id: sessionId }, (row) => String(row.data ?? ""));
  if (rust !== undefined) return rust;
  // 第 17 轮（L4）：旧库回退（`tryGetDatabase()` + 旧 SQL + catch）已删 ——
  // 镜像未就绪时返回 null（"现在读不到"），不再去碰一份刻意不存在的旧库。
  return null;
}

export function saveRecoveryData(sessionId: string, data: string): void {
  const now = Date.now();
  if (domainWrite(RECOVERY_TABLE, [{ session_id: sessionId, data, updated_at: now }], {
    mode: "replace",
    scope: "settings.saveRecoveryData",
    note: "崩溃恢复数据未保存",
  })) {
    return;
  }
    reportWriteNotAccepted("settings.saveRecoveryData", "崩溃恢复数据未保存");
    return;
}

function removeRecoveryData(sessionId: string): void {
  if (domainDelete(RECOVERY_TABLE, { session_id: sessionId }, {
    scope: "settings.removeRecoveryData",
    note: "崩溃恢复数据未删除",
  })) {
    return;
  }
    reportWriteNotAccepted("settings.removeRecoveryData", "崩溃恢复数据未删除");
    return;
}

// ========== Cost Records Storage ==========
//
// ## ⚠️ 这个域**当前没有接线**，第 44 轮把三个"看起来有实现"的死函数删掉了
//
// 审计（真机 + 全仓 grep）坐实的现状：
//
// - `cost_records` 表在 schema 里、也被迁移搬过来，但**零写点、零读点**；
// - 真实的成本持久化在 `cost-tracker.ts`：整个记录数组被 JSON 序列化后塞进
//   `settings` 表的一个键（`codem-cost-tracker`）；
// - 而 `rust-port.ts` 里那句注释写着 "`cost_records`（可能上万行）**不进这个缓存**……
//   属于数据面" —— 与"其实一条都没用"完全相反。
//
// 原来这里有 `addCostRecord` / `getCostRecords` / `getCostStats` 三个导出函数：
// 它们**全仓零调用者**（只有定义与自引用）。留着它们的代价不是"多几行代码"，
// 而是让"成本已经入库了"这件事看起来成立 —— 审计就是这么被骗过一次的。
//
// 所以现在删掉函数，只留这段说明。**`cost_records` 表本身不删**：
// 迁移进来的历史行是用户数据的副本，删表只会让"想用起来"这条路更难走。
// 将来若要把成本搬进这张表，需要先回答三件在 `getCostStats` 里已经写在纸上的事：
// 服务端分页（上万行）、按时间的聚合、以及"settings 里那份旧数据怎么迁"。
//
// `CostRecord` 类型保留：`cost-tracker.ts` 的记录形状与它一致，是将来落库的接口草案。

interface CostRecord {
  id: string;
  sessionId: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  duration: number;
  timestamp: number;
}

