/**
 * `STALLW`（第 309 波）：**"停住"要交出控制权、而不是等外面把它判完** ✓
 *
 * ## 守的缺陷（`§13.226` 交叉表给的硬证据 ✓）
 *
 * `1.16.287` 正式读数 ✓：
 * ```
 * 结局 × 结束形态
 *               settled  stalled  unknown
 *   passed            5        6        0
 *   failed            0       13        0
 * ⇒ 失败的轮次里：被掐停 13 条 / 走到收尾段 0 条
 * ```
 * ★ **13 条失败轮，没有一条走到过收尾段** ✗ —— 一条都没有 ✓。
 *
 * ## 机制（`§13.227` ✓）
 *
 * `executor.ts:401` 的消费循环**只有一道闸门** ✓：
 * ```ts
 * for await (const event of engine.process(...)) {
 *   if (abort.signal.aborted) break;   // ← 唯一的跳出点
 * }
 * ```
 * 而 `abort` 由 `idleWatchdog(abort.signal, idleMs=5min, …)` 触发 ✓
 * ⇒ ★ **闸门要 5 分钟才开** ✗、而跑批 **2 分钟**就放弃 ✓
 * ⇒ **`break` 永远来不及** ✗ ⇒ 收尾段跑不到 ✓ ⇒ 守卫开不了火 ✓。
 *
 * ## 判据
 *
 * | # | 判据 |
 * |---|---|
 * | `STALLW-1` | 连续无事件达 `stallMs` ⇒ 循环**跳出** ✓，且**不**把中断信号置为已中止 ✓ |
 * | `STALLW-2`（反向 ✓） | 事件持续到来时**不许**跳出 ✗（不许把"还在干活"误杀 ✗） |
 * | `STALLW-3` | 跳出之后**收尾段必须真的执行** ✓（这是本条的全部意义 ✓） |
 * | `STALLW-4` | 原因口径里 `stalled` 与 `idle`/`budget`/`tool_hung`/`cancel` **可分** ✓ |
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const EXEC = readFileSync(join(ROOT, "src/core/session/executor.ts"), "utf8");

/**
 * 取"消费循环起点之后的一大段" ✓。
 *
 * ⚠️ **不要按花括号配平取循环体** ✗ —— 第一版就是这么写的 ✓ 而它**跑偏了** ✓：
 * 循环体里有**字符串里的花括号**（如 `"action":"allow" } as any` ✓）⇒ 配平提前结束 ✓
 * ⇒ 拿到的是循环开头那一小段 ✓ ⇒ `STALLW-1` **假红** ✓。
 * ⇒ 判据要钉的是"**这套代码存在**" ✓，不是"它在第几个字节" ✗ ——
 * 按后者写就会像这样被无关细节打红 ✓（与 §13.4「切片边界就是判据的一半」同源 ✓）。
 */
function consumerLoopBody(): string {
  const start = EXEC.indexOf("for await (const event of engine.process(");
  expect(start, "消费循环必须存在").toBeGreaterThan(0);
  return EXEC.slice(start, start + 12_000);
}

describe("STALLW：停住时要交出控制权（让收尾段跑）", () => {
  it("STALLW-1: 存在一条**短于 idleMs** 的停顿判据，且它 break 而不是 abort", () => {
    /**
     * ⚠️ 名字**必须来自实现** ✓（§EXIT-4 那条教训 ✓）——
     * 所以这里只断言"存在一个 stall 语义的标志被 break 用到" ✓，
     * 具体常量名由实现决定 ✓、判据按**形状**钉 ✓。
     */
    const loop = consumerLoopBody();
    expect(loop, "循环里必须有**停顿**判据（短尺子）").toMatch(/stall/i);
    expect(loop, "停顿时必须 break（交出控制权），而不是只 abort").toMatch(/break/);
    /** 反向：不许把 stall 做成"直接 abort 掉" ✗（那就退回现状了 ✓、收尾段照样跑不到 ✓） */
    const src = EXEC;
    expect(
      /stallMs|STALL/i.test(src),
      "必须有一个『停顿窗口』常量/字段（与 idleMs 分开）—— 共用 idleMs 就等于没改",
    ).toBe(true);
  });

  it("STALLW-2（反向）: 停顿窗口必须**短于**空闲窗口（否则退回现状）", () => {
    /**
     * 这是本条最容易写错、也最容易"看起来改了"的地方 ✗：
     * 把 `stallMs` 取成与 `idleMs` **相等** ⇒ 代码里多了个名字 ✓ 而行为**一模一样** ✗。
     *
     * ⚠️ ⚠️ **第一版判据是假绿的，留证** ✓：我原来只断言
     * "表达式里出现了数字" ✓（`/[0-9]/` ✓）——
     * 而变异 `stallMs: 5 * 60 * 1000` ✗ **照样通过** ✓（它当然有数字 ✓）。
     * ⇒ **那次变异没被咬住** ✓ —— 而**变异没咬住 = 判据没在钉这件事** ✗
     * （本仓库那条纪律：**判据绿 ≠ 它到位** ✓）。
     * ⇒ 正解 ✓：**把两个数都算出来、直接比大小** ✓（不是检查"长什么样"✗）。
     */
    const evalConst = (src: string, key: string): number | null => {
      const m = src.match(new RegExp(`${key}:\\s*([0-9_\\s*+/().]+),`));
      if (!m) return null;
      try {
        // 只允许纯算术字面量（数字/运算符 ✓）—— 这是**测试本地**的求值 ✓，不 eval 任意代码 ✓
        const expr = String(m[1]).replace(/_/g, "");
        if (!/^[0-9\s*+/().]+$/.test(expr)) return null;
        // eslint-disable-next-line no-new-func
        return Number(new Function(`return (${expr});`)());
      } catch {
        return null;
      }
    };
    const TYPES = readFileSync(join(ROOT, "src/core/session/types.ts"), "utf8");
    const idleMs = evalConst(TYPES, "turnIdleMs");
    const stallMs = evalConst(TYPES, "stallMs");
    expect(idleMs, "必须能从配置默认值里读出 turnIdleMs").not.toBeNull();
    expect(stallMs, "必须能从配置默认值里读出 stallMs（不能悄悄复用 idleMs）").not.toBeNull();
    expect(
      Number(stallMs) < Number(idleMs),
      `★ 停顿窗口（${stallMs}ms）必须**严格短于**空闲窗口（${idleMs}ms）—— ` +
        `取成相等就等于没改（判据 STALLW-1 想钉的就是这件事，而它第一版没钉住）`,
    ).toBe(true);
  });

  it("STALLW-3: 跳出之后收尾段仍在其后（判据用它确认'控制权交出来了'）", () => {
    const loopStart = EXEC.indexOf("for await (const event of engine.process(");
    /**
     * ⚠️ 窗口要**够大** ✓：收尾段（`settleEmptyAssistant` ✓、`turn_end` ✓、完成守卫 ✓）
     * 离循环起点很远 ✓。第一版只取 4000 字 ⇒ **假红** ✓（同一个错法 ✓）。
     * ⇒ 判据只问"**它在循环之后**" ✓，不问"隔多远" ✗。
     */
    const after = EXEC.slice(loopStart + 2000);
    const hasTail = /settleEmptyAssistant|shouldNudge|completionNudge|turn_end/.test(after);
    expect(hasTail, "收尾段必须在循环之后（否则 break 也救不了）").toBe(true);
  });

  it("STALLW-4: `stalled` 与既有的四个中止原因**可分**（不许混名）", () => {
    const afterLoop = EXEC.slice(EXEC.indexOf("for await (const event of engine.process("));
    /**
     * 既有四个 ✓（`END-3` 钉过 ✓）：`idle` / `budget` / `tool_hung` / `cancel` ✓。
     * ⇒ 新增的停顿原因**不许**复用其中任何一个 ✗ —— 混名就等于没量 ✓。
     */
    for (const name of ["idle", "budget", "tool_hung", "cancel"]) {
      expect(afterLoop, `既有原因 \`${name}\` 必须保留`).toContain(name);
    }
    expect(afterLoop, "必须有一个**区别于** idle 的停顿原因名").toMatch(/stall/i);
  });

  it("STALLW-5: 停顿定时器必须**在回合结束时清掉**（否则结束后开火、日志骗人）", () => {
    /**
     * ## 自查发现的泄漏（留证 ✓）
     *
     * `stallTimer` 虽然 `unref()` 过 ✓（不会把进程钉住 ✓），
     * 但**回合结束后照样会开火** ✗：那时它 `stallController.abort()` ✓
     * 并打一条"交出控制权"的日志 ✓ —— 而**那一轮早就结束了** ✓
     * ⇒ ★ 日志**骗人** ✓（"看起来停了、其实已经完事"✗）、`stalledOut` 被污染 ✗。
     * ⇒ 与既有的 `watchdog.dispose()` / `clearToolFlight()` **同一处置** ✓。
     */
    const finallyIdx = EXEC.lastIndexOf("} finally {");
    expect(finallyIdx, "必须有 `finally` 清理块（既有的看门狗/工具定时器就在里面）").toBeGreaterThan(0);
    const tail = EXEC.slice(finallyIdx, finallyIdx + 900);
    expect(tail, "`finally` 里必须清停顿定时器（与 watchdog.dispose 同一处置）").toMatch(/clearStallTimer\(\)/);
  });

  /**
   * ## `FLIGHT-1..4`（第 309 波 ✓）：**"工具在飞"不能是一条没有上限的免死金牌** ✗→✓
   *
   * ## 守的缺陷（真机取证 ✓，归档 §13.234）
   *
   * 第 2 轮发出**两个** bash，而控制台里 `Tool executed` **只有 1 条**：
   * ```
   * Single-response dedup: 2 tool calls:
   *   [bash("cd …; ls; echo …; cat package.json"),
   *    bash("cd …; npx vitest run src/test/dsh-d10-write-not-execu…")]  ← ★ 从未出现
   * ```
   * 而 `toolsInFlight` **只在收到完成事件时才 `--`** ⇒
   * ★ **"工具开始了、完成事件永不回来" ⇒ 它永远 `> 0`** ⇒
   * **两道看门狗一起失效**（`turnIdleMs` 被 `pulse()` 续命 + `stallMs` 旧版**无条件**重新排队）
   * ⇒ 只剩 `toolFlightMs`（**20 分钟**）⇒ 回合被外人结束 ⇒ **收尾段一行都没执行**。
   */
  it("FLIGHT-1: 工具在飞时**也**要有停顿上限，且它**严格小于** toolFlightMs", () => {
    const EXEC2 = readFileSync(join(ROOT, "src/core/session/executor.ts"), "utf8");
    expect(EXEC2, "必须有 `flightStallMs`（工具在飞的等待上限）").toMatch(/flightStallMs/);
    /** ★ 判据钉**数值关系**（不是"有没有这个名字"）—— 与 STALLW-2 同一条教训 */
    const TYPES2 = readFileSync(join(ROOT, "src/core/session/types.ts"), "utf8");
    const evalConst = (src: string, key: string): number | null => {
      const m = src.match(new RegExp(`${key}:\\s*([0-9_\\s*+/().]+),`));
      if (!m) return null;
      const expr = String(m[1]).replace(/_/g, "");
      if (!/^[0-9\s*+/().]+$/.test(expr)) return null;
      // eslint-disable-next-line no-new-func
      return Number(new Function(`return (${expr});`)());
    };
    const flight = evalConst(TYPES2, "flightStallMs");
    const toolFlight = evalConst(TYPES2, "toolFlightMs");
    expect(toolFlight, "必须能读出 toolFlightMs").not.toBeNull();
    expect(flight, "必须能读出 flightStallMs").not.toBeNull();
    expect(
      Number(flight) < Number(toolFlight),
      `★ 工具在飞的等待上限（${flight}ms）必须**严格小于**挂死上限（${toolFlight}ms）—— ` +
        `相等就等于"延期没有尽头"（那正是本缺陷）`,
    ).toBe(true);
  });

  it("FLIGHT-2（反向）: 工具在飞的等待上限必须**显著大于**正常工具时长（不许误杀合法长工具）", () => {
    const TYPES2 = readFileSync(join(ROOT, "src/core/session/types.ts"), "utf8");
    const m = TYPES2.match(/flightStallMs:\s*([0-9_\s*+/().]+),/);
    const expr = String(m?.[1] ?? "").replace(/_/g, "");
    // eslint-disable-next-line no-new-func
    const ms = /^[0-9\s*+/().]+$/.test(expr) ? Number(new Function(`return (${expr});`)()) : 0;
    /**
     * 真机跑一条 vitest 判据要 20~60 秒 —— 那是一台**合法**的工具 ✓。
     * ⇒ 上限若低于 2 分钟，就会**误杀**它 ✗（而那正是 §13.224 第一节警告过的形态 ✓）。
     * ⇒ 这里钉一个**可辩护的下界**（2 分钟 ✓），而不是一个"刚好让判据过"的值 ✗。
     */
    expect(ms, `工具在飞上限 ${ms}ms 太小 ⇒ 会误杀正常的长工具（真机单跑判据 20~60 秒）`).toBeGreaterThanOrEqual(120_000);
  });

  it("FLIGHT-3/4: 触发时**交出控制权**（break ✓、不 abort ✓），且重置累计等待", () => {
    const EXEC2 = readFileSync(join(ROOT, "src/core/session/executor.ts"), "utf8");
    /** 累计等待必须有变量、且在有事件时清零 ✓（否则"延期"会一直累加、永不重置 ✗） */
    expect(EXEC2, "必须有 `flightWaitedMs`（累计等待）").toMatch(/flightWaitedMs/);
    /**
     * ⚠️ ⚠️ **第一版这条是假绿的，留证** ✗（与 `STALLW-2` 那次同一形态 ✓）：
     * 我原来写 `/flightWaitedMs\s*=\s*0/` ✓ —— 而变异把那一行**换成注释**
     * `// MUT-FLIGHT-B` ✗ 时，**注释上方我自己的说明文字里就写着 `flightWaitedMs = 0`** ✓
     * ⇒ 正则**照样匹配** ✓ ⇒ **变异没被咬住** ✗。
     * ⇒ 正解 ✓：**先把注释剥掉、再断言** ✓（与 `HB-2`/`EXIT-3` 同一条教训 ✓：
     * **注释里引用被禁/被要求的标识是很正常的写法** ✓）。
     */
    const codeOnly = EXEC2
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    /**
     * ⚠️ ⚠️ **第二次也是假绿，留证** ✗（比第一次更隐蔽 ✓）：
     * 收紧之后我用 `/flightWaitedMs\s*=\s*0/` ✓ —— 而**它仍然匹配**
     * ★ **`let flightWaitedMs = 0;`（初始化那一行）** ✗ ⇒ 把**重置**那行删掉也照样绿 ✓。
     * ⇒ 正解 ✓：判据必须钉"**重置**"而不是"**初始化**" ✓ ——
     * 用 `lastIndexOf` 取**最后一次**出现 ✓（初始化在函数中段 ✓、重置在 `noteActivity` 里**更靠后** ✓）。
     * ⇒ ★ 这已经是这条判据**第三次**写错了 ✓（`/[0-9]/` → 没剥注释 → 匹配到初始化 ✓）——
     * 每一次都是**"判据看起来在钉那件事，其实钉的是别的东西"** ✓，同一族错误 ✓。
     */
    /**
     * ⚠️ ⚠️ **第三次也是假绿，留证** ✗（这次错得最隐蔽 ✓）：
     * 我用 `lastIndexOf("flightWaitedMs = 0;")` vs `indexOf("let flightWaitedMs = 0;")` 比大小 ✓ ——
     * 而 ★ **`indexOf` 也会在 `let flightWaitedMs = 0;` **内部**匹配到子串** ✗
     * （它匹配的是 `flightWaitedMs = 0;` 那一段 ✓，**不含前面的 `let `** ✓）
     * ⇒ `init === lastReset`（都指向同一处）✗ ⇒ 删掉真正的重置**照样绿** ✓。
     * ⇒ 正解 ✓：**带负向先行断言**把 `let ` 那一处排掉 ✓ ——
     * `/flightWaitedMs = 0;(?!)/` 不够 ✗，要用**前面**的负向回顾 ✓
     * （JS 支持 `(?<!…)` ✓）。
     * ⇒ ★ 这条判据**连错三次**（`/[0-9]/` → 没剥注释 → 匹配到子串 ✓）——
     * 三次都是"**判据看起来在钉那件事，其实钉的是别的东西**" ✓，同一族 ✓。
     * ⇒ 因此这里**不再用位置比较** ✗，改用**语义精确**的匹配 ✓。
     */
    const resetMatches = codeOnly.match(/(?<!let )flightWaitedMs = 0;/g) ?? [];
    expect(
      resetMatches.length,
      "★ 必须有**独立于 `let` 初始化**的一处清零（`noteActivity` 里那次）—— " +
        "只靠初始化就等于'延期永不重置'（工具一旦在飞就再也回不到 0）",
    ).toBeGreaterThanOrEqual(1);
    /** 处置与 stallMs 一致：走同一个 stallController（⇒ 循环 break ✓，不是 abort ✓） */
    const tail = EXEC2.slice(EXEC2.indexOf("flightStallMs"));
    expect(tail, "触发时必须走 `stallController.abort()`（= 我们的 break 信号 ✓，不是中止回合 ✗）").toMatch(/stallController\.abort\(\)/);
  });
});
