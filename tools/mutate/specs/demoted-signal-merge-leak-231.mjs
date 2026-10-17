/**
 * 变异自证（第 231 波 · 独立审计三条：A1 降级无信号 / A2 合并继承作用域 / A3 副本失败漏目录）。
 *
 * | 变异 | 坏法 | 必须红在哪 |
 * | --- | --- | --- |
 * | MUT-1 | 「本会话已自动降级 N 条」改成数 **pending**（A1 里最像的错口径） | `MEM-DEMOTE-1` / `MEMP-8` |
 * | MUT-2 | 计数恒 0（引擎返回空） | `MEM-DEMOTE-1` / `MEM-DEMOTE-3` / `MEMP-8` |
 * | MUT-3 | 面板无条件渲染那行提示（N=0 也出现） | `MEM-DEMOTE-2` |
 * | MUT-4 | 合并条作用域改回"继承正文最长那条"（A2 原样） | `MEMC-3b` |
 * | MUT-5 | 复制失败不清理临时目录（A3 原样） | `RODB-231-9` |
 * | MUT-6 | 写入路径不再打 `demotedFrom`（信号失去来源） | `MEMP-8` |
 */
export default {
  description:
    "第 231 波（独立审计三条）：A1 降级要有可见信号（N 来自 demotedFrom，不是 pending）、A2 合并取组内最严作用域、A3 只读副本复制失败不留临时目录",
  mutations: [
    {
      id: "MUT-1 A1：把「已自动降级 N 条」改成数 pending",
      why: "MEM-DEMOTE-1 / MEMP-8：这是最像的错口径 —— 用户看到的数字必须与 [extractMemories] 那行「触发降级」日志同源，而不是待批准条数",
      patches: [
        {
          file: "src/core/memory/memory.ts",
          from: "      .filter((entry) => entry.demotedFrom !== undefined && entry.scope === \"conversation\" && entry.sessionId === sessionId)",
          to: "      .filter((entry) => isPendingMemoryEntry(entry))",
        },
      ],
      tests: ["src/test/memory-demoted-signal.test.tsx", "src/test/memory-pending-backlog.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 A1：引擎的降级计数恒 0",
      why: "MEM-DEMOTE-1/3、MEMP-8：恒 0 ⇒ 面板永不提示，等于这条信号没做",
      patches: [
        {
          file: "src/core/memory/memory.ts",
          from: "  listBacklogDemotedForSession(sessionId?: string): MemoryEntry[] {\n    if (!sessionId) return [];",
          to: "  listBacklogDemotedForSession(sessionId?: string): MemoryEntry[] {\n    if (sessionId || !sessionId) return [];",
        },
      ],
      tests: ["src/test/memory-demoted-signal.test.tsx", "src/test/memory-pending-backlog.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 A1：面板无条件渲染降级提示（N=0 也出现）",
      why: "MEM-DEMOTE-2：N=0 还提示就是狼来了（用户会开始忽略这条信号）",
      patches: [
        {
          file: "src/components/MemoryManager.tsx",
          from: "    if (demotedBacklog.length === 0) return null;\n    const n = demotedBacklog.length;",
          to: "    const n = demotedBacklog.length;",
        },
      ],
      tests: ["src/test/memory-demoted-signal.test.tsx"],
      expectRed: true,
    },
    {
      id: "MUT-4 A2：合并条作用域又跟着正文最长那条走",
      why: "MEMC-3b：一条 project + 一条 conversation 合并后可能变成对话级直接生效 ⇒ 合并把审批绕过去（无声、无日志、无上限）",
      patches: [
        {
          file: "src/core/memory/candidate-merge.ts",
          from: "  const scope = promoted ? promoted.to : bodyOwner.scope;",
          to: "  const scope = bodyOwner.scope;",
        },
      ],
      tests: ["src/test/memory-pending-backlog.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-5 A3：复制失败不清理临时目录",
      why: "RODB-231-9：每失败一次漏一个 %TEMP%/codem-ro-db-*（审计实测漏过 jhxC72）",
      patches: [
        {
          file: "tools/maintenance/read-only-db.mjs",
          from: "    } catch (err) {\n      cleanupTempDir(dir);\n      throw err;\n    }",
          to: "    } catch (err) {\n      throw err;\n    }",
        },
      ],
      tests: ["src/test/read-only-db.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-6 A1：写入路径不再打 demotedFrom",
      why: "MEMP-8：降级只在日志里留痕、条目上没有标记 ⇒ 引擎数不出来，面板永远 0",
      patches: [
        {
          file: "src/core/llm/index.ts",
          from: "          ...(demotedForBacklog ? { demotedFrom: intendedScope } : {}),\n",
          to: "",
        },
      ],
      tests: ["src/test/memory-pending-backlog.test.ts"],
      expectRed: true,
    },
  ],
};
