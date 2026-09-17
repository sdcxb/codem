import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts", "./src/test/setup-dom.ts"],
    include: ["src/test/**/*.test.ts", "src/test/**/*.test.tsx"],
    // 并发上限：默认按逻辑核数（本机 32）铺满 worker，每个 worker 都要初始化
    // sql.js / transformers 等重依赖，实测会偶发 "Worker exited unexpectedly"
    // （0 failed 但 exit≠0）。压到 8 后连续复跑稳定。
    maxWorkers: 8,
    minWorkers: 2,
    // P0-4: Coverage configuration with per-file thresholds
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      reportsDirectory: "./coverage",
      // Per-file coverage thresholds — fail if any file drops below these
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
        statements: 50,
        perFile: true,
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
