/**
 * 副作用式 CSS import 的类型声明。
 *
 * `packages/ui/src/browser.tsx` 会 `import "./ui.css"`（esbuild 抽成 `web/ui.css`），
 * 而 `tsc -p packages/ui/tsconfig.json` 的 include 只覆盖 `src` 下的 ts/tsx，
 * 根目录的 `src/vite-env.d.ts` 不生效 —— 没有本文件时 `npm run typecheck:ui` 会报
 * "Cannot find module './ui.css'"。
 */
declare module "*.css";
