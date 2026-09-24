import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts", "./src/test/setup-dom.ts"],
    /*
     * ⚠️ 第 82 轮：`disableConsoleIntercept` 是**为一条真实存在的 teardown 竞态**加的，不是"忽略错误"。
     *
     * 现象：全量跑（369 文件）时偶发一条 unhandled error ——
     * `EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`
     * （报出来的文件是 `feature-context-fixes.test.ts`）。**所有用例仍然全过**，
     * 但它让 `vitest run` 退出码变成 1 ⇒ `npm run verify` 与 CI 的"绿"就不成立了
     * （"测试全过但命令失败"是最容易被人忽略过去的一种假绿/假红）。
     *
     * 它来自 vitest **拦截 console 再通过 RPC 转发给主进程**这条链路：
     * worker 正在关闭时，某条日志还在飞 ⇒ RPC 被关掉 ⇒ unhandled rejection。
     * 关掉拦截之后日志直接输出，这条链路根本不存在，竞态也就没有发生的余地；
     * 而**真正的**未处理错误（未捕获异常、未处理 rejection）依旧会让退出码非 0 ——
     * 判据没有被放宽。用例里 `vi.spyOn(console, "…")` 依然照常拦截（那是用例自己的 spy，与此无关）。
     *
     * 代价（如实写）：测试期间各用例**没有被 spy 掉**的 console 输出会直接打到终端
     * （不再按用例分组显示 `stdout | <用例名>`）。换来的是"全过就是退出码 0"这条底线。
     */
    disableConsoleIntercept: true,
    include: ["src/test/**/*.test.ts", "src/test/**/*.test.tsx"],
    // 并发上限：默认按逻辑核数（本机 32）铺满 worker，每个 worker 都要初始化
    // sql.js / transformers 等重依赖，实测会偶发 "Worker exited unexpectedly"
    // （0 failed 但 exit≠0）。压到 8 后连续复跑稳定。
    maxWorkers: 8,
    minWorkers: 2,
    // P0-4: Coverage configuration with per-file thresholds
    coverage: {
      provider: "v8",
      /*
       * `json-summary` 是**棘轮的真源**：它逐文件给出 statements / branches / functions / lines
       * 四个计数（`coverage/coverage-summary.json`），`tools/audit/coverage-baseline.mjs` 读它。
       *
       * ⚠️ 为什么不用 `lcov.info`：lcov **没有语句计数**，第一版就用"行覆盖率顶替语句覆盖率"
       * 填了阈值 —— 结果第一次真跑就红：实测语句 51.27% 而行 53.66%（v8 的语句 ≠ 行）。
       * 这件事被 `--check` 的对账抓住，也正是"先量后定"必须有对账工具的理由。
       */
      reporter: ["text", "text-summary", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      /*
       * ⚠️ 第 72 轮审计：这里的阈值**从来没有生效过** —— provider `@vitest/coverage-v8`
       * 根本没装（也不在 devDependencies 里），`npm run test:coverage` 直接
       * `MISSING DEPENDENCY` 退出。也就是说"功能轴探到原子函数"这条**一直没有度量**。
       *
       * 现在：provider 已装；下面这组数字是**先量后定**的棘轮（ratchet）——
       * 取自一次真实 `npx vitest run --coverage`（365 文件 / 6033 通过）的
       * `coverage/lcov.info`，每个数字 = 实测值向下取整再减 1 个百分点。
       * 掉下去会红，噪声不会让它乱红；度量与对账工具：
       *
       *   node tools/audit/coverage-baseline.mjs            # 打印实测值
       *   node tools/audit/coverage-baseline.mjs --check    # 配置 vs 实测 对账
       *   node tools/audit/coverage-baseline.mjs --md       # 写 tools/audit/coverage-baseline.md
       *
       * 实测（2026-09 第 72 轮，`coverage/coverage-summary.json`）：全局 语句 51.27% /
       * 分支 43.97% / 函数 47.34% / 行 53.67%；存储 82.24%，LLM 61%，会话 75.93%，诊断 97.5%。
       * ⚠️ 语句覆盖率**不能**用行覆盖率顶替（v8 的两者差了 2 个多百分点，第一版这么写第一次跑就红）。
       *
       * perFile 保持 false 是**有意的、且已记录**：一次性打开 per-file 会让
       * 几十个"只有 UI 接线 / 依赖真机外部进程"的文件（`core/cicd`、`core/provider` …）
       * 立刻全红，最后的结果一定是有人把阈值改回 0。所以这里改按**目录**设地板
       * （下面四条 glob），把"哪个区域在掉"变成可定位的事实；
       * "单文件掉到 0 被别处补回来"这个形态仍然挡不住 —— 它写在
       * `tools/audit/coverage-baseline.md` 的"这张表不说明什么"里，不假装已经解决。
       */
      thresholds: {
        lines: 52,
        functions: 46,
        branches: 42,
        statements: 50,
        "src/core/storage/**": { lines: 81, functions: 82, branches: 68, statements: 79 },
        "src/core/llm/**": { lines: 60, functions: 61, branches: 49, statements: 58 },
        "src/core/session/**": { lines: 74, functions: 78, branches: 54, statements: 74 },
        "src/core/diagnostics/**": { lines: 96, functions: 88, branches: 74, statements: 94 },
        perFile: false,
      },
      // Exclude non-source files from coverage
      exclude: [
        "src/test/**",
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/main.tsx",
        "src/pet.tsx",
        "src/vite-env.d.ts",
        "src-tauri/**",
        "node_modules/**",
        "dist/**",
        ".deepseek-harness-ref/**",
      ],
      // Include only core source files
      include: ["src/core/**/*.ts", "src/store/**/*.ts"],
    },
  },
  /**
   * 第 18 轮（L1）：这里原有两条 `sql.js/dist/…` 的自我映射别名
   * （"避免 ESM mock 处理破坏 wasm/asm 加载"）。旧引擎已删除、`sql.js` 依赖也已移除，
   * 别名指向的模块不再存在 —— 留着只会让"删干净了没有"这件事看不出来。
   */
});
