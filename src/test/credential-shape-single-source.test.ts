/**
 * **凭据形状的单一来源**判据（第 188 波 R5 收口）。
 *
 * ## 现场：`sk-` 形状曾经有**四份**实现，而且互相漂移
 *
 * 收口前实测（AST 扫描，见 `CS-ONE-SOURCE`）：
 *
 * | 出口 | 位置 | `sk-` 形状 | 真机后果 |
 * | --- | --- | --- | --- |
 * | 导出脱敏 + **凭据普查** | `core/settings/settings.ts` 的 `CREDENTIAL_VALUE_RES` | 正文**只允许字母数字** | 认不出 `sk-proj-…` / `sk-ant-api03-…` ⇒ **普查假阴性**：设置里明明躺着明文密钥，界面却什么都不说 |
 * | 记忆/日志脱敏 | `core/utils/redact.ts` | 强前缀 `sk-`/`pk-`（正确口径） | —— |
 * | 工具参数安全警告 | `core/llm/streaming-executor.ts` | 正文只允许字母数字 | 模型把 `sk-proj-…` 写进文件时**不警告** |
 * | 工具参数安全审计 | `core/llm/tool-pipeline.ts` | 同上 | 同上 |
 *
 * 第 49 波只修了`普查`那一份（`redact.ts` 一字未动），第 188 波 R3 又只修了 `redact.ts`
 * 那一份 —— **同一规则的第二份实现**就是这么长出来的：每修一次只修看得见的那一处。
 *
 * ## 判据（三张表，逐条断言；`settings.ts` 只许**引用**共享来源）
 *
 * | 判据 | 断言 | 变异 |
 * | --- | --- | --- |
 * | `CS-TOKENS` | 普查认得出**真实令牌表**（含 `sk-proj-…`、`sk-ant-api03-…`、大写、`sk-…-x`、`sk-…_extra`、`OPENAI_API_KEY-…`） | 把普查改回窄口径 ⇒ 红 |
 * | `CS-PATHS` | **误报表**（`task-sk-…`、`risk-sk-…`、`C:\work\key-…\src`、`feat/key-…`、路径段 `api_key-…`）逐条 0 命中，且**逐字不变**（普查与脱敏两个出口都不许动它） | 去掉前边界 / 把裸 `key-` 加回前缀表 ⇒ 红 |
 * | `CS-ONE-SOURCE` | ①普查表逐条就是共享来源里的**同一批正则对象**；②`redact.ts`/`settings.ts` 都 `import` 共享来源；③**生产代码里"定义 sk- 形状"的正则字面量只出现在一个文件** | 在 `settings.ts` 里另写一份旧口径 ⇒ 红 |
 *
 * 反例对照（**证明这些样本真在打击面内**，而不是在测空气）：`CS-PATHS` 的每一行都登记了
 * `legacyHit` —— 第 187 波之前那两份口径（脱敏那份 / 普查那份）**必须**打中它。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

import { censusCredentialSettings } from "../core/storage/credential-census";
import {
  CREDENTIAL_SHAPE_LABELS,
  CREDENTIAL_VALUE_RES,
  redactCredentialShapes,
} from "../core/settings/settings";
import { CREDENTIAL_VALUE_SHAPES, credentialShape } from "../core/utils/credential-shapes";
import { redactSecrets } from "../core/utils/redact";

const ROOT = join(__dirname, "..", "..");
/** 形状的**唯一**定义处（`CS-ONE-SOURCE` 钉住的就是它） */
const SHARED_SOURCE = "src/core/utils/credential-shapes.ts";

/* ======================================================================
 * CS-TOKENS：真实令牌表 —— 普查必须**逐条**认出来
 * ====================================================================== */

/**
 * 每一条都是**本产品内置 provider 的真实密钥形态**或它们的变体。
 * 修复前（窄口径：正文只允许字母数字）其中 4 条会漏 —— 而漏一条就是"明文密钥在设置里，
 * 普查却报 0"。
 */
const CS_TOKENS: Array<{ label: string; text: string; token: string }> = [
  { label: "小写 sk-", text: "sk-abcdefghijklmnopqrstuvwxyz012345", token: "sk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "OpenAI project key", text: "sk-proj-abcdefghijklmnopqrstuvwxyz012345", token: "sk-proj-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "Anthropic key", text: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz", token: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" },
  { label: "大写 SK-", text: "SK-abcdefghijklmnopqrstuvwxyz012345", token: "SK-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "混合大小写", text: "Sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345", token: "Sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345" },
  { label: "尾部 -x", text: "sk-abcdefghijklmnopqrstuvwxyz012345-x", token: "sk-abcdefghijklmnopqrstuvwxyz012345-x" },
  { label: "尾部 _extra", text: "sk-abcdefghijklmnopqrstuvwxyz012345_extra", token: "sk-abcdefghijklmnopqrstuvwxyz012345_extra" },
  { label: "pk- 强前缀", text: "pk-abcdefghijklmnopqrstuvwxyz012345", token: "pk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "赋值右侧", text: "foo=sk-abcdefghijklmnopqrstuvwxyz012345", token: "sk-abcdefghijklmnopqrstuvwxyz012345" },
  { label: "Api_Key- 写法", text: "Api_Key-abcdefghijklmnopqrstuvwxyz0123", token: "Api_Key-abcdefghijklmnopqrstuvwxyz0123" },
  { label: "OPENAI_API_KEY- 写法", text: "OPENAI_API_KEY-abcdefghijklmnopqrstuvwxyz", token: "API_KEY-abcdefghijklmnopqrstuvwxyz" },
  { label: "GitHub PAT", text: "ghp_ABCDEFGHIJKLMNOPQRST", token: "ghp_ABCDEFGHIJKLMNOPQRST" },
  { label: "AWS access key id", text: "AKIAIOSFODNN7EXAMPLE", token: "AKIAIOSFODNN7EXAMPLE" },
];

/* ======================================================================
 * CS-PATHS：误报表 —— 逐条**不得**被认成凭据
 * ====================================================================== */

/** 反例对照用：第 187 波**之前**的两份口径（脱敏那份 / 普查那份）—— 都不是要用的判据 */
const PRE_187_REDACT_SHAPE = /(?:sk|pk|key|api[_-]?key)[-_]?[a-zA-Z0-9]{20,}/gi;
const PRE_49_CENSUS_SK = /sk-[A-Za-z0-9_-]{16,}/g;

/**
 * `legacyHit = true` ⇒ 两份旧口径里至少有一份**必须**打中它（否则这条样本不在打击面内，
 * 这条判据就是在测空气）；`false` ⇒ 连旧口径也打不中它（那种形态是"谁都会失准"的边界样本），
 * 而**新口径仍然必须放过它**。
 */
const CS_PATHS: Array<{ label: string; text: string; legacyHit: boolean }> = [
  { label: "task- 里的 sk-", text: "C:\\work\\task-sk-9f8e7d6c5b4a3210012345\\src\\index.ts", legacyHit: true },
  { label: "risk 里的 sk-", text: "risk-sk-abcdefghij1234567890 是风险 id", legacyHit: true },
  { label: "段首 key-（Windows 路径）", text: "C:\\work\\key-abcdefghij1234567890\\src", legacyHit: true },
  { label: "分支名里的 key-", text: "feat/key-abcdefghij1234567890", legacyHit: true },
  { label: "路径段 api_key-", text: "C:\\work\\api_key-abcdefghij1234567890\\src\\index.ts", legacyHit: true },
  { label: "路径段 + handler 分隔符", text: "src/api_key-handler-abcdefghij1234567890", legacyHit: false },
];

/* ======================================================================
 * CS-ONE-SOURCE 的 AST 扫描
 * ====================================================================== */

/** 「像 sk- 形状定义」= 出现 sk 前缀（`sk-` / `sk_` / `sk|pk`）**且**带 ≥2 位数字的长度量词 `{NN,}` */
const SK_PREFIX_MARK = /sk[-_|]/i;
const LENGTH_QUANT = /\{\s*\d{2,}\s*,/;

interface ShapeDefSite {
  file: string;
  line: number;
  source: string;
}

/** 生产代码（`src/**`，去掉 `src/test/**` 与 `*.test.ts(x)`） */
function listProductionFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test" || e.name === "node_modules") continue;
      listProductionFiles(abs, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(abs);
    }
  }
  return out;
}

/** 生产代码里所有"定义了 sk- 形状"的正则字面量 */
function scanSkShapeDefinitions(): ShapeDefSite[] {
  const sites: ShapeDefSite[] = [];
  for (const abs of listProductionFiles(join(ROOT, "src"))) {
    const text = readFileSync(abs, "utf8");
    // 便宜的前置过滤：正则字面量里必须有 `sk` 才可能是这种形状
    if (!text.includes("sk")) continue;
    const sf = ts.createSourceFile(
      abs,
      text,
      ts.ScriptTarget.ES2021,
      true,
      abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isRegularExpressionLiteral(node)) {
        const source = node.text;
        if (SK_PREFIX_MARK.test(source) && LENGTH_QUANT.test(source)) {
          sites.push({
            file: relative(ROOT, abs).replace(/\\/g, "/"),
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            source,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** 某个生产文件 import 的模块说明符 */
function importedModules(relFile: string): string[] {
  const abs = join(ROOT, relFile);
  const sf = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.ES2021, true, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      out.push(stmt.moduleSpecifier.text);
    }
  }
  return out;
}

describe("凭据形状：唯一来源（CS-*）", () => {
  it("CS-TOKENS：普查逐条认出真实令牌（含 sk-proj- / sk-ant- / 大写 / 尾部 -_ / api_key 显式形态）", () => {
    for (const { label, text, token } of CS_TOKENS) {
      const out = censusCredentialSettings([{ key: "note", value: text }]);
      expect(out.total, `[${label}] 普查漏报（明文令牌在设置里却报 0）：${text}`).toBeGreaterThan(0);
      // 值绝不外泄：普查结果序列化后不许出现任何令牌文本
      expect(JSON.stringify(out), `[${label}] 普查结果里出现了令牌 = 这个「安全特性」自己成了泄露面`).not.toContain(token);
      // 同一条形状也是**导出脱敏**的判据（两个出口必须一致）
      const { value, redacted } = redactCredentialShapes({ note: text });
      expect(redacted, `[${label}] 导出脱敏与普查口径不一致（同一个值只许有一份定义）`).toBeGreaterThan(0);
      expect(JSON.stringify(value)).not.toContain(token);
    }
  });

  it("CS-PATHS：误报表逐条 0 命中，且普查与脱敏都不许改写它（含反例对照）", () => {
    for (const { label, text, legacyHit } of CS_PATHS) {
      // 反例对照**按登记值断言**：登记 true 的必须真被旧口径打中（否则这条样本在测空气）
      const hitByLegacy =
        (text.match(PRE_187_REDACT_SHAPE)?.length ?? 0) > 0 || (text.match(PRE_49_CENSUS_SK)?.length ?? 0) > 0;
      expect(hitByLegacy, `[${label}] 两份旧口径都没打中 ⇒ 它不是"误伤"样本：${text}`).toBe(legacyHit);

      const out = censusCredentialSettings([{ key: "note", value: text }]);
      expect(out.total, `[${label}] 普查把它当成凭据了：${text}`).toBe(0);
      expect(out.hits, `[${label}] 命中清单不许有它`).toEqual([]);

      const { value, redacted } = redactCredentialShapes({ note: text });
      expect(redacted, `[${label}] 导出脱敏改写了路径/ID 片段（不可逆）：${text}`).toBe(0);
      expect((value as { note: string }).note, `[${label}] 内容必须逐字不变`).toBe(text);

      expect(redactSecrets(text), `[${label}] 记忆/日志脱敏改写了路径/ID 片段：${text}`).toBe(text);
    }
    // 长度口径一并钉住：短串本来就不是令牌（免得有人拿"放宽长度"来消误伤）
    for (const short of ["sk-1", "sk-abc", "key-abc", "pk-2"]) {
      expect(censusCredentialSettings([{ key: "note", value: short }]).total, `短串不是令牌：${short}`).toBe(0);
      expect(redactSecrets(short)).toBe(short);
    }
  });

  it("CS-ONE-SOURCE ①：普查表逐条就是共享来源里的**同一批正则对象**（解析式对账）", () => {
    expect(CREDENTIAL_VALUE_RES.length, "共享来源的值形状条数").toBe(CREDENTIAL_VALUE_SHAPES.length);
    CREDENTIAL_VALUE_SHAPES.forEach((shape, i) => {
      expect(CREDENTIAL_VALUE_RES[i], `第 ${i} 条不是共享来源的那个正则对象（有人又写了一份）：${shape.id}`).toBe(
        shape.pattern,
      );
      expect(CREDENTIAL_SHAPE_LABELS[i], `第 ${i} 条的诊断名与共享来源不一致`).toBe(shape.label);
    });
    // `sk-` 形状 = 共享来源里的 apiKeyStrong（这一条是本波收口的对象）
    expect(CREDENTIAL_VALUE_RES[0], "普查的 sk- 形状必须是共享来源的 apiKeyStrong").toBe(
      credentialShape("apiKeyStrong").pattern,
    );
    expect(CREDENTIAL_VALUE_RES[0].source).toBe(credentialShape("apiKeyStrong").pattern.source);
  });

  it("CS-ONE-SOURCE ②：四个出口都 import 唯一来源（不许各自内联）", () => {
    /** 收口前各自内联一份 `sk-` 形状的四个出口（AST 扫描在 ③ 里从另一侧钉住同一件事） */
    const consumers: Array<[string, string]> = [
      ["src/core/utils/redact.ts", "./credential-shapes"],
      ["src/core/settings/settings.ts", "../utils/credential-shapes"],
      ["src/core/llm/streaming-executor.ts", "../utils/credential-shapes"],
      ["src/core/llm/tool-pipeline.ts", "../utils/credential-shapes"],
    ];
    for (const [file, specifier] of consumers) {
      expect(importedModules(file), `${file} 必须引用唯一来源（不许各自内联一份形状）`).toContain(specifier);
    }
  });

  it("CS-ONE-SOURCE ③：生产代码里「定义 sk- 形状」的正则字面量只出现在共享来源这一个文件", () => {
    const sites = scanSkShapeDefinitions();
    expect(
      sites.map((s) => s.file),
      "定义了第二份 sk- 形状（每多一处就多一次「修了一处漏了另一处」）",
    ).toEqual([SHARED_SOURCE]);
    // 反向对照：扫描器本身必须真的在扫（否则"只命中一处"可能是恒真）
    expect(sites[0].source, "扫到的必须是那条强前缀形状").toContain("(?:sk|pk)");
    expect(sites[0].source, "扫到的形状必须带 ≥20 位的长度量词").toMatch(/\{\s*\d{2,}\s*,/);
  });
});
