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

/**
 * **结束一个 CLI 脚本并给出退出码**（第 191 波）。
 *
 * ## ⚠️ 不要直接 `process.exit(N)`
 *
 * 实测（Windows / Node 24，本目录的脚本）：`console.error(...)` **紧跟** `process.exit(1)`
 * 会偶发崩在 libuv 的断言上 ——
 *
 * ```
 * Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 * ```
 *
 * 退出码从 1 变成 **3221226505（0xC0000409）**，而且**不是必现**（实测 3 次里 2 次崩）。
 * 这是"在输出还没冲干净时就硬退"的必然代价：进程退出与流的关闭在抢同一个 handle。
 * 判据 `skill-creator-scripts.test.ts` 的 CLI-1（真进程跑一遍、断言退出码）当场抓到。
 *
 * 正确做法：写 `process.exitCode` 然后**返回**，让 Node 在输出冲干净之后自然退出。
 * 调用方记得在 `fail(...)` 之后 `return`（否则脚本会继续往下跑）。
 */
export function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

/**
 * **冲干净输出之后再退出**（顶层的 CLI 分支用这个，因为它没法"提前 return"）。
 *
 * 与 `fail()` 是同一件事的两半：`fail()` 用于**函数体**里（设 exitCode + return，最稳），
 * 这个用于**顶层 `if (isMainModule(...))` 块**里（那里没有函数可 return，硬退又会撞上面那个
 * libuv 断言）⇒ 显式等到两个流都写完再 `process.exit`。ESM 顶层 `await` 允许这样写。
 */
export async function exitAfterFlush(code: number): Promise<never> {
  const flush = (s: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => (s.writableLength === 0 ? resolve() : s.write("", () => resolve())));
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(code);
  throw new Error("unreachable"); // process.exit 不返回；这行只为类型上的 never
}
