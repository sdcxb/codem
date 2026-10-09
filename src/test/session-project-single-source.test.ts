/**
 * `SESSION-PROJECT`：**「会话 → 项目根路径」只许有一处实现**，且安全模式必须按它解析
 * （第 191 波"全仓搜同类"的第五个簇）。
 *
 * ## 被守的形态
 *
 * 修 O-46 时发现同一个反查（`sessions.project_id` → `projects.path`）在**三处**各写了一遍：
 * `core/llm/index.ts`（记忆归属）、`core/session/executor.ts`（安全模式）、
 * `core/phone-link/phone-link.ts`（`cwdForSession` 的"没有 worktree 时用项目根"那一支）。
 * 前两处问的是**同一个问题**（这个会话属于哪个项目），第三处问的是"该在哪个目录跑"
 * （所以它刻意先取 `worktreePath`，只把"没有 worktree ⇒ 用项目根"这一支并过来）。
 *
 * ## 为什么 `executor` 那一处是**缺陷**（不只是重复）
 *
 * `executeSessionTurn` 是委派 / 微信桥 / 手机续聊的公共入口，它的 `cwd` 在 worktree 会话上是
 * **worktree 目录**。而项目级安全模式覆盖按**项目根路径**存键
 * （`permission/security-mode.ts` 的 `PROJECT_KEY_PREFIX + projectPath`）⇒ 拿 worktree 目录去查
 * **永远查不到**，静默退回全局模式。方向可能是**放松**（项目里设了 `ask`、全局是 `full`
 * ⇒ 后台/委派任务变成"永不询问"）—— 安全语义上的静默降级。
 *
 * ## 判据
 *
 * - `SP-1`（解析式对账）：`src/**`（除 `src/test/**`）里"从会话反查项目根"的形态只允许出现在
 *   唯一实现 `src/core/storage/session-project.ts`（例外表逐条登记 + 不许过期）；
 * - `SP-2`（行为）：会话登记在项目 P、`cwd` 指向另一个目录（worktree 形态）时，
 *   安全模式必须按 **P** 解析 —— 即项目级覆盖生效；反向对照：登记查不到 ⇒ 退回 `cwd`
 *   并如实留痕（`console.warn`）。用一个**独立**的 `getEffectiveSecurityMode` 调用点断言，
 *   不依赖把整条 `executeSessionTurn` 跑起来（那条路径已由 `memory-project-id-paths.test.ts`
 *   的 MEM-ID-1 真跑覆盖）。
 * - `SP-3`（防恒真）：谓词对历史形态必须命中、对唯一实现必须不命中。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import * as ProjectStorage from "../core/storage/project";
import { sessionProjectPath } from "../core/storage/session-project";
import { getEffectiveSecurityMode, setGlobalSecurityMode, setProjectSecurityMode } from "../core/permission/security-mode";

const ROOT = process.cwd();
const SINGLE_SOURCE = "src/core/storage/session-project.ts";

/** 例外表：确实是"从会话反查项目根"但**故意**不并过来的位置（必须写明理由，且不许过期） */
const EXCEPTIONS: Array<{ file: string; reason: string }> = [];

/**
 * 判定谓词（纯函数）：这一份代码是不是"从会话反查项目根"。
 * 形态：同一个函数/文件里出现 `getSession(...)` 与 `getProject(...).path` 的组合。
 */
export function looksLikeSessionToProjectLookup(code: string): boolean {
  /*
   * 刻意**不**依赖命名空间的名字（`SessionStorage.` / `ProjectStorage.`）：
   * 那种写法一改 import 别名就绕过去了（第一次变异自证就是这么漏的 —— 把 `ProjectStorage`
   * 换成 `ProjectStorage0` 之后谓词判绿）。这里只认**调用形状**。
   */
  const re = /\bgetSession\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const window = code.slice(m.index, m.index + 240);
    /*
     * 窗口内出现 `projects.find(...)` ⇒ 它先查**内存列表**再回落持久层
     * （`store.ts` 分叉会话解析"目标项目的路径"就是这一形态）——那回答的是另一个问题
     * （"分叉目标项目的路径"，带内存层与当前项目兜底），不属于本判据要收口的"从会话反查项目根"。
     */
    if (/projects\s*\.\s*find\s*\(/.test(window)) continue;
    /*
     * `getProject(...)` 之后**同一窗口内**出现 `.path` 就算命中 —— 不要求紧贴调用
     * （历史形态里有 `const proj = getProject(pid); return proj?.path;` 这种隔一行的写法）。
     */
    const at = window.search(/\bgetProject\s*\(/);
    if (at >= 0 && /\.\s*path\b/.test(window.slice(at))) return true;
  }
  return false;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1} `);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name === "test" && path.basename(dir) === "src") continue;
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(abs);
  }
  return out;
}

beforeEach(() => {
  // 端口是 `sessionProjectPath` 读登记表的前提
  setStoragePort(
    createFakeStoragePort({
      seed: {
        settings: [{ key: "noop", value: "" }],
        projects: [{ id: "proj-p", path: "C:\\work\\proj-p", name: "P" }],
        sessions: [{ id: "sess-1", project_id: "proj-p", title: "s", created_at: 1, last_message_at: 2, message_count: 0 }],
      },
    }),
  );
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("SESSION-PROJECT：会话 → 项目根路径只许一处实现（第 191 波同簇收口）", () => {
  it("SP-1: 反查形态只允许出现在唯一实现里（例外表不许过期）", () => {
    const hits: string[] = [];
    for (const full of walk(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (rel.startsWith("src/test/")) continue;
      if (rel === SINGLE_SOURCE) continue;
      const code = stripComments(readFileSync(full, "utf8"));
      if (looksLikeSessionToProjectLookup(code)) hits.push(rel);
    }
    const unexpected = hits.filter((f) => !EXCEPTIONS.some((e) => e.file === f));
    expect(
      unexpected,
      `这些文件自己反查了一遍「会话 → 项目根」（应改用 src/core/storage/session-project.ts）：\n  ${unexpected.join("\n  ")}`,
    ).toEqual([]);
    const stale = EXCEPTIONS.filter((e) => !hits.includes(e.file));
    expect(stale.map((s) => s.file), "例外表里有条目已不再命中（过期）").toEqual([]);
    // 唯一实现自己必须真的在反查（否则上面那句是空转）
    const src = readFileSync(path.join(ROOT, SINGLE_SOURCE), "utf8");
    expect(src).toContain("getSession");
    expect(src).toContain("getProject");
  });

  it("SP-2: 安全模式按**登记的项目根**解析（worktree cwd 不许把项目级覆盖弄丢）", () => {
    /*
     * 夹具：全局 = full（"永不询问"），项目 P = ask（要确认）。
     * 会话登记在 P，而它的 cwd 是别处的目录（worktree 形态）。
     * 旧实现拿 cwd 去查 ⇒ 查不到项目覆盖 ⇒ 退回全局 full（**放松**了权限）。
     */
    setGlobalSecurityMode("full");
    setProjectSecurityMode("C:\\work\\proj-p", "ask");

    const cwdIsWorktree = "C:\\work\\proj-p-worktrees\\sess-1";
    expect(getEffectiveSecurityMode(cwdIsWorktree), "夹具前提：拿 worktree 目录查不到项目覆盖").toBe("full");

    const registered = sessionProjectPath("sess-1");
    expect(registered, "登记表必须能反查到项目根").toBe("C:\\work\\proj-p");
    expect(
      getEffectiveSecurityMode(registered ?? cwdIsWorktree),
      "按登记的项目根解析 ⇒ 项目级 ask 生效（不许静默退回全局 full）",
    ).toBe("ask");
  });

  it("SP-2b 反向对照: 登记读不到 ⇒ 退回 cwd（查不到就**不猜**），读失败则必须留痕", () => {
    setGlobalSecurityMode("full");
    setProjectSecurityMode("C:\\work\\proj-p", "ask");
    vi.spyOn(ProjectStorage, "getProject").mockReturnValue(null as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const path2 = sessionProjectPath("sess-1");
    expect(path2, "登记读不到 ⇒ 查不到（不许猜）").toBeUndefined();
    // 调用方的契约：退回 cwd（这里是 worktree 目录）—— 结果就是全局 full
    const cwdIsWorktree = "C:\\work\\proj-p-worktrees\\sess-1";
    expect(getEffectiveSecurityMode(path2 ?? cwdIsWorktree)).toBe("full");
    // "查不到"是合法结果（调用方自己决定怎么回落并留痕），所以唯一实现此刻**不**该刷日志……
    expect(warn.mock.calls.length, "「查不到」是合法观测态：唯一实现不该把它当异常刷日志").toBe(0);

    // ……但**读失败**必须留痕（读失败与"没登记"对调用方是同一个观测态，可我们必须能查日志）
    vi.restoreAllMocks();
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ProjectStorage, "getProject").mockImplementation(() => {
      throw new Error("端口未就绪");
    });
    expect(sessionProjectPath("sess-1")).toBeUndefined();
    expect(warn2.mock.calls.map((c) => String(c[0])).join("\n"), "读失败必须留痕").toMatch(/session-project/);
  });

  it("SP-2c: 接线检查 —— executor 的安全模式必须按登记的项目根解析（不许再传裸 cwd）", () => {
    const code = readFileSync(path.join(ROOT, "src/core/session/executor.ts"), "utf8");
    expect(code, "executor 必须用唯一实现反查项目根").toContain("sessionProjectPath(sessionId)");
    expect(
      /getEffectiveSecurityMode\(\s*registeredProjectPath\s*\?\?\s*cwd\s*\)/.test(code),
      "executor 必须把登记的项目根交给 getEffectiveSecurityMode（裸 cwd 会让 worktree 会话静默退回全局模式）",
    ).toBe(true);
  });

  it("SP-3 防恒真: 谓词对历史形态必须命中、对唯一实现/无关代码必须不命中", () => {
    const historical = [
      "const row = SessionStorage.getSession(sessionId);\nconst proj = ProjectStorage.getProject(row.projectId);\nreturn proj?.path;",
      "const projectId = SessionStorage.getSession(id)?.projectId;\nconst fromTable = ProjectStorage.getProject(projectId)?.path;",
      // 换 import 别名也必须命中（第一版谓词就是在这里漏的）
      "const row0 = SessionStorage0.getSession(input.sessionId);\nconst fromTable = projectIdFromCwd(ProjectStorage0.getProject(row0?.projectId ?? \"\")?.path);",
    ];
    for (const s of historical) expect(looksLikeSessionToProjectLookup(s), `历史形态必须命中：${s.slice(0, 40)}`).toBe(true);
    const others = [
      "const projects = ProjectStorage.listProjects().filter((p) => p.id !== 'wx-workspace');",
      "const p = ProjectStorage.getProject(projectIdFromRequest)?.path;",
      "const row = SessionStorage.getSession(sessionId);\nif (row.worktreePath) return row.worktreePath;",
    ];
    for (const s of others) expect(looksLikeSessionToProjectLookup(s), `无关代码不许命中：${s.slice(0, 40)}`).toBe(false);
  });
});
