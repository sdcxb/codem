/**
 * WF-GLOB：`workflow` 的 SDK 必须**有 `glob`**，而且与 `run_code` 的 `sdk.glob` 同形。
 *
 * ## 缺陷（改前）
 *
 * `WorkflowSDK`（`workflow-engine.ts`）只有 spawn / wait / bash / read / write ——
 * 工作流脚本里**没有列文件的办法**（模型只能靠 `sdk.bash` 绕），而 `run_code` 的
 * `sdk.glob` 早就有结构化实现（第 186 波：`{ files, truncated, depth_limited, returned, hint? }`）。
 *
 * ## 照抄同形（不另造一套）
 *
 * | # | 钉什么 |
 * |---|---|
 * | `WF-GLOB-1` | 行为：脚本里 `await sdk.glob(p)` 拿到的**是结构化对象**（`files` 是数组、`truncated` 是布尔）；**反向对照**：把裸数组喂给同一条判定必须不合格（改回裸数组 ⇒ 必红） |
 * | `WF-GLOB-2` | **工作区必须传下去**：记录式替身截获 `globSearch` 的实参，`options.workspace === ctx.cwd`；省略 `path` 时默认搜索路径就是工作区；`limit`/`offset` 透传；provider 路径（`execWorkflow`）同样 |
 * | `WF-GLOB-3` | **描述即契约**：guidance/description 里出现了 glob 能力，且描述里点名的字段集合**逐字等于**真实返回的键集合（改回 `string[]` ⇒ 必红） |
 * | `WF-GLOB-4` | 桥不许吞参数：`hostMethodsFromToolSdk` 把 guest 的第三个实参（`opts`）原样转给 `sdk.glob` |
 *
 * ⚠️ 沙箱**开关**那两个方向（开 ⇒ 越界被拒 / 关 ⇒ 同一个越界调用必须成功）在
 * `workflow-sdk-glob-sandbox-mode.test.ts` —— 那份文件走**真实 `file-api`**，
 * 本文件为了量参数与形状把 `file-api` 换成了记录式替身。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WS = "C:/ws";

const mocks = vi.hoisted(() => ({ globSearch: vi.fn() }));

vi.mock("../core/file-api", () => ({
  globSearch: (...a: unknown[]) => mocks.globSearch(...a),
  readFile: async () => "",
  writeFile: async () => undefined,
  listDirectory: async () => [],
  executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  grepSearch: async () => [],
}));

import { createWorkflowTool, execWorkflow } from "../core/llm/workflow-engine";
import { hostMethodsFromToolSdk } from "../core/js/js-remote-runtime";
import type { ToolContext } from "../core/llm/tools";
import { installScriptRunnerDouble, uninstallScriptRunnerDouble } from "./helpers/script-runner-double";

/** 与 `file-api.GlobSearchResult` 同一形状（`hint` 也在 —— 判据要比对键集合） */
const PAYLOAD = {
  files: [`${WS}/src/a.ts`, `${WS}/src/b.ts`],
  truncated: true,
  depth_limited: false,
  returned: 2,
  hint: "call again with offset=2",
};

function ctx(cwd: string = WS): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-message",
    cwd,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    securityMode: "auto",
  } as ToolContext;
}

/**
 * 判据的**判定力自证**：脚本消费 glob 结果的写法（`files` 是数组 + `truncated` 是布尔）。
 * 拿裸数组喂它必须是 `false` —— 否则"结构化"这条断言证明不了任何事。
 */
function looksStructured(v: unknown): boolean {
  const r = v as { files?: unknown; truncated?: unknown } | null;
  return Array.isArray(r?.files) && typeof r?.truncated === "boolean";
}

/** 跑脚本、收回 `[Result]:` 段（`executeCode` 的既有渲染） */
function resultOf(output: string): unknown {
  const idx = output.lastIndexOf("[Result]:");
  expect(idx, "必须能取到 [Result] 段").toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(idx + "[Result]:".length).trim());
}

beforeEach(() => {
  installScriptRunnerDouble();
  mocks.globSearch.mockReset();
  mocks.globSearch.mockResolvedValue(PAYLOAD);
});

afterEach(() => {
  uninstallScriptRunnerDouble();
  mocks.globSearch.mockReset();
});

describe("WF-GLOB-1: 脚本里 sdk.glob 拿到的是结构化结果", () => {
  it("WF-GLOB-1: `files` 是数组、`truncated` 是布尔、键集合完整（裸数组做不到）", async () => {
    const out = await createWorkflowTool().execute(
      {
        code: `const r = await sdk.glob('*.ts');
return JSON.stringify({ isArray: Array.isArray(r), keys: Object.keys(r).sort(), files: r.files, n: r.files.length, truncated: r.truncated, returned: r.returned, hint: r.hint });`,
      },
      ctx(),
    );

    expect(out.isError, `脚本不该失败（实际输出：${out.output}）`).toBe(false);
    const seen = resultOf(String(out.output)) as Record<string, unknown>;

    expect(seen.isArray, "★ 不许是裸数组（`truncated` 会被丢掉）").toBe(false);
    expect(seen.truncated, "★ 截断是布尔事实").toBe(true);
    expect(seen.returned).toBe(2);
    expect(seen.n).toBe(2);
    expect(seen.hint).toBe(PAYLOAD.hint);
    expect(seen.keys).toEqual(["depth_limited", "files", "hint", "returned", "truncated"]);
    expect(looksStructured(seen), "★ 判定力自证：同一段消费逻辑必须认可它").toBe(true);
  });

  it("WF-GLOB-1 反向对照：把裸数组喂给同一段消费逻辑必须不合格", () => {
    expect(
      looksStructured([`${WS}/a.ts`]),
      "★ 若某个版本把 `globSearch` 拆成裸数组，本判据必须能红 —— 这条就是它的判定力证明",
    ).toBe(false);
    expect(looksStructured(null)).toBe(false);
    expect(looksStructured(PAYLOAD), "正向：结构化对象必须通过").toBe(true);
  });
});

describe("WF-GLOB-2: 工作区必须传下去（读侧沙箱的唯一依据）", () => {
  it("WF-GLOB-2a: 省略 path ⇒ 搜索路径是工作区，且 workspace 原样传下去", async () => {
    await createWorkflowTool().execute({ code: "await sdk.glob('*.ts');" }, ctx());

    expect(mocks.globSearch, "★ 必须真的走既有通道（不许自己拼 invoke / 自己拼实现）").toHaveBeenCalledTimes(1);
    const [pattern, searchPath, options] = mocks.globSearch.mock.calls[0];
    expect(pattern).toBe("*.ts");
    expect(searchPath, "省略 path ⇒ 默认就是工作区（与 run_code 同形）").toBe(WS);
    /**
     * ★ 这一条是"沙箱整条不生效"的挡板：`file-api` 的判定是
     * 「没给 workspace 就不检查」（`assertWithinWorkspace`），所以这里必须是 WS，
     * 不是 `undefined`（第 185 波就是这么把 `execWorkflow` 的沙箱摘掉的）。
     */
    expect(options, "★ workspace 不许丢成 undefined").toEqual({
      workspace: WS,
      limit: undefined,
      offset: undefined,
    });
  });

  it("WF-GLOB-2b: 显式 path 与 limit/offset 原样透传", async () => {
    await createWorkflowTool().execute(
      { code: "await sdk.glob('**/*.ts', 'src', { limit: 5, offset: 10 });" },
      ctx(),
    );

    expect(mocks.globSearch.mock.calls[0]).toEqual([
      "**/*.ts",
      "src",
      { workspace: WS, limit: 5, offset: 10 },
    ]);
  });

  it("WF-GLOB-2c: provider 路径（execWorkflow）的 cwd 也是工作区（别漏回来）", async () => {
    await execWorkflow("await sdk.glob('*.ts');", { cwd: WS, sessionId: "s-wf-glob" });

    const [, searchPath, options] = mocks.globSearch.mock.calls[0];
    expect(searchPath).toBe(WS);
    expect((options as { workspace?: string }).workspace, "★ execWorkflow 的 ctx.cwd 必须到这一层").toBe(WS);
  });
});

describe("WF-GLOB-3: 描述即契约（工作流工具必须告诉模型 glob 的形状）", () => {
  const tool = createWorkflowTool();
  const desc = String(tool.description ?? "");
  const guidance = String(tool.guidance ?? "");

  it("WF-GLOB-3a: guidance 与 description 里都出现了 glob 能力", () => {
    expect(guidance, "模型先看的是 guidance —— 那里必须能看出工作流能列文件").toMatch(/sdk\.glob/);
    expect(desc, "说明书里必须有这一行").toMatch(/sdk\.glob\(pattern/);
  });

  it("WF-GLOB-3b: 描述不许宣称返回 `string[]`，且点名的字段集合 == 真实返回的键集合", () => {
    expect(
      desc,
      "★ 照旧描述会稳定地教模型写错代码（`for (const f of await sdk.glob(p))` 会炸）",
    ).not.toMatch(/sdk\.glob[^\n]*→\s*`?string\[\]`?/);

    const line = desc.split("\n").find((l) => l.includes("sdk.glob(pattern"));
    expect(line, "必须有逐字的形状说明").toBeTruthy();
    expect(line!, "要写成 `→ { files … }` 的结构化形状").toMatch(/→\s*`?\{\s*files/);
    expect(line!, "要说明翻页用法").toMatch(/offset\s*\+=\s*returned|opts\.offset/);

    // 描述里点名的字段（`files` / `truncated: …`）必须就是真实返回的键 —— 一个不多一个不少
    const shape = /\{([^}]*)\}/.exec(line!);
    expect(shape, "形状块必须可解析（判据自己先红，不许静默通过）").toBeTruthy();
    const declared = [...shape![1].matchAll(/([a-z_]+)\??\s*:/g)].map((m) => m[1]).sort();
    expect(declared, "★ 描述与真实形状必须同一个字段集合").toEqual(
      Object.keys(PAYLOAD).sort(),
    );
  });
});

describe("WF-GLOB-4: 宿主桥不许吞掉 guest 传的 opts", () => {
  it("WF-GLOB-4: `hostMethodsFromToolSdk` 把第三个实参转给 sdk.glob", async () => {
    const calls: unknown[][] = [];
    const methods = hostMethodsFromToolSdk({
      glob: (...a: unknown[]) => {
        calls.push(a);
        return Promise.resolve(PAYLOAD);
      },
    } as never);

    const out = await (methods.glob as unknown as (args: unknown[]) => Promise<unknown>)([
      "*.ts",
      "src",
      { limit: 5, offset: 10 },
    ]);

    expect(calls[0], "★ guest 给的 limit/offset 必须在桥上活着（描述里承诺了它们）").toEqual([
      "*.ts",
      "src",
      { limit: 5, offset: 10 },
    ]);
    expect(out).toEqual(PAYLOAD);
  });
});
