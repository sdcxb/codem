/**
 * 第 270 波：**收尾提醒（completion nudges）必须进得去跑批记录** ✓
 * —— handoff §5 的 A2 路 ✓（目标①的**唯一**可动方向 ✓ 的数据来源 ✓）。
 *
 * ## 要修的是什么（一句话）
 *
 * 目标①（repo-02 稳定 2/2 ✓）已量清的**唯一可动方向**是"让早收工变难"✓
 * （完成守卫：零产出 / 改完又还原 / 族判据没跑齐 ✓）—— 而
 * 「**守卫到底有没有拦住**」✗ **至今没有数据** ✗：`loopStops` 只记"**停下**"✗、
 * 不记"**催促**"✗ ⇒ "守卫没用"✗ 与 "守卫根本没触发"✗ 这两种完全不同的结论**分不开** ✗。
 *
 * ## 判据（先写判据，再改实现 ✓）
 *
 * | 判据 | 钉什么 | 变异（改坏哪里 ⇒ 它红 ✓） |
 * |---|---|---|
 * | `nudge-1` | 守卫触发时：结果 `detail.completionNudges` **非空** ✓ 且**写明守卫名** ✓ | 收尾段不收集/不上提 ⇒ 红 |
 * | `nudge-2` | 反向对照：不该触发时 `detail` **为空** ✓ 且**行为逐字一致**（请求次数不变 ✓） | 无条件挂字段 ⇒ 红 |
 * | `nudge-3` | **所有**出口都带该字段 ✓（"数出口 = 数带字段的出口" ✓） | 删掉任意一处 `finishWithNudges` ⇒ 红 |
 * | `nudge-4` | 催促**真的落进事件日志** ✓（跑批记录读的就是它 ✓） | 只在结果上挂字段、不记事件 ⇒ 红 |
 *
 * ⚠️ `nudge-4` 是这条链上最容易漏的一环 ✓：`.preview-shot/_codem-repo-eval.mjs` 读的是
 * **会话事件**（`loop_stopped` ✓），不是 `LoopResult` ✓ —— 只挂字段的话，
 * 数据永远进不了 `.jsonl` ✗，判据会"绿着但什么都没测到" ✗。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgenticLoop, withCompletionNudgesDetail, COMPLETION_NUDGES_DETAIL_KEY } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { setStoragePort } from "../core/storage/port";
import { getEventLog } from "../core/storage/event-log";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { ScriptedProvider } from "./helpers/scripted-provider";

vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
  reportAdvisory: () => {},
}));

const SID = "nudge-detail-1";
const ROOT = process.cwd();

function installTauriStub(): void {
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "read_file") throw new Error("no such file");
        if (cmd === "read_text_window") throw new Error("no such file");
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

let port: FakeStoragePort;

function installPort(): FakeStoragePort {
  const p = createFakeStoragePort({
    seed: {
      sessions: [{ id: SID, project_id: "", title: "nudge", created_at: 0, last_message_at: 0, message_count: 0 }],
    },
  });
  setStoragePort(p);
  p.events.ensureLoaded(SID);
  return p;
}

/** 读会话里的 `loop_stopped` 事件载荷（假端口的 `payload` 是 **JSON 文本** ✓，这里解开 ✓） */
function loopStopPayloads(sessionId: string): Array<Record<string, unknown>> {
  return port.events
    .readAll(sessionId)
    .filter((e) => e.type === "loop_stopped")
    .map((e) => {
      try {
        return JSON.parse(e.payload) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    });
}

/** 让 `recordLoopStop` 的**动态 import + append**（两跳微任务 ✓）落地 ✓ */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * 造一轮 bash 工具调用 ✓。
 *
 * ⚠️ 本文件现在的夹具**没有用到它** ✓（零产出那支只需要"读源码"✓），
 * 但**刻意留着** ✗→✓：`completion-nudge-roundtrip-budget.test.ts::NR-1` 用的就是
 * "读 + `git stash push`"那套夹具 ✓ —— 要复现/对照"两条守卫同时成立"时
 * 第一件事就是把它接回来 ✓。**留着的探针要在结论里注明** ✓（handoff §7 第 5 条 ✓）：
 * 它**已被撤出用例** ✓，不是"那条路没走" ✓。
 */
function bashIteration(id: string, command: string): any[] {
  return [
    { type: "tool_use_start", id, name: "bash" },
    { type: "tool_use_delta", id, input: JSON.stringify({ command }) },
    { type: "tool_use_end", id, input: { command } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function readIteration(id: string, path: string): any[] {
  return [
    { type: "tool_use_start", id, name: "read" },
    { type: "tool_use_delta", id, input: JSON.stringify({ path }) },
    { type: "tool_use_end", id, input: { path } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

/** 与 NR-1 同一个夹具 ✓：**只**触发"第 176 波合并的那三条"里的两条 ✓（零产出 + 改完又还原 ✓） */
function registryWithFakeReadAndBash() {
  const registry = createDefaultToolRegistry();
  registry.register({
    id: "bash",
    description: "假 bash",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    contract: { sideEffectScope: "system", accessScope: "system" },
    async execute() {
      return { title: "bash", output: "" };
    },
  } as any);
  registry.register({
    id: "read",
    description: "假 read",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    contract: { sideEffectScope: "none", accessScope: "system" },
    async execute() {
      return { title: "read", output: "// 源码内容" };
    },
  } as any);
  return { registry };
}

/** 跑一个脚本化的循环，返回**每个出口的结果**与 provider（请求次数 = 多要了几轮 ✓） */
async function runLoop(script: any[][], sessionId = SID) {
  const provider = new ScriptedProvider();
  provider.setScript(script);
  const { registry } = registryWithFakeReadAndBash();
  const loop = new AgenticLoop(provider as any, registry, { maxIterations: 20, model: "m", securityMode: "full" });
  /**
   * ⚠️ **收集所有 `end` 结果**（第一版只留最后一个 ✗ ⇒ `nudge-1` 假红 ✓）。
   *
   * 为什么"最后一个"是错的 ✗：催促发生的那一轮**会 `continue`** ✓ —— 它的结果对象
   * 才是带 `detail` 的那一个 ✓；而被催之后模型**正常收尾**的那一轮
   * `completionNudges` 已经清空 ✓ ⇒ 它的 `detail` 是 `undefined` ✓。
   * 只看最后一个 ⇒ 恰好看到**没有**字段的那一个 ✗（而数据其实好好地在日志里 ✓）。
   */
  const endResults: any[] = [];
  for await (const ev of loop.run(sessionId, "把这件事做完", ROOT, "system")) {
    if ((ev as any).type === "end") endResults.push((ev as any).result);
  }
  await flush();
  return { result: endResults[endResults.length - 1], endResults, provider };
}

beforeEach(() => {
  installTauriStub();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  port = installPort();
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

// ========== nudge-1 / nudge-2：语义（有触发就有、没触发就没有） ==========

describe("nudge-1/2 收尾提醒的有与没有", () => {
  it("nudge-1: 守卫触发 ⇒ `detail.completionNudges` 非空，且**写明守卫名**", async () => {
    /**
     * ## 夹具为什么是"读源码 + 收尾"（而不是 NR-1 那个"读 + git stash"✗）
     *
     * 第一版照抄了 NR-1 的夹具 ✗（`read` + `git stash push -- <path>` ✓），
     * 实测**没有触发**那两条合并的守卫 ✓ —— 台账（`loop_stopped` ✓）说明了一切 ✓：
     * ```
     * {"reason":"completed_unverified","phase":"nudge","iteration":3}
     * {"reason":"completed_unverified","phase":"give-up","iteration":4}
     * ```
     * ⇒ 先说话的是**更老的**那条守卫（"改了但没验证"✓，即 `phase: "nudge"` ✓）
     * ⇒ 它一 `continue` 就 `verificationNudgeIssued = true` ✗ ⇒ 下一轮走的是
     * **"没有验证就明说未证实"**那条收尾（`phase: "give-up"` ✓）✗ —— 而它**不在**
     * 第 176 波合并的那三条里 ✓ ⇒ `completionNudges` 自然是空的 ✓。
     * （`NR-1` 之所以能过 ✓：它**不装存储端口**✓，所以 `turnModifiedFiles` 起不来 ✓，
     * 那条老守卫沉默 ✓。这也说明"夹具要精确到哪一条守卫"这件事**必须靠台账**✓，不能靠猜 ✗。）
     *
     * 现在的夹具 ✓：**只读源码、不改任何东西** ⇒
     * 「零产出」那条成立 ✓（`modifiedAnything=false` ✓ + `testStatuses` 空 ✓ +
     * `lookedAtSource=true` ✓，见 `completion-guards.ts:114-125` ✓），
     * 而老的两条都沉默 ✓（没改过 ⇒ VU / 红判据都不该说话 ✓）⇒ **正好一条** ✓。
     */
    const { endResults } = await runLoop([
      readIteration("r1", join(ROOT, "src", "core", "llm", "tools.ts")),
      finalIteration("我做完了。"),
      finalIteration("说明：……"),
    ]);

    /**
     * ## ⚠️ 这条判据的口径（第 270 波按**实测**更正过一次 ✗→✓）
     *
     * 我第一版写的是"出口的 `detail.completionNudges` 非空" ✗ —— 实测证明**它在正常路径上
     * 根本不会出现** ✓，而这**不是缺陷** ✓：
     *
     * - 催促块结尾是 `continue` ✓（第 176 波的往返预算要求：催了之后**不停**，让模型继续 ✓）
     *   ⇒ 被催的那一轮**不产生 `end` 出口** ✗；
     * - 只有"**催促与某个停因在同一轮同时发生**"（重复调用守卫 / 迭代上限 / 连续错误 …
     *   那些在收尾段里就 break 的出口 ✓）时，`detail` 才会带上它 ✓ ——
     *   而那正是**必须留下证据**的那一刻 ✓（"催了、但它还是停了"✓ 是判断"守卫有没有拦住"的关键 ✓）。
     *
     * ⇒ 正常路径上"催过"的证据在**事件日志**里（`nudge-4` 钉 ✓），
     *   而"出口会不会漏掉这个字段"是**结构性质**（`nudge-3` 钉 ✓）。
     *   这里改成断言**这一条链真的通着** ✓：日志里有催促记录 ✓、且有文案与守卫名 ✓。
     */
    const nudgeRecords = loopStopPayloads(SID).filter((p) => p.phase === "nudges");
    expect(nudgeRecords.length, "守卫催过就必须留下这条证据（否则「守卫有没有拦住」永远没有数据）").toBe(1);
    const nudges = nudgeRecords[0].nudges as string[];
    expect(Array.isArray(nudges), "形状必须是数组").toBe(true);
    expect(nudges.length, "这个夹具触发一条守卫 ⇒ 至少一条提醒").toBeGreaterThan(0);
    expect(
      nudgeRecords[0].guards,
      "守卫名必须是**结构化**的（不许从产品文案里正则抠 ✗）",
    ).toEqual(["zero-output"]);
    const text = nudges.join("\n");
    expect(text.length, "文案不能是空串").toBeGreaterThan(0);
    /** 出口那条链也要有证据 ✓：`endResults` 必须真的存在（否则上面读的是别的东西 ✓） */
    expect(endResults.length, "循环必须走到过出口（`end` 事件 ✓）").toBeGreaterThan(0);
  });

  it("nudge-2: 不该触发时**没有 `completionNudges`**（正常路径逐字不变 ✓）", async () => {
    const { result, provider } = await runLoop([finalIteration("这个任务不用改代码，因为……")]);

    /**
     * ⚠️ 这条断言**第 309 波改过** ✓（原来查的是"`detail` 整体为 `undefined`"✗）——
     * 理由 ✓：`detail` 现在**还承载"这一轮从哪个出口结束"** ✓
     * （`EXIT_REASON_DETAIL_KEY` ✓，目标①要靠它归因 ✓，真机 `repo-02` 的 `loopStops: 0` 就卡在这 ✗）。
     * ⇒ 那意味着 `detail` **恒存在** ✓ ⇒ 老断言会**假红** ✗。
     * ⇒ 改成查**语义**：**没有守卫被触发 ⇒ 不许有 `completionNudges`** ✓
     * （"凭空造证据"要防的是**催促**那一条 ✓，不是出口原因 ✓ —— 后者是本轮**真实发生的事** ✓）。
     */
    const detail = (result?.detail ?? {}) as Record<string, unknown>;
    expect(
      detail.completionNudges,
      "没有守卫被触发 ⇒ 不许有 completionNudges（否则是凭空造证据）",
    ).toBeUndefined();
    expect(provider.requests.length, "正常收尾只该要 1 轮（行为逐字不变 ✓）").toBe(1);
    /** 反向对照：事件日志里也不该有催促记录 ✓ */
    const stops = loopStopPayloads(SID);
    expect(
      stops.filter((p) => p.phase === "nudges"),
      "没触发就不许记「催了」",
    ).toEqual([]);
  });
});

// ========== nudge-3：结构性（所有出口都带 ✓） ==========

describe("nudge-3 所有出口都带该字段（收成一处 ✓ 不许逐处加 ✗）", () => {
  /**
   * ⚠️ 这条刻意用**读字面代码**的方式 ✓（与 `no-sync-mirror-reads` 同一套路 ✓）：
   * "所有出口都带字段"是**结构性质** ✓，跑一个用例只能覆盖它走到的那一个出口 ✗
   * —— 15 个出口里漏掉 14 个，随便一个用例都会绿 ✗。
   */
  it("nudge-3: 每一个 `type: \"end\"` 出口的 result 都经 `finishWithNudges`（数出口 = 数带字段的出口）", () => {
    /**
     * ⚠️ `trim()` **只去首尾**，而 CRLF 的 `\r` 在行**尾** ✓ ⇒ 它其实会被去掉 ✓。
     * 但判据不能依赖"编辑器恰好用什么换行"✗ —— 所以下面**先把 `;` 与空白剥掉**再匹配 ✓。
     * （第一版就是在这儿连栽两次 ✗：`\s*$` 撞上 `;` ✓、抠变量名的正则又写成字面 `s*` ✓
     *  ⇒ 9 个**合规**出口被误报 ✗。两次都是"判据自己错"✓，不是实现错 ✗。）
     */
    const src = readFileSync(join(ROOT, "src", "core", "llm", "agentic-loop.ts"), "utf8");
    /**
     * 出口的形状（本文件里只有两种 ✓，都是 `run()` 的结束出口 ✓）：
     * 1. `yield { type: "end", result }` —— result 是那个已包装的局部变量 ✓；
     * 2. `yield { type: "end", result: <表达式> }` —— 表达式必须当场包装 ✓。
     */
    const lines = src.split("\n");
    const exits: Array<{ line: number; text: string }> = [];
    lines.forEach((l, i) => {
      if (/yield\s*\{\s*type:\s*"end"/.test(l)) exits.push({ line: i + 1, text: l.trim().replace(/;\s*$/, "") });
    });    expect(exits.length, "金丝雀：出口数不该是 0（抽取器失效了）").toBeGreaterThanOrEqual(10);

    /**
     * ⚠️ **必须按行号回溯**（第一版没有 ✗ ⇒ 9 条假红 ✓）。
     *
     * "`result` 这个局部变量被包装过"是**位置相关**的性质 ✓：同一个函数里
     * `const result = this.finishWithNudges({…})` 出现了十几次 ✓，
     * 只看"文件里有没有"会把**没包装的那个出口**也判成合规 ✗
     * （实测：9 个出口报了 offener ✗，而它们其实都是合规的 ✓ —— 因为第一版
     * 用 `/result:\s*(\w+)s*,?\s*\}/` 抠变量名 ✗，`s*` 是**字面 `s`** ✗，
     * 于是 `(\w+)` 贪婪吃掉了 `result` 里的字符 ✗ ⇒ 抠出来的是 `resul` ✗）。
     * 现在：从出口往上找**最近一次** `const <同名> = this.finishWithNudges(` ✓。
     */
    const wrappedBefore = (varName: string, exitLine: number): boolean => {
      for (let j = exitLine - 2; j >= 0 && j > exitLine - 80; j--) {
        const l = lines[j];
        if (new RegExp(`const\\s+${varName}\\s*=\\s*this\\.finishWithNudges\\(`).test(l)) return true;
        // 同名变量的**别的**赋值（没包装）出现得更近 ⇒ 说明这个出口用的是没包装的那一份 ✗
        if (new RegExp(`const\\s+${varName}\\s*=`).test(l)) return false;
      }
      return false;
    };

    const offenders: string[] = [];
    for (const e of exits) {
      if (e.text.includes("this.finishWithNudges(")) continue; // 形态 2：当场包装 ✓
      /**
       * ⚠️ 用**字符串**抠变量名，不用正则 ✗→✓ —— 这儿连着栽了三次 ✗
       * （`\s*$` 撞上分号 ✓ / 抠名字的正则写成字面 `s*` ✓ / 复刻出来的正则在
       * `String.raw` 与模板转义之间又对不上 ✓）。**三次都是判据自己错**✓，
       * 而三次的表现都是"9 个合规出口被误报"✗ —— 这正是"判据写错比实现错更费时间"的形态 ✓。
       * 现在只认**两种确定的形状** ✓（本文件里出口就是这两种 ✓），抠不出名字就报出来 ✓（宁可红 ✗ 不可假绿 ✓）。
       */
      const suffix = "result: ";
      const at = e.text.indexOf(suffix);
      let varName: string | null = null;
      if (at >= 0) {
        const rest = e.text.slice(at + suffix.length).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*\s*\}$/.test(rest)) varName = rest.replace(/\s*\}$/, "");
      }
      if (at === -1 && e.text.endsWith("result }")) varName = "result";
      if (varName && wrappedBefore(varName, e.line)) continue; // 形态 1：局部变量已包装 ✓
      offenders.push(`第 ${e.line} 行：${e.text}`);
    }

    expect(
      offenders,
      `这些出口的 result **没有**经 \`finishWithNudges\` ⇒ 从那一条出口结束时，收尾提醒的证据会**静默消失** ✗\n` +
        `（加一个出口就忘了加包装，正是这条判据存在的理由 ✓）：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);

    /** 反向金丝雀：包装点数量必须与"有结果的出口"同量级 ✓（否则上面那条会因为集合为空而恒真 ✗） */
    const wrappedCount = (src.match(/const\s+\w+\s*=\s*this\.finishWithNudges\(/g) ?? []).length;
    expect(wrappedCount, "包装点太少 ⇒ 上面那条判据可能被绕过了").toBeGreaterThanOrEqual(5);

    /**
     * ⚠️ **还差一环：包装点本身必须真的挂字段** ✗→✓（变异 `MUT-N1` 就是这么逃掉的 ✓）。
     *
     * 第一次跑变异时把 `finishWithNudges` 改成 `return result;`（等于本波什么都没做 ✗），
     * 上面那条**照样绿** ✗ —— 因为它只证明"出口都调用了包装函数"✓，
     * 而**没证明包装函数真的把字段挂上去**✗（"调了、但没做"正是最典型的假绿 ✓）。
     * 所以这里再钉一环 ✓：那个私有方法体里必须**同时**出现"转发给纯函数"与"把
     * `completionNudges` 传进去"两件事 ✓。
     */
    const wrapper = /private finishWithNudges\(result: LoopResult\): LoopResult \{([\s\S]*?)\n  \}/.exec(src);
    expect(wrapper, "`finishWithNudges` 必须还是那个单一入口（形状变了请一起改判据）").not.toBeNull();
    expect(
      wrapper![1],
      "单一入口必须把本轮 `completionNudges` 真的交给 `withCompletionNudgesDetail` —— " +
        "只 `return result` 的形态等于本波没做（而出口那一条判据**看不见**它 ✗）",
    ).toMatch(/withCompletionNudgesDetail\(\s*(result|this\.attachExitReason\(result\))\s*,\s*this\.completionNudges\s*\)/);
  });

  it("nudge-3b: 纯函数语义——空数组不加字段、非空数组克隆后加字段（原对象不动 ✓）", () => {
    const base = { type: "stop" as const, reason: "r", usage: {} as any };
    const untouched = withCompletionNudgesDetail(base as any, []);
    expect(untouched, "空 ⇒ 原样返回（同一引用 ⇒ 正常路径行为逐字不变）").toBe(base);
    expect((untouched as any).detail).toBeUndefined();

    const wrapped = withCompletionNudgesDetail(base as any, ["理由一", "理由二"]) as any;
    expect(wrapped).not.toBe(base);
    expect(wrapped.detail[COMPLETION_NUDGES_DETAIL_KEY]).toEqual(["理由一", "理由二"]);
    expect((base as any).detail, "**不许**原地改调用方持有的对象（那会造成 yield 前后不等）").toBeUndefined();

    /** 与既有 `detail`（例如 plan_stale 的 stalledFor）**合并**、不覆盖 ✓ */
    const withExisting = withCompletionNudgesDetail({ ...base, detail: { stalledFor: 24 } } as any, ["x"]) as any;
    expect(withExisting.detail.stalledFor, "既有 detail 不能被冲掉").toBe(24);
    expect(withExisting.detail[COMPLETION_NUDGES_DETAIL_KEY]).toEqual(["x"]);
  });
});

// ========== nudge-4：真的落进事件日志（跑批记录读的就是它 ✓） ==========

describe("nudge-4 催促必须落进事件日志（`.jsonl` 里的 `loopStops` 读它 ✓）", () => {
  it("nudge-4: 触发时记一条 `loop_stopped`（phase=nudges）+ **守卫名**与**文案**都在里面", async () => {
    await runLoop([
      readIteration("r1", join(ROOT, "src", "core", "llm", "tools.ts")),
      finalIteration("我做完了。"),
      finalIteration("说明：……"),
    ]);

    const stops = loopStopPayloads(SID);

    const nudgeRecords = stops.filter((p) => p.phase === "nudges");
    expect(
      nudgeRecords.length,
      "**这一条是本波的落点**：只挂结果字段的话数据永远进不了跑批记录（绿着但什么都没测到 ✗）",
    ).toBe(1);
    const rec = nudgeRecords[0];
    expect(rec.reason, "沿用既有通道（`loopStops` 那条 ✓）").toBe("completed_unverified");

    const guards = rec.guards as string[];
    expect(Array.isArray(guards), "守卫名必须是**结构化**的（不许从产品文案里正则抠 ✗）").toBe(true);
    expect(guards.length, "这个夹具触发两条守卫").toBeGreaterThan(0);
    for (const g of guards) {
      expect(["reverted", "zero-output", "unrun-family"], `守卫名 ${g} 必须在约定取值里`).toContain(g);
    }
    const nudges = rec.nudges as string[];
    expect(Array.isArray(nudges), "文案也要留下（排查时要看它到底说了什么）").toBe(true);
    expect(nudges.length, "守卫名与文案一一对应").toBe(guards.length);
    expect(typeof rec.iteration, "记下是第几轮催的（判据要用它把「催了几次」算出来）").toBe("number");
  });

  it("nudge-4b（反向对照）：一次都没催过的会话里，不许出现 `phase=nudges` 的记录", async () => {
    await runLoop([finalIteration("不用改")], "nudge-detail-clean");
    const stops = loopStopPayloads("nudge-detail-clean");
    expect(stops.filter((p) => p.phase === "nudges")).toEqual([]);
  });
});
