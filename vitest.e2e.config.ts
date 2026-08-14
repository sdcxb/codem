import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * P2-18: E2E Test Configuration
 * 
 * Runs tests against real LLM APIs (requires API key in env).
 * Separate from unit tests to avoid rate limits and costs.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts", "./src/test/setup-dom.ts"],
    include: ["src/test/e2e/**/*.test.ts"],
    timeout: 120_000, // 2 min per test for real API calls
    testTimeout: 120_000,
  },
  resolve: {
    alias: {
      "sql.js/dist/sql-asm.js": "sql.js/dist/sql-asm.js",
    },
  },
});
