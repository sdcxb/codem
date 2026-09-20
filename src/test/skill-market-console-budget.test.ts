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

import { listMarketSkills, searchMarketSkillsOnline, type MarketSource } from "../core/skill/skill-market-client";

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

let warnSpy: any, logSpy: any, errSpy: any;
const warns = () => warnSpy.mock.calls.map((c: any[]) => String(c[0]));
const logs = () => logSpy.mock.calls.map((c: any[]) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers();
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
