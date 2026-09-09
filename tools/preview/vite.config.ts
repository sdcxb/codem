/**
 * 视觉预览构建配置（开发工具，不参与正式打包）。
 * 用法：npx vite build --config tools/preview/vite.config.ts
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [
    react(),
    {
      // 预览构建：把真实适配层替换为桩，避免把宿主模块（node 内建依赖）拉进浏览器构建
      name: "stub-telemetry-adapter",
      enforce: "pre",
      resolveId(source: string) {
        if (source.includes("telemetry-adapter")) return resolve(__dirname, "adapter-stub.ts");
        return null;
      },
    },
  ],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    // 单文件输出便于 headless 截图
    cssCodeSplit: false,
    rollupOptions: {
      output: { manualChunks: undefined },
    },
  },
});
