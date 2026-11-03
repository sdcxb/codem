/**
 * Host 运行时 —— 把「存储端口 + Agent 循环 + 会话/运行/审批/事件」装配起来。
 *
 * ## 关键设计：**不重写 Agent 循环**
 *
 * `AgenticLoop`（渲染侧 6900 行）在 Node 里可以直接跑（已验证）。本文件只做三件事：
 * 1. 用 `RustStoragePort + NodeTransport` 把存储接上（循环自己会读写消息）；
 * 2. 把 `LoopEvent` 映射成**协议事件**（客户端只认协议，不认内部事件名）；
 * 3. 管运行生命周期（runId / 取消 / 订阅 / 幂等）。
 *
 * 这条边界是刻意的：一旦在 Host 里"再写一个循环"，两套行为就会开始漂移，
 * 而漂移的症状是"同一句话在桌面和手机上结果不同"——那是最难查的一类缺陷。
 *
 * ## Spike 明确没做的（都在 ADR-0001 的迁移清单里）
 *
 * - JSONL 权威日志的写入：`session-jsonl.ts` 走 `file-api` → Tauri `invoke`，
 *   在 Node 里没有实现（读取由本包的 `session-log.ts` 直接读文件，是独立的只读路径）；
 * - 工具集只有只读两件；写/命令/终端要连审批、快照、沙箱一起迁；
 * - 事件序号用「单调时钟」而不是 `session_events.seq`（表与命令都已存在，阶段 1 切换）。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ApprovalRequestView,
  HelloResult,
  HostCapabilities,
  HostDiagnostics,
  MessageView,
  PromptSendResult,
  RunState,
  RunStatus,
  SessionEvent,
  SessionSummary,
  WorkspaceDiffResult,
} from "../../protocol/src/index";
import { PROTOCOL_VERSION } from "../../protocol/src/index";

import type { HostConfig } from "./config";
import { hostStateDir } from "./config";
import { ServeClient } from "./db/serve-client";
import { NodeTransport } from "./db/node-transport";
import { LeaseManager } from "./lease";
import { HostError } from "./errors";
import { takeLlmConfigFromEnv, withoutLlmEnv, type LlmConfig } from "./llm-config";
import { OpenAICompatibleProvider } from "./provider";
import { executeBash } from "./bash-run";
import { createHostToolRegistry } from "./tools";
import {
  ApprovalGrantStore,
  diffWorkspaceFileGuarded,
  readWorkspaceFileGuarded,
  SENSITIVE_APPROVAL_MAX_PENDING,
  SENSITIVE_APPROVAL_TTL_MS,
  type SensitiveApprovalGrant,
  type SensitiveApprovalRegistration,
} from "./sensitive-access";
import { isSensitiveReadPath } from "./sensitive-paths";
import {
  ensureWorkspaceArtifactExcludes,
  pruneWorkspaceAttachments,
  shouldManageWorkspaceArtifacts,
  snapshotsEnabledForWorkspace,
} from "./workspace-artifacts";
import type { ToolContext, ToolExecuteResult } from "../../../src/core/llm/tools";
import type { ChangesService } from "./changes";

/** 一轮跑的上下文（Host 内存态；不进库，重启即失效 —— 这是对的：运行不是历史） */
interface RunRecord {
  /** 运行中的循环实例（只用于 steer/guidance；不对外暴露） */
  loop?: { sendGuidance?: (text: string) => unknown };
  runId: string;
  sessionId: string;
  prompt: string;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  error?: string;
  toolCalls: number;
  /** 本轮的助手行 id（工具调用与最终正文都挂到它上面） */
  assistantId?: string;
  abort: () => void;
  events: SessionEvent[];
}

/** 审批请求的内存态 + 等待者（手机点"允许"时 resolve） */
interface ApprovalRecord {
  view: ApprovalRequestView;
  resolve: (decision: { allowed: boolean; note?: string }) => void;
}

const MAX_EVENTS_PER_RUN = 5_000;

export interface RuntimeDeps {
  /** 覆盖 provider（判据/Spike 注入本地假模型） */
  providerFactory?: (cfg: HostConfig) => {
    provider: unknown;
    model: string;
  };
  /**
   * 模型配置（由 `cli.ts` 在启动时解析：`--llm-stdin` 或环境变量）。
   *
   * **只在构造时捕获一次**，不是每次调用 `makeProvider()` 都去读环境：
   * - 环境变量在 `cli.ts` 里解析完就被删掉了（防子进程继承），再读就是 null；
   * - 捕获后 Key 只存在这个私有字段里，没有任何 getter / 诊断出口。
   * 显式传 `null` 表示"确定没配置"；省略则回落到环境（判据/直接装配 HostRuntime 的场景）。
   */
  llm?: LlmConfig | null;
}

export class HostRuntime {
  /** callId → 工具名（持久化到 host/tool-names.json；SQLite 索引不保存工具名） */
  private toolNames = new Map<string, string>();
  private toolNamesLoaded = false;
  private readonly client: ServeClient;
  private readonly transport: NodeTransport;
  private port: {
    start(): Promise<unknown>;
    stop(): Promise<void>;
    data: { command?<T>(command: string, params?: Record<string, unknown>): Promise<T> };
  } | null = null;
  /** 只读文件变更服务（存储端口注册后再装配；见 `init()`） */
  private changes: ChangesService | null = null;

  private readonly runs = new Map<string, RunRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  /**
   * RPC 敏感读取审批：`approvalId → 批准后应登记的 grant`。
   *
   * 与 `approvals` 分开：`approvals` 里的记录是"待答复"，这里的是"答复 allow 时要发什么"。
   * 两个映射同时插入/删除，`respondApproval` 是唯一消费点。
   */
  private readonly pendingSensitiveApprovals = new Map<string, SensitiveApprovalGrant>();
  /** 已获批准的一次性读取 grant（RPC 两阶段；工具审批不走这里） */
  private readonly workspaceGrants = new ApprovalGrantStore();
  /** `.git/info/exclude` 只维护一次（工作区在 Host 生命周期内不变）；失败则每次提示重试 */
  private workspaceArtifactExcludesReady = false;
  private readonly subscribers = new Map<string, Set<(event: SessionEvent) => void>>();
  /** 幂等：requestId → 结果（有界，防内存无界增长） */
  private readonly idempotency = new Map<string, { at: number; value: unknown }>();
  /** 已落库的最大事件序号（seq 由 session_events 分配，不再用时钟） */
  private readonly lease = new LeaseManager();
  private lastSeq = 0;
  /** 事件写库串行链：保证落库顺序 = 产生顺序，且订阅者只看到已落库的事件 */
  private eventChain: Promise<void> = Promise.resolve();
  private eventFailures: Array<{ area: string; message: string; at: number }> = [];
  private readonly startedAt = Date.now();
  readonly hostId: string;
  /** 模型配置：构造时捕获，只有 `makeProvider()` 读它（见 `RuntimeDeps.llm` 的注释） */
  private readonly llm: LlmConfig | null;

  private constructor(
    readonly config: HostConfig,
    private readonly deps: RuntimeDeps,
  ) {
    this.client = new ServeClient({ bin: config.dbBin, dbPath: config.dbPath });
    this.transport = new NodeTransport(this.client, config.dbPath);
    this.llm = deps.llm !== undefined ? deps.llm : takeLlmConfigFromEnv(process.env);
    // hostId 只是"这台机器"的稳定标识（不是密钥）：数据根路径的短哈希足够，
    // 且不含任何用户可识别信息（多主机列表要显示"我的台式机/笔记本"，那由客户端起名）。
    this.hostId = `host-${Buffer.from(config.dataHome).toString("hex").slice(-8)}`;
  }

  static async create(config: HostConfig, deps: RuntimeDeps = {}): Promise<HostRuntime> {
    const runtime = new HostRuntime(config, deps);
    await runtime.init();
    return runtime;
  }

  private async init(): Promise<void> {
    for (const dir of ["sessions", "attachments", "spill", "host"]) {
      await mkdir(join(this.config.dataHome, dir), { recursive: true });
    }
    this.client.start();
    /**
     * 注册**文件层传输**（阶段 1：`file-api` 的显式注入点）。
     * 必须早于任何存储读写：权威日志、附件外置、快照都走这里。
     */
    {
      const { setFileInvoker } = await import("../../../src/core/file-api");
      const { createNodeFileInvoker } = await import("./tauri-compat");
      setFileInvoker({
        invoke: createNodeFileInvoker({
          dataHome: this.config.dataHome,
          dbPath: this.config.dbPath,
          workspaceRoot: this.config.workspaceRoot,
        }),
      });
    }
    /**
     * 注册**命令层传输**（阶段 1：`CommandInvoker` 的显式注入点）。
     *
     * 必须早于任何 Agent 循环：`FileChangeTracker.start()` 的第一句就是
     * `git rev-parse --is-inside-work-tree`。没有它时 Node 兼容层会抛
     * `未实现的 Tauri 命令：execute_command`，异常被吞成 `isGitRepo()=false`
     * ⇒ Host 的 `turn_file_changes` **永远为空**（不是少记，是结构性不可能）。
     */
    {
      const { setCommandInvoker } = await import("../../../src/core/command-api");
      const { createNodeGitInvoker } = await import("./git-exec");
      setCommandInvoker(createNodeGitInvoker({ workspaceRoot: this.config.workspaceRoot }));
    }
    /*
     * 启动序列必须**复用 bootstrap 的同一条**，不能自己手搓一个"差不多"的。
     *
     * 这条是 Spike A 实测出来的：手搓的版本只 `setStoragePort` + 逐个 `domainEnsureLoaded`，
     * 结果 `MessageStorage.createMessage` 的第一道判断（"会话是否已删除"读 `sessions` 域镜像）
     * 拿到 null ⇒ 整条消息写入**被静默跳过**（事件流一切正常、库里一行没有）。
     * 也就是说：**Host 与渲染侧的启动序列一旦分叉，数据会以最安静的方式丢**。
     * 所以这里直接调 `registerRustStoragePort` + `prefetchDomainMirrors`。
     */
    const { registerRustStoragePort, prefetchDomainMirrors } = await import("../../../src/core/storage/bootstrap");
    const boot = await registerRustStoragePort(this.transport as never, "host.bootstrap");
    if (boot.kind === "failed") {
      throw new HostError("BUSY", `存储端口注册失败：${String((boot as { error?: unknown }).error)}`, {
        retryable: true,
      });
    }
    const { getStoragePort } = await import("../../../src/core/storage/port");
    this.port = getStoragePort() as unknown as HostRuntime["port"];
    const warm = await prefetchDomainMirrors({
      // 显式列出（而不是用默认的 HOT 表）：Host 的读路径就是"会话 + 消息 + 项目"，
      // 少预热一张，写入/合并/可见集就会退化成"读不到 ⇒ 静默跳过"。
      tables: ["sessions", "projects", "messages"],
      perTableMs: 8_000,
      totalMs: 20_000,
    });
    if (!warm.ready.includes("sessions")) {
      throw new HostError("BUSY", `sessions 域镜像未就绪（pending=${warm.pending.join(",")}）`, {
        retryable: true,
      });
    }
    /**
     * 只读文件变更服务：与桌面**同一份** `FileChangeTracker` 写入的
     * `turn_file_changes`，按 `created_at DESC` 分页读（不读 `patch` 列、不进 LRU）。
     */
    {
      const { createChangesService } = await import("./changes");
      const { queryChangesPage, FileChangeStorage } = await import(
        "../../../src/core/storage/file-change-storage"
      );
      const { FileChangeTracker } = await import("../../../src/core/environment/file-change-tracker");
      const { runGitCommand } = await import("../../../src/core/command-api");
      this.changes = createChangesService({
        sessionExists: async (id) => (await this.listSessions(500)).items.some((s) => s.id === id),
        queryPage: (sid, offset, limit) => queryChangesPage(sid, offset, limit),
        getById: (id) => FileChangeStorage.getByIdAsync(id),
        // Host 只有一个工作区根（`--workspace`）；按会话注入是为了与桌面网关共用实现。
        workspaceFor: async () => this.config.workspaceRoot,
        isGitWorkspace: (workspace) => FileChangeTracker.isGitWorkspace(workspace),
        runGit: (workspace, args) => runGitCommand(workspace, args),
        // 共享桌面工作区：变更记录的 diff 也不能成为敏感文件的内容出口
        ...(this.config.workspaceSharedWithDesktop ? { isSensitivePath: isSensitiveReadPath } : {}),
      });
    }
    const stateDir = hostStateDir(this.config.dataHome);
    await mkdir(stateDir, { recursive: true });
    /**
     * 共享桌面工作区：Host 的**内部产物**（附件副本、历史快照）不能污染用户 git。
     *
     * 只对"桌面共享的项目"做：Android 本机 / 开发机手跑的工作区是 Host 自己的目录，
     * 往那里写 `.git/info/exclude` 没有意义，还可能动到用户显式指过来的仓库（见 DC-23 的取舍）。
     * 失败**不阻断启动**（Host 的核心职责是会话，不是改 git 配置），但必须留下明确日志；
     * 返回值里带 reason，诊断时能区分"不是 git 仓库（正常）"和"权限不足/可疑重定向（要查）"。
     */
    if (shouldManageWorkspaceArtifacts(this.config.workspaceSharedWithDesktop)) {
      await this.ensureWorkspaceArtifactIsolation("startup");
    }
  }

  /**
   * 维护 `.git/info/exclude` + 清理过期的附件副本。
   *
   * `phase` 只用于日志定位（启动 / 每轮附件复制前）。**永不抛出**：
   * 一个共享仓库的 git 配置问题不该让 Host 起不来或让一次 prompt 失败。
   *
   * 为什么先 `await` 再复制附件：exclude 必须先落地，`git status` 才看不到
   * `.codem-attachments`；否则"这一轮先污染了、下一轮才被忽略"仍会进变更记录。
   */
  private async ensureWorkspaceArtifactIsolation(phase: "startup" | "attachment"): Promise<void> {
    const root = this.config.workspaceRoot;
    if (!this.workspaceArtifactExcludesReady) {
      const exclude = await ensureWorkspaceArtifactExcludes(root).catch((e: unknown) => ({
        ok: false as const,
        reason: "internal-error" as const,
        message: e instanceof Error ? e.message : String(e),
      }));
      if (exclude.ok) {
        this.workspaceArtifactExcludesReady = true;
        if (exclude.changed) {
          console.log(`[host] workspace artifacts: 已更新 ${exclude.path} 的排除块（${phase}）`);
        }
      } else if (exclude.reason === "not-a-git-repo") {
        /*
         * 非 git 工作区是**正常**状态（Host 也支持非 git 项目），用 info 级别，不是告警。
         * 但仍标记为就绪：同一工作区不会下一秒变成 git 仓库，不必每次 prompt 都试一遍。
         */
        this.workspaceArtifactExcludesReady = true;
        console.log(`[host] workspace artifacts: 跳过 .git/info/exclude（${exclude.message}，${phase}）`);
      } else {
        console.warn(
          `[host] workspace artifacts: 未能维护 .git/info/exclude（${exclude.reason}：${exclude.message}，${phase}）` +
            "；内部产物可能出现在 git status 里，但不会被假装已排除",
        );
      }
    }
    const pruned = await pruneWorkspaceAttachments(root).catch((e: unknown) => {
      console.warn(`[host] workspace artifacts: 清理附件副本失败（${phase}）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    if (pruned && pruned.removed > 0) {
      console.log(`[host] workspace artifacts: 清理 ${pruned.removed} 个过期附件副本（${phase}）`);
    }
    if (pruned && pruned.errors.length > 0) {
      // 部分失败也要留痕（否则"清理过了"会变成假话）
      console.warn(`[host] workspace artifacts: 附件清理有 ${pruned.errors.length} 项失败（${phase}）：${pruned.errors.join("；")}`);
    }
  }

  private dataPort(): {    command<T = Record<string, unknown>>(command: string, params?: Record<string, unknown>): Promise<T>;
  } {
    if (!this.port) throw new HostError("BUSY", "Host 尚未初始化", { retryable: true });
    // 端口的 `command` 在接口上是可选（测试双可能只实现 query/write/execute），
    // 但真实的 Rust 端口一定有它；Host 依赖它，所以在这里显式收窄而不是到处 `?.`。
    return this.port.data as {
      command<T = Record<string, unknown>>(command: string, params?: Record<string, unknown>): Promise<T>;
    };
  }

  async close(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.state === "running") run.abort();
    }    try {
      await this.port?.stop();
    } catch {
      /* 停止失败不应阻止退出：连接关闭后 serve 会自行结束 */
    }
    await this.client.close();
  }

  // ========== 会话 ==========

  async listSessions(limit = 100): Promise<{ items: SessionSummary[]; hasMore: boolean }> {
    const page = await this.dataPort().command<{
      items?: Array<Record<string, unknown>>;
      has_more?: boolean;
    }>("sessions.list", { limit });
    const items = (page?.items ?? []).map(toSessionSummary);
    return { items, hasMore: Boolean(page?.has_more) };
  }

  /** 新建会话：远程客户端（手机）没有别的创建通道，必须由 Host 暴露 */
  takeoverLease(clientId: string, confirm: boolean, deviceName?: string) {
    return this.lease.takeover(clientId, confirm, deviceName);
  }

  async createSession(title?: string): Promise<{ session: SessionSummary }> {
    const now = Date.now();
    const clean = (title ?? "").trim().slice(0, 200);
    const id = `host-${now}-${Math.random().toString(36).slice(2, 8)}`;
    await this.dataPort().command("sessions.upsert", {
      id,
      project_id: "",
      title: clean || "新会话",
      created_at: now,
    });
    return {
      session: {
        id,
        projectId: "",
        title: clean || "新会话",
        createdAt: now,
        lastMessageAt: now,
        messageCount: 0,
        model: null,
        running: false,
      },
    };
  }

  async getSession(
    sessionId: string,
    opts: { offset?: number; limit?: number; visibleOnly?: boolean } = {},
  ): Promise<{ session: SessionSummary; messages: MessageView[]; hasMore: boolean; eventSeq: number }> {
    const all = await this.listSessions(500);
    const session = all.items.find((s) => s.id === sessionId);
    if (!session) throw new HostError("NOT_FOUND", `会话不存在：${sessionId}`);
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    const offset = Math.max(0, opts.offset ?? 0);
    const page = await this.dataPort().command<{
      items?: Array<Record<string, unknown>>;
      has_more?: boolean;
    }>("messages.list", {
      session_id: sessionId,
      offset,
      limit,
      // 存储层要求**显式声明**是否要 hidden 消息（不接受默认值）：
      // "完整历史 / 模型视图"是本产品的核心区分，默认值会让某一侧静默改变语义。
      include_hidden: opts.visibleOnly ? false : true,
    });
    await this.ensureToolNames();
    let rows = page?.items ?? [];
    if (opts.visibleOnly) rows = rows.filter((r) => Number(r.hidden ?? 0) === 0);
    return {
      session,
      messages: rows.map((row) => {
        const view = toMessageView(row);
        // 工具行 id 形如 host-tool-<callId>：存储没回 tool_call_id 时用它恢复配对，
        // 否则重开历史会丢掉工具名（真机 DC-5 复跑实证）。
        if (view.role === "tool" && !view.toolCallId && view.id.startsWith("host-tool-")) {
          view.toolCallId = view.id.slice("host-tool-".length);
        }
        if (view.role === "tool" && view.toolCallId) {
          const name = this.toolNames.get(view.toolCallId);
          if (name) view.metadata = { ...(view.metadata ?? {}), toolName: name };
        }
        return view;
      }),
      hasMore: Boolean(page?.has_more),
      eventSeq: this.lastSeq,
    };
  }

  // ========== 文件变更（只读；Host 自己库里的记录） ==========

  private changesService(): ChangesService {
    if (!this.changes) throw new HostError("BUSY", "Host 尚未初始化（变更服务未装配）", { retryable: true });
    return this.changes;
  }

  async listChanges(sessionId: string, offset = 0, limit = 20) {
    return this.changesService().list(sessionId, offset, limit);
  }

  async diffChange(sessionId: string, changeId: string, path: string) {
    return this.changesService().diff(sessionId, changeId, path);
  }

  private rememberToolName(id: string, name: string): void {
    if (!id || !name) return;
    this.toolNames.set(id, name);
    const file = join(this.config.dataHome, "host", "tool-names.json");
    void (async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(this.config.dataHome, "host"), { recursive: true });
      await writeFile(file, JSON.stringify(Object.fromEntries(this.toolNames)));
    })().catch(() => undefined);
  }

  private async ensureToolNames(): Promise<void> {
    if (this.toolNamesLoaded) return;
    this.toolNamesLoaded = true;
    const file = join(this.config.dataHome, "host", "tool-names.json");
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) this.toolNames.set(k, v);
    } catch {
      /* 没有历史名字文件：从空开始 */
    }
  }

  // ========== 事件 ==========

  subscribe(sessionId: string, sink: (event: SessionEvent) => void, sinceSeq?: number): () => void {
    let closed = false;
    let delivered = sinceSeq ?? 0;
    const set = this.subscribers.get(sessionId) ?? new Set<(e: SessionEvent) => void>();
    const deliver = (e: SessionEvent) => {
      if (closed || e.seq <= delivered) return;
      delivered = e.seq;
      try {
        sink(e);
      } catch {
        /* 单个订阅者坏掉不影响其它订阅者（与端口订阅同一纪律） */
      }
    };
    const live = (e: SessionEvent) => deliver(e);
    const run = async () => {
      // 1) 先补历史（来自 session_events，跨重启也连续）
      try {
        for (const e of await this.readEvents(sessionId, sinceSeq ?? 0)) deliver(e);
      } catch (e) {
        this.recordEventFailure("replay", e);
      }
      if (closed) return;
      set.add(live);
      this.subscribers.set(sessionId, set);
      // 2) 再补一次「补历史期间新产生」的缺口
      try {
        for (const e of await this.readEvents(sessionId, delivered)) deliver(e);
      } catch (e) {
        this.recordEventFailure("gap", e);
      }
    };
    void this.eventChain.then(run, run);
    return () => {
      closed = true;
      set.delete(live);
    };
  }

  /** 从 session_events 读 afterSeq 之后的事件（payload 里的 __runId/__timestamp 是内部字段） */
  private async readEvents(sessionId: string, afterSeq: number, limit = 1000): Promise<SessionEvent[]> {
    const page = await this.dataPort().command<{ items?: Array<Record<string, unknown>> }>("events.list", {
      session_id: sessionId,
      from_seq: afterSeq + 1,
      limit,
      order: "asc",
    });
    const out: SessionEvent[] = [];
    for (const row of page?.items ?? []) {
      let extra: Record<string, unknown> = {};
      try {
        extra = JSON.parse(String(row.payload ?? "{}")) as Record<string, unknown>;
      } catch {
        extra = {};
      }
      const runId = typeof extra.__runId === "string" ? extra.__runId : undefined;
      const timestamp = Number(extra.__timestamp ?? row.timestamp ?? Date.now());
      delete extra.__runId;
      delete extra.__timestamp;
      out.push({
        sessionId: String(row.session_id ?? sessionId),
        seq: Number(row.seq ?? 0),
        type: String(row.type ?? "log") as SessionEvent["type"],
        timestamp,
        payload: extra,
        ...(runId ? { runId } : {}),
      });
    }
    return out.filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  }

  private recordEventFailure(area: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.eventFailures.push({ area, message, at: Date.now() });
    if (this.eventFailures.length > 50) this.eventFailures.shift();
    process.stderr.write("[host] 事件处理失败(" + area + ")：" + message + "\n");
  }

  /**
   * 事件落库 + 通知（**先落库、再通知**）。
   *
   * 为什么不再用单调时钟：客户端拿 seq 做 `Last-Event-ID` 续传，时钟在跨重启/多端时不可靠；
   * `session_events.seq` 是持久的、单写者分配的。落库失败时**不通知**（宁可不显示，
   * 也不让客户端收到一个永远补不回来的序号），失败进 `host.diagnostics.persistFailures`。
   */
  private emit(sessionId: string, type: SessionEvent["type"], payload: Record<string, unknown>, runId?: string): void {
    const timestamp = Date.now();
    const run = runId ? this.runs.get(runId) : undefined;
    const next = this.eventChain.then(async () => {
      const res = await this.dataPort().command<{ seq?: number }>("events.append", {
        session_id: sessionId,
        event_type: type,
        payload: { ...payload, __runId: runId ?? null, __timestamp: timestamp },
        timestamp,
      });
      const seq = Number(res?.seq ?? 0);
      if (!seq) throw new Error("events.append 未返回 seq");
      this.lastSeq = Math.max(this.lastSeq, seq);
      const event: SessionEvent = {
        sessionId,
        seq,
        type,
        timestamp,
        payload,
        ...(runId ? { runId } : {}),
      };
      if (run) {
        run.events.push(event);
        if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
      }
      for (const sink of this.subscribers.get(sessionId) ?? []) {
        try {
          sink(event);
        } catch {
          /* 单个订阅者坏掉不影响其它订阅者 */
        }
      }
    });
    this.eventChain = next.catch((e: unknown) => this.recordEventFailure("append", e));
  }

  // ========== 运行 ==========

  async sendPrompt(sessionId: string, text: string, requestId: string, clientId?: string, attachmentIds: string[] = []): Promise<PromptSendResult> {
    const held = this.lease.view();
    if (held.holder !== "none" && clientId && held.clientId !== clientId) {
      throw new HostError("LEASE_HELD", `会话租约由 ${held.clientId ?? "其他设备"} 持有，请先接管`);
    }
    const cached = this.lookupIdempotent<PromptSendResult>(`prompt:${requestId}`);
    if (cached) return cached;

    const existing = this.runs.get(sessionId);
    if (existing && existing.state === "running") {
      throw new HostError("CONFLICT", `会话 ${sessionId} 已在执行中`, {
        hint: "先取消上一轮，或等它结束",
      });
    }
    // 先校验模型可用：否则会返回"已受理"然后把失败塞进事件流 —— 那是假受理。
    this.makeProvider();
    const promptText = await this.buildPromptWithAttachments(text, attachmentIds);
    await this.ensureSession(sessionId, promptText);

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: RunRecord = {
      runId,
      sessionId,
      prompt: promptText,
      state: "running",
      startedAt: Date.now(),
      toolCalls: 0,
      abort: () => undefined,
      events: [],
    };
    // 一个会话同时只允许一个运行：用 sessionId 当键，新 run 覆盖旧 run 记录（旧记录已结束）
    this.runs.set(sessionId, record);
    this.emit(sessionId, "run.started", { prompt: promptText.slice(0, 200), runId }, runId);
    // 等这一条真正落库：客户端拿 eventSeq 当 sinceSeq 时不能漏掉 run.started
    await this.eventChain;
    const accepted: PromptSendResult = { accepted: true, runId, eventSeq: this.lastSeq };
    this.rememberIdempotent(`prompt:${requestId}`, accepted);
    // 不 await：`prompt.send` 的语义是"受理"，不是"跑完"（跑完要靠事件流或 run.status）
    void this.executeRun(record, promptText).catch((e: unknown) => {
      this.finishRun(record, "failed", e instanceof Error ? e.message : String(e));
    });
    return accepted;
  }

  private async executeRun(record: RunRecord, text: string): Promise<void> {
    const { AgenticLoop } = await import("../../../src/core/llm/agentic-loop");
    /*
     * **Host 就是"落库方"**（对应渲染侧的 App.tsx / 后台 executor）。
     *
     * `AgenticLoop` 的设计契约是：它只负责"模型 ↔ 工具"的推进，**消息行由调用方建**
     * （`resolveAssistantMessageId` 的注释写得很清楚：落库方没建行时，工具事件里的 messageId
     * 会指向一条**不存在的行**）。Spike A 第一版的症状正是这个：事件流看着一切正常，
     * 但库里一行没加，模型第二轮也读不到工具结果（于是重复调同一个工具、最后空手收尾）。
     *
     * 所以这里做三件事，顺序不能反：
     * ① 先建 user 行（循环从库里重建上下文时才能"看到"这句话）；
     * ② 再建 assistant 空壳行，并把它作为 `resolveAssistantMessageId` 的答案
     *   （工具调用/事件都挂到这一行）；
     * ③ 收尾时把累积的正文写回同一行（status 从 streaming → done/error）。
     */
    const messageMod = await import("../../../src/core/storage/message");
    const { createTurnWriter } = await import("../../agent/src/turn-writer");
    /**
     * **一个回合的落库契约**（阶段 1 抽出的 TurnWriter）：
     * hydrate → user 行 → assistant 壳 →（工具完成时）tool 行 + 回填 → 收尾正文。
     * 顺序就是正确性：任何一步提前/延后都会让模型看不到本回合的工具结果。
     */
    const writer = createTurnWriter({
      sessionId: record.sessionId,
      idPrefix: "host",
      storage: {
        createMessage: (m, sid) => messageMod.createMessage(m as never, sid),
        updateMessage: (id, patch) => messageMod.updateMessage(id, patch as never),
        addToolCall: (id, call) => messageMod.addToolCall(id, call as never),
        updateToolCall: (id, toolId, patch) => messageMod.updateToolCall(id, toolId, patch as never),
        hydrateSessionLog: (sid) => messageMod.hydrateSessionLog(sid),
      },
    });
    const { assistantId } = await writer.begin(text);
    const registry = createHostToolRegistry(this.config.workspaceRoot, {
      bash: (args, ctx) => this.runBashTool(record, args, ctx),
      approve: (req) =>
        this.requestApproval({
          approvalId: `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: record.sessionId,
          runId: record.runId,
          tool: req.tool,
          summary: req.summary,
          details: req.details,
          createdAt: Date.now(),
        }),
      /**
       * 共享桌面工作区才给 read/grep 装敏感读取审批。Android 本机 / 开发机手跑
       * （`workspaceSharedWithDesktop=false`）行为完全不变 —— 门控是"这份工作区是不是
       * 用户桌面上的那个项目"，不是平台判断。
       */
      sensitiveRead: this.config.workspaceSharedWithDesktop,
    });
    const { provider, model } = this.makeProvider();
    let assistantText = "";
    const loop = new AgenticLoop(provider as never, registry, {
      maxIterations: 8,
      enableCompaction: false,
      enablePermissions: false,
      securityMode: "full",
      maxOutputTokens: 2_048,
      temperature: 0,
      model,
      /*
       * 共享桌面工作区：**不写**自动快照（`<workspace>/.codem-snapshots`）。
       *
       * 两个理由：① Host 没有任何快照查看/回滚 RPC，这些快照对 Host 是纯负债，
       * 却会把完整源码（甚至被写入的 `.env` 内容）落进用户的 git 工作区；
       * ② Host 的写审批在工具内部，而快照在工具执行**之前**读目标文件 ——
       * 快照先于审批读盘，等于给敏感读取审批开了一个旁路。
       * Android 本机 / 开发机手跑（工作区是 Host 自己的目录）保持默认开启。
       */
      enableSnapshots: snapshotsEnabledForWorkspace(this.config.workspaceSharedWithDesktop),
      /*
       * 敏感路径**不进 read 缓存**：一次批准只覆盖一次读取。若命中缓存，
       * 同一路径第二次读取不会再走工具、也不会再弹审批（"每次读取都要批准"就成了假话）。
       */
      ...(this.config.workspaceSharedWithDesktop
        ? { bypassReadCacheFor: (path: string) => isSensitiveReadPath(path) }
        : {}),
      // 本轮助手行的**唯一真相**：工具调用、事件、最终正文都挂到它上面
      resolveAssistantMessageId: () => assistantId,
      /**
       * **在事件交给调用方之前落库**（D-1 的修法：循环每轮从存储重建上下文，
       * 若等 `tool_complete` 事件回来再写，下一轮请求已经定稿 ⇒ 模型看不到工具结果）。
       * 这里全部是同步 API（createMessage/addToolCall/updateToolCall），不引入 await。
       */
      onToolResult: (info: {
        toolCall: { id: string; name: string; input?: unknown };
        result: unknown;
      }) => {
        writer.onToolResult(info);
        this.rememberToolName(info.toolCall.id, info.toolCall.name);
      },
      getSystemPrompt: () =>
        [
          "You are Codem running inside codem-host (headless).",
          `Workspace root: ${this.config.workspaceRoot}`,
          "Use the provided tools when you need file contents. Keep answers short.",
        ].join("\n"),
    } as never);
    record.abort = () => loop.abort();
    record.loop = loop as unknown as RunRecord["loop"];
    const systemPrompt = (
      loop as unknown as { config?: { getSystemPrompt?: () => string } }
    ).config?.getSystemPrompt?.() ?? "You are Codem (headless).";

    const iterator = loop.run(record.sessionId, text, this.config.workspaceRoot, systemPrompt);
    let finalResult: Record<string, unknown> | null = null;
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        finalResult = (next.value ?? { type: "stop", reason: "completed" }) as unknown as Record<string, unknown>;
        break;
      }
      if (next.value.type === "text_delta") assistantText += String(next.value.text ?? "");
      await this.mapLoopEvent(record, next.value);
    }
    const noAnswer = assistantText.trim().length === 0 && record.toolCalls > 0;
    const state: RunState =
      String(finalResult?.type ?? "") === "stop"
        ? noAnswer
          ? "failed"
          : "succeeded"
        : String(finalResult?.type ?? "") === "aborted"
          ? "cancelled"
          : String(finalResult?.type ?? "") === "error" || String(finalResult?.type ?? "") === "overflow"
            ? "failed"
            : "succeeded";
    const reason = noAnswer
      ? "本轮执行了工具但没有产出任何正文：工具结果没有进入下一轮上下文（见 ADR-0001 D-1）"
      : String(finalResult?.reason ?? finalResult?.message ?? finalResult?.type ?? "completed");
    // 收尾写正文：**即使失败也要写**（否则界面上留下一条永远 streaming 的空壳）
    writer.finish(assistantText, state);
    this.finishRun(record, state, state === "succeeded" ? undefined : String(reason));
  }

  private async mapLoopEvent(record: RunRecord, event: Record<string, unknown>): Promise<void> {
    const type = String(event.type ?? "");
    switch (type) {
      case "text_delta":
        this.emit(record.sessionId, "assistant.text", { text: event.text }, record.runId);
        break;
      case "reasoning_delta":
        this.emit(record.sessionId, "assistant.reasoning", { text: event.text }, record.runId);
        break;
      case "tool_start": {
        const call = event.toolCall as { id?: string; name?: string; input?: unknown } | undefined;
        if (record.assistantId && call?.id && call.name) {
          const { addToolCall } = await import("../../../src/core/storage/message");
          addToolCall(record.assistantId, {
            id: call.id,
            tool: call.name,
            args: (call.input ?? {}) as Record<string, unknown>,
            status: "running",
          } as never);
        }
        this.emit(
          record.sessionId,
          "tool.start",
          { id: call?.id, name: call?.name, args: call?.input },
          record.runId,
        );
        break;
      }
      case "tool_complete": {
        record.toolCalls += 1;
        const call = event.toolCall as { id?: string; name?: string } | undefined;
        const result = event.result as { output?: string; isError?: boolean } | undefined;
        /*
         * **工具结果必须落成一行 `role: "tool"` 的消息** —— 这是循环下一轮重建上下文时
         * 唯一能"看见工具结果"的地方（真机症状：不落这一行，模型第二轮看不到结果 ⇒
         * 重复调同一个工具 ⇒ 最后空手收尾）。`toolCallId` 是配对键，不能省。
         */
        // 落库已在 `onToolResult` 钩子里完成（那一步早于本轮请求定稿），这里只发事件。

        this.emit(
          record.sessionId,
          "tool.end",
          {
            id: call?.id,
            name: call?.name,
            preview: typeof result?.output === "string" ? result.output.slice(0, 2000) : "",
            isError: Boolean(result?.isError),
          },
          record.runId,
        );
        break;
      }
      case "tool_error": {
        const call = event.toolCall as { id?: string; name?: string } | undefined;
        this.emit(record.sessionId, "tool.error", { id: call?.id, name: call?.name, error: event.error }, record.runId);
        break;
      }
      case "usage":
        this.emit(record.sessionId, "usage", { ...(event.usage as Record<string, unknown>) }, record.runId);
        break;
      case "retry":
        this.emit(record.sessionId, "log", { level: "warn", message: `retry #${String(event.attempt)}` }, record.runId);
        break;
      default:
        break;
    }
  }

  /** 运行结束/取消时清掉它挂着的审批（否则列表里会留下永远不会被答复的幽灵） */
  private clearApprovalsForRun(runId: string, note: string): void {
    for (const [id, rec] of this.approvals) {
      if (rec.view.runId !== runId) continue;
      rec.resolve({ allowed: false, note });
      this.approvals.delete(id);
    }
  }

  private finishRun(record: RunRecord, state: RunState, error?: string): void {
    if (record.state !== "running") return;
    this.clearApprovalsForRun(record.runId, "运行已结束");
    record.state = state;
    record.endedAt = Date.now();
    record.error = error;
    const type = state === "succeeded" ? "run.finished" : state === "cancelled" ? "run.cancelled" : "run.failed";
    this.emit(
      record.sessionId,
      type,
      { state, toolCalls: record.toolCalls, ...(error ? { error } : {}) },
      record.runId,
    );
  }

  /** 运行中引导（steer）：注入当前循环，不另起 run */
  async sendGuidance(runId: string, text: string): Promise<{ accepted: true }> {
    const value = text.trim();
    if (!value) throw new HostError("INVALID_PARAMS", "引导内容不能为空");
    const record = [...this.runs.values()].find((r) => r.runId === runId);
    if (!record) throw new HostError("NOT_FOUND", `运行不存在：${runId}`);
    if (record.state !== "running") throw new HostError("CONFLICT", "运行已结束，无法引导");
    const ok = record.loop?.sendGuidance?.(value);
    if (!ok) throw new HostError("BUSY", "当前循环没有接收引导（可能刚结束）");
    return { accepted: true };
  }

  async cancelRun(runId: string, requestId: string): Promise<{ cancelled: boolean; runId: string; alreadyFinished?: boolean }> {
    const cached = this.lookupIdempotent<{ cancelled: boolean; runId: string }>(`cancel:${requestId}`);
    if (cached) return cached;
    const record = [...this.runs.values()].find((r) => r.runId === runId);
    if (!record) throw new HostError("NOT_FOUND", `运行不存在：${runId}`);
    const running = record.state === "running";
    if (running) {
      record.abort();
      this.clearApprovalsForRun(record.runId, "运行已取消");
      record.state = "cancelled";
      record.endedAt = Date.now();
      this.emit(record.sessionId, "run.cancelled", { state: "cancelled" }, record.runId);
    }
    const value = running ? { cancelled: true, runId } : { cancelled: false, runId, alreadyFinished: true };
    this.rememberIdempotent(`cancel:${requestId}`, value);
    return value;
  }

  /** 诊断快照：远程排查"手机发了但 PC 没写"这类问题时，唯一的可复核读数入口。 */
  async diagnostics(sessionId?: string): Promise<HostDiagnostics> {
    const { getPersistFailures } = await import("../../../src/core/storage/persist-failure");
    const failures = (getPersistFailures() ?? []).map((f) => ({
      area: String(f.area ?? "unknown"),
      message: String(f.lastMessage ?? ""),
      at: Number(f.lastAt ?? 0),
    }));
    let sessionProbe: HostDiagnostics["sessionProbe"];
    if (sessionId) {
      const { domainReadOne } = await import("../../../src/core/storage/domain-store");
      let domainRow: string | null = null;
      try {
        domainRow = domainReadOne<string>("sessions", { id: sessionId }, (r) => String(r.id ?? "")) ?? null;
      } catch {
        domainRow = null;
      }
      let messageCount = -1;
      try {
        const counted = await this.dataPort().command<{ count?: number; total?: number }>("messages.count", {
          session_id: sessionId,
        });
        messageCount = Number(counted?.total ?? counted?.count ?? -1);
      } catch {
        messageCount = -1;
      }
      let visibleRoles: string[] = [];
      try {
        const { listVisibleMessages } = await import("../../../src/core/storage/message");
        visibleRoles = listVisibleMessages(sessionId).map((m) => String(m.role));
      } catch {
        visibleRoles = [];
      }
      sessionProbe = { sessionId, domainRow, messageCount, visibleRoles };
    }
    return {
      hostId: this.hostId,
      version: this.config.version,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: Date.now() - this.startedAt,
      dataHome: this.config.dataHome,
      workspaceRoot: this.config.workspaceRoot,
      workspaceSharedWithDesktop: this.config.workspaceSharedWithDesktop,
      seq: this.lastSeq,
      runs: this.listRuns(),
      persistFailures: [...failures, ...this.eventFailures].slice(-50),
      ...(sessionProbe ? { sessionProbe } : {}),
    };
  }

  listRuns(): RunStatus[] {
    return [...this.runs.values()].map((r) => ({
      runId: r.runId,
      sessionId: r.sessionId,
      state: r.state,
      startedAt: r.startedAt,
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      ...(r.error ? { error: r.error } : {}),
      toolCalls: r.toolCalls,
    }));
  }

  runStatus(runId: string): RunStatus {
    const r = [...this.runs.values()].find((x) => x.runId === runId);
    if (!r) throw new HostError("NOT_FOUND", `运行不存在：${runId}`);
    return {
      runId: r.runId,
      sessionId: r.sessionId,
      state: r.state,
      startedAt: r.startedAt,
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      ...(r.error ? { error: r.error } : {}),
      toolCalls: r.toolCalls,
    };
  }

  // ========== 审批 ==========

  listApprovals(sessionId?: string): ApprovalRequestView[] {
    this.pruneSensitiveApprovals();
    return [...this.approvals.values()]
      .map((a) => a.view)
      .filter((v) => (sessionId ? v.sessionId === sessionId : true));
  }

  async respondApproval(
    approvalId: string,
    decision: "allow" | "deny",
    requestId: string,
    note?: string,
  ): Promise<{ ok: true }> {
    const cached = this.lookupIdempotent<{ ok: true }>(`approval:${requestId}`);
    if (cached) return cached;
    const record = this.approvals.get(approvalId);
    if (!record) throw new HostError("NOT_FOUND", `审批请求不存在或已过期：${approvalId}`);
    /*
     * TTL：RPC 读取的审批可以挂很久（客户端拿着 approvalId 去问用户），
     * 过期后必须重新发起 —— 不能用一个小时前的批准去读此刻的文件。
     */
    if (record.view.expiresAt !== undefined && record.view.expiresAt <= Date.now()) {
      this.approvals.delete(approvalId);
      this.pendingSensitiveApprovals.delete(approvalId);
      this.workspaceGrants.delete(approvalId);
      throw new HostError("NOT_FOUND", `审批请求已过期：${approvalId}`);
    }
    this.approvals.delete(approvalId);
    const pendingGrant = this.pendingSensitiveApprovals.get(approvalId);
    this.pendingSensitiveApprovals.delete(approvalId);
    const allowed = decision === "allow";
    /*
     * **只有 allow 才发 grant**。grant 绑定（工具, 键, 文件清单），一次性消费。
     * 拒绝时连记录都不留：重试会拿到新的 `APPROVAL_REQUIRED`，而不是"拒绝后仍能读"。
     */
    if (allowed && pendingGrant) {
      /*
       * grant 的有效期**不超过原审批的剩余时间**：用户在卡片挂到第 4 分钟才点"批准"时，
       * 不能因此把可读窗口延长成 9 分钟（协议上"审批 5 分钟过期"必须是真的）。
       */
      const remaining =
        record.view.expiresAt !== undefined
          ? record.view.expiresAt - Date.now()
          : SENSITIVE_APPROVAL_TTL_MS;
      this.workspaceGrants.grant(
        approvalId,
        pendingGrant,
        Math.max(1_000, Math.min(SENSITIVE_APPROVAL_TTL_MS, remaining)),
      );
    }
    record.resolve({ allowed, ...(note ? { note } : {}) });
    const value = { ok: true as const };
    this.rememberIdempotent(`approval:${requestId}`, value);
    return value;
  }

  /** 供阶段 1 的写工具使用：创建审批并等待客户端答复 */
  requestApproval(view: ApprovalRequestView): Promise<{ allowed: boolean; note?: string }> {
    return new Promise((resolve) => {
      this.approvals.set(view.approvalId, { view, resolve });
      this.emit(view.sessionId, "approval.requested", { approval: view }, view.runId);
    });
  }

  /**
   * 登记一个**不阻塞**的敏感读取审批（RPC 两阶段）。
   *
   * 不发事件：这类审批可能发生在"没有选中会话"的时候，而事件流按 sessionId 订阅
   * （发给空串没人收）。客户端从 `APPROVAL_REQUIRED` 的 `details` 拿到卡片内容，
   * headless 客户端可以 `approval.list`（不带 sessionId）看到它。
   */
  private registerSensitiveApproval = (registration: SensitiveApprovalRegistration): void => {
    this.pruneSensitiveApprovals();
    /*
     * 有界：客户端可以只发不答。只淘汰**同类**（工作区读取）审批里最早的一条 ——
     * 绝不能淘汰正在等待的 write/bash 审批（那会让工具永远等不到答复）。
     * `pendingSensitiveApprovals` 里正好只有这类审批，且 Map 保持插入顺序。
     */
    while (this.pendingSensitiveApprovals.size >= SENSITIVE_APPROVAL_MAX_PENDING) {
      const oldest = this.pendingSensitiveApprovals.keys().next();
      if (oldest.done) break;
      this.approvals.delete(oldest.value);
      this.pendingSensitiveApprovals.delete(oldest.value);
      this.workspaceGrants.delete(oldest.value);
    }
    this.approvals.set(registration.view.approvalId, {
      view: registration.view,
      // RPC 审批没有等待者：答复只用来登记 grant
      resolve: () => undefined,
    });
    this.pendingSensitiveApprovals.set(registration.view.approvalId, registration.grant);
  };

  /** 清掉过期的 RPC 敏感审批（懒清理：不在读路径上挂定时器） */
  private pruneSensitiveApprovals(now = Date.now()): void {
    for (const [id, record] of this.approvals) {
      // 只清 RPC 工作区审批（sessionId 为空串）；运行中工具的审批由运行生命周期负责
      if (record.view.sessionId !== "") continue;
      if (record.view.expiresAt === undefined || record.view.expiresAt > now) continue;
      this.approvals.delete(id);
      this.pendingSensitiveApprovals.delete(id);
      this.workspaceGrants.delete(id);
    }
  }

  /** Host 侧的命令执行（G-7）：审批在 Host 发，执行/超时/进程树在 `bash-run.ts`（可单测）。 */
  private async runBashTool(
    record: RunRecord,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecuteResult> {
    const command = String(args.command ?? "").trim();
    const cwd = args.cwd === undefined ? undefined : String(args.cwd);
    const timeoutMs = args.timeout_ms === undefined ? undefined : Number(args.timeout_ms);
    const result = await executeBash({
      command,
      workspace: this.config.workspaceRoot,
      cwd,
      timeoutMs,
      signal: ctx.abort,
      approve: () =>
        this.requestApproval({
          approvalId: `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: record.sessionId,
          runId: record.runId,
          tool: "bash",
          summary: `执行命令：${command.slice(0, 160)}`,
          details: { command, cwd: cwd ?? "." },
          createdAt: Date.now(),
        }),
    });
    return {
      title: `bash ${command.slice(0, 60)}`,
      output: result.output,
      isError: result.isError,
    };
  }

  // ========== 工作区 ==========

  async readWorkspaceFile(
    path: string,
    offset = 0,
    limit = 200_000,
    approvalId?: string,
  ): Promise<{
    path: string;
    size: number;
    truncated: boolean;
    text: string;
    encoding: "utf8" | "binary";
  }> {
    return readWorkspaceFileGuarded({
      root: this.config.workspaceRoot,
      path,
      offset,
      limit,
      ...(approvalId ? { approvalId } : {}),
      shared: this.config.workspaceSharedWithDesktop,
      grants: this.workspaceGrants,
      register: this.registerSensitiveApproval,
    });
  }

  /** 列出工作区目录（只读；目录逃逸由 resolveInsideRoot 拒绝） */
  /** 只读插件列表：扫描数据根 extensions 下每个目录的 package.json（没有就空列表） */
  async listPlugins(): Promise<{ items: Array<{ id: string; name: string; version: string }> }> {
    const dir = join(this.config.dataHome, "extensions");
    const { readdir, readFile } = await import("node:fs/promises");
    const items: Array<{ id: string; name: string; version: string }> = [];
    for (const name of (await readdir(dir).catch(() => [])).slice(0, 200)) {
      const manifest = await readFile(join(dir, name, "package.json"), "utf8").catch(() => "");
      let parsed: { name?: string; version?: string } = {};
      try {
        parsed = manifest ? (JSON.parse(manifest) as { name?: string; version?: string }) : {};
      } catch {
        parsed = {};
      }
      items.push({ id: name, name: parsed.name ?? name, version: parsed.version ?? "" });
    }
    return { items };
  }

  /** 附件上传：base64 → 数据根 attachments/；成功返回 id/bytes/path */
  async putAttachment(name: string, mimeType: string, base64: string): Promise<{ attachmentId: string; bytes: number; path: string }> {
    const safe = (name || "file").replace(/[\\/]/g, "_").replace(/\.\./g, "_").slice(0, 80);
    const buf = Buffer.from(base64, "base64");
    if (buf.length === 0) throw new HostError("INVALID_PARAMS", "附件为空");
    if (buf.length > 10 * 1024 * 1024) throw new HostError("INVALID_PARAMS", "附件超过 10MB");
    const id = "att-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const rel = id + "__" + safe;
    const dir = join(this.config.dataHome, "attachments");
    await mkdir(dir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, rel), buf);
    return { attachmentId: id, bytes: buf.length, path: "attachments/" + rel };
  }

  /** 把附件校验/复制到工作区，并生成带引用的 prompt 文本 */
  private async buildPromptWithAttachments(text: string, ids: string[]): Promise<string> {
    if (ids.length === 0) return text;
    /*
     * 共享桌面工作区：**先**把 `.codem-attachments/` 写进 `.git/info/exclude`，再复制。
     * 顺序反了会出现"这一轮复制完、快照已把它当未跟踪新文件记了一笔"的窗口。
     */
    if (shouldManageWorkspaceArtifacts(this.config.workspaceSharedWithDesktop)) {
      await this.ensureWorkspaceArtifactIsolation("attachment");
    }
    const lines: string[] = [];
    for (const id of ids.slice(0, 8)) {
      const att = await this.resolveAttachment(id);
      if (!att) throw new HostError("INVALID_PARAMS", `附件不存在：${id}`);
      const target = join(this.config.workspaceRoot, ".codem-attachments");
      await mkdir(target, { recursive: true });
      const { copyFile } = await import("node:fs/promises");
      const base = att.rel.slice("attachments/".length);
      await copyFile(join(this.config.dataHome, att.rel), join(target, base)).catch(() => undefined);
      lines.push(`- ${att.name}（工作区路径：.codem-attachments/${base}）`);
    }
    return text + "\n\n[附件]\n" + lines.join("\n");
  }

  /** 找附件（按 id 前缀；重启后仍可用） */
  private async resolveAttachment(id: string): Promise<{ name: string; rel: string } | null> {
    if (!/^att-[a-z0-9-]+$/i.test(id)) return null;
    const dir = join(this.config.dataHome, "attachments");
    const { readdir } = await import("node:fs/promises");
    const hit = (await readdir(dir).catch(() => [])).find((f) => f.startsWith(id + "__"));
    if (!hit) return null;
    return { name: hit.slice(hit.indexOf("__") + 2), rel: "attachments/" + hit };
  }

  async listWorkspaceDir(path = "."): Promise<{ path: string; entries: Array<{ name: string; type: "file" | "dir"; size?: number }> }> {
    const { listWorkspaceDir } = await import("./workspace");
    return listWorkspaceDir(this.config.workspaceRoot, path);
  }

  /**
   * 只读 diff：工作区必须是 git 仓库；不支持时 supported=false（客户端隐藏入口）。
   *
   * 共享桌面工作区下先做**只读预检**（`git diff --name-only`）：命中敏感文件就返回
   * `APPROVAL_REQUIRED`（带 approvalId），批准后带同一个 approvalId 重试才返回 patch。
   */
  async diffWorkspaceFile(path: string, base = "HEAD", approvalId?: string): Promise<WorkspaceDiffResult> {
    const { spawn } = await import("node:child_process");
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((done) => {
        // `env` 显式剔除 CODEM_LLM_*：纵深防御（即使将来某条启动路径忘了提前删环境变量）
        const p = spawn("git", ["-C", this.config.workspaceRoot, ...args], {
          windowsHide: true,
          env: withoutLlmEnv(process.env),
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => p.kill("SIGKILL"), 10_000);
        p.stdout.on("data", (c: Buffer) => { if (out.length < 500_000) out += c.toString("utf8"); });
        p.stderr.on("data", (c: Buffer) => { if (err.length < 50_000) err += c.toString("utf8"); });
        p.on("error", (e) => { clearTimeout(timer); done({ code: null, out, err: String(e) }); });
        p.on("close", (code) => { clearTimeout(timer); done({ code, out, err }); });
      });
    return diffWorkspaceFileGuarded({
      root: this.config.workspaceRoot,
      path,
      base,
      ...(approvalId ? { approvalId } : {}),
      shared: this.config.workspaceSharedWithDesktop,
      grants: this.workspaceGrants,
      register: this.registerSensitiveApproval,
      run,
    });
  }

  // ========== hello / 能力 ==========

  hello(protocolVersion: number, clientName?: string, deviceName?: string, claim = false): HelloResult {
    const identity = deviceName?.trim() || clientName?.trim() || "unknown";
    // 只有显式 claim 的客户端才认领租约：诊断/测试的 hello 不该抢走 UI 的写权限
    const leaseState = claim ? this.lease.hello(identity, deviceName) : { granted: false, lease: this.lease.view() };
    const capabilities: HostCapabilities = {
      supported: [
        "session.list",
        "session.create",
        "session.get",
        "session.watch",
        "prompt.send",
        "run.cancel",
        "run.status",
        "approval.list",
        "approval.respond",
        "workspace.read",
        "attachment.put",
        "workspace.list",
        "plugins.list",
        "workspace.diff",
        "session.changes",
        "session.change.diff",
      ],
      /**
       * 没实现的必须**显式**列出来（客户端据此灰掉入口，而不是点了没反应）。
       *
       * ⚠️ 同一个方法**不许**同时出现在两张表里：`workspace.diff` 曾经在
       * supported 与 unsupported 各列一次（已实现却被灰掉），`CAP-H1` 现在钉住这条。
       */
      unsupported: ["terminal.open", "terminal.write", "terminal.resize", "terminal.close"],
    };
    return {
      server: {
        name: "codem-host",
        version: this.config.version,
        protocolVersion: PROTOCOL_VERSION,
        minClientVersion: 1,
      },
      hostId: this.hostId,
      capabilities,
      lease: leaseState.lease,
      leaseGranted: leaseState.granted,
    };
  }

  // ========== 内部 ==========

  private async ensureSession(sessionId: string, firstPrompt: string): Promise<void> {
    const { items } = await this.listSessions(500);
    if (items.some((s) => s.id === sessionId)) return;
    const compact = firstPrompt.replace(/\s+/g, " ").trim().slice(0, 60);
    await this.dataPort().command("sessions.upsert", {
      id: sessionId,
      project_id: "",
      title: compact || "移动端会话",
    });
  }

  private makeProvider(): { provider: unknown; model: string } {
    if (this.deps.providerFactory) return this.deps.providerFactory(this.config);
    const llm = this.llm;
    if (!llm) {
      throw new HostError("UNSUPPORTED", "没有配置模型：请设置 CODEM_LLM_BASE_URL / CODEM_LLM_MODEL", {
        hint: "Host Spike 需要一个 OpenAI 兼容端点（可用 packages/host/scripts/mock-provider.mjs）",
      });
    }
    return {
      provider: new OpenAICompatibleProvider({
        baseUrl: llm.baseUrl,
        model: llm.model,
        apiKey: llm.apiKey,
      }),
      model: llm.model,
    };
  }

  private lookupIdempotent<T>(key: string): T | undefined {
    const hit = this.idempotency.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > 10 * 60 * 1000) {
      this.idempotency.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  private rememberIdempotent(key: string, value: unknown): void {
    if (this.idempotency.size > 1_000) {
      const oldest = [...this.idempotency.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.idempotency.delete(oldest[0]);
    }
    this.idempotency.set(key, { at: Date.now(), value });
  }
}

function toSessionSummary(row: Record<string, unknown>): SessionSummary {
  return {
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    title: String(row.title ?? ""),
    createdAt: Number(row.created_at ?? 0),
    lastMessageAt: Number(row.last_message_at ?? 0),
    messageCount: Number(row.message_count ?? 0),
    model: (row.model as string | null | undefined) ?? null,
    running: false,
  };
}

function toMessageView(row: Record<string, unknown>): MessageView {
  const rawTools = row.tool_calls;
  let tools: MessageView["toolCalls"];
  if (typeof rawTools === "string" && rawTools.trim().startsWith("[")) {
    try {
      tools = JSON.parse(rawTools) as MessageView["toolCalls"];
    } catch {
      tools = undefined;
    }
  }
  return {
    id: String(row.id ?? ""),
    role: (row.role as MessageView["role"]) ?? "user",
    content: String(row.content ?? ""),
    ...(row.reasoning ? { reasoning: String(row.reasoning) } : {}),
    timestamp: Number(row.timestamp ?? 0),
    model: (row.model as string | null | undefined) ?? null,
    ...(row.status ? { status: String(row.status) } : {}),
    ...(row.tool_call_id ? { toolCallId: String(row.tool_call_id) } : {}),
    ...(typeof row.metadata === "string" && row.metadata.trim().startsWith("{")
      ? (() => {
          try {
            return { metadata: JSON.parse(row.metadata) as Record<string, unknown> };
          } catch {
            return {};
          }
        })()
      : {}),
    hidden: Number(row.hidden ?? 0),
    trimmed: Number(row.trimmed ?? 0),
    ...(tools ? { toolCalls: tools } : {}),
  };
}
