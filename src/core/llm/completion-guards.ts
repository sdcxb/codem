/**
 * 收尾守卫的**纯判定**（第 162 波 ✓）—— 与回路解耦，便于单测与变异 ✓。
 *
 * 目前有两条 ✓：
 * - `shouldNudgeUnverified`：改了文件但**最后一次改动之后没验证** ✓（VU ✓，第 140 波）；
 * - `shouldNudgeZeroOutput`：**一个字节都没改**、而**判据还是红的就收尾** ✓（模式 A ✓，本波新增）。
 */

/**
 * **模式 C：改完又还原** ✓（第 169 波）。
 *
 * ## 真机取证（1.16.268 的收尾段诊断 ✓）
 *
 * ```
 * run-3（failed、diff=0、29 次调用）
 * [agent-loop] 收尾段：进入 modified=true edited=4 lookedAtSource=true tests=8 red=0
 * ```
 *
 * ⇒ 收尾段**走到了** ✓、两把守卫**都正确地沉默** ✓（不属于"零产出"✓；`tests=8 / red=0` ✓
 * 说明该跑的族跑过了 ✓）—— 而它 **`edited=4` 却最终 `diff=0`** ✗。
 *
 * 唯一解释 ✓：**它改了真实文件、跑了 8 条判据（全绿）、然后把改动还原掉了** ✗。
 * 佐证 ✓：这批日志里出现过 `git stash push -- src/core/llm/tools.ts` ✓，
 * 而评测记录的 `selfRestoreCommands` **是空的** ✗（它只认某几种命令形态 ✓）。
 *
 * ## 判据为什么是"**还原之后没有再编辑**"
 *
 * - **还原过** ✓：说明作者一度认为改动该撤 ✓；
 * - **之后再没编辑** ✓：说明它**带着"什么都没留下"的状态收尾** ✗ —— 这是要问的那句话 ✓；
 * - 若之后**又编辑了** ✓ ⇒ 那是正常的"撤销了错的一版、重做一版"✓ ⇒ **不该打扰** ✗。
 *
 * 作用说清 ✓：它消除不了采样方差 ✗，只是把「**看起来全绿、实际什么都没留下**」✗
 * 这种最隐蔽的失败**变得可见** ✓。
 */
export function shouldNudgeRevertedWork(args: {
  /** 会话里出现过"还原型"命令（`git checkout --` / `restore` / `stash` / `reset --hard` ✓） */
  revertedAfterEdit: boolean;
  /** 这条提醒每会话只发一次 ✓ */
  alreadyNudged: boolean;
}): boolean {
  if (args.alreadyNudged) return false;
  return args.revertedAfterEdit;
}

/** 这条命令是不是"**还原型**"（第 169 波 ✓） */
export function looksLikeRevertCommand(command: string): boolean {
  const c = String(command ?? "");
  return (
    /**
     * `git checkout` **带 `--`**（pathspec 分隔符 ✓）才算还原 ✓ ——
     * 两种写法都要认 ✓：`git checkout -- <path>` ✓ 与 `git checkout <path> --` ✓
     * （实测 RV-5 第一版只认前者 ✗，后者漏了 ✓）。
     */
    (/\bgit\s+checkout\b/.test(c) && /--/.test(c)) ||
    /\bgit\s+restore\b/.test(c) ||
    /**
     * ⚠️ `git stash list` 是"**看**"不是"**还原**" ✓ ——
     * 真机日志里它常和还原一起出现 ✗，所以必须先把它排除 ✓。
     */
    /\bgit\s+stash\b(?!\s+(list|show))/.test(c) ||
    /\bgit\s+reset\s+--hard\b/.test(c)
  );
}

/**
 * **模式 A：零产出收工** ✓（第 162 波）。
 *
 * ## 为什么要它（同版本两批对照 ✓）
 *
 * 同一版本（1.16.264）的 repo-02 两批，一批 **3/4** ✓、一批 **0/4** ✗。
 * 分解之后，"把 3/4 打成 0/4"的是这一种 ✗：
 *
 * ```
 * v32 run-3：7 次调用、diff **0**、maxIteration=3、timedOut=false
 *          ⇒ 不是崩溃、不是超时，是模型自己**早早收尾、什么都没改** ✗
 * ```
 *
 * 而**现有两把守卫都正确地沉默了** ✗：
 * - "改了但没验证"：`turnModifiedFiles` 为假 ⇒ 不触发 ✓；
 * - "族判据没跑过"：没动过盘 ⇒ 不触发 ✓。
 *
 * ## 判据为什么是"**没改 + 判据还红着**"（低误报 ✓）
 *
 * - **没改** ✓：一旦改过，这是"未验证/不完整"那两条的辖区 ✓，不该抢 ✗；
 * - **判据红着** ✓：只看"没改"会误伤**只读型任务** ✗（只跑测试、看结论、不改代码 ✓，
 *   测试全绿时它就是做完了 ✓）⇒ 要求"**至少有一条判据是红的**"✓ ——
 *   这是"活没干完"的**硬证据** ✓，不是猜测 ✓。
 *
 * 作用要说清 ✓：它**不能**消除采样方差 ✗（同一提示词，一次 84 次调用、一次 7 次 ✗），
 * 它只能**不让这种失败安静地过去** ✓ —— 而真机数据（v31 的 3/4 ✓）说明"被迫再看一眼"有时就够了 ✓。
 */
export function shouldNudgeZeroOutput(args: {
  /** 本会话有没有动过盘（`sessionModifiedAnything` ✓） */
  modifiedAnything: boolean;
  /** 本会话跑过的判据 → 结果（`testFileStatus` ✓）；**空 = 一次都没跑过** ✓ */
  testStatuses: Iterable<"red" | "green">;
  /**
   * **本会话读过/搜过仓库源码**（第 163 波补 ✓）—— 只用于"连测试都没跑"这一支 ✓。
   *
   * 为什么必须有它 ✗：第一版把"没跑测试"直接当成触发条件 ✗，
   * 结果**把 12 条驱动 AgenticLoop 的既有判据一起打红** ✓
   * （`stall-guard-loop-behavior` / `guidance-carryover` / `output-truncation-behavior` /
   * `o28-assistant-event-wiring` / `cache-loop-accumulation` … ✓）——
   * 那些夹具**既不跑测试也不改文件** ✓，于是我的守卫凭空多要一轮 ⇒ 脚本耗尽 ⇒ 红 ✗。
   *
   * 加上这条之后 ✓：只有"**确实在读源码干活**（读过 `src/` ✓）却没改、也没跑测试就收尾"才提醒 ✓
   * —— 而真机里的"早早收工"轮次**都在读源码** ✓（不读源码根本无从下手 ✓）。
   */
  lookedAtSource: boolean;
  /** 这条提醒每会话只发一次 ✓ */
  alreadyNudged: boolean;
}): boolean {
  if (args.alreadyNudged) return false;
  if (args.modifiedAnything) return false; // 改过了 ⇒ 交给另外两条守卫 ✓
  const statuses = [...args.testStatuses];
  /** ① 判据红着 ⇒ "活没干完"的硬证据 ✓ */
  if (statuses.some((s) => s === "red")) return true;
  /**
   * ② **读过源码 + 一次测试都没跑** ✓（第 163 波补上，并按上面的理由收紧 ✓）。
   *
   * 真机实测的迭代数：通过轮 **47 / 61 / 66** ✓，失败轮 **3 / 17 / 21 / 23 / 24 / 26 / 37** ✗
   * ⇒ "早早收工"是这套指标的主要失败形态 ✓，而它们**常常连测试都没跑** ✓
   * （v31 run-4：23 次、失败 ✗、`loopStops=[]` ✗）。
   */
  if (statuses.length === 0 && args.lookedAtSource) return true;
  /** ③ 其余（全绿 / 没读过源码）⇒ **不打扰** ✓（防误伤 ✓） */
  return false;
}
