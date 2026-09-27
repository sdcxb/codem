/**
 * DELEGATED-193：**跨对话交接产生的中间任务会话，不进对话目录**（第 193 轮）
 *
 * ## 用户现场
 * 「我在另一个电脑上用咱们 app 的时候，左侧栏里有个全局对话 `[DELEGATED TASK]` 内容是
 * 【交接：项目 1.4.2.5 → 课题3 会话】…是做跨对话交接的时候产生的，
 * **这种中间任务应该也不显示在对话目录中吧？**」
 *
 * ## 判据（**只看消息**，两条同时成立）
 *   1. 该会话里**有**机器注入的 user 消息（以 `[DELEGATED TASK] ` 开头），**且**
 *   2. 该会话里**没有任何一条人打的用户消息**（非空、且不以该前缀开头）
 * ⇒ 只要用户在里面说过一句自己的话，它就永远不会被自动隐藏。
 *
 * ## ⚠️ 第一版判据是错的，靠**真库取证**才纠正过来（这段要留着）
 *
 * 第一版要求「`delegation_tasks.task` 里有一条带 `[DELEGATED TASK]` 前缀的记录」。
 * `_audit-193-delegation-sessions.mjs` 在真库上一读就露馅：**8 条真实委派记录的正文
 * 开头全是 `【会话交接】…`**（模型按 `HANDOVER_TEMPLATE` 写的原文），
 * 而那个前缀只在 `executor.ts` **注入消息**时加上（`content: prefix + message + receiverNote`），
 * **从不写回 `task` 列**。
 * ⇒ 那条判据**永远匹配不到任何东西**：实现"完成"、测试全绿、功能静默失效。
 * 教训：**判据必须落在真实存在的数据上**；单测证明不了数据长什么样。
 * 下面 `DELEGATED-193-11` 就是按真库观察到的形态钉住这一点的。
 *
 * ## 为什么不用第 190 轮否掉的那条
 * 否掉的是**裸的**「出现在 `delegation_tasks` 里」——`delegate_to_session` 的目标是
 * **已存在的会话**，用户确实会把任务委派给**自己的对话**（真机 5 条委派关系里有一条
 * 目标会话首条用户消息是「我们正在对标 codex 开发本项目…」，那是人打的）⇒ 会误藏真对话。
 *
 * ## 这些用例守什么 / 守不了什么
 * 守：两条判据、前缀严格匹配、注入失败时的保守方向、与写入点的常量一致、回填的幂等与可逆。
 * 守不了：真实库里行长什么样（那由探针在真机上量）。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DELEGATED_TASK_PREFIX,
  isDelegationArtifact,
  backfillInternalSessions,
} from "../core/storage/session";

const ROOT = process.cwd();
/** 真机上那条会话的标题形态：前缀 + 交接说明 */
const REAL_TITLE_EXAMPLE = `${DELEGATED_TASK_PREFIX}【交接：项目 1.4.2.5 → 课题3 会话】`;
/** 真库里 `delegation_tasks.task` 的形态（模型按模板写的原文，**不带**机器前缀） */
const REAL_TASK_TEXT = "【会话交接】\n1. 目标：读取 C:\\x\\package.json 的 version 字段。";

describe("DELEGATED-193 纯委派任务会话的判定", () => {
  it("DELEGATED-193-1 前缀常量与真机观察到的形态一致", () => {
    expect(DELEGATED_TASK_PREFIX).toBe("[DELEGATED TASK] ");
    /* 用户给的原话里就是「[DELEGATED TASK] 【交接：…」——前缀后带一个空格再接【 */
    expect(REAL_TITLE_EXAMPLE.startsWith("[DELEGATED TASK] 【交接：")).toBe(true);
  });

  it("DELEGATED-193-2 写入点与判据共用同一个常量（防改一处漏一处）", () => {
    /* 最容易出错的地方：executor 注入时加前缀、判据比前缀 ——
       两处各写一遍字符串字面量，改前缀必然漏一处，而漏的表现是"回填静默失效"。 */
    const executor = readFileSync(path.join(ROOT, "src/core/session/executor.ts"), "utf8");
    expect(executor, "executor 必须从 storage/session 导入该常量").toMatch(
      /import\s*\{[^}]*DELEGATED_TASK_PREFIX[^}]*\}\s*from\s*"\.\.\/storage\/session"/,
    );
    expect(executor, "executor 不得再手写字面量（会与判据漂移）").not.toContain('"[DELEGATED TASK] "');
    expect(executor, "executor 应当用它来拼前缀").toMatch(/delegationTaskId\s*\?\s*DELEGATED_TASK_PREFIX/);
  });

  it("DELEGATED-193-3 两条同时成立才判 true", () => {
    const injected = `${DELEGATED_TASK_PREFIX}【交接：…】`;
    /* ① 有机器注入的消息、没有人的消息 ⇒ true */
    expect(isDelegationArtifact([injected])).toBe(true);
    /* ② 没有任何注入消息 ⇒ false（哪怕是个人打的、看着像的会话） */
    expect(isDelegationArtifact([])).toBe(false);
    /* ③ 只有人写的正文（不带机器前缀）⇒ false */
    expect(isDelegationArtifact(["帮我看看这个 bug"])).toBe(false);
  });

  it("DELEGATED-193-4 ★关键防误伤：会话里出现任何一条人打的用户消息 ⇒ 永不隐藏", () => {
    const injected = `${DELEGATED_TASK_PREFIX}【交接：…】`;
    /* 真机场景复刻：目标是用户的对话，首条消息是人打的，后来又收到一条委派 */
    const humanFirst = "我们正在对标 codex 开发本项目…";
    expect(
      isDelegationArtifact([humanFirst, injected]),
      "用户自己说过的会话绝不能因为被委派过就被藏起来",
    ).toBe(false);
    /* 只有人打的消息（没有注入）也必须是 false */
    expect(isDelegationArtifact([humanFirst])).toBe(false);
    /**
     * ⚠️ **非空、且一条注入都没有** ⇒ 必须判否。
     * 这一条是把"判据1（必须有机器注入的消息）"**单独**压出来的：
     * 上面那种 `[人消息, 注入消息]` 的组合里注入消息总是存在，
     * 于是"是否真的要求注入"这件事根本没被考到 ——
     * 变异自证第一版把判据1 削成"空数组才判否"仍然全绿，就是因为缺了这一条。
     */
    expect(
      isDelegationArtifact(["就是普通聊两句", "再聊一句"]),
      "非空但完全没有机器注入 ⇒ 判否（判据1 必须真的生效）",
    ).toBe(false);
    /**
     * ⚠️ 这一条是**变异自证**第二次照出来的漏洞，而且比上一条更精细：
     * 「非空无注入」那一种，在把判据1 削成
     * `if (injected.length === 0 && userMessages.length === 0) return false;`
     * 时**仍然返回 false** —— 因为 `userMessages.length !== 0` 让条件不成立，
     * 于是照常走到判据2，而判据2 又把它判否了。
     * 也就是说**"必须有机器注入"这件事始终没被单独考到**。
     *
     * 能真正分开两者的是「**没有任何以机器前缀开头的消息，且不存在"人消息"**」这一段。
     * 唯一同时满足这两点的输入是**空白消息**：
     *   正确实现：`injected.length === 0` ⇒ 立刻判否。
     *   被削弱的实现：跳过判据1；空白又被 `trim().length > 0` 从"人消息"里滤掉，
     *     判据2 得空数组 ⇒ 判 **true**（把空白会话误判成委派产物）。
     */
    expect(
      isDelegationArtifact(["   ", "\t"]),
      "只有空白、没有任何机器注入 ⇒ 判否（否则空白会话会被误判成委派产物）",
    ).toBe(false);
    /* 空白消息不算"人打的"（不给"敲了个空格"就逃过收纳的口子） */
    expect(isDelegationArtifact([injected, "   "])).toBe(true);
  });

  it("DELEGATED-193-5 前缀必须严格匹配（不做模糊包含）", () => {
    /* 正文里"提到"这个字符串，但不在开头 ⇒ 不算机器注入 */
    expect(isDelegationArtifact(["请解释 [DELEGATED TASK] 是什么意思"])).toBe(false);
    /**
     * ⚠️ 这一条是**变异自证**照出来的第二个漏洞：上面那句以 `请` 开头、
     * 内含 `[DELEGATED TASK] `，在 `includes` 写法下会被**当成注入消息**；
     * 此时"人消息"那条判据反而不再拦它（它被认成注入了），于是整条判 true ——
     * 但上面已断言 false，所以**这一条必须单独再钉一次**，配一条更短的形态，
     * 确保"包含但不在开头"永远判否。
     */
    expect(
      isDelegationArtifact([`前缀在中间 ${DELEGATED_TASK_PREFIX} 的那种`]),
      "前缀出现在中间（不是开头）⇒ 既不是注入，也算人消息 ⇒ 判否",
    ).toBe(false);
    /* 少了尾空格（不是写入点的形态）⇒ 不算 */
    expect(isDelegationArtifact(["[DELEGATED TASK]【交接】"])).toBe(false);
    /**
     * ⚠️ 下面这一条是**变异自证**照出来的漏洞（第 193 轮）：
     * 原先判定写成 `startsWith`，上面几条用例**拦不住**它被改成 `includes` ——
     * 在那些用例里，一条 `startsWith(前缀)` 的人消息**同时也**满足"只含机器消息"，
     * 两种写法给出同一个答案，判据等于没被覆盖。
     * 只有"**人打的消息里恰好含这个前缀、但不在开头**"能把两者分开：
     *   正确（startsWith）：它是人消息 ⇒ 判否
     *   错误（includes）  ：被当成机器消息 ⇒ **用户的对话会被藏起来**（正是要防的误伤）
     */
    const humanTextMentioningMarker = `请看这条 ${DELEGATED_TASK_PREFIX}记录，是不是该收起来？`;
    expect(
      isDelegationArtifact([`${DELEGATED_TASK_PREFIX}交接正文`, humanTextMentioningMarker]),
      "人打的消息里含该前缀但不在开头 ⇒ 仍必须判否（否则用户的对话会被误藏）",
    ).toBe(false);
  });

  it("DELEGATED-193-11 ★判据必须落在真库真实存在的形态上（第一版就是在这儿错的）", () => {
    /* 真库取证观察到的两条事实：
       ① `delegation_tasks.task` 存的是**模型写的交接原文** `【会话交接】…`，**不带**机器前缀；
       ② 机器前缀只出现在**注入的消息**上（executor：content = prefix + message + receiverNote）。
       所以"纯委派任务会话"在真库里长的就是下面这样。 */
    const injectedMessage = `${DELEGATED_TASK_PREFIX}${REAL_TASK_TEXT}\n\n---\n[系统提示] 这是一次会话交接…`;
    expect(
      isDelegationArtifact([injectedMessage]),
      "真库形态（交接原文不带前缀 + 注入消息带前缀）必须判为委派产物",
    ).toBe(true);
    /* 把这个前提钉住：交接原文**不带**前缀。
       将来若有人把判据改回"按 delegation_tasks.task 判"，这条会立刻提醒他判据落空了。 */
    expect(
      REAL_TASK_TEXT.startsWith(DELEGATED_TASK_PREFIX),
      "真库里 task 列存的是模型原文，不带机器前缀 —— 判据不能建立在它上面",
    ).toBe(false);
  });
});

describe("DELEGATED-193 回填（backfillInternalSessions）", () => {
  const mk = (id: string, isInternal: boolean | number = 0) => ({ id, title: id, isInternal });

  it("DELEGATED-193-6 不传判据 ⇒ 行为与第 191 轮完全一致（只按子智能体形态）", () => {
    const mark = vi.fn();
    /* 标题/id 都不是子智能体形态 ⇒ 一个都不该动 */
    const n = backfillInternalSessions([mk("s1"), mk("s2")], mark);
    expect(n).toBe(0);
    expect(mark).not.toHaveBeenCalled();
  });

  it("DELEGATED-193-7 传了判据：命中才标，且只标命中那些", () => {
    const mark = vi.fn();
    const n = backfillInternalSessions([mk("a"), mk("b"), mk("c")], mark, (id) => id === "a" || id === "c");
    expect(n).toBe(2);
    expect(mark.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "c"]);
  });

  it("DELEGATED-193-8 判据抛异常 ⇒ 按「不标」处理，且不打断整批", () => {
    /* 方向必须保守：判据要读库，读失败若被当成 true，就会把用户的对话藏起来 */
    const mark = vi.fn();
    const n = backfillInternalSessions([mk("boom"), mk("ok")], mark, (id) => {
      if (id === "boom") throw new Error("库读失败");
      return true;
    });
    expect(n, "抛异常的那条不标，其余照标").toBe(1);
    expect(mark.mock.calls.map((c) => c[0])).toEqual(["ok"]);
  });

  it("DELEGATED-193-9 已经是内部会话 ⇒ 不重复标（幂等）", () => {
    const mark = vi.fn();
    const n = backfillInternalSessions([mk("a", true), mk("b", 1)], mark, () => true);
    expect(n).toBe(0);
    expect(mark).not.toHaveBeenCalled();
  });

  it("DELEGATED-193-10 单条写入失败不打断整批（与 191 轮同）", () => {
    const seen: string[] = [];
    const n = backfillInternalSessions([mk("a"), mk("b"), mk("c")], (id) => {
      seen.push(id);
      if (id === "b") throw new Error("写被拒");
    }, () => true);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(n, "失败那条不计入成功数").toBe(2);
  });

  it("DELEGATED-193-12 启动维护**真的把判据接上了**（否则整条链静默失效）", () => {
    /**
     * 判据对了、回填支持了，但**调用方没传判据**，整条链一样不生效 ——
     * 而且表现是"什么都没发生"，最难发现。第 192 轮就吃过一次这种亏
     * （srcset 写好了但少一个 1x 档 ⇒ 行为与没写一样）。
     * 单测在 jsdom 里跑不起完整维护流程，所以这里做**源码级窄判据**钉住接线；
     * **如实标注**：它只能守"接线还在"，守不了"维护跑起来真的标对了"。
     */
    const maint = readFileSync(path.join(ROOT, "src/core/storage/maintenance.ts"), "utf8");
    /* 必须导入判据 */
    expect(maint, "maintenance 必须导入 isDelegationArtifact").toMatch(
      /backfillInternalSessions[^}]*isDelegationArtifact|isDelegationArtifact[^}]*backfillInternalSessions/,
    );
    /* 必须把判据**作为第三个参数**传给回填（前两个是 candidates / mark） */
    const call = maint.match(/backfillInternalSessions\([^;]*\);/);
    expect(call, "没找到 backfillInternalSessions 的调用").toBeTruthy();
    expect(call![0], "调用里没有传判据 ⇒ 委派会话永远不会被标").toContain("isDelegation");
    /* 读失败时必须**退化成不判**（传 undefined），而不是"读不到就都标上" */
    expect(maint, "读失败时应退化为不传判据").toMatch(/userMsgs\s*\n?\s*\?\s*\(id: string\)/);
    /* 只喂 user 角色的消息（把助手/工具消息算进来会改变判据语义） */
    expect(maint, "必须只取 user 角色的消息").toMatch(/!==\s*"user"\)\s*continue/);
  });
});
