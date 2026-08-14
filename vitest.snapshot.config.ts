import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * P2-13: Snapshot Test Configuration
 *
 * Replays recorded LLM API responses for deterministic testing.
 * No real API calls — all responses are from recorded snapshots.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts", "./src/test/setup-dom.ts"],
    include: ["src/test/snapshots/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "sql.js/dist/sql-asm.js": "sql.js/dist/sql-asm.js",
    },
  },
});
