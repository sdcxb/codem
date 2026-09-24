/**
 * is-main.ts — **ESM 下判断"本文件是不是被当作入口直接运行"**。
 *
 * ## 为什么需要它（第 97 轮实测发现的问题）
 *
 * 本目录 4 个脚本原本都写成：
 *
 *   if (require.main === module) { ...CLI... }
 *
 * 这是 **CJS 写法**。仓库根 `package.json` 是 `"type": "module"`，所以在 ESM 作用域里
 * `require` **根本不存在** —— 用文档里的命令跑任何一个脚本，第一件事就是崩：
 *
 *   $ npx tsx src/core/skills/skill-creator/scripts/run-eval.ts --skill ...
 *   ReferenceError: require is not defined in ES module scope, you can use import instead
 *       at .../run-eval.ts:164
 *
 * 也就是说 `SKILL.md` 描述的那套"跑 eval / 出评审页"的能力**从来没有真正运行过**
 * （`run-eval.ts` / `generate-review.ts` 全仓无引用，所以没人踩到）。
 *
 * ## 判定方式
 *
 * `import.meta.url` 是本模块的 `file://` URL，`process.argv[1]` 是 node 拿到的入口脚本路径。
 * 两者 `path.resolve` 后相等 ⇒ 本文件就是入口。Windows 下路径**大小写不敏感**，
 * 所以比较前统一小写（否则 `C:\...` 与 `c:\...` 会被判成不同文件）。
 *
 * 不能做成"布尔常量导出"的原因：`import.meta.url` 必须是**调用方**的 URL，所以按参数传入。
 */

import path from "path";
import { fileURLToPath } from "url";

/** 把 `file://` URL 解析成可比较的绝对路径（失败返回 null，绝不抛）。 */
function toComparablePath(metaUrl: string): string | null {
  try {
    const resolved = path.resolve(fileURLToPath(metaUrl));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

/**
 * 本模块是否被直接当作入口运行（而不是被 import）。
 *
 * @param metaUrl 调用方的 `import.meta.url`
 * @param argv1   入口脚本路径，默认 `process.argv[1]`（测试可显式传入）
 */
export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  const self = toComparablePath(metaUrl);
  if (self === null) return false;
  let entry: string;
  try {
    entry = path.resolve(argv1);
  } catch {
    return false;
  }
  if (process.platform === "win32") entry = entry.toLowerCase();
  return self === entry;
}
