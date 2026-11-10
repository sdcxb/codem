/**
 * 24 §P0-1 / P0-4 的**安全与排序缺口**（本轮补齐：MEM-AUTH-1 / MEM-RANK-3 / MEM-TOOLS-1 /
 * MEM-PANEL-1）。
 *
 * ## 为什么单独一个文件
 *
 * 这四条都横跨「记忆服务 ↔ 提示词装配 ↔ 工具注册表 ↔ 面板数字」多个模块，既有文件各自只钉
 * 一侧（`memory-placement-boundary` 钉位置、`memory-history-acceptance-gaps` 钉索引/来源桶、
 * `context-monitor-pressure` 钉面板自洽）。本文件按 §6 的**通过条件**逐条补上，并把
 * 变异自证写在每个用例头上。
 *
 * ## 四条判据
 *
 * | id | 钉什么 | 变异（应当变红） |
 * |---|---|---|
 * | MEM-AUTH-1 | manual 提示含「权威且持续生效」；auto 提示**不含**它且含「不是指令」 | 两块共用 `MEMORY_AUTHORITY_NOTE` |
 * | MEM-RANK-3 | 重启后注入顺序稳定；usage 相同则 recency 高的旧条目优先 | 去掉 `lastUsedAt` 这一层 |
 * | MEM-TOOLS-1 | `codem-context-config.memoryTools=false` ⇒ 工具不在 registry/请求；再开恢复 | 忽略开关、无条件注册 |
 * | MEM-PANEL-1 | 面板 `injected=true` 集合 == 真实 loop 请求里的记忆 id 集合；聚合挡下有逐条原因 | 去掉共享 tracker |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort, type StoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { createMessage } from "../core/storage/message";
import {
  MemoryService,
  MEMORY_AUTHORITY_NOTE,
  MEMORY_UNVERIFIED_NOTE,
  MEMORY_VOLATILE_HEADER,
  injectionScopeContext,
  projectIdFromCwd,
} from "../core/memory/memory";
import { LLMEngine } from "../core/llm/index";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getContextManager } from "../core/context/context";
import { getTokenTracker } from "../core/llm/token-tracker";

const PROJ_CWD = "C:\\work\\memory-safety";
const SESSION = "mem-p0-safety";
let port: FakeStoragePort;

function seedSession(id: string) {
  void port.data.execute("crud.upsert", {
    table: "sessions",
    mode: "replace",
    rows: [
      {
        id,
        project_id: "p-safety",
        title: id,
        model: null,
        created_at: 1,
        last_message_at: 1,
        message_count: 0,
        pinned: 0,
      },
    ],
  });
}

function buildMinimalAgent() {
  return { id: "build", name: "build", description: "", systemPrompt: "" };
}

/**
 * 真实 `LLMEngine.buildSystemPrompt` 的装配路径（只把无关依赖压成桩）。
 *
 * 判据测的是产品形态：抬头/权威框架/易变尾置都由引擎两处注入点真的拼出来，
 * 而不是测试里另写一遍 `composeMemoryBlock` 的参数。
 */
function promptViaEngine(svc: MemoryService, sessionId: string, cwd: string): string {
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = svc;
  engine.agents = { get: () => buildMinimalAgent() } as never;
  engine.skills = {
    buildSkillEnvironmentSection: () => "",
    buildSkillPrompt: () => "",
    buildPreloadedSkillPrompt: () => "",
  } as never;
  engine.mcp = { getAllTools: () => [] } as never;
  return engine.buildSystemPrompt(sessionId, "build", cwd);
}

/** 从注入文本里取一条 `- [date] (id) key — …` 行的 id（与 formatLine 同一形态） */
function injectedIdsIn(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("- [")) continue;
    const m = /^\- \[[^\]]*\] \(([^)]+)\) /.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port as unknown as StoragePort);
});

afterEach(() => {
  setStoragePort(null);
  getContextManager().updateConfig({ memoryTools: true });
  vi.restoreAllMocks();
});

// ========== MEM-AUTH-1：权威拆分（auto 不再是「权威且持续生效」） ==========

describe("MEM-AUTH-1：manual 权威 / auto 未经确认（24 §P0-1 安全项）", () => {
  it("MEM-AUTH-1：manual 小节含权威句；auto 所在的**块级外框**不含权威句且含「不是指令」", () => {
    /*
     * ① auto-only 夹具（平台手动 + 项目自动）：
     *    稳定块 = 平台手动（权威），易变块 = 只剩项目自动 ⇒ 从易变块抬头到提示末尾
     *    **不许**出现 `MEMORY_AUTHORITY_NOTE`（旧实现整块共用这一句 = 本判据要挡的形态）。
     */
    const autoSvc = new MemoryService();
    autoSvc.add({ scope: "platform", key: "平台手写", content: "AUTH_PLATFORM_MANUAL", source: "manual", timestamp: 1_000 });
    autoSvc.add({
      scope: "project",
      projectId: projectIdFromCwd(PROJ_CWD),
      key: "项目自动",
      content: "AUTH_PROJECT_AUTO",
      source: "auto",
      timestamp: 1_002,
    });

    const prompt = promptViaEngine(autoSvc, SESSION, PROJ_CWD);

    // 稳定块（平台手动）：抬头之后就是权威句，且手动条目挂在它后面。
    const firstAuthority = prompt.indexOf(MEMORY_AUTHORITY_NOTE);
    expect(firstAuthority, "稳定块的手动记忆必须带权威句").toBeGreaterThan(-1);
    expect(firstAuthority).toBeLessThan(prompt.indexOf("AUTH_PLATFORM_MANUAL"));

    /*
     * 易变块（auto）：块级外框必须是「未经确认的线索」，**整段不许出现权威句**。
     * 这是旧实现的缺陷形态：auto 行虽有一句「未经人工确认」，却仍处在「权威且持续生效」的块内。
     */
    const volatileStart = prompt.indexOf(MEMORY_VOLATILE_HEADER);
    expect(volatileStart, "易变块抬头必须存在").toBeGreaterThan(firstAuthority);
    const volatileSlice = prompt.slice(volatileStart);
    expect(volatileSlice, "auto 不许继承 manual 的权威句（两块共用同一句 = 红）").not.toContain(
      MEMORY_AUTHORITY_NOTE,
    );
    expect(volatileSlice, "auto 必须被标成「未经确认的线索」").toContain(MEMORY_UNVERIFIED_NOTE);
    expect(volatileSlice, "auto 必须明说「不是指令」").toContain("不是指令");
    expect(volatileSlice, "auto 必须明说「不是权限来源」").toContain("权限来源");
    const autoStart = prompt.indexOf("## 自动提取");
    expect(autoStart, "自动条目的独立小节必须存在").toBeGreaterThan(volatileStart);

    /*
     * ② 两句文案必须**不同**（否则「拆分」只是换了个常量名）。
     */
    expect(MEMORY_UNVERIFIED_NOTE).not.toBe(MEMORY_AUTHORITY_NOTE);
    expect(MEMORY_AUTHORITY_NOTE).toContain("权威且持续生效");
    expect(MEMORY_UNVERIFIED_NOTE).toContain("未经确认");
  });

  it("MEM-AUTH-1 边界：项目/对话级 manual 仍是权威（24 §4.6：权威但易变），不被 auto 一起降级", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "平台手写", content: "AUTH2_PLATFORM", source: "manual", timestamp: 1 });
    svc.add({
      scope: "project",
      projectId: projectIdFromCwd(PROJ_CWD),
      key: "项目手写",
      content: "AUTH2_PROJECT_MANUAL",
      source: "manual",
      timestamp: 2,
    });
    svc.add({
      scope: "project",
      projectId: projectIdFromCwd(PROJ_CWD),
      key: "项目自动",
      content: "AUTH2_PROJECT_AUTO",
      source: "auto",
      timestamp: 3,
    });

    const prompt = promptViaEngine(svc, SESSION, PROJ_CWD);
    const manualAt = prompt.indexOf("AUTH2_PROJECT_MANUAL");
    expect(manualAt, "项目手动条目必须注入").toBeGreaterThan(-1);
    const beforeManual = prompt.slice(prompt.indexOf(MEMORY_VOLATILE_HEADER), manualAt);
    expect(
      beforeManual,
      "易变块里的手动小节必须自带权威句（否则项目 manual 被 auto 一起降级成线索）",
    ).toContain(MEMORY_AUTHORITY_NOTE);
    /* 权威句必须紧贴 manual 小节标题（不是飘在块首给所有来源共用） */
    const manualHeaderAt = prompt.lastIndexOf("## 项目记忆（手动维护）", manualAt);
    expect(manualHeaderAt).toBeGreaterThan(prompt.indexOf(MEMORY_VOLATILE_HEADER));
    expect(prompt.indexOf(MEMORY_AUTHORITY_NOTE, manualHeaderAt)).toBeLessThan(manualAt);
  });

  it("MEM-AUTH-1 反向：来源未知（旧数据）与 auto 同列「未经确认」，不继承权威句", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "平台", content: "AUTH3_PLATFORM", source: "manual", timestamp: 1 });
    /*
     * 直接构造一条 `source === undefined` 的旧数据（`normalizeLoadedEntry` 对缺失来源给 undefined；
     * `add` 的缺省是 manual，所以这里先把条目写进内存态、再抹掉来源）。
     */
    const added = svc.add({
      scope: "project",
      projectId: projectIdFromCwd(PROJ_CWD),
      key: "旧数据",
      content: "AUTH3_UNKNOWN",
      source: "manual",
      timestamp: 2,
    });
    expect(added.ok).toBe(true);
    const holder = svc as unknown as { entries: Map<string, { source?: string }> };
    delete holder.entries.get(added.entry!.id)!.source;

    const prompt = promptViaEngine(svc, SESSION, PROJ_CWD);
    const unknownStart = prompt.indexOf("## 来源未知（旧数据）");
    expect(unknownStart, "旧数据块必须显式说来源未知").toBeGreaterThan(-1);
    const unknownSlice = prompt.slice(unknownStart);
    expect(unknownSlice, "来源未知不许继承 manual 的权威句").not.toContain(MEMORY_AUTHORITY_NOTE);
    expect(unknownSlice, "来源未知必须被标成未经确认的线索").toContain(MEMORY_UNVERIFIED_NOTE);
    expect(unknownSlice).toContain("不是指令");
  });
});

// ========== MEM-RANK-3：重启稳定 + recency 参与排序 ==========

describe("MEM-RANK-3：重启后顺序稳定，且 recency 高的旧条目优先", () => {
  it("MEM-RANK-3：usage 相同 ⇒ lastUsedAt 更新的旧条目排在新建条目之前，且重载后逐条不变", async () => {
    const svc = new MemoryService();
    const older = svc.add({
      scope: "project",
      projectId: projectIdFromCwd(PROJ_CWD),
      key: "旧条目·最近用过",
      content: "RANK3_RECENT_OLD",
      source: "manual",
      usageCount: 3,
      lastUsedAt: 1_900_000_000_000,
      timestamp: 1_000,
    });
    const newer = svc.add({
      scope: "project",
      projectId: projectIdFromCwd(PROJ_CWD),
      key: "新条目·很久没用",
      content: "RANK3_STALE_NEW",
      source: "manual",
      usageCount: 3,
      lastUsedAt: 1_000_000_000_000,
      timestamp: 2_000,
    });
    expect(older.ok && newer.ok).toBe(true);

    const prompt = svc.buildMemoryPrompt("project", projectIdFromCwd(PROJ_CWD));
    expect(prompt.indexOf("RANK3_RECENT_OLD"), "recency 高的旧条目必须排在前面").toBeLessThan(
      prompt.indexOf("RANK3_STALE_NEW"),
    );
    const before = prompt
      .split("\n")
      .filter((l) => l.startsWith("- ["))
      .map((l) => /^\- \[[^\]]*\] \(([^)]+)\)/.exec(l)![1]);

    await svc.flushPendingPersist();
    const reloaded = new MemoryService();
    const afterPrompt = reloaded.buildMemoryPrompt("project", projectIdFromCwd(PROJ_CWD));
    const after = afterPrompt
      .split("\n")
      .filter((l) => l.startsWith("- ["))
      .map((l) => /^\- \[[^\]]*\] \(([^)]+)\)/.exec(l)![1]);

    expect(after, "重启（真实重载）后注入顺序必须逐条相同").toEqual(before);
    const reloadedOlder = reloaded.listAll({ projectId: projectIdFromCwd(PROJ_CWD) }).find((e) => e.id === older.entry!.id);
    expect(reloadedOlder?.usageCount, "usageCount 必须落库（否则排序每次重启归零）").toBe(3);
    expect(reloadedOlder?.lastUsedAt, "lastUsedAt 必须落库").toBe(1_900_000_000_000);

    /*
     * 反向对照：把两条的 lastUsedAt 抹平 ⇒ 排序回落到创建序（新条目在前）。
     * 若实现里根本没有 recency 这一层，上面第一条断言就会红（而不是靠这条对照）。
     */
    for (const entry of (svc as unknown as { entries: Map<string, { lastUsedAt?: number }> }).entries.values()) {
      entry.lastUsedAt = undefined;
    }
    const fallback = svc.buildMemoryPrompt("project", projectIdFromCwd(PROJ_CWD));
    expect(fallback.indexOf("RANK3_STALE_NEW"), "没有 recency 信号时按创建序（新在前）").toBeLessThan(
      fallback.indexOf("RANK3_RECENT_OLD"),
    );
  });
});

// ========== MEM-TOOLS-1：记忆只读工具开关 ==========

describe("MEM-TOOLS-1：codem-context-config.memoryTools 显式 false 不注册工具", () => {
  const ids = (engine: LLMEngine) => engine.tools.getAll().map((t) => t.id);
  const coreIds = (engine: LLMEngine) => engine.tools.getCoreDefinitions().map((t) => t.name);

  it("MEM-TOOLS-1：关闭 ⇒ registry/请求都没有 memory_search/read；开启（新引擎）⇒ 恢复；注入与提取开关不变", () => {
    /* 默认（旧配置/缺键）= 开 */
    const onEngine = new LLMEngine();
    expect(ids(onEngine)).toContain("memory_search");
    expect(ids(onEngine)).toContain("memory_read");
    expect(coreIds(onEngine), "请求的 tools 里也必须有").toContain("memory_search");

    getContextManager().updateConfig({ memoryTools: false });
    const offEngine = new LLMEngine();
    expect(ids(offEngine), "关闭后 registry 里不许有 memory_search").not.toContain("memory_search");
    expect(ids(offEngine), "关闭后 registry 里不许有 memory_read").not.toContain("memory_read");
    expect(coreIds(offEngine), "关闭后请求的 tools 里也不许出现").not.toContain("memory_search");
    expect(coreIds(offEngine)).not.toContain("memory_read");

    /*
     * 边界：只控**工具**。注入与提取的开关（`memory-enabled-<sid>` / 注入路径）不受影响。
     * 这里用真实引擎提示断言「记忆仍然照常注入」。
     */
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "平台", content: "TOOLS_OFF_STILL_INJECTED", source: "manual", timestamp: 1 });
    const engineWithMemory = new LLMEngine();
    (engineWithMemory as unknown as { memory: MemoryService }).memory = svc;
    engineWithMemory.agents = { get: () => buildMinimalAgent() } as never;
    engineWithMemory.skills = {
      buildSkillEnvironmentSection: () => "",
      buildSkillPrompt: () => "",
      buildPreloadedSkillPrompt: () => "",
    } as never;
    engineWithMemory.mcp = { getAllTools: () => [] } as never;
    expect(
      engineWithMemory.buildSystemPrompt(SESSION, "build", PROJ_CWD),
      "关闭只读工具不许影响记忆注入",
    ).toContain("TOOLS_OFF_STILL_INJECTED");
    expect(engineWithMemory.isMemoryEnabled(SESSION), "与 memory-enabled-<sid>（只控提取）是两个开关").toBe(true);

    /* 再开（新引擎按新配置构造）⇒ 恢复 */
    getContextManager().updateConfig({ memoryTools: true });
    const restored = new LLMEngine();
    expect(ids(restored)).toContain("memory_search");
    expect(ids(restored)).toContain("memory_read");
  });
});

// ========== MEM-PANEL-1：面板 injected 集合 == 真实 loop 请求 ==========

class RecordingProvider {
  id = "panel-parity-provider";
  name = "Panel Parity Mock";
  requests: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "收到" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "摘要", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

describe("MEM-PANEL-1：面板 injected 与真实 loop 请求逐条一致（含聚合预算原因）", () => {
  it("MEM-PANEL-1：真实请求里的记忆 id 集合 == injectionExplanations().injected；聚合挡下有逐条原因", async () => {
    seedSession(SESSION);
    createMessage({ id: "panel-user-1", role: "user", content: "你好", timestamp: 1, status: "done" }, SESSION);

    const svc = new MemoryService();
    const projectId = projectIdFromCwd(PROJ_CWD);
    const longKey = (prefix: string) => `${prefix}_${"K".repeat(110)}`;
    const filler = "内容".repeat(150);
    /* 四个块各自都远小于「单块 12000」预算，但**合计**必然越过聚合预算 */
    for (let i = 0; i < 20; i += 1) {
      svc.add({ scope: "platform", key: longKey(`pm${i}`), content: `PANEL_PM_${i}_${filler}`, source: "manual", timestamp: 1_000 + i });
      svc.add({ scope: "platform", key: longKey(`pa${i}`), content: `PANEL_PA_${i}_${filler}`, source: "auto", timestamp: 2_000 + i });
      svc.add({ scope: "project", projectId, key: longKey(`jm${i}`), content: `PANEL_JM_${i}_${filler}`, source: "manual", timestamp: 3_000 + i });
      svc.add({ scope: "conversation", sessionId: SESSION, key: longKey(`cm${i}`), content: `PANEL_CM_${i}_${filler}`, source: "manual", timestamp: 4_000 + i });
    }

    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    engine.agents = { get: () => buildMinimalAgent() } as never;
    engine.skills = {
      buildSkillEnvironmentSection: () => "",
      buildSkillPrompt: () => "",
      buildPreloadedSkillPrompt: () => "",
    } as never;
    engine.mcp = { getAllTools: () => [] } as never;
    const systemPrompt = engine.buildSystemPrompt(SESSION, "build", PROJ_CWD);

    /* 真实 loop 请求：把引擎装配的 systemPrompt 真的传给循环（产品路径同形） */
    getTokenTracker().setContextWindow(128_000);
    const provider = new RecordingProvider();
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 1,
      model: "panel-parity-model",
      securityMode: "full",
      enableCompaction: false,
    } as never);
    for await (const _event of loop.run(SESSION, "你好", PROJ_CWD, systemPrompt)) {
      /* 只跑一轮，事件不关心 */
    }

    const request = provider.requests[0];
    expect(request, "必须真的发出一次请求").toBeTruthy();
    const systemMessage = (request.messages as Array<{ role?: string; content?: unknown }>).find(
      (m) => m.role === "system",
    );
    expect(systemMessage, "请求里必须有 system 消息").toBeTruthy();
    const requestIds = injectedIdsIn(String(systemMessage!.content ?? ""));
    expect(requestIds.size, "前提：请求里必须有被注入的记忆（否则对账是空对空）").toBeGreaterThan(0);

    const explanations = svc.injectionExplanations(injectionScopeContext(projectId, SESSION));
    expect(
      [...requestIds].sort(),
      "面板 injected=true 的集合必须与真实请求逐条一致（多报/少报都会让用户按错误信息取舍）",
    ).toEqual([...explanations.injected].sort());

    /*
     * 聚合预算挡下的条目：必须**逐条**有原因，而且原因要能指名「跨块聚合」，
     * 不能只给一句笼统的「超出注入上限」（那会让用户以为是单块 20 条上限）。
     */
    const blocked = [...(explanations.reasons.keys())];
    expect(blocked.length, "前提：必须真的有被挡下的条目").toBeGreaterThan(0);
    for (const id of blocked) {
      expect(explanations.reasons.get(id), "每一条未注入条目都必须有可读原因").toBeTruthy();
    }
    expect(
      blocked.some((id) => explanations.reasons.get(id)!.includes("跨块聚合预算")),
      "至少有一条原因必须指名聚合预算（否则面板说的和真实请求不是同一件事）",
    ).toBe(true);
    expect(systemPrompt, "真实提示里必须如实披露聚合截断").toContain("未注入");
  });
});
