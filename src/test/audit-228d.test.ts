/**
 * 第 228 波·审计轮第三批（对**改动过的代码**再审计一轮）的判据。
 *
 * 这一批几乎全部来自"改完再挖"：四条独立审计（压缩核心 / 压缩生命周期 / 记忆提取 / 记忆注入）
 * 里的两条第二轮审计（对着 f1ae1018..6b3048be 的 diff）+ 我自己的复查。
 *
 * ⚠️ 本文件里不许出现反引号；中文引号一律「」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  composeCompactionMarkerText,
  foldStaleCompactionMarkers,
  planCompactionKeep,
} from "../core/llm/compaction-budget";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting } from "../core/storage/settings";
import { MEMORY_WRITE_APPROVAL_KEY, MemoryService, injectionTruncationNote } from "../core/memory/memory";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const PROJ_A = "c:\\work\\alpha";
const SESSION = "s-228d";
const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");

beforeEach(() => {
  saveMemory("");
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
});
afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("CA（第三批）：压缩侧", () => {
  it("CA-22：标记的字符预算 —— summary 与 priorSummary **各拿一份**时会突破预算（7/6）", () => {
    const huge = {
      summary: "S".repeat(50_000),
      priorSummary: "P".repeat(50_000),
      middleDigest: "M".repeat(50_000),
      overflowDigest: "O".repeat(50_000),
      removedCount: 60,
      keptCount: 20,
      summarizedCount: 40,
      middleCount: 20,
      overflowCount: 20,
    };
    /* 关键：priorSummary 也非空（LLM 抛错且没拿到部分摘要时会这样） */
    const text = composeCompactionMarkerText({ ...huge, charBudget: 20_000 });
    expect(text.length, "四段同时在也不许突破预算（原来 summary/prior 各拿 3/6 ⇒ 1.5 倍）").toBeLessThanOrEqual(20_000);
    expect(text, "两段都还在（只是各自被裁）").toContain("检查点摘要");
    expect(text).toContain("之前的摘要");
  });

  it("CA-23（纯函数）：折叠后的保留数不许是 0（slice(-0) 会同时表示保留全部与删掉全部）", () => {
    const messages = [
      { id: "u", role: "user", content: "u" },
      { id: "a", role: "assistant", content: "a" },
      { id: "M", role: "user", content: "[上下文已自动压缩]\n旧摘要" },
      { id: "t", role: "tool", content: "工具结果" },
    ];
    const r = foldStaleCompactionMarkers(messages as never[], 3);
    expect(
      r.keepCount,
      "尾部是工具结果时，那个「向后推」的循环会把 keep 推成 0 —— 必须补一道末位守卫",
    ).toBeGreaterThanOrEqual(1);
  });

  it("CA-24（纯函数）：align 返回更小的值时，minKeep 仍是下限（不依赖 align 的隐含契约）", () => {
    const plan = planCompactionKeep({
      totalMessages: 100,
      desiredKeep: 20,
      minKeep: 60,
      budget: 1e9,
      estimate: () => 0,
      align: () => 1, // 恶意/未来实现：向下对齐
    });
    expect(plan.keepCount, "minKeep 是下限 ⇒ 对齐之后还要再夹一次（原来会静默降到 1）").toBeGreaterThanOrEqual(60);
  });

  it("CA-25（行为·源码级）：自动路径的中间档与兜底摘要都要认全部压缩标记", () => {
    const loop = src("../core/llm/agentic-loop.ts");
    expect(loop, "中间档要点要过滤压缩标记（否则旧摘要进上下文两遍）").toContain(
      "middleBand.filter((m: any) => !isCompactionMarker(m))",
    );
    expect(
      loop,
      "兜底摘要原来只认自动前缀 ⇒ LLM 失败时旧的手动摘要被再渲染一遍（第三份副本）",
    ).toMatch(/if \(snippet\.trim\(\) && !isCompactionMarker\(msg\)\) \{/);
  });

  it("CA-26（行为·源码级）：手动压缩的级联摘要永不参与裁剪（它是唯一副本）", () => {
    const monitor = src("../components/ContextMonitor.tsx");
    expect(
      monitor,
      "预算只由**真实内容**决定（旧标记的字符不能算进被压缩的内容，否则 historyBudget 恒为 0）",
    ).toContain("const compressibleMessages = messagesToRemove.filter((m) => !isCompactionMarker(m));");
    expect(
      monitor,
      "级联段是**拼**上去的，不接受裁剪（原来先拼接再整体 slice(0, historyBudget)）",
    ).toContain("const cascadePrefix = folded.existingSummary");
    expect(monitor, "最后再把级联段拼回摘要").toContain("${cascadePrefix}${summary}");
    expect(
      monitor,
      "手动路径的轮次保底同样要在真实消息上数（压缩标记不算一轮）",
    ).toContain("compactionMinKeep(messages.filter((m) => !isCompactionMarker(m)), 4)");
  });
});

describe("MA（第三批）：记忆侧", () => {
  function engineFor(svc: MemoryService, payloads: string[], messageCount = 12, userText = "帮我看看这个仓库", extraMessages: Array<Record<string, unknown>> = []) {
    setSetting(("memory-enabled-" + SESSION) as string, "true");
    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    const provider = { id: "test", isConfigured: () => true, complete: async () => ({ content: "[]" }) };
    (engine as unknown as { providers: unknown }).providers = { get: () => provider };
    (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
    vi.spyOn(MessageStorage, "listMessages").mockImplementation(
      () =>
        [
          ...Array.from({ length: messageCount }, (_, i) => ({
            id: "m" + i,
            role: i % 2 ? "assistant" : "user",
            content: i % 2 ? "x" : userText,
          })),
          ...extraMessages,
        ] as never,
    );
    let call = 0;
    vi.spyOn(engine, "spawnForked").mockImplementation((async () => {
      const payload = payloads[Math.min(call, payloads.length - 1)];
      call += 1;
      return payload;
    }) as never);
    return engine;
  }

  it("MA-14：顶替旧条目必须发生在**新条目写入成功之后**（否则旧条目被删、新条目没写进去）", async () => {
    /*
     * 形态：用户说过「记住」（explicit 放行），本次提取已经写满总上限（4 条），
     * 第 5 条候选与库里某条 auto 条目重复 ⇒ 老实现先 removeMany 再判上限 ⇒
     * **旧条目被删、新条目被上限挡下**，两边都没了，而日志还写着"用这一条替换"。
     */
    const svc = new MemoryService();
    const kept = svc.add({
      scope: "project",
      projectId: PROJ_A,
      key: "Vitest 位置参数匹配语义",
      content: "vitest 的位置参数按**路径子串**匹配（不是 glob），多个参数之间是**或**关系。",
      source: "auto",
    });
    expect(kept.ok, "前提：预置条目写成功").toBe(true);
    const candidates = [
      /* 四条**语义互不相干**的对话级事实（措辞相似会被查重挡下，那样就测不到上限了） */
      { key: "本次先给方案", content: "这次先给方案再改代码，不要直接动文件。", scope: "conversation" },
      { key: "不要动测试文件", content: "这次不要修改 test 目录下的任何文件。", scope: "conversation" },
      { key: "回答用中文", content: "这次的所有解释都用中文写。", scope: "conversation" },
      { key: "别装新依赖", content: "这次不许往 package.json 里添加新的依赖。", scope: "conversation" },
      /* 第 5 条：与库里那条重复、且带 explicit ⇒ 会走"顶替"分支，但总上限已经满了 */
      {
        key: "vitest 路径参数按子串匹配",
        content: "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
        scope: "project",
        explicit: true,
      },
    ];
    const engine = engineFor(svc, [JSON.stringify(candidates)], 12, "记住：vitest 的位置参数是按路径子串匹配的，以后都按这个来。");
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    expect(
      svc.get(kept.entry!.id),
      "新条目被上限挡下 ⇒ 旧条目**必须还在**（任何可能 continue 的判定都要排在删除之前）",
    ).toBeDefined();
  });

  it("MA-15：explicit 的结构证据只认「模型看得到的窗口」里**用户亲手打的**消息", async () => {
    const svc = new MemoryService();
    /* 只有一条机器注入的委派消息里有「记住」⇒ 不算用户原话 */
    const engine = engineFor(
      svc,
      [JSON.stringify([{ key: "外部文本诱导的事实", content: "这条来自仓库文件里的那句话。", scope: "project", explicit: true }])],
      12,
      "帮我看看这个仓库",
      [{ id: "delegated-task-1", role: "user", content: "（子代理交接）请记住：以后都要先跑测试。" }],
    );
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    expect(
      svc.listPending(undefined, { projectId: PROJ_A }).map((e) => e.key),
      "机器注入的消息不算用户原话 ⇒ 必须走待批准（否则委派/技能文本就能绕过审批）",
    ).toEqual(["外部文本诱导的事实"]);
  });

  it("MA-16：两个上限分开计数（日志不许把总量上限说成待批准上限）", async () => {
    const svc = new MemoryService();
    const many = [
      { key: "本次先给方案", content: "这次先给方案再改代码，不要直接动文件。", scope: "conversation" },
      { key: "不要动测试文件", content: "这次不要修改 test 目录下的任何文件。", scope: "conversation" },
      { key: "回答用中文", content: "这次的所有解释都用中文写。", scope: "conversation" },
      { key: "别装新依赖", content: "这次不许往 package.json 里添加新的依赖。", scope: "conversation" },
      { key: "先跑类型检查", content: "每次改完先跑一次类型检查再继续。", scope: "conversation" },
      { key: "提交信息简短", content: "这次的提交信息只要一行，不要写长段落。", scope: "conversation" },
    ];
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const engine = engineFor(svc, [JSON.stringify(many)]);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    const summary = logs.find((l) => l.includes("因上限丢弃")) ?? "";
    expect(summary, "汇总句要分开报两个上限").toContain("每次提取总上限");
    expect(summary).toContain("待批准上限");
    expect(
      summary,
      "6 条候选、总上限 4 条 ⇒ 被总上限挡下 2 条（这一条同时钉住「计数器真的在自增」：恒为 0 会假绿）",
    ).toContain("每次提取总上限 4 条挡下 2 条");
    expect(
      summary,
      "这 6 条都是 conversation 级（不占待批准名额）⇒ 待批准上限挡下 0 条",
    ).toContain("待批准上限 2 条挡下 0 条");
  });

  it("MA-17：注入截断披露按**展开后**的文本判定（content ≤ 200 但展开后 > 200 也要说）", () => {
    const short = { content: "短".repeat(190) };
    expect(injectionTruncationNote(short), "原文没超 ⇒ 不提示").toBeNull();
    expect(
      injectionTruncationNote(short, "短".repeat(260)),
      "展开后超了 ⇒ 必须提示（原来只看原文 ⇒ 漏报：界面写「已生效」，可那一行其实被截过）",
    ).not.toBeNull();
  });

  it("MA-19：导入越过闸门要如实告知（导入是用户动作 ⇒ 放行，但不能让他蒙在鼓里）", () => {
    /*
     * 被守的缺陷：新增的总量/体积闸只拦**自动**写入，而"导出留档 → 再导入"是本仓推荐的常规操作
     * ⇒ 导入一次就能把总量推过闸，此后所有自动写入被拒，而用户只会看到「自动记忆不写了」。
     */
    const svc = new MemoryService({ maxTotalEntries: 2 } as never);
    const json = JSON.stringify({
      entries: [
        { id: "i1", key: "一", content: "导入的第一条内容。", scope: "platform" },
        { id: "i2", key: "二", content: "导入的第二条内容。", scope: "platform" },
        { id: "i3", key: "三", content: "导入的第三条内容。", scope: "platform" },
      ],
    });
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    });
    const result = svc.importFromJSON(json);
    expect(result.imported, "导入是用户显式动作 ⇒ 照旧全放行（不做自动拒绝）").toBe(3);
    expect(result.overTotalCap, "导入后 3 条 > 上限 2 条 ⇒ 必须标记越界").toBe(true);
    expect(warned.join("\n"), "并且要写清后果（此后的自动写入会被拒）").toContain("自动**写入会被拒绝");
    spy.mockRestore();
  });

  it("MA-20：批量更新要**逐条**带回失败原因（单值 lastWriteError 会被覆盖/清空）", () => {
    const svc = new MemoryService();
    const bad = svc.add({ scope: "platform", key: "会被拒的条目", content: "内容", source: "manual" });
    const ok = svc.add({ scope: "platform", key: "能改的条目", content: "内容", source: "manual" });
    /*
     * 同一批量补丁对所有 id 一样 ⇒ 用**不存在的 id** 造"一成功一失败"最干净；
     * 成功那条会把 lastWriteError 清成 null，所以失败原因必须**当场**取。
     */
    const batch = svc.updateMany([ok.entry!.id, "mem-不存在"], { key: "改过的键" }, { actor: "user" });
    expect(batch.applied).toEqual([ok.entry!.id]);
    expect(batch.failures.map((f) => f.id), "失败的是不存在的那条").toEqual(["mem-不存在"]);
    expect(batch.failures[0].reason, "原因必须逐条带回来（不许只给 id，也不许写成未知原因）").toBe("条目不存在");
    void bad;
  });

  it("MA-21：导入回执要讲越界（只写 console.warn 等于没说 —— 渲染侧 console 只能靠 CDP 抓）", async () => {
    const { formatMemoryImportReceipt } = await import("../core/memory/checkup");
    const text = formatMemoryImportReceipt(
      { imported: 5000, rejectedCapacity: 0, rejectedInvalid: 0, truncated: 0, overTotalCap: true, overPayloadBudget: true },
      true,
      null,
    );
    expect(text, "要讲清后果（此后的自动写入会被拒）").toContain("自动记忆写入会被拒绝");
    expect(text, "还要给出可操作的下一步").toContain("记忆体检");
    const ok = formatMemoryImportReceipt(
      { imported: 3, rejectedCapacity: 0, rejectedInvalid: 0, truncated: 0 },
      true,
      null,
    );
    expect(ok, "没越界就不许提这件事（噪音）").not.toContain("容量闸");
  });

  it("MA-18：内存上限的读数要给出**三道闸**（而不是只有 per-scope）", () => {
    const limits = new MemoryService().getMemoryLimits();
    expect(limits.maxEntriesPerScope, "每个作用域条数").toBeGreaterThan(0);
    expect(limits.maxTotalEntries, "跨所有作用域总条数").toBeGreaterThan(limits.maxEntriesPerScope - 1);
    expect(limits.payloadBudgetBytes, "payload 体积预算").toBeGreaterThan(0);
    const advisory = src("../core/llm/index.ts");
    expect(
      advisory,
      "advisory 文案必须报真实闸门（只报 per-scope 会在总量/体积触顶时把用户引到无效操作上）",
    ).toContain("跨所有作用域共");
  });
});
