import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "remove-redundant-ort-wasm",
      apply: "build",
      closeBundle() {
        const assetsDir = resolve(process.cwd(), "dist/assets");
        if (!existsSync(assetsDir)) return;
        for (const file of readdirSync(assetsDir)) {
          if (/^ort-wasm-simd-threaded.*\.wasm$/.test(file)) {
            unlinkSync(resolve(assetsDir, file));
            console.log(`[vite] Removed redundant WASM copy: dist/assets/${file} (-22.5MB)`);
          }
        }
      },
    },
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html"),
      },
    },
  },
  optimizeDeps: {
    exclude: ["@huggingface/transformers"],
  },
  assetsInclude: ["**/*.wasm"],
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      fs: resolve(__dirname, "src/stubs/node-fs-stub.ts"),
      path: resolve(__dirname, "src/stubs/node-path-stub.ts"),
      os: resolve(__dirname, "src/stubs/node-os-stub.ts"),
      "node:fs": resolve(__dirname, "src/stubs/node-fs-stub.ts"),
      "node:path": resolve(__dirname, "src/stubs/node-path-stub.ts"),
      "node:os": resolve(__dirname, "src/stubs/node-os-stub.ts"),
      "node:crypto": resolve(__dirname, "src/stubs/node-crypto-stub.ts"),
      crypto: resolve(__dirname, "src/stubs/node-crypto-stub.ts"),
      buffer: resolve(__dirname, "src/stubs/buffer-polyfill.ts"),
    },
  },
});
