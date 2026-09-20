/**
 * 技能市场 console 预算契约（第 63 轮；发布闸门的一部分）
 *
 * ## 背景（真机读数，改动前基线）
 *
 * 打开「技能管理 → 技能市场」并点一次"检查更新"，console 里量到 **44 条 warning**：
 *  - 35 × `GitHub Trees API rate limited for <repo>`（同一个源内部按仓库刷屏）
 *  - 7 × `Source "<名称>" timed out after 12000ms`
 *  - 1 × `Failed to fetch repo info for anthropic-skills: 403`
 *  - 1 × `Skills.sh API requires Vercel OIDC token authentication`
 *
 * 其中"7 个源全部超时"是**假的**：真机把 `setTimeout`/`clearTimeout` 包起来量到
 * 7 个 12000ms 定时器 `clearedCount: 0`，全部在点击后 13.3s 照原样开火，
 * 连 `Codem 内置技能`（同步返回、0ms 就赢了竞速）和已经打完
 * `ClawHub: fetched 296 skills` 这一行的源也照报超时。
 *
 * ## 这个文件守什么
 *
 * 用**假 Tauri 层**驱动改后的真实实现，守住三条"修掉的真问题不会被改回去"：
 *  - 正常完成的源不允许出现超时告警（定时器必须被清）
 *  - GitHub 限流必须被识别成限流（而不是每仓库刷一条 + 逐仓库退化成 Contents 串行兜底）
 *  - 降级的源不得出现在 `result.skills` 里（否则调用方会把该市场已有技能整片丢掉）
 *
 * 真机装的是 1.16.110（不含本次改动），所以**真机只能复量改动前读数**；
 * "改动后"的行为由本文件与 `.preview-shot/out-*` 下的读数共同支撑。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSettings: Record<string, any> = {};
vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn().mockReturnValue(null),
  getSettingJSON: vi.fn().mockImplementation((k: string, d: any) => mockSettings[k] ?? d),
  setSettingJSON: vi.fn(),
  removeSetting: vi.fn(),
}));
vi.mock("../core/file-api", () => ({
  // CLI 源：**永不 settle 的 promise**，用来制造一个真实"源超时"（不 reject，避免留下噪声）
  executeCommand: vi.fn(() => new Promise(() => {})),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deletePath: vi.fn(),
}));

import {
  listMarketSkills,
  searchMarketSkillsOnline,
  __resetHttpGateForTests,
  __setHttpGateLimitForTests,
  type MarketSource,
} from "../core/skill/skill-market-client";

function installFakeTauri(handler: (url: string) => any) {
  const calls: string[] = [];
  (globalThis as any).window = globalThis;
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "http_get") {
          calls.push(args.url);
          return handler(args.url);
        }
        return { status: 500, body: "", headers: {} };
      },
    },
  };
  return calls;
}

/**
 * 一个"永远不返回"的 `http_get`。
 *
 * ## 为什么 ③d/③e 需要一个真的挂着不动的源（而不是沿用 ③ 的 CLI 源）
 *
 * 这条**踩过坑，值得写下来**：本文件原先的"源超时"都是用 CLI 源
 * （`executeCommand` 返回 `new Promise(() => {})`）造的，但 CLI 适配器的第一步是
 * `await import("../core/file-api")` —— 一次**动态 import**。
 *
 * `withSourceTimeout` 的 12s 定时器是在 `work` **返回之后**才挂上去的，
 * 而动态 import 的落地时刻相对"假定时器推进"是**不确定**的：
 * 实测同一个用例单独跑能开出告警、放进本文件按顺序跑却量到 **0 条** ——
 * 于是测试会红得莫名其妙（还会被误读成"去重把真问题静音了"）。
 *
 * 改用 GitHub 源之后，hang 发生在 `tauriInvoke` 返回的 promise 上：
 * 全程只有原生 promise、**没有动态 import**，所以定时器一定会在推进前挂好，判定是确定的。
 */
const hangForever = () => new Promise<never>(() => {});

const ok = (body: any) => ({ status: 200, body: typeof body === "string" ? body : JSON.stringify(body), headers: {} });
const rateLimited = () => ({ status: 403, body: "rate limited", headers: { "x-ratelimit-remaining": "0" } });

/**
 * Rust 侧 `http_get` 并发闸门拒绝时的**真实错误体**（逐字取自 `lib.rs::busy_error()`）。
 *
 * 为什么测试要用**逐字**的真实形状而不是 `new Error("BUSY")`：
 * 前端是靠 `JSON.parse(err.message).code === "BUSY"` 判定的，测试若用简化文本，
 * 就测不到"信封解析"这一步 —— 而真机上打出来的恰恰就是这个 JSON 字符串。
 *
 * ⚠️ **必须 `throw` 它，不能 `return` 它**（第一版就踩了这个坑，值得记下来）：
 * `installFakeTauri` 里的 `invoke` 是 `async` 函数，**`return` 一个 Error 对象会被
 * `Promise.resolve` 包成"成功"**，于是适配器把一个 Error 当成 `HttpResponse` 收下
 * （`status === undefined` → 走 `status !== 200` 分支 → 返回空数组）。
 * 真机上 Tauri 的 invoke 在命令 `Err` 时是**拒绝** promise 的，所以测试也必须扔。
 */
const busyHttpError = () =>
  new Error(
    JSON.stringify({
      code: "BUSY",
      hint: "稍后重试；前端应退避，而不是立刻重发",
      message: "并发请求已达上限（12 路在飞），本次请求未被发出",
      retryable: true,
    }),
  );

/** 模拟 Tauri invoke 在命令返回 `Err` 时**拒绝** promise（而不是 resolve 一个 Error）。 */
const throwBusy = (): never => {
  throw busyHttpError();
};

/** GitHub 配额耗尽的 403（`isRateLimitedResponse` 判定的形态：403 + 剩余量为 0）。 */
const rateLimited403 = () => ({
  status: 403,
  body: "API rate limit exceeded",
  headers: { "x-ratelimit-remaining": "0" },
});

/** 非限流的非 200（403 权限 / 404 / 5xx 都归这一类）。 */
const forbidden403 = () => ({ status: 403, body: "forbidden", headers: {} });

/** 「源可达、返回为空」这句**只允许在真·空结果时出现**的那句话。 */
const EMPTY_CLAIM = /源可达、返回为空/;
const emptyClaims = () => logs().filter((t) => EMPTY_CLAIM.test(t));

/**
 * 把"源超时"那条 12s 定时器推到开火（单次大跳跃，确定性口径）。
 *
 * 配合上面的 `hangForever`：源挂在 `tauriInvoke` 上、没有动态 import，
 * 所以"推进 60s"之前定时器一定已经挂好 —— 不需要试探性小步推进。
 * 保留这层封装只是为了把"单次推进 + 断言真的开火"这件事写在一处、口径统一。
 *
 * @param observed 传入"当前超时告警条数"，返回是否已开火
 */
async function fireSourceTimeout(observed: () => number): Promise<boolean> {
  await vi.advanceTimersByTimeAsync(60_000); // 远超 12s 上限
  return observed() >= 1;
}
const SKILL_MD = "---\nname: pdf\ndescription: d\n---\n\n# PDF\n";

const repoSrc: MarketSource = { id: "anthropic-skills", name: "Anthropic Skills", type: "github-repo", url: "https://api.github.com/repos/anthropics/skills", enabled: true, subdir: "skills" };
const searchSrc: MarketSource = { id: "github-agent-skills", name: "GitHub Agent Skills", type: "github-search", url: "https://api.github.com/search/repositories?q=x", enabled: true };
const cliSrc: MarketSource = { id: "skillhub-cli", name: "SkillHub CLI", type: "cli", url: "", enabled: true, cliCommand: "skillhub" };

/**
 * 造一个**没被别的用例碰过**的 github-repo 源。
 *
 * ## 为什么必须换仓库名（这条是实测踩出来的，不是洁癖）
 *
 * `skill-market-client.ts` 里有一个**模块级**的仓库树缓存
 * （`const repoTreeCache = new Map(...)`，按 `owner/repo@branch` 键）。
 * 它跨用例存活，而本文件里 `repoSrc` 被多个用例共用 ——
 * 于是新写的用例一旦复用 `repoSrc`，`fetchRepoGitHubRepoSkills` 会**直接命中缓存**：
 * `httpGet` 一次都不发，被 mock 的 BUSY 永远没机会发生，
 * 用例就去断言"没有假话"——**测了个空**（第一版就是这么假绿的：`httpGet` 无调用）。
 *
 * 每个 BUSY 用例用一个独立仓库名，才能保证请求真的走出去。
 */
const uniqueRepoSrc = (n: number): MarketSource => ({
  id: `busy-probe-${n}`,
  name: `Busy Probe ${n}`,
  type: "github-repo",
  url: `https://api.github.com/repos/codem-test/busy-${n}`,
  enabled: true,
});

let warnSpy: any, logSpy: any, errSpy: any;
const warns = () => warnSpy.mock.calls.map((c: any[]) => String(c[0]));
const logs = () => logSpy.mock.calls.map((c: any[]) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers();
  /**
   * 每个用例开头复位**前端准入闸门**与 BUSY 记账。
   *
   * 为什么必须复位：闸门是模块级单例，而本文件里有好几个用例把"永远挂着的请求"
   * 留在飞（`hangForever`）—— 不复位的话这些残留会占满许可，后续用例全部排队等待、
   * 表现为莫名其妙的超时（用例之间互相污染）。这条是实测踩出来的。
   */
  __resetHttpGateForTests();
  /**
   * 注意：这里**只监听、不替换实现**（不传 mockImplementation）。
   *
   * 原因（本仓库踩过的坑）：如果把这些 console 方法整体换成 no-op，vitest 的
   * "测试里产生了 console 输出" 这条 RPC 会悬在半空，worker 退出时就可能报
   * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
   * —— 那种噪声会让整个套件的退出码变成 1（0 failed 但 exit≠0）。
   */
  warnSpy = vi.spyOn(console, "warn");
  logSpy = vi.spyOn(console, "log");
  errSpy = vi.spyOn(console, "error");
});
afterEach(() => {
  warnSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore();
  vi.useRealTimers();
});

describe("技能市场取数收口（改动后行为）", () => {
  it("① 源正常完成 → 不出现超时告警，回调拿到真实结果", async () => {
    installFakeTauri((url) => {
      if (/\/repos\/anthropics\/skills$/.test(url)) return ok({ default_branch: "main", full_name: "anthropics/skills", updated_at: "2026-01-01" });
      if (/git\/trees/.test(url)) return ok({ sha: "s", tree: [{ path: "skills/pdf/SKILL.md", type: "blob", sha: "x" }] });
      if (/raw\.githubusercontent\.com/.test(url)) return ok(SKILL_MD);
      return { status: 404, body: "", headers: {} };
    });
    const loaded: Array<[string, number]> = [];
    const p = listMarketSkills([repoSrc], (id, s) => loaded.push([id, s.length]));
    await vi.advanceTimersByTimeAsync(60_000); // 远超 12s 上限
    const res = await p;

    expect(res.skills.length, "应当拿到 1 条技能").toBe(1);
    expect(loaded).toEqual([["anthropic-skills", 1]]);
    expect(warns().filter((t) => /timed out|仍未取完/.test(t)), "源已经成功，不允许有超时告警").toEqual([]);
  });

  it("② GitHub 限流 → 每源一条说明、不退化成 Contents、限流后停止继续打", async () => {
    const calls = installFakeTauri((url) => {
      if (/search\/repositories/.test(url)) {
        return ok({ items: [...Array(30).keys()].map((i) => ({ full_name: `o/r${i}`, name: `r${i}`, default_branch: "main" })) });
      }
      if (/git\/trees/.test(url)) return rateLimited();
      return { status: 404, body: "", headers: {} };
    });

    const p = listMarketSkills([searchSrc]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    expect(res.skills, "限流时拿不到技能（不假装成功）").toEqual([]);
    expect(warns().filter((t) => /GitHub Trees API rate limited for/.test(t)), "不许每仓库刷一条（改前 35 条）").toEqual([]);
    const limitNotes = logs().filter((t) => /配额/.test(t));
    expect(limitNotes.length, "限流说明每源一次").toBe(1);

    const treeCalls = calls.filter((u) => /git\/trees/.test(u));
    expect(treeCalls.length, "限流后必须停止继续打 GitHub").toBeLessThanOrEqual(8);
    expect(calls.filter((u) => /\/contents/.test(u)), "限流时不许退化成 Contents API 兜底").toEqual([]);
    expect(warns().filter((t) => /仍未取完/.test(t)), "限流是被识别并快速收口，不该拖到 12s 超时").toEqual([]);
  });

  it("③ 源真的超时 → 只报一条、返回空、不回调空数组（界面保留旧数据）", async () => {
    installFakeTauri(() => ({ status: 500, body: "", headers: {} }));
    const loaded: string[] = [];
    const p = listMarketSkills([cliSrc], (id) => loaded.push(id));
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    expect(res.skills).toEqual([]);
    expect(warns().filter((t) => /仍未取完/.test(t)).length, "超时只报一次").toBe(1);
    expect(loaded, "超时不回调（否则界面上该源的技能会被清空）").toEqual([]);
    // 关键：降级的源绝不能被当成"这个源现在 0 条"塞进结果 ——
    // SkillManager 按 result.skills 里的 sourceId 决定替换哪些源的旧数据，
    // 塞进去就等于把该市场整片技能删掉。
    expect(res.skills.some((s) => s.sourceId === cliSrc.id), "降级源不得出现在结果里").toBe(false);
    // 超时是我们自己的 12s 上限、且后台仍在跑完它，不该升级成 `errors`
    // （errors 会变成面板顶部那条红色的"部分源加载失败"，等于把降级说成故障）。
    expect(res.errors, "超时只进日志，不算 errors").toEqual([]);
  });

  /**
   * ③d 真机 1.16.112 的读数：`Source "ClawHub.ai" … 超过 12000ms` **×2**、
   * `Source "SkillHub" …` **×2**（限流那条路径已经每源一条，**超时这条没有去重**）。
   *
   * 重复的来源不是"日志写重了"，而是**真的取了两遍**：
   * `listMarketSkills()`（列表页）与 `searchMarketSkillsOnline()`（搜索页）
   * 各自重新取一遍所有源、各自独立套一层 `withSourceTimeout`，
   * 于是同一个源在同一轮刷新里超时两次 → 两条**逐字相同**的 warning。
   *
   * 这条断言钉的是去重口径本身：**同轮 · 同源 · 只一条 warning**，
   * 同时确认去重**没有吞掉真问题**（该源的降级语义照旧）。
   */
  it("③d 同一轮里列表页与搜索页都取同一个源 → 超时只报一条（真机 1.16.112 报了 ×2）", async () => {
    // GitHub 源挂在 `tauriInvoke` 上（全程只有原生 promise、无动态 import）
    // → 12s 定时器一定在"推进假时间"之前挂好，判定是确定的（坑见 hangForever 的注释）。
    installFakeTauri(() => hangForever());
    const timeoutWarns = () =>
      warns().filter((t) => new RegExp(`Source "${searchSrc.name}"`).test(t) && /仍未取完/.test(t)).length;

    // 同一轮刷新：列表页与搜索页**先后**取同一个源（12s 上限内都没取完）。
    // 两个 promise 都不会 settle（请求永远挂着），所以不 await 它们。
    const listRun = listMarketSkills([searchSrc]);
    const searchRun = searchMarketSkillsOnline("pdf", [searchSrc]);
    expect(vi.getTimerCount(), "两个入口各自都该挂上 12s 超时定时器").toBeGreaterThanOrEqual(2);

    const fired = await fireSourceTimeout(timeoutWarns);
    expect(fired, "12s 超时定时器必须真的开火（否则本用例测了个空）").toBe(true);

    // 两个入口各自的收口都已走完（能 await 到，说明降级路径没被吞）
    await Promise.all([listRun, searchRun]);

    expect(timeoutWarns(), "同轮同源只许报一次（改动前是 2 条逐字相同的 warning）").toBe(1);
  });

  /**
   * ③e 去重的**边界**：去重是按轮清的，不是"一个源一辈子只说一次"。
   *
   * 否则就变成"把真问题静音"—— 用户下一轮刷新时同一个源又超时，必须能再次看到。
   * 这里把时间推过轮次合并窗口（`ROUND_COALESCE_MS`）后再取一次，断言重新报账。
   */
  it("③e 下一轮刷新（超出轮次合并窗口）同一个源仍会再次报超时 —— 去重不静音", async () => {
    installFakeTauri(() => hangForever());
    const timeoutWarns = () =>
      warns().filter((t) => new RegExp(`Source "${searchSrc.name}"`).test(t) && /仍未取完/.test(t)).length;

    // 先空推一段时间越出轮次合并窗口，保证本用例第一段一定是"新的一轮"
    // （避免依赖上一条用例留下的模块级轮次状态，那样用例之间会互相耦合）。
    await vi.advanceTimersByTimeAsync(4_000);

    const firstRun = listMarketSkills([searchSrc]);
    await fireSourceTimeout(timeoutWarns);
    await firstRun;
    expect(timeoutWarns(), "第一轮报一条").toBe(1);

    // 推进时间越过 ROUND_COALESCE_MS，让下一次调用开新轮
    await vi.advanceTimersByTimeAsync(4_000);

    const secondRun = listMarketSkills([searchSrc]);
    await fireSourceTimeout(timeoutWarns);
    await secondRun;

    expect(timeoutWarns(), "新的一轮必须能再次报出来（去重只在一轮内生效）").toBe(2);
  });

  /**
   * ③f 真机 1.16.112 的**"假话"缺陷**：BUSY 被当成普通失败，于是打出
   * `Source "Anthropic Skills" 本次没有可展示的技能（源可达、返回为空）`
   * —— 而 `BUSY` 的含义恰恰是 `"本次请求未被发出"`（源可达性压根没验证过）。
   *
   * 这条钉两件事：
   *  1. BUSY 必须被认出来，并且按**「并发受限、稍后重试」**如实分类（保留上一次的结果）；
   *  2. **绝不允许**出现"源可达、返回为空"这句与事实相反的结论。
   */
  it("③f BUSY 必须如实分类为「并发受限」—— 不许打「源可达、返回为空」这句假话", async () => {
    const calls = installFakeTauri(() => throwBusy()); // 永远被闸门拒（重试 2 次后仍拒）
    const src = uniqueRepoSrc(1); // 独立仓库名：避开模块级树缓存，否则 httpGet 不会被调用

    const p = listMarketSkills([src]);
    await vi.advanceTimersByTimeAsync(60_000); // 让退避重试全部走完
    const res = await p;

    expect(calls.length, "请求必须真的发出过（否则本用例测了个空）").toBeGreaterThanOrEqual(1);

    expect(
      logs().filter((t) => /源可达、返回为空/.test(t)),
      "请求根本没发出去，绝不能说「源可达、返回为空」（真机 1.16.112 就是这么说的）",
    ).toEqual([]);

    const busyWarns = warns().filter((t) => /并发受限/.test(t));
    expect(busyWarns.length, "并发受限必须**可见**（每源一条），不许静默").toBe(1);
    expect(busyWarns[0], "文案要说清请求没发出去、并且可重试").toMatch(/并发闸门已满|并发受限/);
    expect(busyWarns[0]).toMatch(/保留上一次的结果/);
    expect(busyWarns[0]).toMatch(/稍后重试/);

    expect(res.skills, "并发受限 → 不计入结果（否则界面会把该源旧数据当成 0 条）").toEqual([]);
    expect(res.errors, "并发受限是拥塞、不是源故障，不进顶部红色横幅").toEqual([]);
  });

  /**
   * ③g BUSY 是**明确可重试**的（`retryable: true`）：退避后重试成功，必须走正常路径
   * —— 既不该报并发受限，也不该把已经拿到的技能丢掉。
   */
  it("③g BUSY 退避后重试成功 → 走正常路径拿到技能", async () => {
    const src = uniqueRepoSrc(2); // 独立仓库名：避开模块级树缓存
    let busyFirst = true;
    installFakeTauri((url) => {
      if (busyFirst) {
        busyFirst = false; // 只有第一次被拒，之后一律正常
        throw busyHttpError(); // 必须 throw（见 busyHttpError 的注释）
      }
      if (url.endsWith("/busy-2")) {
        return ok({ default_branch: "main", full_name: "codem-test/busy-2", updated_at: "x" });
      }
      if (/git\/trees/.test(url)) return ok({ sha: "s", tree: [{ path: "skills/pdf/SKILL.md", type: "blob", sha: "x" }] });
      if (/raw\.githubusercontent\.com/.test(url)) return ok(SKILL_MD);
      return { status: 404, body: "", headers: {} };
    });

    const p = listMarketSkills([src]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    expect(res.skills.length, "重试成功 → 必须走正常路径拿到技能").toBe(1);
    expect(res.skills[0].sourceId).toBe(src.id);
    expect(warns().filter((t) => /并发受限/.test(t)), "重试成功了就不该报并发受限").toEqual([]);
    expect(logs().filter((t) => /源可达、返回为空/.test(t)), "更不该说源是空的").toEqual([]);
  });

  /**
   * ③h **闸门过严的根因复核**：这道前端准入闸门的验收点是
   * "**同时在飞的 `http_get` 不超过容量**"（而不是"少发请求"）。
   *
   * 真机的形态是 7 源 × 8 并发 ≈ 56 路一次性提交，把 Rust 侧 12 路闸门打爆。
   * 这条用一个很小的容量（2）把同一个形态压缩到可测规模：8 个请求 → 在飞峰值必须 ≤ 2。
   */
  it("③h 前端准入闸门：在飞的 http_get 不超过容量（真机形态 56 路 → 被压到容量内）", async () => {
    /**
     * ## 为什么要在这里**重载模块**（`vi.resetModules()` + 动态 import）
     *
     * `skill-market-client.ts` 里有**模块级**的仓库树缓存 `repoTreeCache`，
     * 它跨用例存活。前几个用例已经把若干 `owner/repo@branch` 键写进去，
     * 于是本用例即使换仓库名也会命中缓存、**一个请求都不发**
     * （实测：`calls === []`，用例报"测的是单请求路径"）。
     *
     * 用一个全新的模块实例，缓存自然是空的 —— 这样这条闸门用例的判定
     * 不再依赖"前面用例碰巧没污染缓存"，也不再依赖用例顺序。
     */
    vi.resetModules();
    const fresh = await import("../core/skill/skill-market-client");
    fresh.__resetHttpGateForTests();

    const src: MarketSource = {
      id: "gate-probe",
      name: "Gate Probe",
      type: "github-repo",
      url: "https://api.github.com/repos/codem-test/gate",
      enabled: true,
    };

    let inFlight = 0;
    let maxInFlight = 0;
    let fanOutStarted = false; // 只有进入"扇出阶段"才开始记峰值
    const calls = installFakeTauri(async (url) => {
      // **测量口径**：一个源的前两步（repo 信息 + Trees API）各只有 1 个请求，
      // 真正的扇出在第三步（N 个 SKILL.md 并发取）。若从第一个请求就开始记，
      // 测到的永远是 1 —— 真机上就是这么写的，第一版断言因此假红。
      if (/git\/trees/.test(url) || /\/gate$/.test(url)) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (/git\/trees/.test(url)) {
          return ok({
            sha: "s",
            tree: [...Array(8).keys()].map((i) => ({ path: `skills/s${i}/SKILL.md`, type: "blob", sha: `x${i}` })),
          });
        }
        return ok({ default_branch: "main", full_name: "codem-test/gate", updated_at: "x" });
      }
      // 扇出阶段：8 个 SKILL.md 请求，全部记账
      fanOutStarted = true;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok(SKILL_MD);
    });
    fresh.__setHttpGateLimitForTests(2);

    const p = fresh.listMarketSkills([src]);
    await vi.advanceTimersByTimeAsync(60_000);
    await p;

    expect(fanOutStarted, `必须真的走到扇出阶段，否则本用例测的是单请求路径。实际请求：${JSON.stringify(calls)}`).toBe(true);
    expect(maxInFlight, "同时在飞不得超过闸门容量（超量提交正是 BUSY 的根因）").toBeLessThanOrEqual(2);
    expect(maxInFlight, "容量为 2 时应当真的用满 2 路（否则闸门把并发压得过死）").toBe(2);
  });

  // ==========================================================================
  // 「源可达、返回为空」这句**只允许在真·空结果时出现**
  //
  // 真机先后抓到**同一类假话走了两条分支**（BUSY 一次、403 限流一次）。
  // 这几条用例把三条失败分支与"真·空结果"分别钉死 ——
  // 特别是**必须保留真·空结果那句**，否则修法本身就变成了另一种失真。
  // ==========================================================================

  /**
   * ③i **403 限流**（真机 1.16.112 重建版抓到的那条）：
   * 配额耗尽的源绝不许说自己"源可达、返回为空"。
   */
  it("③i 403 限流 → 绝不打「源可达、返回为空」（真机重建版抓到的假话）", async () => {
    installFakeTauri(() => rateLimited403());
    const src = uniqueRepoSrc(11); // 独立仓库名：避开模块级树缓存

    const p = listMarketSkills([src]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    expect(emptyClaims(), "配额已耗尽却报「源可达、返回为空」——这就是那条假话").toEqual([]);
    // 真话必须仍然可见（说清是配额、并且给出可操作建议）
    expect(logs().filter((t) => /配额/.test(t)).length, "限流必须有它自己的真话").toBe(1);
    expect(warns().filter((t) => /Failed to fetch repo info/.test(t)).length, "失败本身也要可见").toBe(1);
    expect(res.skills).toEqual([]);
  });

  /**
   * ③j **非限流的非 200**（403 权限 / 404 / 5xx）：同样不许说"源可达、返回为空"。
   * 这条与 ③i 分开，是因为它走的是另一条判据（`!limited` 分支）。
   */
  it("③j 非限流的 403 → 也不许打「源可达、返回为空」", async () => {
    installFakeTauri(() => forbidden403());
    const src = uniqueRepoSrc(12);

    const p = listMarketSkills([src]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    expect(emptyClaims(), "403（非限流）同样没能拿到结果，不能说源可达").toEqual([]);
    expect(warns().filter((t) => /Failed to fetch repo info/.test(t)).length).toBe(1);
    expect(res.skills).toEqual([]);
  });

  /**
   * ③k **源抛错**（异常路径）：不许说"源可达、返回为空"。
   */
  it("③k 源抛错 → 不许打「源可达、返回为空」", async () => {
    installFakeTauri(() => {
      throw new Error("boom: 网络层直接炸了"); // 非 JSON 信封 → 普通失败
    });
    const src = uniqueRepoSrc(13);

    const p = listMarketSkills([src]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    expect(emptyClaims(), "取数抛错不能说源可达").toEqual([]);
    expect(errSpy.mock.calls.map((c: any[]) => String(c[0])).some((t: string) => /Error fetching repo skills/.test(t)), "失败必须可见").toBe(true);
    expect(res.skills).toEqual([]);
  });

  /**
   * ③l **真·空结果必须保留那句话**（反向守卫）。
   *
   * 这条是**防"把修法做成另一种失真"**：如果为了消掉假话就把
   * 「源可达、返回为空」整句删掉/永久静音，那么"源真的空"也会变得不可见，
   * 用户会以为是我们没测出来。所以真·空结果**必须**仍然能读到这句。
   *
   * 场景：仓库可访问、Trees API 正常返回，但树里**一个 SKILL.md 都没有**。
   */
  it("③l 真·空结果（访问成功且列表确为空）→ 必须保留「源可达、返回为空」", async () => {
    installFakeTauri((url) => {
      if (url.endsWith("/empty-14")) return ok({ default_branch: "main", full_name: "codem-test/empty-14", updated_at: "x" });
      if (/git\/trees/.test(url)) return ok({ sha: "s", tree: [] }); // 树是空的 → 真的没有技能
      return { status: 404, body: "", headers: {} };
    });
    const src: MarketSource = {
      id: "empty-probe-14",
      name: "Empty Probe 14",
      type: "github-repo",
      url: "https://api.github.com/repos/codem-test/empty-14",
      enabled: true,
    };

    const p = listMarketSkills([src]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    expect(emptyClaims().length, "源真的可达且为空 —— 这句话是**真话**，必须保留（不许把修法做成永久静音）").toBe(1);
    expect(res.skills, "空结果仍是成功（degraded=false），不算降级").toEqual([]);
    expect(res.errors).toEqual([]);
  });

  /**
   * ③m **失败之后仍然不许说假话**：同一轮里失败过的源，即使随后拿到空数组，
   * 也一律不再走"源可达、返回为空"（这正是"先查账再决定文案"的核心）。
   */
  it("③m 同一轮内三类失败各自的真话都能读到，且都不落进「源可达、返回为空」", async () => {
    installFakeTauri((url) => {
      if (/busy-15/.test(url)) throwBusy(); // ① BUSY
      if (/rate-16/.test(url)) return rateLimited403(); // ② 403 限流
      return forbidden403(); // ③ 其它非 200
    });
    const busySrc: MarketSource = { id: "d-busy", name: "D Busy", type: "github-repo", url: "https://api.github.com/repos/codem-test/busy-15", enabled: true };
    const rateSrc: MarketSource = { id: "d-rate", name: "D Rate", type: "github-repo", url: "https://api.github.com/repos/codem-test/rate-16", enabled: true };
    const otherSrc: MarketSource = { id: "d-other", name: "D Other", type: "github-repo", url: "https://api.github.com/repos/codem-test/other-17", enabled: true };

    const p = listMarketSkills([busySrc, rateSrc, otherSrc]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    expect(emptyClaims(), "三类失败都不得落进「源可达、返回为空」").toEqual([]);
    expect(warns().filter((t) => /并发受限/.test(t)).length, "① 并发受限一条").toBe(1);
    expect(logs().filter((t) => /配额/.test(t)).length, "② 配额受限一条").toBe(1);
    expect(warns().filter((t) => /Failed to fetch repo info/.test(t)).length, "③ 普通失败两条（限流那条也走这里）").toBe(2);
    expect(res.skills).toEqual([]);
  });

  /**
   * ③n **冷却早退分支**（第 4 条假话分支，真机 1.16.113 复量 R4/R5 抓到）。
   *
   * ## 形态（这条必须是**两个源**，一个源测不出来）
   *
   * 未认证配额按 IP 计，多个 github-* 源共用同一份 60 次/小时；
   * 源 A 撞光配额后，源 B 的每个仓库都在 `githubRateLimitCoolingDown()` 里被 `skipped++`，
   * **一个请求都没发** —— 改动前这一笔不记账，于是 B 照旧打出
   * `Source "B" 本次没有可展示的技能（源可达、返回为空）`。
   *
   * ## 为什么用 `setTimeout` 把 B 的搜索请求押后（而不是靠 map 顺序）
   *
   * `listMarketSkills` 是 `activeSources.map(...)` 并发起的：谁先跑到"取仓库树"这一步
   * 取决于微任务交错。这里给 B 的第一步（search 请求）挂一个 20ms 的假定时器，
   * A 的整条路径（全是同步返回的假 http_get）会在推进假时间的那一刻之前跑完，
   * 于是"A 先撞限流、B 再进冷却"这个顺序是**确定的**，不是碰运气。
   */
  it("③n 同一轮里 A 撞限流后 B 整源被冷却跳过 → B 不许说自己「源可达、返回为空」", async () => {
    const searchOf = (q: string) =>
      ok({ items: [...Array(3).keys()].map((i) => ({ full_name: `o/${q}${i}`, name: `${q}${i}`, default_branch: "main" })) });

    installFakeTauri(async (url) => {
      if (/search\/repositories/.test(url)) {
        if (/q=B/.test(url)) {
          // B 的第一步押后，保证 A 先撞光配额（顺序确定，见用例注释）
          await new Promise((r) => setTimeout(r, 20));
          return searchOf("b");
        }
        return searchOf("a");
      }
      if (/git\/trees/.test(url)) return rateLimited403(); // A 的第一次树请求就撞光配额
      return { status: 404, body: "", headers: {} };
    });

    const srcA: MarketSource = { id: "cool-a", name: "Cool A", type: "github-search", url: "https://api.github.com/search/repositories?q=A", enabled: true };
    const srcB: MarketSource = { id: "cool-b", name: "Cool B", type: "github-search", url: "https://api.github.com/search/repositories?q=B", enabled: true };

    const p = listMarketSkills([srcA, srcB]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    // 前提：B 确实**一个 GitHub 请求都没发**（否则本用例测的不是冷却早退那条分支）
    expect(
      logs().filter((t) => /GitHub 搜索源 "Cool B"：0 个仓库完成/.test(t)).length,
      "B 必须是被整源跳过的形态（0 个完成），否则本用例测了个空",
    ).toBe(1);

    expect(emptyClaims(), "B 一个请求都没发，绝不能说「源可达、返回为空」（第 4 条假话分支）").toEqual([]);
    // 每个源都要有**自己的**真话：A 亲眼看的是 403，B 是被共享配额冷却跳过，两者都点名到源
    expect(logs().filter((t) => /源 "cool-a" 依赖的 GitHub API/.test(t)).length, "A 要有一条").toBe(1);
    expect(logs().filter((t) => /源 "cool-b" 依赖的 GitHub API/.test(t)).length, "B 也必须有一条（不许静默）").toBe(1);
    expect(res.skills).toEqual([]);
  });

  it("③b 一个源降级、另一个源成功 → 结果里只留成功的那个源", async () => {
    installFakeTauri((url) => {
      if (/\/repos\/anthropics\/skills$/.test(url)) return ok({ default_branch: "main", full_name: "anthropics/skills", updated_at: "x" });
      if (/git\/trees/.test(url)) return ok({ sha: "s", tree: [{ path: "skills/pdf/SKILL.md", type: "blob", sha: "x" }] });
      if (/raw\.githubusercontent\.com/.test(url)) return ok(SKILL_MD);
      return { status: 404, body: "", headers: {} };
    });
    const p = listMarketSkills([repoSrc, cliSrc]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;

    const sourceIds = [...new Set(res.skills.map((s) => s.sourceId))];
    expect(sourceIds, "只允许成功的源出现在结果里").toEqual([repoSrc.id]);
    expect(res.errors, "超时降级不报红").toEqual([]);
  });

  /**
   * ③c 不测"源抛错 → errors"这条分支，如实说明原因（避免造一个假证据）：
   * 现有一批取数函数（`fetchGitHubRepoSkills` / `fetchGitHubSearchSkills` / `fetchClawHubSkills` …）
   * **内部各自 try/catch**，异常被就地吞掉、返回空数组 + 一条 console 输出，
   * 因此"源真的把异常抛到 `listMarketSkills`"在现状下拿不到（不是靠测试造不出来，是代码里不可达）。
   * 那个分支只是防御性收口：真出现时进 `errors`（界面顶部红色横幅），而不是被静默。
   */
  it("⑤ 现有取数函数的异常都是内部消化 → 表现为空结果，不会被误升级成 errors", async () => {
    const boom = installFakeTauri((url) => {
      throw new Error(`boom ${url}`); // http_get 本身拒绝
    });
    const p = listMarketSkills([searchSrc]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;
    expect(boom.length, "确实发过请求").toBeGreaterThan(0);
    expect(res.skills).toEqual([]);
    expect(res.errors, "内部消化的异常不该升级成界面报红").toEqual([]);
    // 但绝不允许静默：源自己打了一条 console.error
    expect(errSpy.mock.calls.map((c: any[]) => String(c[0])).some((t: string) => /Error fetching search skills/.test(t)), "异常必须有日志").toBe(true);
  });

  it("④ 在线搜索路径同样收口（无裸定时器；成功时无告警）", async () => {
    installFakeTauri((url) => {
      if (/\/repos\/anthropics\/skills$/.test(url)) return ok({ default_branch: "main", full_name: "anthropics/skills", updated_at: "x" });
      if (/git\/trees/.test(url)) return ok({ sha: "s", tree: [{ path: "skills/pdf/SKILL.md", type: "blob", sha: "x" }] });
      if (/raw\.githubusercontent\.com/.test(url)) return ok(SKILL_MD);
      return { status: 404, body: "", headers: {} };
    });
    const p = searchMarketSkillsOnline("pdf", [repoSrc]);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;
    expect(res.skills.length).toBe(1);
    expect(warns().filter((t) => /timed out|仍未取完/.test(t))).toEqual([]);
  });
});

// ============================================================================
// `[PluginManager] Disabled …` ：警示不许断言没有证据的事（第 63 轮）
//
// 真机读数（改动前）：冷启动 20s 内不出现这条日志；`@codem/ui-game` 在镜像与 DB 里
// 都是 disabled；而整个启动期日志里**没有一行** `Loaded provider: ui-game`
// ——`App.tsx:154` 明确不调用 `loader.load()`，所以它本次进程里根本没被装载。
// 旧文案却写死"代码/服务仍在本次进程内运行"（对那些从未装载的插件就是假话）。
// 下面三个用例把三态各自钉住：卸载成功 / 装载过但无句柄 / 从未装载。
// ============================================================================

describe("PluginManager 禁用日志三态（不许撒没有证据的谎）", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    };
    (globalThis as any).window = { dispatchEvent: () => {} };
    warnSpy = vi.spyOn(console, "warn");
    logSpy = vi.spyOn(console, "log");
  });

  const build = async (ctxPlugin: any) => {
    const { PluginDependencyGraph } = await import("../core/plugin-loader/dependency-graph");
    const { PluginManagerService } = await import("../core/plugin-loader/plugin-manager-service");
    const graph = new PluginDependencyGraph();
    graph.register({ name: "@codem/ui-game", provides: ["uiGame"], inject: [], core: false });
    const mgr = new PluginManagerService({ plugin: ctxPlugin } as never, graph);
    // 每次 enable 都让 ctx.plugin 返回一个"已装载"的 fiber
    mgr.registerPluginLoader("@codem/ui-game", () => () => {});
    return mgr;
  };

  it("P0 三态文案口径：纯函数 reportDisableOutcome（不靠读源码字符串防回归）", async () => {
    const { reportDisableOutcome } = await import("../core/plugin-loader/plugin-manager-service");

    // ① 卸载成功 → info，且不许出现任何"没有句柄/仍在运行"的说法
    reportDisableOutcome("@codem/x", { unloaded: true, everLoaded: true });
    expect(logs().filter((t) => /Disabled \(unloaded\)/.test(t)).length).toBe(1);
    expect(warns().filter((t) => /Disabled/.test(t))).toEqual([]);

    // ② 装载过但没句柄（真·假禁用）→ warning，说清"没有句柄 + 要重启"
    reportDisableOutcome("@codem/x", { unloaded: false, everLoaded: true });
    const w = warns().filter((t) => /Disabled/.test(t));
    expect(w.length, "这才是真问题，必须可见").toBe(1);
    expect(w[0]).toMatch(/没有找到可卸载的实例/);
    expect(w[0]).toMatch(/没有可用的卸载句柄/);
    expect(w[0]).toMatch(/重启/);

    // ③ 本次进程从未装载 → info，**不许**再说"仍在本次进程内运行"
    reportDisableOutcome("@codem/x", { unloaded: false, everLoaded: false });
    const neverLoaded = logs().filter((t) => /Disabled \(never-loaded\)/.test(t));
    expect(neverLoaded.length).toBe(1);
    expect(neverLoaded[0]).toMatch(/从未装载/);
    expect(neverLoaded[0], "不许断言没有证据的事").not.toMatch(/仍在本次进程内运行/);
    expect(warns().filter((t) => /Disabled/.test(t)).length, "第三态不该再增加 warning").toBe(1);
  });

  it("P1 真实走一条 disable：从未装载的插件（@codem/ui-game 的真机形态）→ 不报 warning，但仍留日志", async () => {
    // 关键判据：App.tsx:154 明确不调用 loader.load()，builtin 插件的 fiber 从来不存在
    const mgr = await build(() => { throw new Error("不该被调用"); });
    const res = await mgr.disable("@codem/ui-game");
    expect(res.success).toBe(true);
    const warnings = warns().filter((t) => /\[PluginManager\] Disabled/.test(t));
    expect(warnings, "没有证据说它还在跑，就不该报 warning").toEqual([]);
    const info = logs().filter((t) => /\[PluginManager\] Disabled/.test(t));
    expect(info.length, "但必须留下一条可见日志（不静默）").toBe(1);
    expect(info[0]).toMatch(/never-loaded/);
    expect(info[0]).toMatch(/从未装载/);
    expect(info[0], "不许再说「仍在本次进程内运行」").not.toMatch(/仍在本次进程内运行/);
  });

  it("P3 真装载且能卸载 → info(unloaded) + 真的 dispose，没有任何 warning", async () => {
    const dispose = vi.fn(async () => {});
    // ctx.plugin 返回带 dispose 的 fiber，并让 manager 记录它（enable 路径）
    const mgr = await build(vi.fn(() => ({ dispose, name: "@codem/ui-game" })));
    await mgr.enable("@codem/ui-game");
    const res = await mgr.disable("@codem/ui-game");
    expect(res.success).toBe(true);
    // 注意：disable() 的返回值里**没有** unloaded 字段（它只回 success/disabledList/needsConfirmation），
    // 所以"是否真卸载"只能靠这两条硬证据来判：dispose 真被调用 + 日志说的是 unloaded。
    expect(dispose, "必须真的 dispose").toHaveBeenCalled();
    expect(warns().filter((t) => /\[PluginManager\] Disabled/.test(t))).toEqual([]);
    expect(logs().filter((t) => /\[PluginManager\] Disabled \(unloaded\)/.test(t)).length).toBe(1);
  });
});
