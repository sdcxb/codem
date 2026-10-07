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

/**
 * ★ 第 46 波：**还原型命令分两种** ✓ —— 它们的**救法完全不同** ✗，所以文案不能是同一句 ✗。
 *
 * - `"stash"`：改动**还在 `git stash` 里** ✓ ⇒ 救法是 `git stash list` + `git stash pop` ✓；
 * - `"discard"`：改动**已经被丢掉** ✓（`checkout --` / `restore` / `reset --hard` ✓）⇒ 只能**重做** ✓。
 *
 * 为什么必须分开（**真机实测 ✓**）：`1.16.295` 批的 `repo-02` run-2 败 ✗，
 * 控制台里逐字留着 **只有 `git stash push -- src/core/llm/tools.ts`、全轮一次 `git stash pop` 都没有** ✗
 * —— 模型为了做"这条红是不是既有"的基线对比把自己的修复 stash 走了 ✓，之后没恢复 ✓
 * （最终 `diff` 只剩 1083 字符 ✗）。而当时 `reverted` 守卫**开火了** ✓，
 * 文案却是泛泛的"请把它**做回来**"✗ —— **没告诉它改动还在 stash 里** ✗。
 */
export type RevertKind = "stash" | "discard";
/** 这条命令是哪种"还原型"（不是还原 ⇒ `null` ✓） */
export function revertKindOf(command: string): RevertKind | null {
  const c = String(command ?? "");
  /**
   * ⚠️ `git stash list` / `show` 是"**看**"不是"**还原**" ✓（既有口径 ✓，判据 `REV-3` 钉住 ✓）。
   */
  if (/\bgit\s+stash\b(?!\s+(list|show))/.test(c)) return "stash";
  if (
    (/\bgit\s+checkout\b/.test(c) && /--/.test(c)) ||
    /\bgit\s+restore\b/.test(c) ||
    /\bgit\s+reset\s+--hard\b/.test(c)
  ) {
    return "discard";
  }
  return null;
}

/** 这条命令是不是"**还原型**"（第 169 波 ✓） */
export function looksLikeRevertCommand(command: string): boolean {
  return revertKindOf(command) !== null;
}

/**
 * ★ 第 46 波：`reverted` 守卫的**文案构造**（纯函数 ⇒ 可单测 ✓）。
 *
 * 口径：**按类型给"下一步具体做什么"** ✓ —— 而不是同一句泛泛的"把它做回来" ✗。
 * 真机证据见 {@link RevertKind} 的注释 ✓（`git stash push` 后再没 `pop` ✓）。
 *
 * @param kind 这一路见过的还原类型（`null` = 没见过 ⇒ 仍然给通用文案 ✓，不崩 ✗）
 */
export function buildRevertedWorkNudge(kind: RevertKind | null): string {
  const common =
    "[SYSTEM] 这一路你**改动过文件，但后来把改动撤销了**，而且**之后再没有编辑过**（一条事实 ✓）。\n";
  if (kind === "stash") {
    return (
      common +
      "\n★ 你这儿用的是 **`git stash`** 类的命令 —— 如果是拿它做「这条红是不是既有」的基线对比 ✓，" +
      "那你的改动**很可能还在 stash 里** ✗（真机数据里这种形态几乎都是**忘了 `pop`**）：\n" +
      "- 先 `git stash list` 看有没有你的那条 ✓；\n" +
      "- 有 ⇒ `git stash pop` 把它恢复回来，然后重新验证 ✓。\n" +
      "\n（如果是有意放弃这版实现，请**说明理由**：为什么现在的代码是对的、你验证过什么 ✓。）"
    );
  }
  if (kind === "discard") {
    return (
      common +
      "\n★ 你用的是 **`git checkout --` / `restore` / `reset --hard`** 这类**丢弃式**命令 ✓ —— " +
      "改动**不在任何地方**了 ✗ ⇒ 只能**重做**：\n" +
      "- 如果是为了「这条红是不是既有」做的基线对比 ⇒ 对比完**必须把实现做回来**再收尾 ✓；\n" +
      "\n（如果是有意放弃这版实现，请**说明理由**：为什么现在的代码是对的、你验证过什么 ✓。）"
    );
  }
  return (
    common +
    "\n如果是有意放弃这版实现，请**说明理由**（为什么现在的代码是对的、你验证过什么）✓；" +
    "否则请把它**做回来** —— 真机数据里这种形态（改了、测了、又还原，最后盘上什么都没留下）" +
    "几乎总是**收尾时误撤**，而不是「确实不需要改」。"
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

/**
 * ★ 第 46 波：**"红测试收尾提醒"的文案**（纯函数 ⇒ 可单测 ✓）。
 *
 * ## 为什么要把这段抽出来（**真机取证 ✓**）
 *
 * 这段文案里原来有一个**逃生口** ✗：
 * ```
 * ② 如果它们确实不该由你修（例如与本任务无关的既有缺陷），就在回执里**点名**：…
 * ```
 * 而 `1.16.295` 批 `repo-02` run-2 的收尾回执**逐字**写着"…与本次 write-custom 修复无关，
 * 按任务范围我没有动它们"，其中点名了 `dsh-d9-multi-edit-partial-failure`（`multi_edit`
 * 部分失败未判 error ✗）—— 可它与题面（"写文件被拒绝却报成功" = **假成功** ✗）**是同一个病** ✓
 * （任务注释：修题面时"顺手就修" ✓）。结果：整轮 `diff` 只有**一行** ✗（`write` 分支加 `isError: true`），
 * `dsh-d9` 依旧红 ✗。历史上一大批失败轮的 `diffChars` 挤在 **952 / 1036 / 1083** ✗ —— 同一行 ✓。
 *
 * ⇒ 修法：在**模型真正做决定的那一刻**（这条提醒就在收尾前 ✓）把规则写清 ✓ ——
 * **同病不算"无关"** ✓，必须走 ① 修掉 ✓；豁免只留给"确实属于另一套机制/另一个特性" ✓。
 *
 * ⚠️ 措辞刻意保留"② 点名"这条既有出路 ✓（红测试确实可能不该由它修 ✓，见 `PROMPT-ROOT-4` ✓）——
 * 只是把**同病**从豁免里摘出去 ✓。
 */
export function buildRedTestNudgeText(args: {
  failedCount: number;
  /** 形如 `（a.test.ts, b.test.ts）`；没有文件级信息时传空串 ✓ */
  fileList: string;
  /** 最近一次测试命令（可能没有 ✓） */
  command?: string;
}): string {
  const { failedCount, fileList, command } = args;
  return (
    `[SYSTEM] 你这一轮跑过的测试里还有 **红的**：${failedCount} 条失败${fileList}` +
    `${command ? `（最近一次命令：${command}）` : ""}。\n` +
    "「跑另一组绿的」不能给这些文件洗白 —— 它们还是红的。现在你要收尾了，二选一：\n" +
    "① 把**这些文件**跑到绿（正常收尾）；\n" +
    "② 如果它们确实不该由你修（例如与本任务无关的既有缺陷），就在回执里**点名**：" +
    "哪几条红、为什么留着、对用户意味着什么。\n" +
    /**
     * ⚠️ **第 46 波末：这里原有的一段"与题面同一个病的不算无关 ⇒ 必须修"的措辞已被撤下** ✗。
     *
     * 为什么撤 ✓：用户直接指令 —— **提示词不是治本手段** ✗，效果随模型升级/切换而变 ✓；
     * 对标 DSH 就要照它的做法 ✓：**正确性由结构保证** ✓（见 `test-regression.ts` +
     * `turn-outcome.ts` 的**回归完成门** ✓）。
     *
     * 现在这条提醒只承担它该承担的 ✓：**确定性触发**（红就是红 ✓）+ **事实陈述** ✓；
     * "该不该修"不再由措辞施压 ✗，而由**回归门**判定 ✓：
     *   基线绿 → 现在红 ⇒ 不接受点名豁免 ✓（`agentic-loop.ts` 的 `regressions` 分支 ✓），
     *   且结果里带 `regressionRedTests` ⇒ **界面绝不显示"任务完成"** ✓。
     */
    "不允许把这次收尾写成「已完成」而不提这些红。"
  );
}
