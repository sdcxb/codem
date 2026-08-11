import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    // === 消除 ONNX Runtime WASM 冗余复制 ===
    // onnxruntime-web 的源码中包含 `new URL("ort-wasm-simd-threaded.asyncify.wasm", import.meta.url)`
    // 引用（位于 `if (false)` 死代码块中，运行时永不执行）。
    // 但 Vite 的静态分析不判断可达性，会盲式提取该 WASM 文件到 dist/assets/，
    // 产生 22.5MB 冗余副本。运行时实际使用 public/wasm/ 中的文件（通过 wasmPaths 对象配置）。
    // 此插件在构建完成后删除 dist/assets/ 中的冗余 WASM 副本。
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
    // 多页打包：宠物窗口使用独立入口，避免加载主应用的 3.4MB Bundle
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html"),
      },
    },
  },
  // === 风险3缓解：ONNX Runtime WASM 轻量化打包 ===
  // @huggingface/transformers 包含 onnxruntime-web WASM 文件，
  // 不应被 Vite 预打包（会导致 WASM 路径错误和体积膨胀）。
  optimizeDeps: {
    exclude: ["@huggingface/transformers"],
  },
  // 确保 WASM 文件被正确处理为静态资源
  assetsInclude: ["**/*.wasm"],
  worker: {
    format: "es",
  },
});
