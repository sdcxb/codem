/**
 * ★ 第 185 波（复审 R1-4b）：`task-keyword-search` 的**装机版默认实现**（走 IPC 的那条）
 * 必须把工作区交给读侧沙箱。
 *
 * ## 钉的是什么
 *
 * `createIpcFileSource()` / `createIpcSearcher()` 的三处调用
 * （`readFile(path)`、`readTextWindow(path, …)`、`grepSearch(pattern, root, include)`）
 * **都没传 `workspace`**，而读侧判定是「`workspace` 未给 ⇒ 不做判定」（`file-api.ts:68`）
 * ⇒ 循环内部的这条搜索是又一个"免费"的越界读口（`read` 工具被拒、它却读得到）。
 *
 * ## 判据（把 `file-api` 换成记录式替身，驱动**真的**默认实现）
 *
 * | id | 钉什么 |
 * |---|---|
 * | TKS-1 | 装机版读文件时 `readTextWindow` / `readFile` 都必须带 `options.workspace === root` |
 * | TKS-2 | 装机版搜索时 `grepSearch` 必须带 `options.workspace === root` |
 * | TKS-3 | 注入的替身（测试自己的 `src` / `search`）不受影响 —— 只有默认实现被接线 |
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ROOT = "C:/ws";
const FILE_TEXT =
  "usage 记账 不对 的话请看 usage.test.ts 与 记账.test.ts 的判据；applyToolResultStatus 是同族符号";

const listDirectory = vi.fn(async (dir: string) => [
  { name: "usage.test.ts", path: `${dir}/usage.test.ts`, isDirectory: false },
  { name: "记账.test.ts", path: `${dir}/记账.test.ts`, isDirectory: false },
]);
const readTextWindow = vi.fn(async () => ({ text: FILE_TEXT, nextOffset: 0, eof: true, size: FILE_TEXT.length }));
const readFile = vi.fn(async () => FILE_TEXT);
const grepSearch = vi.fn(async (pattern: string, path?: string) => [`${path}/src/usage.ts:1:${pattern}`]);

/**
 * 只替换 `file-api` 的四个读/搜入口 —— 判据要区分"默认实现有没有传 workspace"，
 * 所以必须**看见调用参数**（记录式替身），而不是断言源码里有没有那个字符串。
 */
vi.mock("../core/file-api", () => ({
  listDirectory: (dir: string) => listDirectory(dir),
  readTextWindow: (p: string, offset?: number, maxBytes?: number, options?: unknown) =>
    readTextWindow(p as never, offset as never, maxBytes as never, options as never),
  readFile: (p: string, options?: unknown) => readFile(p as never, options as never),
  grepSearch: (pattern: string, path?: string, include?: unknown, options?: unknown) =>
    grepSearch(pattern, path as never, include as never, options as never),
}));

import { buildTaskSearchNotice, buildSymbolSiblings } from "../core/llm/task-keyword-search";

function optionCalls() {
  return [
    ...readFile.mock.calls.map((c) => ({ fn: "readFile", ws: (c[1] as any)?.workspace })),
    ...readTextWindow.mock.calls.map((c) => ({ fn: "readTextWindow", ws: (c[3] as any)?.workspace })),
    ...grepSearch.mock.calls.map((c) => ({ fn: "grepSearch", ws: (c[3] as any)?.workspace })),
  ];
}

beforeEach(() => {
  listDirectory.mockClear();
  readTextWindow.mockClear();
  readFile.mockClear();
  grepSearch.mockClear();
  readTextWindow.mockImplementation(async () => ({
    text: FILE_TEXT,
    nextOffset: 0,
    eof: true,
    size: FILE_TEXT.length,
  }));
  readFile.mockImplementation(async () => FILE_TEXT);
  grepSearch.mockImplementation(async (pattern: string, path?: string) => [`${path}/src/usage.ts:1:${pattern}`]);
});

describe("R1-4b：task-keyword-search 的 IPC 默认实现必须带 workspace", () => {
  it("TKS-1: 读文件（窗口读与整读两条路）都带 workspace=root", async () => {
    await buildTaskSearchNotice(ROOT, "记账 usage 不对", {});
    const win = readTextWindow.mock.calls;
    expect(win.length, "前置：默认实现确实走了分窗读").toBeGreaterThan(0);
    expect(
      win.every((c) => (c[3] as any)?.workspace === ROOT),
      `分窗读必须带 workspace（改前不传 ⇒ file-api 的 if (!workspace) return 让检查整条失效）`,
    ).toBe(true);

    // 让窗口读失败 ⇒ 走整读那条路（报告点名的 :142）
    readTextWindow.mockImplementation(async () => {
      throw new Error("window read failed");
    });
    await buildTaskSearchNotice(ROOT, "记账 usage 不对", {});
    const full = readFile.mock.calls;
    expect(full.length, "前置：窗口读失败后必须回退到整读").toBeGreaterThan(0);
    expect(full.every((c) => (c[1] as any)?.workspace === ROOT), "整读同样必须带 workspace").toBe(true);
  });

  it("TKS-2: 搜索（grepSearch）必须带 workspace=root", async () => {
    await buildTaskSearchNotice(ROOT, "记账 usage 不对", {});
    const calls = grepSearch.mock.calls;
    expect(calls.length, "前置：默认实现确实发起了搜索").toBeGreaterThan(0);
    expect(
      calls.every((c) => (c[3] as any)?.workspace === ROOT),
      "越界搜索与越界读是同一个缺口（`file-api.ts` 的 searchPath 判定）",
    ).toBe(true);

    // 另一条走默认实现的入口：同族判据搜索
    readTextWindow.mockClear();
    grepSearch.mockClear();
    await buildSymbolSiblings(ROOT, "src/core/llm/tools.ts", {});
    expect(optionCalls().length, "前置：这条入口确实读了文件/发了搜索").toBeGreaterThan(0);
    expect(grepSearch.mock.calls.length, "前置：抽出符号后确实发起了搜索").toBeGreaterThan(0);
    expect(
      optionCalls().every((c) => c.ws === ROOT),
      `所有 IPC 读/搜调用都要带 workspace，实际：${JSON.stringify(optionCalls())}`,
    ).toBe(true);
  });

  it("TKS-3: 注入式替身不受影响（接线只落在默认实现上）", async () => {
    const injected = {
      list: async () => [],
      read: async () => FILE_TEXT,
    };
    await buildTaskSearchNotice(ROOT, "记账 usage 不对", { src: injected as never });
    expect(readTextWindow.mock.calls, "给了 src 就不该碰 IPC 默认实现").toHaveLength(0);
    expect(readFile.mock.calls).toHaveLength(0);
  });
});
