/**
 * LLM 引擎的唯一"动态取用"入口（叶子门面）。
 *
 * ## 为什么需要它（这一条是生产构建的真实崩溃）
 *
 * 仓里有 12 处 `await import` 指向 barrel（`../llm` 或 `../llm/index`）。只要**动态导入的目标是 barrel**，
 * Rollup 就必须为它生成一个命名空间对象，且这个对象是**急切求值**的：
 *
 * ```js
 * const Wf = Object.freeze({ __proto__: null, AgenticLoop: v0, LLMEngine: mM, getLLMEngine: yu, … });
 * ```
 *
 * 而 `core/llm/index.ts` 处在一条环上：
 * `index → agentic-loop → tools → tools/read-attachment → store → core/store → index`。
 * 当模块求值从环的另一侧进入时，index 的对象字面量会先读到 `AgenticLoop`（此时那个 class 还在 TDZ）
 * ⇒ 生产包直接 `Uncaught ReferenceError: Cannot access 'v0' before initialization` ⇒ **应用白屏**。
 * dev 下看不到：ESM 逐模块加载、绑定后置初始化，所以这个坑只在打过包之后出现。
 *
 * ## 做法
 *
 * 动态导入改为指向本文件。这里**只再导出一个已提升的函数声明**（`getLLMEngine`），
 * 命名空间字面量因此只含函数引用（函数在模块实例化阶段就初始化完毕），不会读到任何 class 绑定。
 * 语义、调用方式、时序都不变：仍然是"用到时才加载 barrel"，仍然返回同一个单例。
 *
 * ## 口径
 *
 * 新增动态取引擎的地方请 `await import("…/llm/engine-access")`，**不要**再动态导入 barrel。
 * 判据见 `src/test/llm-barrel-namespace-tdz.test.ts`（扫全仓：动态导入 barrel 一律报红）。
 */
export { getLLMEngine, peekLLMEngine } from "./index";
