import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts", "./src/test/setup-dom.ts"],
    include: ["src/test/**/*.test.ts", "src/test/**/*.test.tsx"],
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
  resolve: {
    alias: {
      "sql.js/dist/sql-asm.js": "sql.js/dist/sql-asm.js",
      // FIX: database.ts 已切换到 memory-growth 版本（自动扩展堆，支持大数据量会话）。
      // 保持 vitest 对 sql.js CJS 模块的自我映射，避免 ESM mock 处理破坏 wasm/asm 加载。
      "sql.js/dist/sql-asm-memory-growth.js": "sql.js/dist/sql-asm-memory-growth.js",
    },
  },
});
