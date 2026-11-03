/**
 * Host 工具与渲染侧工具的**契约一致性**（HTOOL-*）。
 *
 * 为什么需要它：Host 的工具是新写的（`packages/host/src/tools.ts`），而渲染侧有 40+ 个工具
 * （`src/core/llm/tools.ts`）。一旦两边用**不同的 id 或不同的参数名**，同一段历史在桌面与手机上
 * 会显示成两个工具，模型也会学到两套调用习惯。
 *
 * 本判据当前只要求"Host 的 id 是渲染侧的子集 + 参数名一致"；阶段 1 工具迁移完成后，
 * 应升级为"逐个 schema 深度相等"（见 ADR-0001 §6）。
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createHostToolRegistry, globToRegExp, resolveInsideRoot } from "../../packages/host/src/tools";
import { createDefaultToolRegistry } from "../../src/core/llm/tools";
import { needsPreCallSnapshotForCall } from "../../src/core/llm/tool-contract";

describe("HTOOL-1 工具 id 与参数名对得上", () => {
  it("Host 每个工具 id 都能在渲染侧找到（不允许自造 id）", () => {
    const renderer = createDefaultToolRegistry();
    const host = createHostToolRegistry(process.cwd());
    const rendererIds = new Set(renderer.getAll().map((t) => t.id));
    for (const tool of host.getAll()) {
      expect(rendererIds.has(tool.id), `Host 工具 ${tool.id} 在渲染侧不存在`).toBe(true);
    }
  });

  it("read 的必填参数与渲染侧一致（path）", () => {
    const renderer = createDefaultToolRegistry();
    const host = createHostToolRegistry(process.cwd());
    const pick = (r: { getAll(): Array<{ id: string; parameters: Record<string, unknown> }> }) =>
      r.getAll().find((t) => t.id === "read") as { parameters: { required?: string[]; properties?: Record<string, unknown> } };
    const a = pick(renderer);
    const b = pick(host);
    expect(b.parameters.required).toEqual(a.parameters.required);
    for (const key of Object.keys(b.parameters.properties ?? {})) {
      expect(Object.keys(a.parameters.properties ?? {}), `Host read 多出参数 ${key}`).toContain(key);
    }
  });
});

describe("HTOOL-2 工作区边界", () => {
  it("拒绝绝对路径与 .. 逃逸（手机是不可信输入源）", async () => {
    const root = await mkdtemp(join(tmpdir(), "codem-root-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.txt"), "hello", "utf8");

    await expect(resolveInsideRoot(root, "/etc/passwd")).rejects.toThrow(/相对项目根/);
    await expect(resolveInsideRoot(root, "C:\\Windows\\win.ini")).rejects.toThrow(/相对项目根/);
    await expect(resolveInsideRoot(root, "../outside.txt")).rejects.toThrow(/逃出项目根/);

    const ok = await resolveInsideRoot(root, "src/a.txt");
    expect(await readFile(ok, "utf8")).toBe("hello");
  });
});

describe("HTOOL-4 Host 工具契约与桌面同类工具一致", () => {
  /**
   * 第 270 波：Host 的工具以前**不声明契约**，`resolveToolContract` 会兜底成
   * `sideEffectScope: "workspace"` ⇒ 每个只读工具（read/glob/grep）都被算成
   * "改动工作区"⇒ 每迭代白拍一次 git 快照；`bash` 跑 `npx tsc` 也一样。
   *
   * 这条判据钉三件事：
   * 1. 只读工具 `readOnly=true`；
   * 2. 写工具 `workspace`；
   * 3. `bash` 是 `system`，且**验证类命令不算改动**（按命令意图，不按工具名）。
   */
  it("read/glob/grep=readOnly，write/edit=workspace，bash=system", () => {
    const host = createHostToolRegistry(process.cwd(), {
      bash: async () => ({ title: "bash", output: "" }),
      approve: async () => ({ allowed: true }),
    });
    for (const id of ["read", "glob", "grep"]) {
      const c = host.getContract(id);
      expect(c.readOnly, `${id} 必须是只读`).toBe(true);
      expect(c.sideEffectScope).toBe("none");
    }
    for (const id of ["write", "edit"]) {
      const c = host.getContract(id);
      expect(c.readOnly).toBe(false);
      expect(c.sideEffectScope, `${id} 改工作区`).toBe("workspace");
    }
    const bash = host.getContract("bash");
    expect(bash.sideEffectScope).toBe("system");
    expect(bash.readOnly).toBe(false);
  });

  it("bash 的验证命令不触发快照，npm install 触发（契约 + 命令意图）", () => {
    const host = createHostToolRegistry(process.cwd(), {
      bash: async () => ({ title: "bash", output: "" }),
      approve: async () => ({ allowed: true }),
    });
    const bash = host.getContract("bash");
    expect(needsPreCallSnapshotForCall("bash", bash, { command: "npx tsc --noEmit" })).toBe(false);
    expect(needsPreCallSnapshotForCall("bash", bash, { command: "npx vitest run" })).toBe(false);
    expect(needsPreCallSnapshotForCall("bash", bash, { command: "npm install" })).toBe(true);
  });
});

describe("HTOOL-5 敏感读取审批是**宿主 hook**，不是工具参数", () => {
  it("read 的 schema 不新增任何模型可见参数（审批不能由模型自己绕过/伪造）", () => {
    const host = createHostToolRegistry(process.cwd(), {
      approve: async () => ({ allowed: true }),
      sensitiveRead: true,
    });
    const read = host.get("read")!;
    const props = Object.keys((read.parameters as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props.sort()).toEqual(["limit", "line_numbers", "offset", "path"]);
    expect((read.parameters as { required?: string[] }).required).toEqual(["path"]);
    // 审批 hook 只在注册表侧（HostToolHooks），工具参数里没有 approval/approve 之类的键
    for (const key of props) {
      expect(key.toLowerCase()).not.toContain("approv");
    }
  });
});

describe("HTOOL-3 glob 语义", () => {
  it("** 跨目录、* 不跨目录、? 单字符", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
  });

  it("正则元字符按字面匹配（不许把文件名当正则）", () => {
    expect(globToRegExp("a(b).ts").test("a(b).ts")).toBe(true);
    expect(globToRegExp("a(b).ts").test("ab.ts")).toBe(false);
  });
});
