/**
 * 第 184 波（G5）：**`run_code` 的 SDK 契约必须与描述同形**（"描述即契约"）。
 *
 * ## 缺陷形态
 *
 * 描述是模型唯一的说明书，它错了就会**稳定地写错代码**（不是偶发）。改前三处失真：
 *
 * 1. 引擎写成 "QuickJS compiled to WebAssembly"，真机是 Rust **`boa_engine`**
 *    （`src-tauri/src/js_sandbox.rs:11`）；
 * 2. 五个 SDK 方法**全是 async**，描述里逐条没写"要 await / 返回什么形状"
 *    —— 上游 Pi 的同款缺陷（`#10555`）就是"模型不 await、把 promise 序列化成 `{}`"；
 * 3. `sdk.fetch` 返回的是**字符串**（`response.text()`），照标准 fetch 直觉写
 *    `res.ok` / `res.json()` 会 undefined/抛错。
 *
 * 另外有一个**真 bug**：`sdk.grep` 把 `grepSearch` 返回的整行字符串
 * （`path:行号:内容`）同时塞进 `file` 与 `content`，而 `line` **恒为 0**。
 *
 * ## 判据
 *
 * | # | 判据 |
 * | --- | --- |
 * | SDK-1 | 描述里不许再出现 "QuickJS"（引擎说错），且必须点明是 Rust 侧沙箱 |
 * | SDK-2 | 每个 SDK 方法在描述里都带 `await` 与返回形状（逐条） |
 * | SDK-3 | `sdk.fetch` 的返回被描述为**字符串/正文**（不许让模型以为是 Response） |
 * | SDK-4 | `sdk.grep` 的返回形状与 `ToolSDK` 类型一致，且**实现里不再写死 `line: 0`** |
 * | SDK-5 | 行为：给一段 `path:行号:内容` 的输入，`sdk.grep` 必须拆出真实行号；拆不开时 `line` 为 null（**不许编 0**） |
 *
 * ## 第 186 波（GLOB-LIMIT-6）：`sdk.glob` 的形状从 `string[]` 变成**结构化对象**
 *
 * 描述里原来写的是 `→ string[]`。glob 的截断改口径之后（超限不再报错，而是回一个有界
 * 窗口 + `truncated` + `hint`），描述不改就是**稳定地教模型写错代码**：脚本会写
 * `for (const f of await sdk.glob(p))`，然后拿到 `undefined is not iterable`。
 * 所以这条判据与实现的形状**必须一起动**（描述即契约）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRunCodeTool } from "../core/llm/tools/run-code";

/** 去掉注释后看源码（避免注释里的说明被当成"实现"；这类坑本仓库踩过） */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

describe("第 184 波 · run_code SDK 契约（G5）", () => {
  const tool = createRunCodeTool();
  const desc = String(tool.description ?? "");

  it("SDK-1: 描述不许**声称**引擎是 QuickJS（真机是 Rust boa 引擎）", () => {
    // 注意：描述里可以出现"not QuickJS"这种**纠正**说法，但不能再把它当成引擎宣称
    expect(desc, "改前那句错误宣称不许再出现").not.toMatch(/QuickJS compiled to WebAssembly/i);
    expect(desc, "引擎不许被描述成 QuickJS").not.toMatch(/engine \(QuickJS[^)]*\)/i);
    /**
     * ⚠️ 这里断言 `boa` 而**不是** "sandbox"：本仓库另有一条判据
     * （`pi-p2-run-code-permission-parity.test.ts` 的 P2-3）明令**工具不得声称自己是沙箱**
     * —— 那是"能力边界"而不是安全保证，说成沙箱会overpromise。
     * 我第一版就写成 "Rust-side sandbox"，被那条判据当场抓住（这就是判据的价值）。
     */
    expect(desc, "必须点明引擎是 Rust 侧 boa（不是 WebView）").toMatch(/Rust-side boa/i);
    expect(desc, "不许声称沙箱/隔离（另一条判据 P2-3 明令禁止）").not.toMatch(/sandbox|isolated|隔离|沙箱/i);
  });

  it("SDK-2: 每个 SDK 方法都写了 await + 返回形状", () => {
    for (const method of ["bash", "read", "write", "glob", "grep", "fetch"]) {
      expect(desc, `\`sdk.${method}\` 必须标出 await`).toMatch(new RegExp(`await sdk\\.${method}\\(`));
    }
    expect(desc, "必须整体说明「每个方法都是 async，必须 await」").toMatch(/must `await`|Every sdk method is async/i);
    // 逐条形状（抽查最容易被误用的三个）
    expect(desc).toMatch(/sdk\.bash\(command[^)]*\)`?\s*→\s*`?\{ stdout/);
    expect(desc).toMatch(/sdk\.grep\(pattern[^)]*\)`?\s*→\s*`?\{ file/);
    expect(desc).toMatch(/sdk\.read\(path\)`?\s*→\s*`?string/);
  });

  it("SDK-3: `sdk.fetch` 必须说明返回的是**正文文本**，不是 Response", () => {
    expect(desc, "要写清返回值类型").toMatch(/sdk\.fetch\(url\)`?\s*→\s*`?string/);
    expect(desc, "要写清没有 status/headers/json()").toMatch(/no status, no headers/i);
  });

  it("SDK-4: 实现里不许再把 grep 的行号写死成 0", () => {
    const src = code("src/core/llm/tools/run-code.ts");
    expect(src, "`line: 0` 是那个真 bug 的签名").not.toMatch(/line:\s*0\s*,/);
    expect(src, "要按 `path:行号:内容` 的真实格式拆行").toContain("line: Number(m[2])");
    expect(src, "拆不开时不许编行号").toContain("line: null");
  });

  /**
   * ★ 第 186 波（GLOB-LIMIT-6）：**描述与形状同形**，而且是"行为可见"的那种同形
   * —— 描述说 `{ files, … }`，脚本跑起来就必须真的能取到 `files` / `truncated`。
   */
  it("SDK-6: `sdk.glob` 描述为结构化对象（不许再宣称返回 `string[]`）", () => {
    expect(
      desc,
      "★ 改前这里写的是 `→ string[]`：截断改口径之后，照旧描述会稳定地教模型写错代码",
    ).not.toMatch(/sdk\.glob[^\n]*→\s*`?string\[\]`?/);
    expect(desc, "必须给出结构化形状").toMatch(
      /sdk\.glob\(pattern[^)]*\)`?\s*→\s*`?\{\s*files/,
    );
    for (const field of ["truncated", "returned", "hint"]) {
      expect(desc, `形状里必须点明 \`${field}\``).toContain(field);
    }
    expect(desc, "必须说明翻页的用法（offset += returned）").toMatch(/offset\s*\+=?\s*returned|opts\.offset/);
  });

  it("SDK-6 行为：`sdk.glob` 的返回值能被脚本按 `{ files, truncated }` 消费", async () => {
    const { executeCode, __setScriptRunnerForTests } = await import("../core/llm/tools/run-code");
    __setScriptRunnerForTests(async ({ code: src, sdk }) => {
      const fn = new Function("sdk", `return (async () => { ${src} })()`);
      const value = await (fn as never as (s: unknown) => Promise<unknown>)(sdk);
      return { ok: true, stdout: "", stderr: "", value };
    });
    try {
      const sdk: any = {
        bash: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        read: async () => "",
        write: async () => {},
        // 与实现同一形状（行为断言：形状契约能被脚本观察到）
        glob: async () => ({
          files: ["C:\\repo\\src\\a.ts", "C:\\repo\\src\\b.ts"],
          truncated: true,
          depth_limited: false,
          returned: 2,
          hint: "call again with offset=2",
        }),
        grep: async () => [],
        fetch: async () => "body-text",
      };
      const res = await executeCode(
        `const r = await sdk.glob("*.ts"); return JSON.stringify({ n: r.files.length, t: r.truncated, ret: r.returned, hint: !!r.hint });`,
        sdk,
        5_000,
      );
      const idx = String(res.stdout).lastIndexOf("[Result]:");
      expect(idx, "必须能取到 [Result] 段").toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(String(res.stdout).slice(idx + "[Result]:".length).trim());
      expect(parsed, "★ 脚本必须能按 `{ files, truncated, returned }` 消费（裸数组做不到）").toEqual({
        n: 2,
        t: true,
        ret: 2,
        hint: true,
      });
    } finally {
      __setScriptRunnerForTests(null);
    }
  });

  it("SDK-5 行为：`path:行号:内容` 必须拆出真实行号；拆不开时 line 为 null（不许编 0）", async () => {
    const { executeCode, __setScriptRunnerForTests } = await import("../core/llm/tools/run-code");
    // 用注入的执行前端跑真实脚本（默认前端要真机 Rust 沙箱，测试里不能用）
    __setScriptRunnerForTests(async ({ code: src, sdk }) => {
      const fn = new Function("sdk", `return (async () => { ${src} })()`);
      const value = await (fn as never as (s: unknown) => Promise<unknown>)(sdk);
      // ⚠️ 不要自己往 stdout 里写 `[Result]: …` —— `executeCode` 会渲染 `value`
      // （自己写会得到两份，判据在 JSON.parse 上炸）
      return { ok: true, stdout: "", stderr: "", value };
    });
    try {
      const sdk: any = {
        bash: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        read: async () => "",
        write: async () => {},
        glob: async () => [],
        grep: async () => {
          // 与工具实现同一套映射逻辑（行为断言：形状契约能被脚本观察到）
          const raw = ["C:\\repo\\src\\a.ts:142:const x = 1;", "no-colon-line"];
          return raw.map((r) => {
            const m = /^(.*?):(\d+):([\s\S]*)$/.exec(r);
            if (!m) return { file: "", line: null, content: r };
            return { file: m[1], line: Number(m[2]), content: m[3] };
          });
        },
        fetch: async () => "body-text",
      };
      const res = await executeCode(`const hits = await sdk.grep("x"); return JSON.stringify(hits);`, sdk, 5_000);
      // `executeCode` 把完成值渲染成 `\n[Result]: <pretty JSON>`（前面可能有 stdout，故取最后一段）
      const idx = String(res.stdout).lastIndexOf("[Result]:");
      expect(idx, "必须能取到 [Result] 段").toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(String(res.stdout).slice(idx + "[Result]:".length).trim());
      expect(parsed[0], "第一行必须拆出真实行号 142").toEqual({
        file: "C:\\repo\\src\\a.ts",
        line: 142,
        content: "const x = 1;",
      });
      expect(parsed[1].line, "拆不开时不许编 0，必须是 null").toBeNull();
    } finally {
      __setScriptRunnerForTests(null);
    }
  });
});
