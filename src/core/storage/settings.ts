import { reportPersistFailure } from "./persist-failure";
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
// ## 分流规则（迁移期）
//
// - 端口已注册且是 `rust` → 读走端口的内存缓存（同步），写走"内存即时生效 + 写穿队列"；
// - 否则（默认）→ 完全维持原来的 WASM 行为，**一个字节都不变**。
//
// 这条分流是"回滚开关"能生效的关键：`localStorage[codem-storage-engine]=wasm`
// 时端口不注册，这里自动退回原路径。
//
// ## 硬约束
//
// `settings` 是**唯一**允许进内存镜像的数据（配置的量级是几十行）。
// 消息语料绝不进渲染进程 —— 见 port.ts 的硬约束 4。

/** 端口可用时用端口（rust 引擎），否则返回 null 走原路径 */
function rustConfig() {
  if (!hasStoragePort()) return null;
  const port = getStoragePort();
  return port.kind === "rust" ? port.config : null;
}

/** 是否处于 rust 引擎（配置面扩展域的分流判据） */
function isRust(): boolean {
  return hasStoragePort() && getStoragePort().kind === "rust";
}

/** 配置面**扩展域**的内存镜像（quick_phrases / mcp_servers / memory） */
function rustConfigDomain() {
  if (!hasStoragePort()) return null;
  const port = getStoragePort();
  if (port.kind !== "rust") return null;
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

export function getSettingJSON<T>(key: string, defaultValue: T): T {
  const raw = getSetting(key);
  if (raw === null) return defaultValue;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

export function setSettingJSON(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
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
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    dom.patch({ memory: content });
    writeThrough("memory.set", { content }, "storage.saveMemory", "记忆内容未保存");
    return;
  }
    reportWriteNotAccepted("settings.saveMemory", "记忆未保存");
    return;
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

export function removeRecoveryData(sessionId: string): void {
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

export interface CostRecord {
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

/** `cost_records` 行 → `CostRecord`（列名 snake_case → 驼峰） */
function wireToCostRecord(row: Record<string, unknown>): CostRecord {
  return {
    id: String(row.id ?? ""),
    sessionId: String(row.session_id ?? ""),
    model: String(row.model ?? ""),
    provider: String(row.provider ?? ""),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    cost: Number(row.cost ?? 0),
    duration: Number(row.duration ?? 0),
    timestamp: Number(row.timestamp ?? 0),
  };
}

export function addCostRecord(record: CostRecord): void {
  if (domainWrite(COST_TABLE, [{
    id: record.id,
    session_id: record.sessionId,
    model: record.model,
    provider: record.provider,
    prompt_tokens: record.promptTokens,
    completion_tokens: record.completionTokens,
    cost: record.cost,
    duration: record.duration,
    timestamp: record.timestamp,
  }], { scope: "settings.addCostRecord", note: "成本记录未保存" })) {
    return;
  }
    reportWriteNotAccepted("settings.addCostRecord", "成本记录未保存");
    return;
}

export function getCostRecords(limit: number = 1000): CostRecord[] {
  const rust = domainReadMany(COST_TABLE, wireToCostRecord);
  if (rust) {
    // 旧 SQL：ORDER BY timestamp DESC LIMIT ?
    return rust.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
  return []; // 第 17 轮（L4）：旧库回退已删 —— 镜像未就绪 → 诚实的空结果（端口就绪后重读）
}

export function getCostStats(): { totalCost: number; todayCost: number; totalSessions: number; totalTokens: number } {
  const rust = domainReadMany(COST_TABLE, wireToCostRecord);
  if (rust) {
    // 四个聚合在**同一份数据**上算完（旧实现是四条独立 SELECT）
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const since = todayStart.getTime();
    let totalCost = 0;
    let todayCost = 0;
    let totalTokens = 0;
    const sessions = new Set<string>();
    for (const r of rust) {
      totalCost += r.cost;
      if (r.timestamp >= since) todayCost += r.cost;
      totalTokens += r.promptTokens + r.completionTokens;
      sessions.add(r.sessionId);
    }
    return { totalCost, todayCost, totalSessions: sessions.size, totalTokens };
  }
  // 第 17 轮（L4）：旧库回退（`tryGetDatabase()` + 四条聚合 SQL + catch）已删 ——
  // 四个聚合在端口分支里已经在**同一份数据**上算完了；镜像未就绪时给空统计。
  return { totalCost: 0, todayCost: 0, totalSessions: 0, totalTokens: 0 };
}
