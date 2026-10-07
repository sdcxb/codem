/**
 * `EXIT`（第 309 波）：`run()` 的**每个出口**都必须留下"为什么结束" ✓
 *
 * ## 守的缺陷（`repo-02` 的完整归因链换来的 ✓，见归档 §13.199–§13.201）
 *
 * `repo-02 r3`（`1.16.283`）的判定链已经完全查清 ✓：
 * 1. 它**只跑了 `dsh-d10*`** ✓，从没跑过判据文件 `dsh-d9-multi-edit-partial-failure.test.ts` ✗；
 * 2. `unrun-family` 守卫**本该点名它** ✓ —— 我拿**真实工作区** +
 *    它**真实跑过的那 3 条**喂进 `.preview-shot/_unrun-family-check.mjs` ✓，
 *    `dsh-d9` **确实**在"没跑过"的 38 条清单里 ✓（⇒ 判定是对的 ✓）；
 * 3. 而那一轮的记录是 **`loopStops: 0 条`** ✗ ⇒ **收尾段没走到** ✓。
 *
 * 代码里自己写着为什么 ✗（`agentic-loop.ts:686-693` ✓，`completionNudges` 字段注释）：
 * > 本轮在**到达收尾段之前**就结束的出口（**关键服务不可用 / 成本上限 / 上下文溢出 /
 * > 重复调用守卫 / 写被拒 / 被中止 … 共 10 处** ✓）会带上**上一轮**的提醒 ✗
 * > ⇒ …… 一条**假证据** ✓（而这条证据正是用来判断"守卫有没有拦住"的 ✓，**假证据比没有更糟** ✗）。
 *
 * ⇒ 于是"守卫没拦住"这件事**永远无法归因** ✗：
 * `loopStops: 0` 同时兼容"**判定错**"✗ 与"**那段代码没执行**"✓，而两者修法完全不同 ✗。
 *
 * ## 判据
 *
 * | # | 判据 |
 * |---|---|
 * | `EXIT-1` | `run()` 里**每一个** `return <result>` 之前都必须先 `this.noteExit("<原因>")` ✓ |
 * | `EXIT-2` | 原因名必须是**稳定的机器可读标识**（`snake_case` ✓，不许是中文句子 ✗） |
 * | `EXIT-3` | **反向**：`noteExit` 不许是空实现（必须真的落一条可读到的记录 ✓） |
 * | `EXIT-4` | 至少覆盖到已知的那几个出口（`aborted` / `cost_limit` / `overflow` / `loop_end` ✓） |
 *
 * ⚠️ 这是一条**源码结构**判据 ✓（与 `console-noise.test.ts::LOG-4` / `output-truncation-continue.test.ts::TRUNC-4`
 * 同一类做法 ✓）—— 它的价值在于：**以后任何人往 `run()` 里加出口，都会被它逼着留痕** ✓。
 * 昨天那 10 个出口是历史遗留的 ✗；这条判据保证不会再有第 11 个静默出口 ✓。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SRC = readFileSync(join(ROOT, "src", "core", "llm", "agentic-loop.ts"), "utf8");

/**
 * 抽出 `run()` 里**主循环**那一段（`while (true) {` → 循环结束）✓。
 *
 * ⚠️ 为什么不抽整个 `run()` ✗：它的体里有**十几处小回调**（权限判定 ✓、
 * 路径校验 ✓、计划渲染 ✓ …），那些里面的 `return { allowed: … }` / `return result`
 * **不是回合出口** ✗ —— 第一版按"从 `async *run(` 到下一个顶格 `}`"抽，
 * 结果**抽错了结束花括号** ✓、又把这些回调全算了进来 ✗（报了 13 个假出口 ✓）。
 * 真正的回合出口只有**主循环体里**那几处 ✓ —— 收尾段也在这个循环体里 ✓（这正是问题所在 ✓）。
 */
function mainLoopBody(): string {
  const start = SRC.indexOf("while (true) {");
  expect(start, "抽取器失效：找不到主循环").toBeGreaterThan(-1);
  /** 找循环的结束：从 start 起做**花括号配平** ✓（不依赖缩进/换行 ✓） */
  let depth = 0;
  let i = SRC.indexOf("{", start);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  expect(depth, "抽取器失效：主循环花括号没配平").toBe(0);
  return SRC.slice(start, i + 1);
}

describe("EXIT：run() 的每个出口都必须留下结束原因", () => {
  it("EXIT-1: 每个出口都必须先 noteExit（不许再有静默出口）", () => {
    const body = mainLoopBody();
    /**
     * ⚠️ 判据形态**第 309 波第二版改过** ✗→✓，理由是真机读数换来的 ✓：
     *
     * - 第一版查的是"`return <结果>` 往上 12 行内有没有 `noteExit`"✓ ——
     *   而第二版把 `noteExit` 挪到了 **`finishWithNudges` 之前** ✓
     *   （因为出口原因现在挂在 **`LoopResult.detail`** 上 ✓，
     *    而 `finishWithNudges` 就是**构造 result 的那一刻** ✓ ⇒ 必须先设 ✓）。
     * - ⇒ 老判据会**假红** ✗（`noteExit` 离 `return` 更远了 ✓）。
     *
     * 新版口径更贴近语义 ✓：**每个出口都要么先 `noteExit`、要么带着 `LoopResult` 出去** ✓ ——
     * 也就是"每一个 `return <结果>` 的**上游**必须能找到一次 `noteExit`" ✓（窗口放到 40 行 ✓）。
     */
    const lines = body.split("\n");
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const isResultExit =
        /^\s*return (result|truncResult|errResult|failResult|abortedResult|finalResult);/.test(l) ||
        /^\s*return \{ type: "/.test(l);
      if (!isResultExit) continue;
      const window = lines.slice(Math.max(0, i - 40), i).join("\n");
      if (!/this\.noteExit\(/.test(window)) offenders.push(`第 ${i + 1} 行：${l.trim()}`);
    }
    expect(
      offenders,
      "这些出口没有留痕 —— `loopStops: 0` 会继续同时兼容'判定错'与'没执行'（正是 repo-02 卡住的地方）",
    ).toEqual([]);
  });

  it("EXIT-2: 原因名是稳定的机器可读标识（不是中文句子）", () => {
    const body = mainLoopBody();
    const names = [...body.matchAll(/this\.noteExit\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length, "至少要有一处 noteExit").toBeGreaterThan(0);
    for (const n of names) {
      expect(n, `原因名 \`${n}\` 必须是 snake_case 标识（读记录的那一侧要按它归因）`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("EXIT-3（反向）: 出口原因必须**真的能读到**，且不许走会话事件", () => {
    expect(SRC, "`noteExit` 必须存在").toMatch(/private noteExit\(/);
    /**
     * ⚠️ 切片范围要**盖住两个函数** ✓：`noteExit`（设置 ✓）与 `attachExitReason`（挂载 ✓）——
     * 第一版只切 `noteExit` 那一段 ✗ ⇒ "必须有 `attachExitReason`"这条**假红** ✓
     * （它俩在文件里**不挨着** ✓）。
     *
     * ⚠️ 第 309 波第二次修正 ✗→✓：切片**到下一个函数定义为止** ✓ ——
     * 否则它会把**后面**的函数也吞进来 ✓，于是 `noteHeartbeat` 里**合法**的
     * `recordLoopStop` 会把"不许写事件"那条**误伤成假红** ✗（实测就是这样红的 ✓）。
     */
    const noteStart = SRC.indexOf("private noteExit(");
    const nextFn = SRC.indexOf("private noteHeartbeat(", noteStart);
    const def = SRC.slice(noteStart, nextFn > noteStart ? nextFn : noteStart + 5200);
    /**
     * ★ **必须有读出通道** ✓ —— 但**通道换过一次** ✗→✓，理由是真机读数换来的 ✓：
     *
     * - 第一版要求 `getLastExitReason()`（给 `executor` 直接读 loop 实例 ✓）——
     *   真机装上 `1.16.284` 跑两轮之后，**全库 101 536 条 `session_events` 里 `turn_end` 是 0 条** ✗
     *   （同一次运行的 `loop_stopped` 有 5 条 ✓ ⇒ 事件日志没坏 ✓，是**那条写路径没落地** ✗）。
     * - ⇒ 第二版把原因挂到 **`LoopResult.detail`** ✓（`attachExitReason` ✓），
     *   随**既有的 `end` 事件**出去 ✓ —— 那条通道**已被证明能到达** ✓。
     *
     * ⇒ 判据也要跟着换 ✓（**判据必须盯着"可达的那条通道"** ✗，否则它只是在证明"我写了代码"✓）。
     */
    expect(SRC, "必须有 attachExitReason 这个挂载点（它在 noteExit 之外，所以查全文）").toMatch(
      /private attachExitReason\(/,
    );
    expect(
      SRC,
      "出口原因必须挂到 LoopResult.detail 上（可达通道），且要有稳定的键",
    ).toMatch(/EXIT_REASON_DETAIL_KEY/);
    /**
     * ★ **不许写会话事件** ✓ —— 第一版写了，当场把
     * `dsh-d5-prefix-cache-stability` 打红 ✗（每轮多一条事件 ⇒ 上下文摘要里的
     * `M total events` 变了 ⇒ 第二轮不再以第一轮为前缀 ⇒ 破坏前缀缓存 ✓）。
     * 这条断言是**那次回归的守门人** ✓：谁再把出口原因写成事件，这里就红 ✓。
     *
     * ⚠️ 必须**先剥掉注释**再查 ✗ —— 第一版没剥 ✓，于是 `noteExit` 的说明里
     * 那句"第一版调的是 `recordLoopStop(…)`"自己把判据打红了 ✗（**假红** ✓）。
     * 这也是本仓库里反复出现的一类夹具缺陷 ✓：**注释里引用被禁 API 是很正常的写法** ✓，
     * 按文本断言时必须把注释排除掉 ✓。
     */
    const codeOnly = def
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(
      codeOnly,
      "出口原因**不许**写成会话事件（会改上下文摘要、破坏前缀缓存 —— D5 那次就是这么红的）",
    ).not.toMatch(/recordLoopStop\(|getEventLog\(\)/);
  });

  it("EXIT-4: 已知的关键出口都要有名字", () => {
    const body = mainLoopBody();
    /**
     * ⚠️ 我第一版把名字猜成了 `overflow` / `loop_end` ✗ ⇒ **假红** ✓
     * （实测用的是 `context_overflow` ✓ 与 `completed` ✓）。
     * **判据里写死名字时，名字必须来自实现、不能来自记忆** ✓ ——
     * 否则下一次改名又会造一条假红 ✗（与 `RED-6` 那次"没写覆盖那一行的判据"同源 ✓）。
     */
    for (const must of ["aborted", "cost_limit", "context_overflow", "completed", "repeat_guard"]) {
      expect(body, `出口 \`${must}\` 必须有 noteExit（历史真机上出现过）`).toContain(`this.noteExit("${must}"`);
    }
  });

  /**
   * ## `HB`：**回合心跳**必须在**主循环体里面** ✓（第 309 波 ✓）
   *
   * ## 守的缺陷（真机读数逼出来的 ✓，归档 §13.209）
   *
   * 那一批失败轮（`repo-01 r3` / `repo-04` 的 13、18 轮 ✓）的共同形态是：
   * **引擎静默满 2 分钟** ⇒ 跑批判"跑完" ✓，而应用的 `for await` 消费循环
   * **仍在等下一个事件** ✗ ⇒ `run()` 的收尾段**永远没执行** ✓
   * ⇒ `turn_end` / 出口原因 / 消息定稿**全都没有** ✗。
   *
   * ⇒ ★ **任何写在"循环之后"或"某个出口上"的东西，对这些轮次都到不了** ✗ ——
   * 我为此**白改过两趟通道** ✓（先写 `turn_end` ✗、再改挂 `LoopResult.detail` ✗，
   * 两次都在循环之外 ✓）。**心跳是这类轮次里唯一必然执行到的报点** ✓。
   *
   * 判据本身**按位置**钉 ✓（不是按"函数存在"钉 ✗）——
   * 因为这一波的全部教训就是"**位置不对 ⇒ 写了也白写**" ✓。
   */
  it("HB-1: 回合心跳必须在**主循环体内**调用（位置就是这条判据的全部意义）", () => {
    const body = mainLoopBody();
    expect(body, "心跳必须在主循环体里面 —— 写在循环之外，被掐停的轮次一律到不了").toContain(
      "this.noteHeartbeat(sessionId)",
    );
    /** 反向：循环**之前**的代码里不许出现它 ✓（那是同一个错误的另一种写法 ✗） */
    const loopStart = SRC.indexOf("while (true) {");
    const beforeLoop = SRC.slice(SRC.indexOf("async *run("), loopStart);
    expect(beforeLoop, "心跳不许出现在循环**之前**").not.toContain("this.noteHeartbeat(sessionId)");
  });

  it("HB-2: 心跳走**已被证明会落地**的那条链（`recordLoopStop`），且带 `iteration`", () => {
    const hbStart = SRC.indexOf("private noteHeartbeat(");
    expect(hbStart, "`noteHeartbeat` 必须存在").toBeGreaterThan(0);
    /**
     * ⚠️ 切片**到下一个函数定义为止** ✗→✓ —— 用固定长度（1200 ✓）会把**后面**的函数
     * （`finishWithNudges` ✓，它**本来就要用** `completionNudges` ✓）吞进来 ✓
     * ⇒ "心跳不许碰收尾字段"这条**假红** ✓（HB-3 实测就是这么红的 ✓）。
     * 与 `EXIT-3` 那次是同一条教训 ✓：**按文本断言时，切片边界就是判据的一半** ✓。
     */
    const hbNext = SRC.indexOf("private finishWithNudges(", hbStart);
    const hb = SRC.slice(hbStart, hbNext > hbStart ? hbNext : hbStart + 1200);
    /**
     * ⚠️ 必须把**文档注释里的 `*` 行**也剥掉 ✗ —— 第一版只剥块注释与 `//` ✓，
     * 而 JSDoc 的内层是「星号开头的行」✗ ⇒ **注释里提到 `completionNudges` 也会把判据打红** ✓
     * （HB-3 第一次跑就是这么假红的 ✓）。与 `EXIT-3` 那次同一条教训 ✓：
     * **注释里引用被禁标识是很正常的写法** ✓。
     */
    const codeOnly = hb
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(
      codeOnly,
      "心跳必须走 `recordLoopStop` —— 那是真机上**已被证明会落地**的那条链（真机 236 条 loop_stopped）",
    ).toMatch(/recordLoopStop\(/);
    expect(codeOnly, "载荷必须带 `iteration`（读数侧要据此算'走到第几轮停住'）").toMatch(/iteration:/);
  });

  it("HB-3（反向）: 心跳**不碰**收尾字段（不许造出'假催促证据'）", () => {
    const hbStart = SRC.indexOf("private noteHeartbeat(");
    /**
     * ⚠️ 切片**到下一个函数定义为止** ✗→✓ —— 用固定长度（1200 ✓）会把**后面**的函数
     * （`finishWithNudges` ✓，它**本来就要用** `completionNudges` ✓）吞进来 ✓
     * ⇒ "心跳不许碰收尾字段"这条**假红** ✓（HB-3 实测就是这么红的 ✓）。
     * 与 `EXIT-3` 那次是同一条教训 ✓：**按文本断言时，切片边界就是判据的一半** ✓。
     */
    const hbNext = SRC.indexOf("private finishWithNudges(", hbStart);
    const hb = SRC.slice(hbStart, hbNext > hbStart ? hbNext : hbStart + 1200);
    /**
     * ⚠️ 必须把**文档注释里的 `*` 行**也剥掉 ✗ —— 第一版只剥块注释与 `//` ✓，
     * 而 JSDoc 的内层是「星号开头的行」✗ ⇒ **注释里提到 `completionNudges` 也会把判据打红** ✓
     * （HB-3 第一次跑就是这么假红的 ✓）。与 `EXIT-3` 那次同一条教训 ✓：
     * **注释里引用被禁标识是很正常的写法** ✓。
     */
    const codeOnly = hb
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    /**
     * `completionNudges` 字段的注释里写明：早出口若带上"上一轮的提醒"，
     * 跑批记录里就会出现**假证据** ✗（"这轮明明没催、却记着催过"✓）——
     * 而那条证据正是用来判断"守卫有没有拦住"的 ✓。心跳**每轮都跑** ✓，
     * 一旦碰那两个字段就是**最严重的一种假证据** ✗。
     */
    expect(codeOnly, "心跳不许碰 completionNudges").not.toMatch(/completionNudges/);
    expect(codeOnly, "心跳不许碰 completionNudgeReasons").not.toMatch(/completionNudgeReasons/);
  });
});
