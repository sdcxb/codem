/**
 * Provider 分类审计判据（tools/audit/provider-audit.mjs 的契约）。
 *
 * 两类断言分开写，避免把「分类规则」和「当前仓库快照」绑死：
 *  ① **纯函数判据**：用合成输入驱动 buildAudit / checkAgainstJson，验证
 *     剥注释、消费方识别、inject-only 分类、副作用识别、市场锚、--check 漂移；
 *  ② **真实清单契约**：只断言「结构合法 + wrapper 不带市场锚/inject + 每个 provide 有 kind」
 *     这类不随条目增减变化的规则；具体条目数量与名单不写死（改代码不该让判据假红）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KINDS,
  PATHS,
  buildAudit,
  checkAgainstJson,
  stripComments,
} from "../../tools/audit/provider-audit.mjs";

const ROOT = process.cwd();

interface AuditFile {
  path: string;
  text: string;
}

function audit(files: AuditFile[], yaml = "", registry = "") {
  return buildAudit(files, yaml, registry);
}

function entryOf(doc: { entries: Array<Record<string, any>> }, plugin: string) {
  const found = doc.entries.find((entry) => entry.plugin === plugin);
  expect(found, "清单里应有 " + plugin).toBeTruthy();
  return found as Record<string, any>;
}

function providedServices(doc: { entries: Array<Record<string, any>> }): string[] {
  return doc.entries.flatMap((entry) => entry.provides as string[]);
}

/* ------------------------------------------------------------------ */
/* ① 纯函数：分类规则                                                   */
/* ------------------------------------------------------------------ */

describe("provider-audit：剥注释 / 字符串里的 provide 不算", () => {
  it("JSDoc 与行注释里的 ctx.provide 不算提供", () => {
    const files: AuditFile[] = [
      {
        path: "src/core/provider/comment-provider.ts",
        text: [
          "/**",
          " * 示例：ctx.provide('myService', { hello: () => 'world' })",
          " */",
          "// ctx.provide('lineCommentService', {})",
          "export const x = 1",
        ].join("\n"),
      },
      {
        path: "src/core/provider/real-provider.ts",
        text: "ctx.provide('realService', {})",
      },
    ];
    const doc = audit(files);
    const services = providedServices(doc);
    expect(services).toContain("realService");
    expect(services).not.toContain("myService");
    expect(services).not.toContain("lineCommentService");
  });

  it("字符串字面量里的 ctx.provide 不算提供（工具描述里的示例代码）", () => {
    const files: AuditFile[] = [
      {
        path: "src/core/llm/example-description.ts",
        text: [
          "export const description = \"示例：`ctx.provide('myService', {})`\";",
          "// 真正的提供在另一个文件",
        ].join("\n"),
      },
    ];
    expect(providedServices(audit(files))).not.toContain("myService");
  });

  it("正则字面量里的引号不会把后续代码吞成字符串（web-fetch 的 .replace(/[\\\"']/g) 形态）", () => {
    const files: AuditFile[] = [
      {
        path: "src/core/provider/after-regex-provider.ts",
        text: [
          "function clean(text: string) {",
          "  return text.replace(/^[\"']|[\"']$/g, '')",
          "}",
          "ctx.provide('afterRegexService', {})",
        ].join("\n"),
      },
    ];
    expect(providedServices(audit(files))).toContain("afterRegexService");
    // stripComments 输出必须与输入等长（masked 与 stripped 靠偏移对齐）
    const source = files[0].text;
    expect(stripComments(source).length).toBe(source.length);
  });
});

describe("provider-audit：消费方识别", () => {
  it("getCtxService('x') 算消费（kind 从 wrapper 抬成 service）", () => {
    const files: AuditFile[] = [
      { path: "src/core/provider/x-provider.ts", text: "ctx.provide('x', {})" },
      { path: "src/core/llm/use-x.ts", text: "const x = getCtxService('x')" },
    ];
    const entry = entryOf(audit(files), "@codem/x");
    expect(entry.kind).toBe("service");
    expect(entry.consumers).toContain("src/core/llm/use-x.ts:getCtxService");
  });

  it("六种取服务写法 + 可选链都算消费", () => {
    const files: AuditFile[] = [
      { path: "src/core/provider/x-provider.ts", text: "ctx.provide('x', {})" },
      {
        path: "src/core/llm/all-consumers.ts",
        text: [
          "const a = ctx.get('x')",
          "const b = getCtxService('x')",
          "const c = _getOrFallback('x', () => null)",
          "const d = waitForService('x')",
          "const e = getServiceAsync('x')",
          "const f = getServiceSync('x')",
          "const g = ctx?.get?.('x')",
        ].join("\n"),
      },
    ];
    const entry = entryOf(audit(files), "@codem/x");
    expect(entry.consumers).toEqual(
      expect.arrayContaining([
        "src/core/llm/all-consumers.ts:get",
        "src/core/llm/all-consumers.ts:getCtxService",
        "src/core/llm/all-consumers.ts:_getOrFallback",
        "src/core/llm/all-consumers.ts:waitForService",
        "src/core/llm/all-consumers.ts:getServiceAsync",
        "src/core/llm/all-consumers.ts:getServiceSync",
      ])
    );
    // 可选链与普通 .get 归到同一方法标签，去重后只有一条
    expect(
      entry.consumers.filter((item: string) => item === "src/core/llm/all-consumers.ts:get")
    ).toHaveLength(1);
  });

  it("provider 自己文件里的 ctx.get 不算自己的消费方", () => {
    const files: AuditFile[] = [
      {
        path: "src/core/provider/self-provider.ts",
        text: "const s = ctx.get('selfService')\nctx.provide('selfService', s)",
      },
    ];
    const entry = entryOf(audit(files), "@codem/self");
    expect(entry.consumers.filter((item: string) => item.startsWith(entry.file + ":"))).toHaveLength(0);
  });
});

describe("provider-audit：inject / 副作用 / 市场锚 / dynamic", () => {
  it("无消费方、只有 inject ⇒ inject-dependency", () => {
    const files: AuditFile[] = [
      { path: "src/core/provider/lonely-provider.ts", text: "ctx.provide('lonely', {})" },
    ];
    const yaml = [
      "- id: consumer",
      "  name: '@codem/consumer'",
      "  inject: [lonely]",
      "",
    ].join("\n");
    const entry = entryOf(audit(files, yaml), "@codem/lonely");
    expect(entry.kind).toBe("inject-dependency");
    expect(entry.injectDependents).toContain("@codem/consumer");
  });

  it("有 registerProvider 的 provider 不被判 wrapper", () => {
    const files: AuditFile[] = [
      { path: "src/core/provider/llm-main-provider.ts", text: "ctx.provide('llm', {})" },
      {
        path: "src/core/provider/llm-x-provider.ts",
        text: [
          "const llm = ctx.get('llm')",
          "if (llm && llm.registerProvider) llm.registerProvider('x', provider)",
          "ctx.provide('llmX', provider)",
        ].join("\n"),
      },
    ];
    const entry = entryOf(audit(files), "@codem/llm-x");
    expect(entry.sideEffects).toContain("llm.registerProvider");
    expect(entry.kind).toBe("registration");
    expect(entry.kind).not.toBe("wrapper");
  });

  it("市场锚存在时 kind 不是 wrapper", () => {
    const files: AuditFile[] = [
      { path: "src/core/provider/foo-provider.ts", text: "ctx.provide('foo', {})" },
      {
        path: PATHS.market,
        text: "export const DSH_MARKET_CATALOG = [{ dshName: '@deepseek-ai/dsh-foo', codemAnchor: '@codem/foo', status: 'bundled' }]",
      },
    ];
    const entry = entryOf(audit(files), "@codem/foo");
    expect(entry.marketAnchors).toEqual(["@deepseek-ai/dsh-foo"]);
    expect(entry.kind).not.toBe("wrapper");
    expect(entry.reason).toContain("市场锚");
  });

  it("运行期无界名记 dynamic，不写进静态服务清单", () => {
    const files: AuditFile[] = [
      {
        path: "src/core/provider/dynamic-runner-provider.ts",
        text: [
          "ctx.provide('dynamicCordisRunner', {})",
          "const dispose = ctx.provide(descriptor.name, service)",
        ].join("\n"),
      },
    ];
    const entry = entryOf(audit(files), "@codem/dynamic-runner");
    expect(entry.kind).toBe("dynamic");
    expect(entry.provides).toEqual(["dynamicCordisRunner"]);
    expect(entry.reason).toContain("descriptor.name");
  });
});

describe("provider-audit：--check 漂移判红", () => {
  function synthetic() {
    return audit(
      [{ path: "src/core/provider/stable-provider.ts", text: "ctx.provide('stable', {})" }],
      "",
      ""
    );
  }

  it("清单一致 ⇒ 绿", () => {
    const generated = synthetic();
    expect(checkAgainstJson(generated, JSON.stringify(generated)).ok).toBe(true);
  });

  it("代码多出一条（已提交清单没有）⇒ 判红并指出新增条目", () => {
    const committed = synthetic();
    const coded = JSON.parse(JSON.stringify(committed));
    coded.entries.push({
      plugin: "@codem/extra",
      file: "src/core/provider/extra-provider.ts",
      provides: ["extra"],
      kind: "service",
      consumers: [],
      injectDependents: [],
      marketAnchors: [],
      sideEffects: [],
      switchable: false,
      reason: "hand-added",
    });
    const result = checkAgainstJson(coded, JSON.stringify(committed));
    expect(result.ok).toBe(false);
    expect(result.added).toContain("@codem/extra|src/core/provider/extra-provider.ts");
  });

  it("代码改了一个字段（已提交清单还是旧值）⇒ 判红并指出字段", () => {
    const committed = synthetic();
    const coded = JSON.parse(JSON.stringify(committed));
    // 合成输入里 @codem/stable 本来是 wrapper（无消费方），改成 registration 模拟代码变化
    expect(coded.entries[0].kind).toBe("wrapper");
    coded.entries[0].kind = "registration";
    const result = checkAgainstJson(coded, JSON.stringify(committed));
    expect(result.ok).toBe(false);
    expect(result.changed[0].fields).toContain("kind");
  });

  it("JSON 坏掉 ⇒ 判红（不当成空清单放行）", () => {
    const result = checkAgainstJson(synthetic(), "{ not json");
    expect(result.ok).toBe(false);
    expect(result.parseError).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* ② 真实清单：只断言结构契约                                           */
/* ------------------------------------------------------------------ */

describe("provider-audit：提交的清单纯函数契约", () => {
  const raw = readFileSync(join(ROOT, PATHS.out), "utf8");
  const doc = JSON.parse(raw) as {
    entries: Array<Record<string, any>>;
    duplicates: Record<string, string[]>;
    summary: { kinds: Record<string, number>; total: number };
  };

  it("每条都有完整字段，kind 在枚举内", () => {
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries.length).toBeGreaterThan(0);
    for (const entry of doc.entries) {
      expect(typeof entry.plugin, JSON.stringify(entry)).toBe("string");
      expect(typeof entry.file).toBe("string");
      expect(Array.isArray(entry.provides)).toBe(true);
      expect(KINDS).toContain(entry.kind);
      expect(Array.isArray(entry.consumers)).toBe(true);
      expect(Array.isArray(entry.injectDependents)).toBe(true);
      expect(Array.isArray(entry.marketAnchors)).toBe(true);
      expect(Array.isArray(entry.sideEffects)).toBe(true);
      // 只断言是布尔：switchable 允许后续人工把「明确非 core + 可逆」的条目翻成 true
      expect(typeof entry.switchable).toBe("boolean");
      expect(typeof entry.reason).toBe("string");
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("每个 provide 都落在一条有 kind 的条目上", () => {
    const withKind = new Set<string>();
    for (const entry of doc.entries) {
      if (!KINDS.includes(entry.kind)) continue;
      for (const service of entry.provides) withKind.add(service);
    }
    for (const service of providedServices(doc)) {
      expect(withKind.has(service), "服务 " + service + " 缺少带 kind 的条目").toBe(true);
    }
  });

  it("wrapper 不带市场锚 / inject 依赖 / 消费方 / 副作用", () => {
    const auditDoc = JSON.parse(readFileSync("src/core/provider/provider-audit.json", "utf8")) as { entries: Array<{ plugin: string; kind: string }> };
    const wrappers = auditDoc.entries.filter((entry) => entry.kind === "wrapper");
    for (const wrapper of wrappers) {
      expect(wrapper.marketAnchors, wrapper.plugin + " 有市场锚却判 wrapper").toEqual([]);
      expect(wrapper.injectDependents, wrapper.plugin + " 有人 inject 却判 wrapper").toEqual([]);
      expect(wrapper.consumers, wrapper.plugin + " 有消费方却判 wrapper").toEqual([]);
      expect(wrapper.sideEffects, wrapper.plugin + " 有副作用却判 wrapper").toEqual([]);
    }
  });

  it("summary 的 kind 计数与 entries 对齐", () => {
    expect(doc.summary.total).toBe(doc.entries.length);
    for (const kind of KINDS) {
      const actual = doc.entries.filter((entry) => entry.kind === kind).length;
      expect(doc.summary.kinds[kind], kind + " 计数漂移").toBe(actual);
    }
  });
});

describe("SERVICE-17：wrapper 不许出现假开关", () => {
  it("每个 wrapper 插件在注册表里都是 core（UI 不可关闭）", () => {
    const registry = readFileSync("src/core/plugin-loader/builtin-registry.ts", "utf8");
    const auditDoc = JSON.parse(readFileSync("src/core/provider/provider-audit.json", "utf8")) as {
      entries: Array<{ plugin: string; kind: string }>;
    };
    const wrappers = auditDoc.entries.filter((entry) => entry.kind === "wrapper");
    expect(wrappers.length).toBeGreaterThan(0);
    for (const wrapper of wrappers) {
      const line = registry
        .split("\n")
        .find((l) => l.includes("registerBuiltinPlugin('" + wrapper.plugin + "'"));
      expect(line, wrapper.plugin + " 未在注册表登记").toBeTruthy();
      expect(/\bcore:\s*true\b/.test(line!), wrapper.plugin + " 是 wrapper 却不是 core").toBe(true);
    }
  });
});
