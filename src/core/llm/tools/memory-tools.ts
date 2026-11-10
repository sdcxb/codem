/**
 * 记忆检索工具（P0-1 / D4 / 24 §0.1–§0.4）：`memory_search` + `memory_read`。
 *
 * ## 为什么需要它们（真机形态）
 *
 * 注入侧每行只给**摘要上限 120 字符**（`MEMORY_INJECT_LINE_MAX`），而一条记忆允许 10,000 字符。
 * 800 字的项目约定，模型每轮只看到开头 120 字，剩下 680 字在库里**却没有任何入口**
 * —— 于是「零星记不住」不是模型记性问题，是**取不回**。
 *
 * 索引式注入（24 §0.4）把入口直接写在行里：每行 `- [date] (id) key — 摘要… ·用N`，
 * id 恒在行内 ⇒ 模型不需要等「被截断」才知道该读哪一条。
 *
 * ## 边界（与 D4 一致）
 *
 * - **不新增/不删除/不改写条目正文**；但 `memory_read` 会把 `usageCount`/`lastUsedAt`
 *   记一次（那就是 P0-1 要的使用信号，见 `MemoryEntry.usageCount` 的口径）——
 *   所以它的契约**不是只读**：`readOnly: false` + `sideEffectScope: "memory"`。
 *   早先这里声明成 `readOnly: true / none` 是与事实相反的（权限层会据此当只读放行，
 *   而它确实在写记忆库）；`memory_search` 仍是真的只读；
 * - **作用域 fail-closed**：检索/读取都用 `injectionScopeContext` 构造上下文，
 *   看不到别的项目/别的对话的条目（这是 `visibleIn` 的既有契约，不在这里重写）；
 * - **pending 默认不可见**：未批准的条目不该被模型"读出来"绕开审批；
 * - 读不到时**如实说**（不假装"没有这条记忆"）：服务没起来 / 不可见 / id 不存在
 *   是三种不同的事实。
 */
import type { ToolContext, ToolDef, ToolExecuteResult } from "../tools";
import { redactForModelEgress } from "../../privacy/egress";
import {
  getMemoryService,
  hasMemoryServiceInstance,
  injectionScopeContext,
  injectedIn,
  isExpiredMemoryEntry,
  isPendingMemoryEntry,
  memoryExpiryTag,
  memorySourceOf,
  projectIdFromCwd,
  validUntilOf,
  type MemoryScope,
  type MemorySearchBackend,
} from "../../memory/memory";

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;
const READ_DEFAULT_MAX_CHARS = 8_000;
const READ_MAX_CHARS = 10_000;

/**
 * 结果契约（output-schema 棘轮：新工具必须顺手声明结果形状）。
 * `text` 就是模型可见文本（与 `output` 逐字相同），其余字段供下游/判据消费。
 */
const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    query: { type: "string" },
    count: { type: "number" },
    ids: { type: "array", items: { type: "string" } },
    /** C08：本轮命中里**已过期**的条数（≥1 时文本里逐条标了 `expired`） */
    expired: { type: "number" },
    /** P2-A：本次检索的作用域模式（默认 `current`，跨作用域必须显式 `all`） */
    scopeMode: { type: "string", enum: ["current", "all"] },
    /** P2-A/P2-C：实际取数路径（`current` / `fts` 镜像 / 回退 `settings` 扫描） */
    backend: {
      type: "string",
      enum: ["current", "fts", "settings", "fts+hybrid", "fts+fallback"],
    },
    /** P2-A：`scopeMode=all` 时的项目过滤（只回显，不参与任何判定） */
    projectId: { type: "string" },
    /** P2-A：`scopeMode=all` 时的会话过滤（只回显，不参与任何判定） */
    sessionId: { type: "string" },
    /** 任务 A：本次是否**请求**了混合检索（`true` 不等于语义分一定参与排序 —— 看 `backend`） */
    hybrid: { type: "boolean" },
  },
  required: ["text", "query", "count", "ids", "expired", "scopeMode", "backend", "hybrid"],
  additionalProperties: false,
} as const;

const READ_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    id: { type: "string" },
    scope: { type: "string" },
    key: { type: "string" },
    truncated: { type: "boolean" },
    totalChars: { type: "number" },
    /** C08：来源（`manual` / `auto` / 旧数据的 `unknown`） */
    source: { type: "string" },
    /** C08：有效期已过（`true` 时文本里必须有 `expired` 标记，不许静默当有效） */
    expired: { type: "boolean" },
    /** C08：与这一条冲突的其它条目 id（空数组 = 没有发现冲突） */
    conflicts: { type: "array", items: { type: "string" } },
  },
  required: ["text", "id", "scope", "key", "truncated", "totalChars", "source", "expired", "conflicts"],
  additionalProperties: false,
} as const;

const renderTextValue = (v: unknown): string => String((v as { text?: unknown } | null)?.text ?? "");

/** 三种"读不到"必须能区分：服务没起来 ≠ 不可见 ≠ 不存在 */
type MemoryServiceGate =
  | { ok: true; service: ReturnType<typeof getMemoryService> }
  | { ok: false; output: string };

function memoryServiceGate(toolId: string): MemoryServiceGate {
  if (!hasMemoryServiceInstance()) {
    return {
      ok: false,
      output:
        `Error: 记忆服务此刻还没初始化，${toolId} 读不到任何条目。` +
        `这不是「没有相关记忆」—— 不要据此断言用户没记过这件事；稍后重试。`,
    };
  }
  return { ok: true, service: getMemoryService() };
}

function scopeContext(ctx: ToolContext) {
  return injectionScopeContext(projectIdFromCwd(ctx.cwd), ctx.sessionId);
}

function parseScope(raw: unknown): MemoryScope | undefined {
  return raw === "platform" || raw === "project" || raw === "team" || raw === "conversation" ? raw : undefined;
}

export function createMemorySearchTool(): ToolDef {
  return {
    id: "memory_search",
    contract: {
      readOnly: true,
      accessScope: "none",
      sideEffectScope: "none",
      outputSchema: SEARCH_OUTPUT_SCHEMA,
      renderOutput: renderTextValue,
    },
    guidance:
      "Use memory_search to find long-term memories (conventions, preferences, past decisions) by keyword. " +
      "Default: current project/conversation only. scopeMode=\"all\" + projectId or sessionId searches another " +
      "explicit scope (opt-in; no filter ⇒ rejected). hybrid=true requests semantic rerank (off by default; " +
      "falls back to keywords when no embedding backend is configured). Lines are truncated; search + " +
      "memory_read recovers the rest.",
    description: `Search long-term memory entries by keyword.
Default (scopeMode="current"): current scope only (platform / this project / this conversation).
Opt-in (scopeMode="all") requires projectId and/or sessionId; returns platform + that project/conversation.
No filter ⇒ rejected (no silent widening). Returns id, scope, owner, key, score, snippet; memory_read gives
the full entry. Pending (unapproved) and archived entries are NOT returned.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for (space separated)." },
        scope: {
          type: "string",
          enum: ["platform", "project", "team", "conversation"],
          description: "Optional: restrict to one scope.",
        },
        limit: { type: "number", description: `Max results (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` },
        scopeMode: {
          type: "string",
          enum: ["current", "all"],
          description: "Default \"current\" (this project/conversation). \"all\" = opt-in cross-scope search (needs projectId/sessionId).",
        },
        projectId: {
          type: "string",
          description: "Only with scopeMode=\"all\": project to include (platform entries always included).",
        },
        sessionId: {
          type: "string",
          description: "Only with scopeMode=\"all\": conversation to include (platform entries always included).",
        },
        hybrid: {
          type: "boolean",
          description:
            "Optional semantic rerank (off by default; needs an embedding backend, else keyword-only fallback).",
        },
      },
      required: ["query"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const gate = memoryServiceGate("memory_search");
      if (!gate.ok) return { title: "memory_search", output: gate.output, isError: true };

      const query = String(args.query ?? "").trim();
      if (!query) {
        return { title: "memory_search", output: "Error: query 不能为空。", isError: true };
      }
      const scope = parseScope(args.scope);
      const rawLimit = Number(args.limit);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.floor(rawLimit), 1), SEARCH_MAX_LIMIT)
        : SEARCH_DEFAULT_LIMIT;

      /**
       * P2-A：跨作用域检索必须**显式 opt-in**，而且**必须指名范围**。
       *
       * 三种非法形态都 fail-closed（宁可报错也不"猜一个范围"）：
       * ① `scopeMode` 不是 current/all ⇒ 参数错误（不静默降级成 current）；
       * ② `scopeMode=all` 但没有任何过滤 ⇒ 拒绝（不给「全库搜索」这种默认）；
       * ③ `scopeMode=current` 却传了 projectId/sessionId ⇒ 拒绝（调用方显然以为过滤生效了，
       *    静默忽略会让它把"当前位置的结果"误当成"那个项目的结果"）。
       */
      const rawScopeMode = args.scopeMode === undefined ? "current" : String(args.scopeMode);
      if (rawScopeMode !== "current" && rawScopeMode !== "all") {
        return {
          title: "memory_search",
          output: `Error: scopeMode 只能是 "current" 或 "all"（收到 ${JSON.stringify(args.scopeMode)}）。`,
          isError: true,
        };
      }
      const scopeMode: "current" | "all" = rawScopeMode;
      const projectId = typeof args.projectId === "string" ? args.projectId.trim() : "";
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (scopeMode === "current" && (projectId || sessionId)) {
        return {
          title: "memory_search",
          output:
            "Error: projectId / sessionId 只在 scopeMode=\"all\" 时可用；当前是 \"current\"（只查本项目/本对话）。" +
            " 要跨作用域检索请显式传 scopeMode=\"all\"。",
          isError: true,
        };
      }
      if (scopeMode === "all" && !projectId && !sessionId) {
        return {
          title: "memory_search",
          output:
            "Error: 跨作用域检索必须给出 projectId 或 sessionId（scopeMode=\"all\" 缺过滤条件会被拒绝 —— " +
            "不提供「全库搜索」，那会泄漏其它项目）。",
          isError: true,
        };
      }

      /**
       * 任务 A：`hybrid` 只能是**布尔**。字符串 `"true"` / 数字 `1` 一律拒绝 ——
       * 静默当 false 会让调用方以为"语义重排生效了"，而实际拿到的是纯词法结果（两种事实分不开）。
       * 默认 `false` ⇒ 不安装 embedder 的部署里这条工具的行为与改前逐字一致。
       */
      const rawHybrid = args.hybrid;
      if (rawHybrid !== undefined && typeof rawHybrid !== "boolean") {
        return {
          title: "memory_search",
          output: `Error: hybrid 只能是 true 或 false（收到 ${JSON.stringify(rawHybrid)}）。`,
          isError: true,
        };
      }
      const hybrid = rawHybrid === true;

      let results: ReturnType<ReturnType<typeof getMemoryService>["search"]>;
      let backend: MemorySearchBackend = "current";
      try {
        if (scopeMode === "all") {
          const out = await gate.service.searchAcrossScopes(
            query,
            { projectId: projectId || undefined, sessionId: sessionId || undefined },
            { limit, callerSessionId: ctx.sessionId, hybrid },
          );
          backend = out.backend;
          // `scope` 过滤在**取回之后**做：跨作用域的候选集由引擎按作用域过滤，这里只是再收一层
          results = scope ? out.results.filter((r) => r.entry.scope === scope) : out.results;
        } else if (hybrid) {
          /*
           * 任务 A：当前位置也支持 hybrid（与跨作用域共用 `applyHybridRerank`）。
           * 单独走一条异步方法而不是把同步的 `search()` 改成 async —— 后者的调用方遍布全仓。
           */
          const out = await gate.service.searchWithHybrid(query, scope, limit, scopeContext(ctx));
          backend = out.backend;
          results = out.results;
        } else {
          /**
           * `search` 的可见性只按作用域/归属过滤（`visibleIn`），**pending 仍在结果里**
           * —— 那是对的：审批界面要靠它看候选。但工具是模型面，未批准的条目绝不能
           * 被"读出来"绕开审批（D4），所以这一层必须自己滤掉。
           */
          results = gate.service
            .search(query, scope, limit, scopeContext(ctx), { onlyInjected: true });
        }
      } catch (e) {
        return {
          title: "memory_search",
          output: `Error: 记忆检索失败（${e instanceof Error ? e.message : String(e)}）。这不是「没有结果」。`,
          isError: true,
        };
      }

      // P2-B：检索命中计数（按会话累计；指标失败不影响检索结果）
      try {
        gate.service.recordSearchHit(ctx.sessionId, results.length);
      } catch {
        // 观测是旁路：计数没记上不许影响本次检索
      }

      const valueBase = {
        query,
        scopeMode,
        backend,
        hybrid,
        ...(projectId ? { projectId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };

      if (results.length === 0) {
        const emptyText =
          scopeMode === "all"
            ? `No memories matched "${query}" in the requested scope (platform + ` +
              [projectId ? `project=${projectId}` : "", sessionId ? `session=${sessionId}` : ""].filter(Boolean).join(" + ") +
              `). Only approved, non-archived entries are searchable.`
            : `No memories matched "${query}"${scope ? ` in scope ${scope}` : ""} ` +
              `(only approved entries in the current project/conversation are searchable).`;
        return {
          title: "memory_search",
          output: emptyText,
          value: { text: emptyText, count: 0, ids: [], expired: 0, ...valueBase },
          isError: false,
        };
      }

      /**
       * C08：每条命中必须自带**来源 / 作用域 / 有效期（含过期标记）/ 置信度 / 冲突**。
       *
       * 旧输出只有 `id (scope) key — score: snippet`：模型知道有条记忆，但不知道它
       * 「谁写的、什么时候失效、和谁打架」——那三件事恰恰决定了它该不该被当成事实用。
       * 这里逐项写进同一行，保证**单行可自证**（不要求模型再调一次工具才看得到）。
       *
       * P2-A：`scopeMode=all` 时命中可能来自别的项目/对话，**归属键必须写在行里**
       * （`scope` 只有 platform/project/team/conversation 四个值，光看它分不清是哪个项目/团队）。
       */
      let expiredCount = 0;
      const lines = results.map((r, i) => {
        const entry = r.entry;
        const snippet = r.snippet.replace(/\s+/g, " ").slice(0, 240);
        const meta: string[] = [`source=${memorySourceOf(entry)}`];
        const confidence = typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
          ? entry.confidence
          : undefined;
        if (confidence !== undefined) meta.push(`confidence=${confidence}`);
        const validUntil = validUntilOf(entry);
        if (validUntil !== undefined) {
          meta.push(`validUntil=${new Date(validUntil).toISOString()}`);
          // 过期标记用**英文词 expired**：模型读得懂，判据也能逐字断言（不靠中文措辞）
          if (isExpiredMemoryEntry(entry)) {
            expiredCount += 1;
            meta.push("expired");
          }
        }
        if (r.conflictWith.length > 0) meta.push(`conflicts=${r.conflictWith.join(",")}`);
        const owner = `${entry.projectId ? ` · project=${entry.projectId}` : ""}${
          entry.sessionId ? ` · session=${entry.sessionId}` : ""
        }${entry.teamId ? ` · team=${entry.teamId}` : ""}`;
        return `${i + 1}. [${entry.id}] (${entry.scope}${owner}) ${entry.key} — score ${r.score} · ${meta.join(" · ")}: ${snippet}`;
      });
      const conflictHits = results.filter((r) => r.conflictWith.length > 0).length;
      const header =
        scopeMode === "all"
          ? `Found ${results.length} memor${results.length === 1 ? "y" : "ies"} for "${query}" across the requested scope ` +
            `(platform + ${[projectId ? `project=${projectId}` : "", sessionId ? `session=${sessionId}` : ""].filter(Boolean).join(" + ")}).`
          : `Found ${results.length} memor${results.length === 1 ? "y" : "ies"} for "${query}".`;
      const text = [
        header,
        ...(expiredCount > 0
          ? [`⚠ ${expiredCount} of them are expired (marked "expired") — read them, but do not treat them as current rules.`]
          : []),
        ...(conflictHits > 0
          ? [`⚠ ${conflictHits} of them conflict with another entry (see "conflicts=" ids) — the two disagree; check both before acting.`]
          : []),
        "",
        ...lines,
        "",
        "Use memory_read with an id (e.g. memory_read id=<id>) to read the full entry.",
      ].join("\n");
      return {
        title: `memory_search: ${query}`,
        output: text,
        value: { text, count: results.length, ids: results.map((r) => r.entry.id), expired: expiredCount, ...valueBase },
        isError: false,
      };
    },
  };
}

export function createMemoryReadTool(): ToolDef {
  return {
    id: "memory_read",
    contract: {
      /**
       * 不是只读：执行体在读到条目后会调 `service.markUsed([id])` 把 usageCount/lastUsedAt
       * 写回记忆库（P0-1 的使用信号）。声明与事实必须一致 —— 否则权限/计划模式会按
       * 「只读」放行一个会写记忆库的工具。
       */
      readOnly: false,
      accessScope: "none",
      sideEffectScope: "memory",
      outputSchema: READ_OUTPUT_SCHEMA,
      renderOutput: renderTextValue,
    },
    guidance:
      "Use memory_read to read one full memory entry by id. Every injected memory line starts with " +
      "「- [date] (id) key — summary」, and a trailing 「…」 means the summary was truncated; " +
      "read the entry when you need the rest, or when memory_search returned a relevant hit.",
    description: `Read one full memory entry (not truncated) by id, if it is visible in the current scope.
Also returns scope, ownership, source, status and usage counters. Reading counts as a real use (usage signal).`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory entry id (from the injected line or memory_search)." },
        max_chars: {
          type: "number",
          description: `Truncate the returned body to this many chars (default ${READ_DEFAULT_MAX_CHARS}, max ${READ_MAX_CHARS}).`,
        },
      },
      required: ["id"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const gate = memoryServiceGate("memory_read");
      if (!gate.ok) return { title: "memory_read", output: gate.output, isError: true };

      const id = String(args.id ?? "").trim();
      if (!id) return { title: "memory_read", output: "Error: id 不能为空。", isError: true };

      const rawMax = Number(args.max_chars);
      const maxChars = Number.isFinite(rawMax)
        ? Math.min(Math.max(Math.floor(rawMax), 200), READ_MAX_CHARS)
        : READ_DEFAULT_MAX_CHARS;

      const context = scopeContext(ctx);
      let entry: ReturnType<ReturnType<typeof getMemoryService>["listAll"]>[number] | undefined;
      try {
        entry = gate.service.listAll(context).find((e) => e.id === id && injectedIn(e, context));
      } catch (e) {
        return {
          title: "memory_read",
          output: `Error: 读取记忆失败（${e instanceof Error ? e.message : String(e)}）。这不是「id 不存在」。`,
          isError: true,
        };
      }

      if (!entry || isPendingMemoryEntry(entry)) {
        return {
          title: "memory_read",
          output:
            `Memory entry "${id}" is not visible in the current scope (platform / this project / this conversation). ` +
            `It may not exist, may belong to another project, or may still be pending approval.`,
          isError: true,
        };
      }

      let body: string;
      try {
        // C11：记忆出口脱敏的**唯一入口**（默认为开；用户显式关闭时按原文返回）
        body = redactForModelEgress(gate.service.injectionTextFor(entry));
      } catch (e) {
        return {
          title: "memory_read",
          output: `Error: 该条目正文解析失败（${e instanceof Error ? e.message : String(e)}）。`,
          isError: true,
        };
      }

      /* 使用信号：只有"真的读了"才算（见 MemoryEntry.usageCount 的口径） */
      try {
        gate.service.markUsed([entry.id]);
      } catch (e) {
        console.warn("[memory_read] usage 计数未写回（不影响本次读取）:", e);
      }
      /* P2-B：读取命中计数（`memory_read` 真的读到全文才算；指标失败不影响本次读取） */
      try {
        gate.service.recordReadHit(ctx.sessionId);
      } catch {
        // 观测是旁路
      }

      /**
       * C08：读全文时把**来源 / 有效期 / 置信度 / 冲突**一并给出。
       *
       * 读全文是模型做决定的时刻（"这条约定还作数吗"），此时不给有效期与冲突，
       * 等于把判断依据留在库里、只给结论 —— 过期条目会被当成现行规则用。
       */
      let conflicts: string[] = [];
      try {
        for (const group of gate.service.conflicts(context, { onlyInjected: true })) {
          if (group.ids.includes(entry.id)) {
            conflicts = [...new Set([...conflicts, ...group.ids.filter((id) => id !== entry.id)])];
          }
        }
      } catch {
        // 冲突查询失败不影响读正文：只是"没标注冲突"，不许把读取整体判死
        conflicts = [];
      }
      const expired = isExpiredMemoryEntry(entry);
      const validUntil = validUntilOf(entry);
      const confidence =
        typeof entry.confidence === "number" && Number.isFinite(entry.confidence) ? entry.confidence : undefined;

      const shown = body.length > maxChars ? body.slice(0, maxChars) : body;
      const lines = [
        `Memory [${entry.id}]`,
        `scope: ${entry.scope}${entry.projectId ? ` · project: ${entry.projectId}` : ""}${entry.sessionId ? ` · session: ${entry.sessionId}` : ""}`,
        `key: ${entry.key}`,
        `source: ${memorySourceOf(entry)}${entry.status ? ` · status: ${entry.status}` : ""}`,
        `usage: ${Math.max(0, Number(entry.usageCount) || 0)}`,
        `validUntil: ${validUntil !== undefined ? new Date(validUntil).toISOString() : "none"}${expired ? " · expired" : ""}`,
        ...(confidence !== undefined ? [`confidence: ${confidence}`] : []),
        ...(validUntil !== undefined ? [`expiry: ${memoryExpiryTag(entry)}`] : []),
        `conflicts: ${conflicts.length > 0 ? conflicts.join(", ") : "none"}`,
        "",
        shown,
      ];
      if (body.length > shown.length) {
        lines.push(
          "",
          `[... 截断：本条共 ${body.length} 字符，只显示前 ${shown.length} 字符；可用更大的 max_chars 重读]`,
        );
      }
      const text = lines.join("\n");
      return {
        title: `memory_read: ${entry.key}`,
        output: text,
        value: {
          text,
          id: entry.id,
          scope: entry.scope,
          key: entry.key,
          truncated: body.length > shown.length,
          totalChars: body.length,
          source: memorySourceOf(entry),
          expired,
          conflicts,
        },
        isError: false,
      };
    },
  };
}

export function createMemoryTools(): ToolDef[] {
  return [createMemorySearchTool(), createMemoryReadTool()];
}
