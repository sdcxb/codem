import { getDatabase, tryGetDatabase, persistDatabase } from "./database";
import { reportPersistFailure } from "./persist-failure";
import { getStoragePort, hasStoragePort } from "./port";
import { domainDelete, domainReadMany, domainReadOne, domainWrite, shouldFallbackToLegacy, writeShouldFallBackToLegacy } from "./domain-store";

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
  try {
        if (!shouldFallbackToLegacy()) return null;
const db = getDatabase();
    const result = db.exec("SELECT value FROM settings WHERE key = ?", [key]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: string): void {
  const cfg = rustConfig();
  if (cfg) {
    cfg.set(key, value);
    return;
  }
    if (!writeShouldFallBackToLegacy("settings.setSetting", "设置未保存")) return;
const db = getDatabase();
  const now = Date.now();
  db.run(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
    [key, value, now]
  );
  persistDatabase();
}

export function removeSetting(key: string): void {
  const cfg = rustConfig();
  if (cfg) {
    cfg.remove(key);
    return;
  }
    if (!writeShouldFallBackToLegacy("settings.removeSetting", "设置未删除")) return;
const db = getDatabase();
  db.run("DELETE FROM settings WHERE key = ?", [key]);
  persistDatabase();
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
    if (!writeShouldFallBackToLegacy("settings.saveQuickPhrase", "快捷短语未保存")) return;
const db = getDatabase();
  const now = Date.now();

  db.run(
    `INSERT INTO quick_phrases (id, title, content, category, usage_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       category = excluded.category,
       usage_count = usage_count + 1,
       updated_at = excluded.updated_at`,
    [phrase.id, phrase.title, phrase.content, phrase.category, phrase.usageCount + 1, phrase.createdAt || now, now]
  );

  persistDatabase();
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
  try {
        if (!shouldFallbackToLegacy()) return [];
const db = getDatabase();
    const result = db.exec(
      "SELECT id, title, content, category, usage_count, created_at, updated_at FROM quick_phrases ORDER BY usage_count DESC, updated_at DESC"
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      title: row[1] as string,
      content: row[2] as string,
      category: row[3] as string as QuickPhrase["category"],
      usageCount: row[4] as number,
      createdAt: row[5] as number,
      updatedAt: row[6] as number,
    }));
  } catch {
    return [];
  }
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
  try {
        if (!writeShouldFallBackToLegacy("settings.deleteQuickPhrase", "快捷短语未删除")) return;
const db = getDatabase();
    db.run("DELETE FROM quick_phrases WHERE id = ?", [phraseId]);
    persistDatabase();
  } catch (e) { reportPersistFailure("storage.deleteQuickPhrase", e, "快捷短语未删除，重启后还会出现"); }
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
  try {
        if (!writeShouldFallBackToLegacy("settings.incrementQuickPhraseUsage", "快捷短语使用次数未更新")) return;
const db = getDatabase();
    db.run(
      "UPDATE quick_phrases SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?",
      [Date.now(), phraseId]
    );
    persistDatabase();
  } catch (e) { console.warn('[settings.ts]', e) }
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
  try {
        if (!shouldFallbackToLegacy()) return [];
const db = getDatabase();
    const result = db.exec("SELECT id, name, config, enabled FROM mcp_servers ORDER BY name");
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      name: row[1] as string,
      config: row[2] as string,
      enabled: (row[3] as number) === 1,
    }));
  } catch {
    return [];
  }
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
    if (!writeShouldFallBackToLegacy("settings.saveMcpServer", "MCP 服务未保存")) return;
const db = getDatabase();
  const now = Date.now();
  db.run(
    "INSERT OR REPLACE INTO mcp_servers (id, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, name, config, enabled ? 1 : 0, now, now]
  );
  persistDatabase();
}

export function removeMcpServer(id: string): void {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    const current = dom.read<McpServerConfig[]>((s) => (s as { mcpServers: McpServerConfig[] }).mcpServers, [], "mcp_servers");
    dom.patch({ mcpServers: current.filter((s) => s.id !== id) });
    writeThrough("mcp_servers.remove", { id }, "storage.removeMcpServer", "MCP 服务器未删除");
    return;
  }
    if (!writeShouldFallBackToLegacy("settings.removeMcpServer", "MCP 服务未删除")) return;
const db = getDatabase();
  db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
  persistDatabase();
}

// ========== Memory Storage ==========

export function loadMemory(): string {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    return dom.read<string>((s) => (s as { memory: string }).memory, "", "memory");
  }
  try {
        if (!shouldFallbackToLegacy()) return "";
const db = getDatabase();
    const result = db.exec("SELECT content FROM memory WHERE id = 'default'");
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return "";
  } catch {
    return "";
  }
}

export function saveMemory(content: string): void {
  const dom = rustConfigDomain();
  if (dom && isRust()) {
    dom.patch({ memory: content });
    writeThrough("memory.set", { content }, "storage.saveMemory", "记忆内容未保存");
    return;
  }
    if (!writeShouldFallBackToLegacy("settings.saveMemory", "记忆未保存")) return;
const db = getDatabase();
  const now = Date.now();
  db.run(
    "INSERT OR REPLACE INTO memory (id, content, updated_at) VALUES ('default', ?, ?)",
    [content, now]
  );
  persistDatabase();
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
  try {
    const db = tryGetDatabase();
    if (!db) return null;
    const result = db.exec("SELECT data FROM recovery_data WHERE session_id = ?", [sessionId]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  } catch {
    return null;
  }
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
    if (!writeShouldFallBackToLegacy("settings.saveRecoveryData", "崩溃恢复数据未保存")) return;
const db = getDatabase();
  db.run(
    "INSERT OR REPLACE INTO recovery_data (session_id, data, updated_at) VALUES (?, ?, ?)",
    [sessionId, data, now]
  );
  persistDatabase();
}

export function removeRecoveryData(sessionId: string): void {
  if (domainDelete(RECOVERY_TABLE, { session_id: sessionId }, {
    scope: "settings.removeRecoveryData",
    note: "崩溃恢复数据未删除",
  })) {
    return;
  }
    if (!writeShouldFallBackToLegacy("settings.removeRecoveryData", "崩溃恢复数据未删除")) return;
const db = getDatabase();
  db.run("DELETE FROM recovery_data WHERE session_id = ?", [sessionId]);
  persistDatabase();
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
    if (!writeShouldFallBackToLegacy("settings.addCostRecord", "成本记录未保存")) return;
const db = getDatabase();
  db.run(
    "INSERT INTO cost_records (id, session_id, model, provider, prompt_tokens, completion_tokens, cost, duration, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [record.id, record.sessionId, record.model, record.provider, record.promptTokens, record.completionTokens, record.cost, record.duration, record.timestamp]
  );
  persistDatabase();
}

export function getCostRecords(limit: number = 1000): CostRecord[] {
  const rust = domainReadMany(COST_TABLE, wireToCostRecord);
  if (rust) {
    // 旧 SQL：ORDER BY timestamp DESC LIMIT ?
    return rust.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
  try {
    const db = tryGetDatabase();
    if (!db) return [];
    const result = db.exec(
      "SELECT id, session_id, model, provider, prompt_tokens, completion_tokens, cost, duration, timestamp FROM cost_records ORDER BY timestamp DESC LIMIT ?",
      [limit]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      sessionId: row[1] as string,
      model: row[2] as string,
      provider: row[3] as string,
      promptTokens: row[4] as number,
      completionTokens: row[5] as number,
      cost: row[6] as number,
      duration: row[7] as number,
      timestamp: row[8] as number,
    }));
  } catch {
    return [];
  }
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
  try {
    const db = tryGetDatabase();
    if (!db) return { totalCost: 0, todayCost: 0, totalSessions: 0, totalTokens: 0 };
    const totalResult = db.exec("SELECT COALESCE(SUM(cost), 0) FROM cost_records");
    const totalCost = totalResult.length > 0 ? (totalResult[0].values[0][0] as number) : 0;
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayResult = db.exec("SELECT COALESCE(SUM(cost), 0) FROM cost_records WHERE timestamp >= ?", [todayStart.getTime()]);
    const todayCost = todayResult.length > 0 ? (todayResult[0].values[0][0] as number) : 0;
    
    const sessionsResult = db.exec("SELECT COUNT(DISTINCT session_id) FROM cost_records");
    const totalSessions = sessionsResult.length > 0 ? (sessionsResult[0].values[0][0] as number) : 0;
    
    const tokensResult = db.exec("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM cost_records");
    const totalTokens = tokensResult.length > 0 ? (tokensResult[0].values[0][0] as number) : 0;
    
    return { totalCost, todayCost, totalSessions, totalTokens };
  } catch {
    return { totalCost: 0, todayCost: 0, totalSessions: 0, totalTokens: 0 };
  }
}
