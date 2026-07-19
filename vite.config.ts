import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
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
