/**
 * 第 97 波：**沙箱也要管住 shell 的路径**（`bash` 的路径藏在命令文本里）。
 *
 * ## 缺陷形态（真实仓库档评测实测）
 *
 * 沙箱原来的判据是"入参里有 `path` 就查它，没有就放行"。`read` / `grep` / `glob` 有 `path`
 * ⇒ 被挡住；`bash` 的路径**藏在 `command` 文本里** ⇒ 一路放行。后果是同一个沙箱里：
 *
 * ```
 *   read  { path: "C:\\mimo-gui\\package.json" }              → 拒绝（Sandbox: Read from …）
 *   bash  { command: "Get-Content 'C:\\mimo-gui\\package.json'" } → 通过，内容原样返回
 * ```
 *
 * 在真实仓库档评测里这条就是**作弊通道**：工作区的 git 已经修干净（历史里只有 bug 状态、
 * 参考解不可达），被测 agent 于是跑去**隔壁主仓库**把参考解读走 ——
 * `cd C:\mimo-gui; git show HEAD:src/core/llm/edit-matchers.ts | Select-String 'findAmbiguousLiteral'`，
 * 那一次 21 次工具调用碰了工作区之外，成绩作废。
 *
 * ## 判据（保守：只报**能确定**的逃逸）
 *
 * 拒：绝对路径（盘符/UNC）在工作区外、含 `..` 的相对路径解析后在工作区外、`workdir` 在工作区外。
 * 放：工作区内的路径、不含路径的命令、URL、`$env:`/`%VAR%` 这类运行期才展开的引用（**边界，见文件末**）。
 *
 * ⚠️ 反向对照是**判据的一半**：沙箱**关闭**时（默认）这些命令必须照旧放行 ——
 * 否则这一改动就会变成"给所有用户加了一道看不见的墙"。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { initDefaultPipeline, getToolPipeline } from "../core/llm/tool-pipeline";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { setSetting, removeSetting, getSetting } from "../core/storage/settings";

const WS = "C:\\eval\\workspace";
const registry = createDefaultToolRegistry();

/** 与生产同形的"在不在工作区内"判定（大小写不敏感的前缀判定，Windows） */
function isWithinWorkspace(path: string, cwd: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const p = norm(path);
  const c = norm(cwd);
  return p === c || p.startsWith(`${c}/`);
}

let handlerCalls = 0;

beforeAll(async () => {
  await initDefaultPipeline({
    isPlanMode: () => false,
    // ⚠️ 必须**活读**设置：写死 `() => false` 的话守卫一次都不会跑，
    // 于是"该拒的都放行"看起来像功能没实现（这版测试第一跑就是这么假绿的）。
    isSandboxEnabled: () => getSetting("codem-sandbox-enabled") === "true",
    isPathWithinWorkspace: isWithinWorkspace,
    contractOf: (n: string) => registry.getContract(n),
    rawContractOf: (n: string) => registry.getRawContract(n),
    toolDefOf: (n: string) => registry.get(n),
    checkPermission: async () => ({ allowed: true }),
  });
});

/** 让 sandbox 开关"活"起来：管线里的 `isSandboxEnabled` 每轮重读设置 */
function sandbox(on: boolean) {
  if (on) setSetting("codem-sandbox-enabled", "true");
  else setSetting("codem-sandbox-enabled", "false");
}

function ctx(cwd = WS) {
  return { messageId: "m", cwd, messages: [], abort: new AbortController().signal } as never;
}

async function runBash(args: Record<string, unknown>, cwd = WS) {
  handlerCalls = 0;
  const r = await getToolPipeline().execute("bash", args, ctx(cwd), async () => {
    handlerCalls++;
    return {
      id: "call-bash",
      name: "bash",
      input: args,
      output: "SHOULD-NOT-RUN",
      status: "completed" as const,
      value: { command: String(args.command ?? ""), output: "SHOULD-NOT-RUN" },
    };
  });
  return r.result;
}

describe("沙箱：shell 命令里的工作区外路径", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeSetting("codem-sandbox-enabled");
  });

  it("SHLEAK-1: 命令里出现工作区外的**绝对路径** ⇒ 拒绝，且命令根本没执行", async () => {
    sandbox(true);
    const res = await runBash({ command: "Get-Content 'C:\\mimo-gui\\package.json' -TotalCount 3" });
    expect(String(res.output)).toMatch(/Sandbox/);
    expect(String(res.output)).toContain("C:\\mimo-gui\\package.json");
    expect(String(res.output)).not.toContain("SHOULD-NOT-RUN");
    expect(handlerCalls, "拦下时不许执行 —— 否则内容已经读出来了").toBe(0);
  });

  it("SHLEAK-2: `cd` 到工作区外再干活（含 git show 那一次的真实形态）⇒ 拒绝", async () => {
    sandbox(true);
    const realOne =
      "cd C:\\mimo-gui; \"==HEAD_edit-matchers has fix?==\"; git show HEAD:src/core/llm/edit-matchers.ts | Select-String 'findAmbiguousLiteral'";
    const res = await runBash({ command: realOne });
    expect(String(res.output)).toMatch(/Sandbox/);
    expect(handlerCalls).toBe(0);
  });

  it("SHLEAK-3: 相对路径用 `..` 逃出工作区 ⇒ 拒绝", async () => {
    sandbox(true);
    const res = await runBash({ command: "cd ..\\..\\mimo-gui; git status" });
    expect(String(res.output)).toMatch(/Sandbox/);
    expect(handlerCalls).toBe(0);
  });

  /**
   * **裸 `..`**：真机实测抓到的漏洞 —— 第一版要求 token 里带 `/` 或 `\` 才算路径，
   * 于是 `Get-ChildItem .. | Format-Table Name`（一条就能列出父目录，也就是隔壁主仓库）
   * 一路放行。上面那条 `..\..\mimo-gui` 有分隔符所以被拦，这条没有。
   */
  it("SHLEAK-3b: **裸 `..`** 也算逃逸（真机上这条曾放行并列出父目录）", async () => {
    sandbox(true);
    for (const command of ["Get-ChildItem -Force .. | Format-Table Name", "ls ..", "cd .."]) {
      const res = await runBash({ command });
      expect(String(res.output), `${command} 应当被拒`).toMatch(/Sandbox/);
      expect(handlerCalls, `${command} 拦下时不许执行`).toBe(0);
    }
  });

  /**
   * 第 15 轮：POSIX 绝对路径。
   *
   * 真机实测：`rm -rf /tmp/x` 在 Windows 上**绕过了沙箱**（只抽盘符/UNC/`..`），
   * 而同一路径的 `read` 被拒 —— 同一个沙箱两套口径。
   */
  it("SHLEAK-3c: 命令里的 POSIX 绝对路径（/tmp、/etc）⇒ 拒绝", async () => {
    sandbox(true);
    for (const command of ["rm -rf /tmp/codem-probe", "cat /etc/passwd", "ls /home/other/repo"]) {
      const res = await runBash({ command });
      expect(String(res.output), `${command} 应当被沙箱拒绝`).toMatch(/Sandbox/);
      expect(handlerCalls, `${command} 拦下时不许执行`).toBe(0);
    }
  });

  it("SHLEAK-3d: Windows 开关参数（/s、/q）不能被当成 POSIX 路径误拦", async () => {
    sandbox(true);
    const res = await runBash({ command: `rd /s /q ${WS}\\dist` });
    expect(handlerCalls, "工作区内的 rd /s /q 应当放行到执行层（危险性由权限层判）").toBe(1);
    expect(res.output).toBe("SHOULD-NOT-RUN");
  });

  it("SHLEAK-4: `workdir` 指到工作区外 ⇒ 拒绝（bash 支持换目录执行，等于绕过命令文本检查）", async () => {
    sandbox(true);
    const res = await runBash({ command: "git status", workdir: "C:\\mimo-gui" });
    expect(String(res.output)).toMatch(/Sandbox/);
    expect(handlerCalls).toBe(0);
  });

  it("SHLEAK-5: 工作区内的绝对路径 / 普通命令 ⇒ 放行（不能把好调用也拦了）", async () => {
    sandbox(true);
    for (const args of [
      { command: `Get-Content '${WS}\\package.json' -TotalCount 3` },
      { command: "echo hello" },
      { command: "npx vitest run src/test/x.test.ts" },
      { command: "git log --oneline HEAD..HEAD~1" }, // `..` 但不是路径逃逸
    ]) {
      const res = await runBash(args);
      expect(handlerCalls, `${JSON.stringify(args)} 应当放行`).toBe(1);
      expect(res.output).toBe("SHOULD-NOT-RUN");
    }
  });

  it("SHLEAK-6: URL 里的 `s://` 不能被当成盘符（假阳性控制）", async () => {
    sandbox(true);
    const res = await runBash({ command: "curl -sS https://example.com/data.json -o out.json" });
    expect(handlerCalls, "URL 不是路径").toBe(1);
  });

  it("SHLEAK-7: 沙箱**关闭**时（默认）工作区外的命令照旧放行 —— 不给普通用户加隐形墙", async () => {
    sandbox(false);
    for (const args of [
      { command: "Get-Content 'C:\\mimo-gui\\package.json'" },
      { command: "cd C:\\mimo-gui; git status" },
      { command: "git status", workdir: "C:\\mimo-gui" },
    ]) {
      const res = await runBash(args);
      expect(handlerCalls, `${JSON.stringify(args)} 在沙箱关闭时应当放行`).toBe(1);
    }
  });

  /**
   * **边界即判据**：变量引用是运行期才展开的，文本层看不见 —— 这条**故意**放行。
   * 写成用例是为了让"我们知道它拦不住"成为可执行的记录，而不是一句口头免责。
   * 兜底在评测侧：驱动的 `contaminated` 检测。
   */
  it("SHLEAK-8: `$env:` / `%VAR%` 这类变量引用拦不住（**已知边界**，靠评测侧兜底）", async () => {
    sandbox(true);
    const res = await runBash({ command: "Get-Content \"$env:USERPROFILE\\secret.txt\"" });
    expect(handlerCalls, "变量展开发生在运行期，文本层判不了 ⇒ 放行（边界）").toBe(1);
  });
});

/**
 * 补记（ACL 清理）：`sandbox-acl` 里那套从没被生产消费的 `checkPath`
 * （工作区内允许 / 工作区外与 `~/.ssh` 拒绝）已随 ACL 实现一并删除。
 * 同一件事的**真实**判据在管线这一层，所以这里把原来 ACL 单测覆盖的
 * 「越界读被拒 / 工作区内放行」搬到 `read` 工具的真管线上，
 * 并保留"沙箱关闭时不许误拒"的反向对照。
 */
describe("沙箱：文件工具（read）的工作区边界（ACL 删除后的等价覆盖）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeSetting("codem-sandbox-enabled");
  });

  async function runRead(path: string) {
    handlerCalls = 0;
    const r = await getToolPipeline().execute("read", { path }, ctx(), async () => {
      handlerCalls++;
      return {
        id: "call-read",
        name: "read",
        input: { path },
        output: "SHOULD-NOT-RUN",
        status: "completed" as const,
        // `read` 声明了 outputSchema ⇒ 必须给结构化 value（否则契约层会把成功改写成 error）
        value: { path, content: "SHOULD-NOT-RUN" },
      };
    });
    return r.result;
  }

  it("READ-BOUND-1: 工作区外的读（含用户凭证目录）⇒ 拒绝，且一个字节都没读", async () => {
    sandbox(true);
    for (const path of [
      "C:\\Users\\me\\.ssh\\id_rsa",
      "C:\\Users\\me\\.aws\\credentials",
      "/etc/passwd",
      // 前缀相似但**不在**工作区里：按路径段判定，不能拿 `workspace-evil` 当工作区
      "C:\\eval\\workspace-evil\\secret.txt",
    ]) {
      const res = await runRead(path);
      expect(String(res.output), `${path} 应当被沙箱拒绝`).toMatch(/Sandbox/);
      expect(String(res.output), "读操作被拒时文案必须说 Read from，而不是 Write to").toMatch(/Read from/);
      expect(String(res.output), `${path} 被拒时不许回显内容`).not.toContain("SHOULD-NOT-RUN");
      expect(handlerCalls, `${path} 拦下时不许执行 —— 否则内容已经读出来了`).toBe(0);
    }
  });

  it("READ-BOUND-2: 工作区内的读 ⇒ 放行（不能把好调用也拦了）", async () => {
    sandbox(true);
    const res = await runRead(`${WS}\\src\\a.ts`);
    expect(handlerCalls, "工作区内的读必须真的执行").toBe(1);
    expect((res.value as { content?: string })?.content).toBe("SHOULD-NOT-RUN");
  });

  it("READ-BOUND-3: 沙箱**关闭**时（默认）工作区外的读照旧放行 —— 不给普通用户加隐形墙", async () => {
    sandbox(false);
    const res = await runRead("C:\\Users\\me\\.ssh\\id_rsa");
    expect(handlerCalls, "关闭时越界读必须真的执行").toBe(1);
    expect((res.value as { content?: string })?.content).toBe("SHOULD-NOT-RUN");
  });
});
