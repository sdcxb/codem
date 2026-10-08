/**
 * ★ 第 186 波判据：**glob 的截断必须是「数据」，不是「异常」**，而且模型必须**看得见**它。
 *
 * ## 钉的是什么缺陷（用户原话）
 *
 * > *"如果真的超过 2 万条，怎么处理呢？仅仅返回错误，并没有解决问题。
 * > 而且我都是批处理超大文件，超过 2 万条很常见。"*
 *
 * 改前：`glob_search` 契约是 `Result<Vec<String>, String>`，超限 ⇒ `Err(...)`。
 * 三重代价 —— ① 拿不到数据（超大目录正是这个工具的用例）；② "匹配很多"与"参数写错"
 * 压成同一种输出；③ 没有下一步。
 *
 * ## 判据
 *
 * | # | 钉什么 |
 * |---|---|
 * | `GLOB-LIMIT-5a` | 超限时**不报错**：`isError: false`，且 `value` 里带 `truncated: true` / `returned` |
 * | `GLOB-LIMIT-5b` | 模型可见文本里有**截断说明**（`<harness>` 块，复用既有诊断口径）+ 完整列表的 **spill 路径** |
 * | `GLOB-LIMIT-5c` | **内联条数有界**：两万条里最多内联 `GLOB_INLINE_MAX`（500）条 —— 1–2 MB token 不许进上下文 |
 * | `GLOB-LIMIT-5d` | 落盘的是**完整返回列表**（不是内联的那 500 条），且走的是既有 spill 机制（会话私有目录 + 时刻文件名） |
 * | `GLOB-LIMIT-5e` | 反例：结果完整时**零变化**（不落盘、不加 `<harness>`、逐字等于旧行为） |
 * | `GLOB-LIMIT-6` | `sdk.glob` 返回**结构化对象**（脚本能看见 `truncated` / `returned`），描述与形状同形（见 `run-code-sdk-contract.test.ts`） |
 *
 * 驱动的是**真实工具** + 真实 `file-api` + 真实 spill 机制（只把最底层 IPC 换成假的），
 * 所以"判据长在没人走的那条链路上"这种假绿在这里不成立。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { createGlobTool } from "../core/llm/tools";
import { createRunCodeTool, __setScriptRunnerForTests } from "../core/llm/tools/run-code";
import type { ToolContext } from "../core/llm/tools";

const WS = "C:/ws";
/** 数据根目录（由 `storage_info` 的库路径推出，见 `data-root.ts`） */
const DATA_ROOT = "C:/data/";
const SESSION = "sess-glob-186";
/** 与工具内的 `GLOB_INLINE_MAX` 一致（判据里写死，改小/改大都必须两处一起动） */
const INLINE_MAX = 500;

const invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];

/** 造 n 条路径（长度贴近真实 Windows 绝对路径，用于量上下文体积） */
function fakeFiles(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${WS}/src/core/module-${String(i).padStart(5, "0")}/file-${i}.ts`);
}

let globPayload: Record<string, unknown>;

function installTauriMock() {
  invokes.length = 0;
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        invokes.push({ command, args });
        if (command === "glob_search") return globPayload;
        if (command === "storage_info") return { path: `${DATA_ROOT}codem-db-rust.bin`, standard: true };
        if (command === "get_app_data_dir") return DATA_ROOT;
        if (command === "check_path_in_workspace") return true;
        if (command === "write_file" || command === "rename_file") return null;
        if (command === "read_file") return "file content";
        return null;
      }),
    },
  };
}

function ctx(cwd = WS): ToolContext {
  return {
    sessionId: SESSION,
    messageId: "m-glob-186",
    cwd,
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
    securityMode: "auto",
  };
}

beforeEach(() => {
  installTauriMock();
});

describe("第 186 波 GLOB-LIMIT-5：glob 的截断是数据，而且模型看得见", () => {
  it("GLOB-LIMIT-5a/5c: 两万条命中 ⇒ 不报错，内联有界，truncated/returned 如实上报", async () => {
    const all = fakeFiles(20_000);
    globPayload = {
      files: all,
      truncated: true,
      depth_limited: false,
      returned: 20_000,
      hint: "at least one more match exists beyond this page of 20000 (offset=0): call again with offset=20000 …",
    };

    const out = await createGlobTool().execute({ pattern: "*.ts" }, ctx());

    expect(out.isError, "★ 超限**不许**再变成错误（改前就是 Err）").toBe(false);
    const value = out.value as {
      files: string[];
      count: number;
      returned: number;
      truncated: boolean;
      spillPath?: string;
    };
    expect(value.truncated, "必须如实说「至少还有更多」").toBe(true);
    expect(value.returned).toBe(20_000);
    expect(value.files.length, "★ 内联必须有界（两万条会撑爆上下文）").toBe(INLINE_MAX);
    expect(value.count).toBe(INLINE_MAX);
  });

  it("GLOB-LIMIT-5b: 模型可见文本里有截断说明 + 完整列表的 spill 路径", async () => {
    const all = fakeFiles(20_000);
    globPayload = {
      files: all,
      truncated: true,
      depth_limited: false,
      returned: 20_000,
      hint: "call again with offset=20000 to keep enumerating",
    };

    const out = await createGlobTool().execute({ pattern: "*.ts" }, ctx());
    const text = String(out.output);

    /**
     * 内联的**只有**前 500 行：第 500 行（0-based 500）就应当是 `<harness>` 块的开头。
     * 这条断言同时钉住"有界"与"截断说明紧跟在内联列表之后"。
     */
    const lines = text.split("\n");
    expect(lines[INLINE_MAX], `第 ${INLINE_MAX + 1} 行必须是 <harness> 块的开头`).toBe("<harness>");
    expect(text, "必须复用既有截断诊断口径（<harness> + [warn]）").toMatch(/<harness>\n\[warn\] /);
    expect(text, "截断说明必须明确说结果被截断").toMatch(/truncated/i);
    expect(text, "必须说明「至少还有更多」").toMatch(/at least one more match/i);
    expect(text, "必须说明内联了几条").toContain(`only the first ${INLINE_MAX} are shown inline`);
    expect(text, "必须原样带上 Rust 侧给的下一步（offset 翻页）").toContain("offset=20000");

    const spillPath = (out.value as { spillPath?: string }).spillPath;
    expect(spillPath, "★ 完整列表必须落盘，且路径要给到模型").toBeTruthy();
    expect(text, "spill 路径必须出现在模型可见文本里").toContain(String(spillPath));
    expect(
      text,
      "完整列表在哪个文件、怎么读，必须说清（否则模型只会以为内联的就是全部）",
    ).toMatch(/the complete returned list is saved at/i);
  });

  it("GLOB-LIMIT-5d: 落盘的是**完整返回列表**，且走既有 spill 机制（会话私有目录 + 时刻文件名）", async () => {
    const all = fakeFiles(20_000);
    globPayload = { files: all, truncated: true, depth_limited: false, returned: 20_000 };

    const out = await createGlobTool().execute({ pattern: "*.ts" }, ctx());
    const spillPath = String((out.value as { spillPath?: string }).spillPath);

    // ① 路径 = 数据根目录 + spill/<sessionId>/<tool>-<epochMs>.txt（`pruneSpillFiles` 认的就是这个形状）
    const normalized = spillPath.replace(/\\/g, "/");
    expect(normalized.startsWith(`${DATA_ROOT}spill/${SESSION}/`), spillPath).toBe(true);
    expect(normalized).toMatch(/\/glob-\d{10,}\.txt$/);

    // ② 内容 = **全部两万条**（不是内联的那 500 条）
    const writes = invokes.filter((i) => i.command === "write_file");
    const tmpWrite = writes.find((i) => String(i.args?.path).endsWith(".tmp"));
    expect(tmpWrite, "溢出写盘必须是原子的（先写 .tmp 再改名，见 spill.ts）").toBeTruthy();
    const content = String(tmpWrite!.args?.content ?? "");
    expect(content.split("\n").length, "★ 落盘的必须是完整列表").toBe(all.length);
    expect(content).toContain(all[all.length - 1]);
    expect(
      invokes.some((i) => i.command === "rename_file"),
      "原子写的第二步（改名）也必须真的发生",
    ).toBe(true);
  });

  it("GLOB-LIMIT-5e: 反向对照 —— 结果完整时零变化（不落盘、不加 <harness>）", async () => {
    globPayload = {
      files: ["C:/ws/a.ts", "C:/ws/b.ts"],
      truncated: false,
      depth_limited: false,
      returned: 2,
    };

    const out = await createGlobTool().execute({ pattern: "*.ts" }, ctx());

    expect(out.isError).toBe(false);
    expect(out.output, "完整结果必须**逐字**等于旧行为").toBe("C:/ws/a.ts\nC:/ws/b.ts");
    expect(out.output).not.toContain("<harness>");
    expect((out.value as { spillPath?: string }).spillPath).toBeUndefined();
    expect(
      invokes.some((i) => i.command === "write_file"),
      "没有截断就不该有任何落盘 I/O（常规搜索零开销）",
    ).toBe(false);
  });

  it("GLOB-LIMIT-5f: 未截断但条数超过内联上限 ⇒ 同样落盘 + 说明（不许把有界当全量）", async () => {
    const all = fakeFiles(900);
    globPayload = { files: all, truncated: false, depth_limited: false, returned: 900 };

    const out = await createGlobTool().execute({ pattern: "*.ts" }, ctx());
    const text = String(out.output);

    expect(out.isError).toBe(false);
    expect((out.value as { files: string[] }).files.length).toBe(INLINE_MAX);
    expect((out.value as { truncated: boolean }).truncated).toBe(false);
    expect(text, "没截断也要说清「只内联了前 500 条」").toContain(`only the first ${INLINE_MAX} are shown inline`);
    expect(text, "并给出完整列表路径").toMatch(/the complete returned list is saved at/i);
    expect((out.value as { spillPath?: string }).spillPath).toBeTruthy();
  });

  it("GLOB-LIMIT-5g: limit/offset 透传到 IPC（模型的「下一页」是可执行的）", async () => {
    globPayload = { files: [], truncated: false, depth_limited: false, returned: 0 };

    await createGlobTool().execute({ pattern: "*.ts", limit: 1000, offset: 20000 }, ctx());

    const call = invokes.find((i) => i.command === "glob_search");
    expect(call?.args?.limit, "★ hint 说「用 offset 翻页」，工具就必须真的收得下这两个参数").toBe(1000);
    expect(call?.args?.offset).toBe(20000);
  });
});

describe("第 186 波 GLOB-LIMIT-6：sdk.glob 的形状是结构化的", () => {
  it("GLOB-LIMIT-6: 脚本通过 sdk.glob 看到的 `{ files, truncated, returned }`，不是裸数组", async () => {
    globPayload = {
      files: [...fakeFiles(3)],
      truncated: true,
      depth_limited: false,
      returned: 3,
      hint: "offset page",
    };
    // 注入脚本前端：把 SDK 的返回值**按脚本里真实的写法**带回（`JSON.stringify`，
    // 判据不需要 Rust 引擎）—— 这也顺带证明"结构化对象能被脚本序列化"，而裸数组不会。
    __setScriptRunnerForTests((async ({ sdk }: { sdk: any }) => {
      const r = await sdk.glob("*.ts");
      return { ok: true, value: JSON.stringify(r), stdout: "", stderr: "" };
    }) as never);

    try {
      const out = await createRunCodeTool().execute({ code: "await sdk.glob('*.ts')" }, ctx());
      expect(out.isError).toBe(false);
      /**
       * `executeCode` 把完成值渲染成 `\n[Result]: <JSON>`（与 SDK-5 同一形态），
       * 所以取**最后一段** `[Result]:` 再解析（前面可能有 stdout）。
       */
      const text = String(out.output);
      const idx = text.lastIndexOf("[Result]:");
      expect(idx, "必须能取到 [Result] 段").toBeGreaterThanOrEqual(0);
      const seen = JSON.parse(text.slice(idx + "[Result]:".length).trim());
      expect(Array.isArray(seen), "★ 不许再是裸数组（`truncated` 会被丢掉）").toBe(false);
      expect(Object.keys(seen).sort()).toEqual(["depth_limited", "files", "hint", "returned", "truncated"]);
      expect(seen.truncated).toBe(true);
      expect(seen.returned).toBe(3);
      expect(seen.files.length).toBe(3);
    } finally {
      __setScriptRunnerForTests(null);
    }
  });
});
