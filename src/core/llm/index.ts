import { ProviderRegistry, createDefaultProviders } from "./provider";
import { ToolRegistry, createDefaultToolRegistry } from "./tools";
import { SessionManager, type Session } from "./session";
import { AgentRegistry, getAgentRegistry, type AgentDefinition } from "../agent/agent";
import { PermissionManager, getPermissionManager } from "../permission/permission";
import { ContextManager, getContextManager, type CompactionConfig } from "../context/context";
import { MemoryService, getMemoryService, type MemoryScope } from "../memory/memory";
import { RetryExecutor, getRetryExecutor } from "../retry/retry";
import { buildSystemPrompt, type SystemPromptConfig } from "../prompt/prompt";
import { MCPRegistry, getMCPRegistry, type MCPServerConfig, type MCPTool } from "../mcp/mcp";
import { SkillRegistry, getSkillRegistry, type SkillDefinition } from "../skill/skill";
import { SnapshotService, getSnapshotService, type Snapshot, type FileChange } from "../snapshot/snapshot";
import { SubagentManager, getSubagentManager, type SubagentTask, type SubagentResult } from "../subagent/subagent";
import { SessionRecoveryService, getSessionRecoveryService } from "../recovery/recovery";
import { AgenticLoop, type LoopEvent } from "./agentic-loop";
import { CostTracker, getCostTracker } from "./cost-tracker";
import { ToolRenderRegistry, getToolRenderRegistry } from "./tool-renderer";
import { SettingsManager, getSettingsManager, type SettingsSource, type PermissionRule } from "../settings/settings";

// ========== Re-exports ==========
export type { LLMProvider, LLMRequest, LLMResponse, StreamEvent, TokenUsage, ToolDefinition } from "./types";
export type { ToolDef, ToolContext, ToolExecuteResult } from "./tools";
export type { Session, MessageV2, Part, TextPart, ReasoningPart, ToolPart } from "./session";
export type { LoopConfig, LoopResult, LoopState, LoopEvent } from "./agentic-loop";
export type { ModelCost, UsageRecord, SessionCost, CostTrackerConfig } from "./cost-tracker";
export type { ToolRenderer, ToolRenderResult, ToolRenderConfig } from "./tool-renderer";

export { ProviderRegistry, OpenAICompatibleProvider, createDefaultProviders } from "./provider";
export { ToolRegistry, createDefaultToolRegistry } from "./tools";
export { SessionManager } from "./session";
export { AgentRegistry, getAgentRegistry } from "../agent/agent";
export { PermissionManager, getPermissionManager } from "../permission/permission";
export { ContextManager, getContextManager } from "../context/context";
export { MemoryService, getMemoryService } from "../memory/memory";
export { RetryExecutor, getRetryExecutor, logRetry } from "../retry/retry";
export { buildSystemPrompt } from "../prompt/prompt";
export { MCPRegistry, getMCPRegistry } from "../mcp/mcp";
export { SkillRegistry, getSkillRegistry } from "../skill/skill";
export { SnapshotService, getSnapshotService } from "../snapshot/snapshot";
export { SubagentManager, getSubagentManager } from "../subagent/subagent";
export { SessionRecoveryService, getSessionRecoveryService } from "../recovery/recovery";
export { StreamingToolExecutorImpl, getStreamingToolExecutor } from "./streaming-executor";
export { AgenticLoop } from "./agentic-loop";
export { CostTracker, getCostTracker } from "./cost-tracker";
export { ToolRenderRegistry, getToolRenderRegistry, DefaultToolRenderer } from "./tool-renderer";

// ========== LLM Engine Config ==========
export interface LLMEngineConfig {
  defaultProvider?: string;
  defaultModel?: string;
  defaultAgent?: string;
  temperature?: number;
  maxTokens?: number;
  maxToolCalls?: number;
  context?: Partial<CompactionConfig>;
}

// ========== LLM Engine ==========
export class LLMEngine {
  readonly providers: ProviderRegistry;
  readonly tools: ToolRegistry;
  readonly sessions: SessionManager;
  readonly agents: AgentRegistry;
  readonly permissions: PermissionManager;
  readonly context: ContextManager;
  readonly memory: MemoryService;
  readonly retry: RetryExecutor;
  readonly mcp: MCPRegistry;
  readonly skills: SkillRegistry;
  readonly subagents: SubagentManager;
  readonly recovery: SessionRecoveryService;
  readonly costTracker: CostTracker;
  readonly toolRenderer: ToolRenderRegistry;
  readonly settings: SettingsManager;

  private agenticLoop: AgenticLoop | null = null;
  private config: LLMEngineConfig;
  private snapshots: Map<string, SnapshotService> = new Map();

  constructor(config?: LLMEngineConfig, projectPath?: string) {
    this.config = config || {};
    this.providers = createDefaultProviders();
    this.tools = createDefaultToolRegistry();
    this.sessions = new SessionManager();
    this.agents = getAgentRegistry();
    this.permissions = getPermissionManager();
    this.context = getContextManager();
    this.memory = getMemoryService();
    this.retry = getRetryExecutor();
    this.mcp = getMCPRegistry();
    this.skills = getSkillRegistry();
    this.subagents = getSubagentManager();
    this.recovery = getSessionRecoveryService();
    this.costTracker = getCostTracker();
    this.toolRenderer = getToolRenderRegistry();
    this.settings = getSettingsManager(projectPath) || new SettingsManager(projectPath || ".");

    // Set up sub-agent spawner and register spawn tool
    this.setupSubagentSpawner();
  }

  private setupSubagentSpawner() {
    import("../subagent/spawner").then(({ LLMSubagentSpawner }) => {
      import("./tools").then(({ setSubagentManager, createSpawnSubagentTool, createWaitForSubagentTool }) => {
        const spawner = new LLMSubagentSpawner(this);
        this.subagents.setSpawner(spawner);
        setSubagentManager(this.subagents);
        this.tools.register(createSpawnSubagentTool());
        this.tools.register(createWaitForSubagentTool());
      });
    });
  }

  /** Get or create an agentic loop */
  getAgenticLoop(_agentId?: string): AgenticLoop {
    const provider = this.providers.get(this.config.defaultProvider || "openai");
    if (!provider) throw new Error("No provider configured");

    this.agenticLoop = new AgenticLoop(
      provider,
      this.tools,
      this.sessions,
      {
        maxIterations: this.config.maxToolCalls || 20,
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxTokens || 4096,
        model: this.config.defaultModel,
      },
    );

    return this.agenticLoop;
  }

  /** Build system prompt for a session */
  buildSystemPrompt(_sessionId: string, agentId?: string, cwd?: string): string {
    const agent = this.agents.get(agentId || this.config.defaultAgent || "build");
    if (!agent) return "";

    const skillPrompt = this.skills.buildSkillPrompt();

    const mcpTools = this.mcp.getAllTools();
    const mcpPrompt = mcpTools.length > 0
      ? mcpTools.map((t) => `- **${t.server}/${t.name}**: ${t.description}`).join("\n")
      : "";

    const config: SystemPromptConfig = {
      agent,
      workingDirectory: cwd,
      date: new Date().toISOString(),
      modelInfo: `${this.config.defaultProvider}/${this.config.defaultModel}`,
      skillInstructions: skillPrompt,
      mcpInstructions: mcpPrompt,
    };

    return buildSystemPrompt(config);
  }

  /** Process a user message through the agentic loop */
  async *process(
    sessionId: string,
    message: string,
    cwd: string,
    agentId?: string,
    options?: { onPermissionRequest?: (request: import("../permission/permission").PermissionRequest) => Promise<import("../permission/permission").PermissionResult> },
  ): AsyncGenerator<LoopEvent, void, unknown> {
    // Ensure session exists in SessionManager
    this.sessions.getOrCreateSession(sessionId, "default", this.config.defaultModel || "unknown");

    const loop = this.getAgenticLoop(agentId);
    if (options?.onPermissionRequest) {
      loop.updateConfig({ onPermissionRequest: options.onPermissionRequest });
    }
    const systemPrompt = this.buildSystemPrompt(sessionId, agentId, cwd);

    const startTime = Date.now();
    let lastUsage: import("./types").TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let toolCallCount = 0;

    for await (const event of loop.run(sessionId, message, cwd, systemPrompt)) {
      if (event.type === "usage") {
        lastUsage = event.usage;
      }
      if (event.type === "tool_complete") {
        toolCallCount++;
      }
      yield event;
    }

    // Record usage after loop completes
    if (lastUsage.totalTokens > 0) {
      this.costTracker.recordUsage({
        sessionId,
        model: this.config.defaultModel || "unknown",
        provider: this.config.defaultProvider || "unknown",
        usage: lastUsage,
        duration: Date.now() - startTime,
        toolCalls: toolCallCount,
        success: true,
      });
    }
  }

  /** Abort current processing */
  abort() {
    this.agenticLoop?.abort();
  }

  /** Configure a provider */
  setProviderConfig(providerId: string, config: { apiKey: string; baseUrl?: string }) {
    const existing = this.providers.get(providerId);
    if (existing && "config" in existing) {
      (existing as any).config = { ...(existing as any).config, ...config };
    }
  }

  /** Update engine configuration */
  updateConfig(config: Partial<LLMEngineConfig>) {
    this.config = { ...this.config, ...config };
  }

  getDefaultProvider(): string {
    return this.config.defaultProvider || "openai";
  }

  getDefaultModel(): string {
    return this.config.defaultModel || "gpt-4o";
  }

  setDefaultModel(model: string) {
    this.config.defaultModel = model;
  }

  registerTool(tool: import("./tools").ToolDef) {
    this.tools.register(tool);
  }

  registerAgent(agent: AgentDefinition) {
    this.agents.register(agent);
  }

  getContextPressure(sessionId: string): number {
    const session = this.sessions.getSession(sessionId);
    if (!session) return 0;
    return this.context.getPressureLevel(session.messages);
  }

  getTokenSummary(sessionId: string) {
    const session = this.sessions.getSession(sessionId);
    if (!session) return null;
    return this.context.getUsageSummary(session.messages);
  }

  searchMemory(query: string, scope?: MemoryScope) {
    return this.memory.search(query, scope);
  }

  addMemory(entry: { scope: MemoryScope; key: string; content: string; tags?: string[] }) {
    return this.memory.add(entry);
  }

  async connectMCP(config: MCPServerConfig) {
    return this.mcp.connect(config);
  }

  async disconnectMCP(serverName: string) {
    return this.mcp.disconnect(serverName);
  }

  getMCPTools(): Array<MCPTool & { server: string }> {
    return this.mcp.getAllTools();
  }

  async callMCPTool(serverName: string, toolName: string, args: Record<string, unknown>) {
    return this.mcp.callTool(serverName, toolName, args);
  }

  registerSkill(skill: SkillDefinition) {
    this.skills.register(skill);
  }

  getSkill(name: string) {
    return this.skills.get(name);
  }

  searchSkills(query: string) {
    return this.skills.search(query);
  }

  detectSkills(query: string, limit?: number) {
    return this.skills.detectRelevant(query, limit);
  }

  getAllSkills() {
    return this.skills.getAll();
  }

  getSnapshotService(cwd: string): SnapshotService {
    if (!this.snapshots.has(cwd)) {
      this.snapshots.set(cwd, getSnapshotService(cwd));
    }
    return this.snapshots.get(cwd)!;
  }

  async createSnapshot(cwd: string, sessionId: string, messageIndex: number, description?: string): Promise<Snapshot> {
    const service = this.getSnapshotService(cwd);
    return service.create(sessionId, messageIndex, description);
  }

  async restoreSnapshot(cwd: string, snapshotId: string): Promise<FileChange[]> {
    const service = this.getSnapshotService(cwd);
    return service.restore(snapshotId);
  }

  async spawnSubagent(parentId: string, agentId: string, prompt: string, cwd: string, timeout?: number): Promise<SubagentTask> {
    return this.subagents.spawn(parentId, agentId, prompt, cwd, timeout);
  }

  async waitForSubagent(taskId: string, timeout?: number): Promise<SubagentResult> {
    return this.subagents.waitForCompletion(taskId, timeout);
  }

  getSubagentStats() {
    return this.subagents.getStats();
  }

  saveToRecovery(session: Session) {
    this.recovery.saveSession(session);
  }

  loadFromRecovery(sessionId: string): Session | undefined {
    return this.recovery.loadSession(sessionId);
  }

  getRecoverableSessions(): Session[] {
    return this.recovery.getAllSessions();
  }

  getRecoverySummary() {
    return this.recovery.getRecoverySummary();
  }

  getCostStats() {
    return this.costTracker.getStats();
  }

  getTodayCost() {
    return this.costTracker.getTodayCost();
  }

  // ========== Settings Methods ==========

  getSetting<T = unknown>(key: string, defaultValue?: T): T {
    return this.settings.get<T>(key, defaultValue);
  }

  async setSetting(key: string, value: unknown, source?: SettingsSource): Promise<void> {
    return this.settings.set(key, value, source);
  }

  getPermissionRules(): PermissionRule[] {
    return this.settings.getPermissionRules();
  }

  isFeatureEnabled(feature: string): boolean {
    return this.settings.isFeatureEnabled(feature);
  }

  isModelAllowed(model: string): boolean {
    return this.settings.isModelAllowed(model);
  }
}

// ========== Singleton ==========
let engineInstance: LLMEngine | null = null;

export function getLLMEngine(): LLMEngine {
  if (!engineInstance) {
    engineInstance = new LLMEngine({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      defaultAgent: "build",
      temperature: 0.7,
      maxTokens: 4096,
      maxToolCalls: 20,
    });
  }
  return engineInstance;
}

export function createLLMEngine(config?: LLMEngineConfig): LLMEngine {
  engineInstance = new LLMEngine(config);
  return engineInstance;
}
