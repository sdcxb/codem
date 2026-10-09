/**
 * O-46（`project-id-191`）：**项目身份在 executor / 后台路径上的唯一来源**的变异自证。
 *
 * 被证明的判据：`src/test/memory-project-id-paths.test.ts` 的
 * `MEM-ID-1` / `MEM-ID-1b` / `MEM-ID-2` / `MEM-ID-3`。
 *
 * 这一波要挡住的正是 O-46 记的那个形态：写入侧与注入侧**一起**退化成 worktree 目录，
 * 因为两侧对称，"看起来一致"，于是没有任何判据会红。所以这里的每一条变异都把
 * 实现改回那种"看起来一致"的形态（或把两侧拆开），判据必须变红。
 *
 * ⚠️ `patches[].from` 必须是当前源码里**唯一命中**的一段原文（运行器在 LF 归一化后匹配）。
 */
export default {
  description:
    "O-46：把「项目身份」按 session → project 登记表解析这件事改坏（退回 cwd 兜底 / 摘掉登记表 / 让两侧分叉 / 去掉如实上报），MEM-ID-* 必须变红",
  mutations: [
    {
      id: "MUT-1 摘掉 session → project 登记表那一跳（等于退回按 cwd 兜底）",
      why: "MEM-ID-1：executor 路径的 cwd 是 worktree 目录 ⇒ 身份必须来自登记表；登记表被摘掉 ⇒ 两侧一起退化成 worktree 目录（O-46 的原始缺陷形态）",
      patches: [
        {
          file: "src/core/llm/index.ts",
          from: `    const fromTable = projectIdFromCwd(sessionProjectPath(input.sessionId));
    if (fromTable) return fromTable;`,
          to: `      // 变异：登记表这一跳被摘掉（身份只能退回最后一跳的 cwd = worktree 目录）`,
        },
      ],
      tests: ["src/test/memory-project-id-paths.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 最后一跳静默：删掉「如实上报」",
      why: "MEM-ID-2 / MEM-ID-3：登记缺失时必须如实上报（不许静默用一个可能是 worktree 目录的值）；上报被删掉 ⇒ 判据必须红",
      patches: [
        {
          file: "src/core/llm/index.ts",
          from: `  const degraded = projectIdFromCwd(input.cwd);
  if (degraded) reportMemoryProjectIdDegrade(input.sessionId, degraded);
  return degraded;`,
          to: `  const degraded = projectIdFromCwd(input.cwd);
  return degraded;`,
        },
      ],
      tests: ["src/test/memory-project-id-paths.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 两侧分叉：注入侧不再读写入侧登记的值",
      why: "MEM-ID-1：注入侧绕开写入侧登记的身份、直接按 cwd 取 ⇒ 写入落项目根的桶、注入查 worktree 的桶（R3 修过的那个「看不到自己写的记忆」形态）",
      patches: [
        {
          file: "src/core/llm/index.ts",
          from: `    return resolveMemoryProjectId({
      sessionId,
      cwd,
      registered: this.sessionMemoryProjectId.get(sessionId),
    });`,
          to: `    return projectIdFromCwd(cwd);`,
        },
      ],
      tests: ["src/test/memory-project-id-paths.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 写入侧退回 O-46 的原始形态（options?.memoryProjectId ?? projectIdFromCwd(cwd)）",
      why: "MEM-ID-1：写入侧不再走唯一解析点、直接拿 cwd 兜底 ⇒ worktree 会话的项目记忆落进 worktree 目录的桶",
      patches: [
        {
          file: "src/core/llm/index.ts",
          from: `    const memoryProjectId = resolveMemoryProjectId({
      sessionId,
      cwd,
      explicit: options?.memoryProjectId,
    });`,
          to: `    const memoryProjectId = options?.memoryProjectId ?? projectIdFromCwd(cwd);`,
        },
      ],
      tests: ["src/test/memory-project-id-paths.test.ts"],
      expectRed: true,
    },
  ],
};
