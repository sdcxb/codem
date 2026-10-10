/**
 * 第 197 波判据（用户报的三件事）：
 * ① 「已经有的类似的记忆，还是频繁写入并申请审批」⇒ 写入前查重必须真的挡得住**换了个说法**的重复；
 * ② 「加一个去重重复类似记忆的按钮」⇒ 人工清理入口（界面判据在 `memory-checkup.test.tsx` 的
 *    `MEM-CHECK-DUP-*`，这里钉数据层：分组、保留最早、跨桶找得到）；
 * ③ 「怎么什么东西都往记忆写 / 每轮几十条」⇒ 每轮条数上限 + 提取限频 + 提示词门槛（清单）。
 *
 * ## 判据的输入全部来自**真机取证**（不是编的字符串）
 *
 * 用户的库里现存 23 对近似重复，下面这些夹具就是那些真实条目（相似度是用
 * `.preview-shot/_mem-dedup-*.py` 在同一套口径下量出来的）：
 * - 「Vitest 位置参数匹配语义」vs「vitest 路径参数按子串匹配、多参数为 OR」＝ 0.54；
 * - 「开发环境:Windows + PowerShell」vs「Windows + PowerShell 环境限制」＝ 0.25（key 0.73）；
 * - **误报对照**：「MCP 探针服务器 codem-res-probe」vs「二进制 MCP 资源不内联」＝ 0.23（key 0.07）
 *   —— 这两条是**不同的事实**，任何判重都不许把它们当成一条（否则就是"新事实永远写不进去"）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import { MemoryService, MEMORY_WRITE_APPROVAL_KEY } from "../core/memory/memory";
import { memoryLooksDuplicate, memorySimilarity, normalizeMemoryText } from "../core/memory/similarity";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const PROJ_A = "c:\\work\\alpha";
const PROJ_B = "c:\\work\\beta";
const SESSION = "s-197";

/** 真机库里"同一条事实的两种写法"（用于钉住自动判重必须挡得住） */
const REAL_DUP_PAIRS: Array<[string, string, string, string]> = [
  [
    "Vitest 位置参数匹配语义",
    "vitest 的位置参数按**路径子串**匹配（不是 glob），多个参数之间是**或**关系。",
    "vitest 路径参数按子串匹配、多参数为 OR",
    "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
  ],
  [
    "开发环境:Windows + PowerShell",
    "项目在 Windows 上进行开发，命令通过 PowerShell 执行。",
    "Windows + PowerShell 环境限制",
    "开发环境为 Windows + PowerShell，命令行不支持 `&&` 作为语句分隔符。",
  ],
  [
    "无本地 TypeScript 编译器",
    "`npx tsc --noEmit` 不可用，会提示 'This is not the tsc command you are looking for'。",
    "项目内调用 tsc 的方式",
    "该项目里 `npx tsc --noEmit` 会失败（提示 'This is not the tsc command you are looking for'），要走别的入口。",
  ],
];

/** 真机库里的**误报对照**：两条不同的事实，只是都带 MCP（合并 0.23 / key 0.07） */
const REAL_FALSE_POSITIVE: [string, string, string, string] = [
  "MCP 探针服务器 codem-res-probe",
  "存在一个用于真机验证的 MCP 服务器 codem-res-probe，暴露两个资源。",
  "二进制 MCP 资源不内联",
  "读取二进制 MCP 资源时不会内联大段 base64，而是返回占位摘要。",
];

beforeEach(() => {
  saveMemory("");
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  /* 默认审批：项目级需批准（对话级直接生效）—— 与真机默认档一致 */
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

/**
 * 造一个喂 `extractMemoriesFromSession` 的引擎。
 *
 * `messageCount` 可调：限频判据要能造出"消息涨够了"与"没涨"两种形态。
 * 返回的对象里带 `prompts`（发给模型的**真实提示词**）—— 提示词里带了什么，判据就断什么。
 */
function engineForExtraction(
  memory: MemoryService,
  sessionId: string,
  payloads: string[],
  messageCount = 12,
): { engine: LLMEngine; prompts: string[] } {
  setSettingJSON(`memory-enabled-${sessionId}`, true);
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = memory;
  const provider = { id: "test", isConfigured: () => true, complete: async () => ({ content: "[]" }) };
  (engine as unknown as { providers: unknown }).providers = { get: () => provider };
  (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
  vi.spyOn(MessageStorage, "listMessages").mockImplementation(
    () =>
      Array.from({ length: messageCount }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 ? "assistant" : "user",
        content: "x",
      })) as never,
  );
  const prompts: string[] = [];
  let call = 0;
  vi.spyOn(engine, "spawnForked").mockImplementation((async (_sid: string, _sys: string, prompt: string) => {
    prompts.push(prompt);
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    return payload;
  }) as never);
  return { engine, prompts };
}

/** 取某个桶里的条目（界面可见口径：含 pending） */
function bucket(svc: MemoryService, projectId: string): ReturnType<MemoryService["listByScope"]> {
  return svc.listByScope("project", { projectId, includePending: true, includeUnscoped: true });
}

describe("MEM-DEDUP：写入前查重（换了个说法也必须挡住）", () => {
  it("MEM-DEDUP-1：真机那三对近似重复，判重口径必须都认出来（否则它们就是白写的重复）", () => {
    for (const [keyA, contentA, keyB, contentB] of REAL_DUP_PAIRS) {
      expect(
        memoryLooksDuplicate({ key: keyA, content: contentA }, { key: keyB, content: contentB }),
        `换了个说法的同一条事实必须判重：「${keyA}」/「${keyB}」`,
      ).toBe(true);
    }
  });

  it("MEM-DEDUP-2（反向对照 · 误报）：真机那对**不同**的事实不许被判重", () => {
    const [keyA, contentA, keyB, contentB] = REAL_FALSE_POSITIVE;
    expect(
      memoryLooksDuplicate({ key: keyA, content: contentA }, { key: keyB, content: contentB }),
      "这两条是不同的事实（只是都带 MCP）⇒ 判重它们就等于「新事实永远写不进去」",
    ).toBe(false);
  });

  it("MEM-DEDUP-3：同一轮里换了说法的重复**不会**被写进两次（旧口径前 50 字符相等挡不住）", async () => {
    const svc = new MemoryService();
    const [keyA, contentA, keyB, contentB] = REAL_DUP_PAIRS[0];
    const { engine } = engineForExtraction(
      svc,
      SESSION,
      [
        JSON.stringify([{ key: keyA, content: contentA, scope: "project" }]),
        JSON.stringify([{ key: keyB, content: contentB, scope: "project" }]),
      ],
      // 两条逻辑上属于"两轮"：每次给够水位（这里用两次显式提取模拟两轮）
    );

    await engine.extractMemoriesFromSession(SESSION, PROJ_A);
    expect(bucket(svc, PROJ_A), "第一条正常写入").toHaveLength(1);

    /* 第二轮：消息涨够了（模拟又聊了几轮），模型又提了一遍同一件事（换了说法） */
    const msgs = MessageStorage.listMessages as unknown as { mockImplementation: (fn: () => unknown) => void };
    msgs.mockImplementation(() =>
      Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, role: i % 2 ? "assistant" : "user", content: "x" })),
    );
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    expect(bucket(svc, PROJ_A), "换个说法的同一条事实不许再写一份（真机上这一条事实被写了 5 次）").toHaveLength(1);
  });

  it("MEM-DEDUP-4：平台级已经记住的事实，不许再写一份项目级/对话级", async () => {
    const svc = new MemoryService();
    /* 真机形态：同一条事实既在平台级（旧数据）又被自动提取写成项目级（0.45 那一对） */
    const [keyA, contentA, keyB, contentB] = REAL_DUP_PAIRS[2];
    svc.add({ scope: "platform", key: keyA, content: contentA, source: "manual" });

    expect(
      svc.findDuplicateOf({ scope: "project", projectId: PROJ_A, key: keyB, content: contentB }, { projectId: PROJ_A }),
      "平台记忆处处注入 ⇒ 同一个事实再写一份项目级纯属重复",
    ).toBeTruthy();
    expect(
      svc.findDuplicateOf({ scope: "conversation", sessionId: SESSION, key: keyB, content: contentB }, { projectId: PROJ_A }),
      "对话级同理（平台那条已经在上下文里了）",
    ).toBeTruthy();
  });

  it("MEM-DEDUP-5：同项目下**待批准**的项目级事实，不许被「对话级直接生效」绕过去再写一份", async () => {
    const svc = new MemoryService();
    const seeded = svc.add({
      scope: "project",
      projectId: PROJ_A,
      key: "Vitest 位置参数匹配语义",
      content: "vitest 的位置参数按**路径子串**匹配（不是 glob），多个参数之间是**或**关系。",
      source: "auto",
      status: "pending",
    });
    expect(seeded.ok).toBe(true);

    const dup = svc.findDuplicateOf(
      {
        scope: "conversation",
        sessionId: SESSION,
        key: "vitest 路径参数按子串匹配、多参数为 OR",
        content: "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
      },
      { projectId: PROJ_A },
    );
    expect(dup, "项目级那条还在等批准 ⇒ 不许用对话级再插一份（那等于绕过审批）").toBeTruthy();
    expect(dup!.status).toBe("pending");
  });

  it("MEM-DEDUP-6（反向对照 · 作用域隔离）：项目 A 记住的事实**不挡**项目 B 记同样的事实", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: PROJ_A, key: "跑测试的命令", content: "用 npx vitest run 跑测试。", source: "auto" });

    expect(
      svc.findDuplicateOf({ scope: "project", projectId: PROJ_B, key: "跑测试的命令", content: "用 npx vitest run 跑测试。" }, { projectId: PROJ_B }),
      "不同项目的桶各自成立（跨项目去重会误删另一个项目里合法的那份）",
    ).toBeUndefined();
  });

  it("MEM-DEDUP-7：归一化口径 —— 大小写/空白/标点差异不影响「像不像」", () => {
    expect(normalizeMemoryText("Windows + PowerShell 环境限制！")).toBe("windowspowershell环境限制");
    expect(memorySimilarity("Windows + PowerShell", "windows+  powershell")).toBe(1);
  });
});

describe("MEM-DEDUP-GROUP：找出相似重复（人工清理入口的数据层）", () => {
  it("MEM-DEDUP-8：跨桶的同一条事实会被分到一组，并给出相似度与「最早在前」的 id 顺序", () => {
    const svc = new MemoryService();
    /* 真机形态：同一条事实被写进两个不同的 projectId（每次评测换了工作目录） */
    const first = svc.add({
      scope: "project",
      projectId: PROJ_A,
      key: "Vitest 位置参数匹配语义",
      content: "vitest 的位置参数按**路径子串**匹配（不是 glob），多个参数之间是**或**关系。",
      source: "auto",
      status: "pending",
    });
    const second = svc.add({
      scope: "project",
      projectId: PROJ_B,
      key: "vitest 路径参数按子串匹配、多参数为 OR",
      content: "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
      source: "auto",
      status: "pending",
    });
    expect(first.entry && second.entry).toBeTruthy();

    const groups = svc.findDuplicateGroups();
    expect(groups, "这一对必须被找出来（否则「人工清理一波」无从下手）").toHaveLength(1);
    expect(groups[0].ids, "组内按创建序（最早的在前 —— 「只留最早的一条」用它）").toEqual([
      first.entry!.id,
      second.entry!.id,
    ]);
    expect(groups[0].similarity, "要给出可核对的相似度读数").toBeGreaterThan(0.3);

    /* 反向对照：不同的事实不该被凑成一组 */
    svc.add({ scope: "project", projectId: PROJ_A, key: REAL_FALSE_POSITIVE[0], content: REAL_FALSE_POSITIVE[1], source: "auto" });
    svc.add({ scope: "project", projectId: PROJ_A, key: REAL_FALSE_POSITIVE[2], content: REAL_FALSE_POSITIVE[3], source: "auto" });
    expect(svc.findDuplicateGroups(), "误报对照那两条仍不许成组").toHaveLength(1);

    /* 跨桶也算：这正是用户库里"同一事实 5 种写法"的形态 */
    svc.add({ scope: "conversation", sessionId: SESSION, key: "vitest 位置参数匹配语义", content: "位置参数按路径子串匹配。", source: "auto" });
    expect(svc.findDuplicateGroups()[0].ids.length, "跨作用域也要能聚到一起（人工判断，不自动删）").toBeGreaterThanOrEqual(2);
  });
});

describe("MEM-EXTRACT-LIMIT：每轮条数上限 + 限频（用户报的「每轮几十条」）", () => {
  it("MEM-EXTRACT-LIMIT-1：模型返回 8 条 ⇒ 只写前 3 条（撞上限的如实写进日志）", async () => {
    const svc = new MemoryService();
    const many = [
      { key: "命令包装器", content: "命令都走 PowerShell 包装器执行，会设置输出编码。", scope: "project" },
      { key: "测试文件位置", content: "单元测试统一放在 src/test 下，按功能族加前缀命名。", scope: "project" },
      { key: "构建命令", content: "构建走 tauri build，签名私钥读取自 .tauri 目录下的密钥文件。", scope: "project" },
      { key: "发布流程", content: "发布需要先写 CHANGELOG，再建 GitHub release 并上传五个资产。", scope: "project" },
      { key: "日志位置", content: "运行时日志落在数据目录下，文件名带 codem-runtime 前缀。", scope: "project" },
      { key: "依赖管理", content: "前端依赖用 pnpm 管理，锁文件必须一并提交。", scope: "project" },
      { key: "界面样式约定", content: "样式一律走 styles.css 里的语义变量，不许写裸色值。", scope: "project" },
      { key: "提交规范", content: "每个波次一次提交，提交信息里带上门禁读数。", scope: "project" },
    ];
    const { engine } = engineForExtraction(svc, SESSION, [JSON.stringify(many)]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    expect(bucket(svc, PROJ_A), "每轮最多写 3 条（上限是结构性的，不看模型返回多少）").toHaveLength(3);
    expect(
      logs.some((l) => l.includes("丢弃 5 条")),
      "被上限丢掉 5 条这件事必须如实写进日志（静默丢内容等于替用户决定什么不重要）",
    ).toBe(true);
  });

  it("MEM-EXTRACT-LIMIT-2：消息没涨够 ⇒ 不再跑第二次（旧实现每轮都跑）", async () => {
    const svc = new MemoryService();
    const { engine } = engineForExtraction(svc, SESSION, [JSON.stringify([])], 12);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);
    expect(vi.mocked(engine.spawnForked).mock.calls.length, "同一个会话、消息数没变 ⇒ 第二次不该再发 LLM").toBe(1);
  });

  it("MEM-EXTRACT-LIMIT-3（反向对照）：消息涨够了 ⇒ 必须再跑一次（别把提取彻底关掉）", async () => {
    const svc = new MemoryService();
    const { engine } = engineForExtraction(svc, SESSION, [JSON.stringify([])], 12);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    const msgs = MessageStorage.listMessages as unknown as { mockImplementation: (fn: () => unknown) => void };
    msgs.mockImplementation(() =>
      Array.from({ length: 17 }, (_, i) => ({ id: `n${i}`, role: i % 2 ? "assistant" : "user", content: "x" })),
    );
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);
    expect(vi.mocked(engine.spawnForked).mock.calls.length, "涨了 5 条（≥4）⇒ 该跑第二次").toBe(2);
  });

  it("MEM-EXTRACT-LIMIT-4：提示词里带上「已经记住的」清单（只含相关桶），且写明每轮上限", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "平台级已有事实", content: "平台级内容", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_A, key: "本项目已有事实", content: "项目级内容", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_B, key: "别的项目的事实", content: "不该出现在清单里", source: "manual" });
    const { engine, prompts } = engineForExtraction(svc, SESSION, [JSON.stringify([])]);

    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    expect(prompts, "必须真的发了提示词").toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt, "已经记住的清单要发给模型（看不见已有的记忆就只能每轮重复推导）").toContain("平台级已有事实");
    expect(prompt).toContain("本项目已有事实");
    expect(prompt, "别的项目的记忆不许出现在清单里（作用域隔离）").not.toContain("别的项目的事实");
    expect(prompt, "每轮条数上限要写进提示词（模型自己排序，比我们随机截断更合理）").toContain("最多 3 条");
  });
});
