/** 变异波次：旧工具参数折叠（write/edit/multi_edit，最近 2 次不动）。 */
export default {
  description:
    "ARGSFOLD：旧 write/edit/multi_edit 的参数只留 path、正文换可重读标记；最近 2 次调用不动；只读视图。判据 ARGSFOLD-1..4；3 条变异各自对红",
  mutations: [
    {
      id: "MUT-1 完全不折参数",
      why: "ARGSFOLD-1：真机 98K token 的文件正文留在参数里 ⇒ 会话仍然超预算",
      patches: [
        {
          file: "src/core/llm/tool-output-fold.ts",
          from: "      if (!FOLDABLE_ARGS_TOOLS.has(tool) || tc?.args === undefined) return;",
          to: "      if (true) return;",
        },
      ],
      tests: ["src/test/tool-args-fold.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 连最近 2 次调用也折",
      why: "ARGSFOLD-1：当前正在写的东西依赖最近参数，折了会让模型看不到自己刚写的文件",
      patches: [
        {
          file: "src/core/llm/tool-output-fold.ts",
          from: "  const protectedCalls = new Set(withCalls.slice(Math.max(0, withCalls.length - ARGS_KEEP_TAIL_CALLS)));",
          to: "  const protectedCalls = new Set<number>();",
        },
      ],
      tests: ["src/test/tool-args-fold.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 把 bash 也当成可折参数",
      why: "ARGSFOLD-2：bash 命令不是落盘内容，折掉后模型无法知道当时跑了什么",
      patches: [
        {
          file: "src/core/llm/tool-output-fold.ts",
          from: 'export const FOLDABLE_ARGS_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multi_edit"]);',
          to: 'export const FOLDABLE_ARGS_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multi_edit", "bash"]);',
        },
      ],
      tests: ["src/test/tool-args-fold.test.ts"],
      expectRed: true,
    },
  ],
};
