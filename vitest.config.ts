import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/test/**/*.test.ts", "src/test/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "sql.js/dist/sql-asm.js": "sql.js/dist/sql-asm.js",
    },
  },
});
