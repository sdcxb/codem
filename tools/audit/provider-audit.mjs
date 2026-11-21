#!/usr/bin/env node
/**
 * Provider 分类审计：把「哪个插件、哪个文件、提供哪些服务、谁在消费、谁在 inject、
 * 有没有市场锚、有没有副作用」一次性算清，产出可提交的清单。
 *
 * ## 为什么要这份清单
 *
 * 插件化装配里最容易被误判的两件事：
 *  1. **provide 不等于被消费**：`ctx.provide('x')` 之后可能没有任何 `get('x')`
 *     （历史上有插件靠 inject 看起来「有人用」，实际是死服务）；
 *  2. **文件存在不等于插件需要存在**：provider 文件如果只是把模块包一层、既没有
 *     副作用也没有消费方，那它就是一个可删的 wrapper。
 *
 * 本脚本按 kinds 分类（registration / service / inject-dependency / wrapper / dynamic），
 * 让「保留 / 待人工 / 可删」有据可查，而不是靠读文件名猜。
 *
 * ## 判据边界（如实写）
 *
 * - **先剥注释再扫**：`ctx.provide` 常出现在 JSDoc 里（如 `dynamic-runner-provider.ts`
 *   的 `myService`），注释里的名字一律不算。字符串字面量里的 `ctx.provide(` 也不算
 *   （定位 `ctx.provide(` 时用「字符串内容已抹空」的副本，保留位置对齐）。
 * - **服务名解析**：字面量、同文件 `const X = 'name'`、函数参数默认值（`name = 'x'`）、
 *   `super(ctx, 'name')` 类服务都能解析；解析不出来的（`descriptor.name` / 运行期变量）
 *   记成 **dynamic**，不写进静态服务清单。
 * - **消费方**：`.get('x')`、`getCtxService('x')`、`_getOrFallback('x')`、
 *   `waitForService('x')`、`getServiceAsync('x')`、`getServiceSync('x')`、`ctx.x` 属性读，
 *   以及 dsh-compat 的显式别名表（dshLlm→llm 等）。
 *   测试目录与注册表/市场目录不算消费方（否则死代码会被自己的登记表救活）。
 * - **inject** 只从 `config/codem.base.yml` 与 `builtin-registry.ts` 读，不把 inject
 *   当消费（inject 只说明依赖要先就绪）。
 * - **副作用**只用于区分 registration 与 wrapper：`registerProvider(`、`.register(`、
 *   `.route(`、`setInterval(`、`ctx.on(`、`ctx.plugin(`、`ctx.get(...).method(`、
 *   DOM 全局写入；`new X` 单独不算。注册表声明了 `slots: [...]` 的 UI 插件也算
 *   registration（槽位贡献是装配期真实动作）。
 * - **副作用是保守启发式**：实现体里的 `.register(` / `registry.register(` 也会命中
 *   （例如 `llm-provider` 的 registerProvider 方法体），只会把 service 抬成 registration
 *   （保留方向），不会把有副作用的插件误判成 wrapper —— 所以 registration 数偏高是预期。
 * - **wrapper 是「候选」不是「结论」**：词法层是轻量实现（正则/除号按前一个有效字符判断，
 *   JSX 文本里的撇号理论上可能被当字符串起点；实测 App.tsx / SlotBridge.tsx 未受影响）。
 *   个别漏扫只会让条目更可能落进 wrapper，必须人工复核后再删。
 * - **duplicate 只说明「同名服务有多处 provide」**，不代表两处都已装载；未注册进
 *   registry/YAML 的实现会同时出现在 summary.unclassified 里。
 * - **switchable 一律 false**：可切换性需要「非 core + 可逆」两个运行时事实，静态扫描
 *   证明不了。本清单只给候选线索，开关由人拍板。
 *
 * ## 用法
 *
 *   node tools/audit/provider-audit.mjs            # 打印摘要（kind 计数 / wrapper / duplicate / 未分类）
 *   node tools/audit/provider-audit.mjs --write    # 重建 src/core/provider/provider-audit.json
 *   node tools/audit/provider-audit.mjs --check    # 与已提交 JSON 比对，漂移判红（exit 1）
 *
 * 纯函数 `buildAudit(files, yaml, registry)` 可被单测直接驱动；`files` 支持
 * `[{ path, text }]`、`[[path, text]]` 或 Map。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/** 清单里引用到的固定路径（测试可以直接用，避免重复写字符串） */
export const PATHS = {
  out: "src/core/provider/provider-audit.json",
  registry: "src/core/plugin-loader/builtin-registry.ts",
  yaml: "config/codem.base.yml",
  market: "src/core/plugin-market/dsh-market-catalog.ts",
  dshCompat: "src/core/dsh-compat/index.ts",
};

/** kind 枚举，测试与 --check 都以此为契约 */
export const KINDS = ["registration", "service", "inject-dependency", "wrapper", "dynamic"];

/** 注册表 / 市场目录里的字符串不算「生产消费方」 */
const CONSUMER_EXCLUDE = new Set([PATHS.registry, PATHS.market]);

/**
 * dsh-compat 的显式别名表。
 *
 * `dsh-compat/index.ts` 里是 `ctx.get(realName)`（变量），静态扫不出来；这里按
 * 「别名 → 真实服务」显式补齐。表只登记该文件里确实 export 的别名，新增别名要同步这里。
 */
const DSH_ALIASES = {
  dshLlm: "llm",
  dshShell: "shell",
  dshFs: "fs",
  dshTools: "tools",
  dshSessions: "session",
  dshCredentials: "settings",
};

const DOC =
  "Provider 分类审计清单。由 tools/audit/provider-audit.mjs 生成；" +
  "勿手改：改完代码后跑 node tools/audit/provider-audit.mjs --write 重建，" +
  "node tools/audit/provider-audit.mjs --check 校验漂移。";

const KIND_ORDER = ["registration", "service", "inject-dependency", "wrapper", "dynamic"];

/* ------------------------------------------------------------------ */
/* 纯工具                                                              */
/* ------------------------------------------------------------------ */

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqSorted(values) {
  return [...new Set(values)].sort(cmp);
}

function normalizePath(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "");
}

const REGEX_KEYWORDS = new Set([
  "return",
  "case",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "else",
  "do",
]);

/** 只看「/ 前面那个字符 / 单词」判断它是不是正则字面量的起点（否则按除号处理） */
function isRegexStart(prevChar, word) {
  if (prevChar === "") return true;
  if ("([{,;:=!&|?+-*%^~<>".includes(prevChar)) return true;
  return REGEX_KEYWORDS.has(word);
}

/** 跳过从 i（指向 `/`）开始的正则字面量，返回结束位置（含 flags） */
function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") {
      inClass = true;
      j++;
      continue;
    }
    if (c === "]") {
      inClass = false;
      j++;
      continue;
    }
    if (c === "/" && !inClass) {
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      return j;
    }
    if (c === "\n") return j;
    j++;
  }
  return j;
}

/** 把非换行字符替换成空格（保持长度与行号） */
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

/**
 * 轻量词法变换：剥注释，可选抹掉字符串内容，并跳过正则字面量。
 *
 * 为什么不能用「逐字符找引号」的简化版：provider 里常见的
 * `.replace(/^["']|["']$/g, '')` 会把正则里的引号当字符串起点，导致**后半文件被当成
 * 字符串**，provide 与消费方全部漏扫（web-fetch-http / session-title-all-prompts 实测）。
 * 因此这里按「上一个有效字符 / 关键字」判断 `/` 是正则还是除号；JSX 的 `</div>` 与
 * `/>` 单独绕开。
 *
 * 输出与输入**等长**（注释/字符串/正则都替换成空格，保留换行），保证 masked 与 stripped
 * 的偏移一一对应，消费方命中可以用位置对照排除「写在字符串里的假代码」。
 */
function lex(text, maskStrings) {
  const src = String(text || "");
  let out = "";
  let i = 0;
  const n = src.length;
  let prevChar = "";
  let lastWord = "";
  let curWord = "";

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      const bodyEnd = closed ? j - 1 : j;
      const body = src.slice(i + 1, bodyEnd);
      out += quote + (maskStrings ? blank(body) : body) + (closed ? quote : "");
      i = j;
      prevChar = "x";
      lastWord = "";
      curWord = "";
      continue;
    }
    if (ch === "/" && isRegexStart(prevChar, curWord || lastWord)) {
      // JSX 收尾标签 `</div>` 与自闭合 `/>` 不是正则
      if (next === ">") {
        out += ch;
        i++;
        prevChar = "x";
        continue;
      }
      if (prevChar === "<" && /^[A-Za-z_$][\w$.:-]*\s*>/.test(src.slice(i + 1))) {
        out += ch;
        i++;
        prevChar = "x";
        continue;
      }
      const j = skipRegex(src, i);
      out += blank(src.slice(i, j));
      i = j;
      prevChar = "x";
      lastWord = "";
      curWord = "";
      continue;
    }

    out += ch;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      curWord += ch;
    } else if (curWord) {
      lastWord = curWord;
      curWord = "";
    }
    prevChar = ch;
    i++;
  }
  return out;
}

/** 剥注释（保留字符串内容与换行；注释字符替换成空格以保持偏移量不变） */
export function stripComments(text) {
  return lex(text, false);
}

/**
 * 把字符串字面量的**内容**抹成空格（保留引号与换行，长度不变）。
 *
 * 用途：扫 `ctx.provide(` / 副作用时不把字符串里的示例代码当成真代码；
 * 位置与原文一一对应，取字面量参数时仍可回到剥注释后的原文按偏移读取。
 */
function maskStringContents(text) {
  return lex(text, true);
}

/** 跳过从 i 开始的字符串（i 指向引号）；返回结束位置之后的下标 */
function skipString(text, i) {
  const quote = text[i];
  i++;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** 读取以 openIndex（指向 `(`）开始的调用第一个实参原文 */
function readFirstArg(text, openIndex) {
  let depth = 0;
  let i = openIndex + 1;
  const start = i;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) break;
    i++;
  }
  return text.slice(start, i).trim();
}

/** 读取以 openIndex（指向 `(`）开始的调用实参列表原文 */
function readCallArgs(text, openIndex) {
  const args = [];
  let depth = 0;
  let i = openIndex + 1;
  let start = i;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" && depth === 0) {
      args.push(text.slice(start, i));
      return args;
    }
    if (ch === "]" || ch === "}") {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  args.push(text.slice(start));
  return args;
}

/** 解析简单字符串字面量；不是字面量返回 null */
function parseStringLiteral(raw) {
  const text = String(raw || "").trim();
  const quote = text[0];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  let out = "";
  let i = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      const e = text[i + 1];
      out += e === "n" ? "\n" : e === "t" ? "\t" : e === undefined ? "" : e;
      i += 2;
      continue;
    }
    if (c === quote) return out;
    out += c;
    i++;
  }
  return null;
}

/** 从对象字面量文本里抽 `key: ['a', 'b']` 的字符串数组 */
function extractStringArray(objectText, key) {
  const re = new RegExp("\\b" + key + "\\s*:\\s*\\[([^\\]]*)\\]");
  const match = re.exec(objectText || "");
  if (!match) return [];
  return uniqSorted([...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]));
}

/* ------------------------------------------------------------------ */
/* 提供源解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 从单个文件里抽 provide 与 dynamic。
 *
 * 关键点：定位用 masked（字符串内容已抹空），取值回到 stripped（仅剥注释）。
 * 这样字符串里的 `ctx.provide('myService', ...)` 不会被当成真 provide，
 * 而真正的 `ctx.provide('x', ...)` 仍能读到 `'x'`。
 */
function extractProvides(strippedText, maskedText) {
  const consts = new Map();
  const constRe =
    /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*['"]([^'"\n]+)['"]/g;
  let match;
  while ((match = constRe.exec(strippedText))) {
    if (!consts.has(match[1])) consts.set(match[1], match[2]);
  }

  // 函数参数默认值：`serviceName: string = 'squad'`（squad-provider 的工厂写法）
  const params = new Map();
  const paramRe =
    /([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>\s[\]|]*=\s*['"]([^'"\n]+)['"]/g;
  while ((match = paramRe.exec(strippedText))) {
    if (!params.has(match[1])) params.set(match[1], match[2]);
  }

  const provides = [];
  const dynamic = [];

  const callRe = /ctx\.(?:reflect\.)?provide\s*\(/g;
  while ((match = callRe.exec(maskedText))) {
    const open = match.index + match[0].length - 1;
    const raw = readFirstArg(strippedText, open).trim();
    const literal = parseStringLiteral(raw);
    if (literal) {
      provides.push(literal);
      continue;
    }
    const ident = /^([A-Za-z_$][\w$]*)$/.exec(raw);
    if (ident && (consts.has(ident[1]) || params.has(ident[1]))) {
      provides.push(consts.has(ident[1]) ? consts.get(ident[1]) : params.get(ident[1]));
      continue;
    }
    dynamic.push(raw.length > 60 ? raw.slice(0, 57) + "..." : raw);
  }

  // 类服务：`class SlotsService extends Service { constructor(ctx) { super(ctx, 'slots') } }`
  const superLitRe = /\bsuper\s*\(\s*ctx\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/g;
  while ((match = superLitRe.exec(strippedText))) provides.push(match[1]);

  const superDynRe = /\bsuper\s*\(\s*ctx\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  while ((match = superDynRe.exec(strippedText))) {
    const name = match[1];
    if (consts.has(name)) provides.push(consts.get(name));
    else if (params.has(name)) provides.push(params.get(name));
    else dynamic.push(name);
  }

  // 旧式插件模块：`export const provide = ['pluginRegistry', 'pluginInstaller'] as const`
  const moduleRe = /export\s+const\s+provide\s*=\s*\[([^\]]*)\]/g;
  while ((match = moduleRe.exec(strippedText))) {
    for (const item of match[1].matchAll(/['"]([^'"]+)['"]/g)) provides.push(item[1]);
  }

  return { provides: uniqSorted(provides), dynamic: uniqSorted(dynamic) };
}

/**
 * 副作用识别（剥注释后的文本）。
 *
 * `new X` 单独不算；只算「装配期对外部世界产生动作」的调用。`ctx.get('x')` 后直接
 * 链式调用方法（`ctx.get('slots').register(...)`）也算一条。
 */
function extractSideEffects(strippedText) {
  const effects = [];
  let match;

  const registerProviderRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\.registerProvider\s*\(/g;
  while ((match = registerProviderRe.exec(strippedText))) {
    effects.push(match[1] + ".registerProvider");
  }

  // 排除 `this.core.register` / 链式调用里的 `xxx.yyy.register`（receiver 前置 . 或 $），
  // 也排除 `this.register(...)` —— 那是类内部方法调用，不是插件装配动作。
  const registerRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\.register\s*\(/g;
  while ((match = registerRe.exec(strippedText))) {
    if (match[1] === "this" || match[1] === "super") continue;
    effects.push(match[1] + ".register");
  }

  const routeRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\.route\s*\(/g;
  while ((match = routeRe.exec(strippedText))) {
    if (match[1] === "this" || match[1] === "super") continue;
    effects.push(match[1] + ".route");
  }

  if (/\bsetInterval\s*\(/.test(strippedText)) effects.push("setInterval");
  if (/\bctx\.on\s*\(/.test(strippedText)) effects.push("ctx.on");
  if (/\bctx\.plugin\s*\(/.test(strippedText)) effects.push("ctx.plugin");

  const chainedRe =
    /\bctx\.get\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((match = chainedRe.exec(strippedText))) {
    effects.push("ctx.get(" + match[1] + ")." + match[2]);
  }

  // UI 插件（ui-theme / ui-skin-*）的真实副作用是写 DOM 全局样式
  if (/\bdocument\.documentElement\b|\bdocument\.body\b/.test(strippedText)) {
    effects.push("dom-mutation");
  }

  return uniqSorted(effects);
}

/* ------------------------------------------------------------------ */
/* 注册表 / YAML / 市场                                                 */
/* ------------------------------------------------------------------ */

function resolveImportCandidates(fromRel, spec) {
  if (!/^\.{1,2}\//.test(spec)) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(base)) return [base];
  return [base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx"];
}

/**
 * 解析 builtin-registry.ts：import 映射 + 每条 registerBuiltinPlugin 的
 * plugin / provides / inject / slots / loader 里的模块标识符。
 */
export function parseRegistry(text) {
  const clean = stripComments(text);
  const imports = new Map();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(clean))) {
    const candidates = resolveImportCandidates(PATHS.registry, match[2]);
    for (const part of match[1].split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(piece);
      const ident = aliased ? aliased[2] : piece;
      if (/^[A-Za-z_$][\w$]*$/.test(ident)) imports.set(ident, candidates);
    }
  }

  const registrations = [];
  const callRe = /\bregisterBuiltinPlugin\s*\(/g;
  while ((match = callRe.exec(clean))) {
    const open = match.index + match[0].length - 1;
    const args = readCallArgs(clean, open);
    if (args.length < 3) continue;
    const plugin = parseStringLiteral(args[0]);
    if (!plugin) continue;
    const meta = args[1];
    const loader = args[2];
    let fileCandidates = [];
    const loaderIdents = [];
    for (const ident of loader.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      if (!imports.has(ident[1])) continue;
      loaderIdents.push(ident[1]);
      if (!fileCandidates.length) fileCandidates = imports.get(ident[1]);
    }
    registrations.push({
      plugin,
      provides: extractStringArray(meta, "provides"),
      inject: extractStringArray(meta, "inject"),
      slots: extractStringArray(meta, "slots"),
      core: /\bcore\s*:\s*true\b/.test(meta),
      fileCandidates,
      loaderIdents,
    });
  }
  return { imports, registrations };
}

/** 解析 config/codem.base.yml 的插件条目（只认两空格缩进的顶层键） */
export function parseYaml(text) {
  const entries = [];
  let current = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const idMatch = /^-\s+id:\s*(\S+)/.exec(line);
    if (idMatch) {
      if (current) entries.push(current);
      current = { id: idMatch[1], name: null, inject: [], core: false };
      continue;
    }
    if (!current) continue;
    const nameMatch = /^ {2}name:\s*['"]([^'"]+)['"]/.exec(line);
    if (nameMatch) {
      current.name = nameMatch[1];
      continue;
    }
    const injectMatch = /^ {2}inject:\s*\[([^\]]*)\]/.exec(line);
    if (injectMatch) {
      // YAML 里是 `inject: [llmEngine]`（不带引号），不能只匹配带引号的写法
      current.inject = uniqSorted(
        injectMatch[1]
          .split(",")
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
      );
      continue;
    }
    if (/^ {2}core:\s*true\b/.test(line)) current.core = true;
  }
  if (current) entries.push(current);
  return entries;
}

/** 解析 dsh 市场目录的 codemAnchor → dsh 包名 */
export function parseMarketAnchors(text) {
  const clean = stripComments(text);
  const out = [];
  const re = /dshName:\s*['"]([^'"]+)['"][^}]*?codemAnchor:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(clean))) {
    out.push({ dshName: match[1], anchor: match[2] });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 文件与插件名                                                        */
/* ------------------------------------------------------------------ */

function normalizeFiles(files) {
  if (files instanceof Map) {
    return [...files.entries()].map(([p, text]) => ({
      path: normalizePath(p),
      text: String(text ?? ""),
    }));
  }
  if (!Array.isArray(files)) return [];
  return files.map((item) => {
    if (Array.isArray(item)) {
      return { path: normalizePath(item[0]), text: String(item[1] ?? "") };
    }
    return { path: normalizePath(item.path), text: String(item.text ?? "") };
  });
}

/** 框架自身不是插件：Cordis 运行时的 `Service` 基类会接 `name` 参数，不能当 provider */
const INFRA_PREFIXES = ["src/core/cordis/"];

/** 插件名兜底：注册表没有映射时按路径推导，便于人工核对 */
function derivePluginName(file) {
  if (file === "src/App.tsx") return "@codem/app-bootstrap";
  let match = /^src\/core\/provider\/([^/]+)\.ts$/.exec(file);
  if (match) {
    const base = match[1];
    return "@codem/" + base.replace(/-provider$/, "");
  }
  match = /^src\/core\/ui-plugins\/([^/]+)\/index\.tsx?$/.exec(file);
  if (match) return "@codem/" + match[1];
  match = /^src\/plugins\/([^/]+)\/(?:provider|index)\.tsx?$/.exec(file);
  if (match) return "@codem/" + match[1];
  match = /^src\/core\/([^/]+)\/index\.tsx?$/.exec(file);
  if (match) return "@codem/" + match[1];
  match = /^src\/core\/([^/]+)\/([^/]+)\.tsx?$/.exec(file);
  if (match) return "@codem/" + match[2].replace(/-provider$/, "");
  return "@codem/" + path.posix.basename(file).replace(/\.tsx?$/, "").replace(/-provider$/, "");
}

function pickExisting(candidates, fileSet) {
  for (const candidate of candidates || []) {
    if (fileSet.has(candidate)) return candidate;
  }
  return (candidates || [])[0] || null;
}

/**
 * 穿透 barrel：注册表里 `import { shellOpsProvider } from '../../plugins/shell-ops'`
 * 解析到的是 `index.ts`（只做转出），真正 provide 的是 `./provider.ts`。
 * 不穿透会让同一个服务出现「barrel 条目 + 实现条目」两条，误报 duplicate。
 */
function resolveBarrel(file, idents, fileSet, textByFile) {
  let current = file;
  for (let depth = 0; depth < 3; depth++) {
    const text = textByFile.get(current);
    if (!text) break;
    let next = null;
    for (const ident of idents) {
      const re = new RegExp(
        "export\\s*\\{[^}]*\\b" + ident + "\\b[^}]*\\}\\s*from\\s*['\"]([^'\"]+)['\"]"
      );
      const match = re.exec(text);
      if (!match) continue;
      next = pickExisting(resolveImportCandidates(current, match[1]), fileSet);
      break;
    }
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* 分类与描述                                                          */
/* ------------------------------------------------------------------ */

function classify(entry) {
  if (entry.dynamicNames.length > 0) return "dynamic";
  if (entry.sideEffects.length > 0 || entry.declaredSlots.length > 0) return "registration";
  if (entry.consumers.length > 0) return "service";
  if (entry.injectDependents.length > 0) return "inject-dependency";
  if (entry.marketAnchors.length > 0) return "registration";
  return "wrapper";
}

/** 每个 provide 的处置状态：消费 / 仅 inject / 无人问津 */
function provideStatuses(entry, consumersByService, injectors) {
  const out = {};
  for (const service of entry.provides) {
    const hasConsumer = (consumersByService.get(service) || []).some(
      (record) => !record.startsWith(entry.file + ":")
    );
    const hasInject = injectors.some(
      (item) => item.plugin !== entry.plugin && item.inject.includes(service)
    );
    out[service] = hasConsumer
      ? "provide-consumed"
      : hasInject
        ? "provide-inject-required"
        : "provide-unused";
  }
  return out;
}

function describeEntry(entry, statuses, duplicates) {
  const bits = [];
  if (entry.source === "derived") {
    // 提示「这个插件不是从注册表映射出来的」，避免把内核装配点当成普通插件
    bits.push(
      entry.file === "src/App.tsx"
        ? "App.tsx 启动装配中的 ctx.provide（不是插件，也不在 registry/YAML 里）"
        : entry.file === "src/core/slots/index.ts"
          ? "SlotsService 通过 super(ctx, 'slots') 自注册（App.tsx 直接 ctx.plugin 装配；YAML 里已注释）"
          : "未在 builtin-registry / codem.base.yml 登记（插件名按路径推导）"
    );
  }
  if (entry.kind === "dynamic") {
    bits.push(
      "运行期动态 provide（无界名：" +
        entry.dynamicNames.join("、") +
        "），按规则不进静态服务清单"
    );
    if (entry.provides.length) {
      bits.push("静态 provide " + entry.provides.join("、") + " 照常统计");
    }
    if (entry.sideEffects.length) {
      bits.push("另有副作用：" + entry.sideEffects.join("、"));
    }
  } else if (entry.kind === "registration") {
    if (entry.sideEffects.length) {
      bits.push("有副作用：" + entry.sideEffects.join("、"));
    }
    if (entry.declaredSlots.length) {
      bits.push("注册表声明 UI 槽位 " + entry.declaredSlots.join("、"));
    }
    if (!entry.sideEffects.length && !entry.declaredSlots.length && entry.marketAnchors.length) {
      bits.push(
        "无代码副作用，但存在市场锚 " +
          entry.marketAnchors.join("、") +
          "（bundled 等价插件，保留）"
      );
    }
    if (entry.provides.length) {
      const byStatus = { "provide-consumed": [], "provide-inject-required": [], "provide-unused": [] };
      for (const service of entry.provides) byStatus[statuses[service]].push(service);
      if (byStatus["provide-consumed"].length) {
        bits.push("provide-consumed：" + byStatus["provide-consumed"].join("、"));
      }
      if (byStatus["provide-inject-required"].length) {
        bits.push(
          "provide-inject-required：" + byStatus["provide-inject-required"].join("、")
        );
      }
      if (byStatus["provide-unused"].length) {
        bits.push(
          "provide-unused：" +
            byStatus["provide-unused"].join("、") +
            "（无消费方、无 inject，可评估下线该 provide）"
        );
      }
    }
  } else if (entry.kind === "service") {
    bits.push(
      "无副作用；provide " +
        entry.provides.join("、") +
        " 有 " +
        entry.consumers.length +
        " 处消费方，保留"
    );
    if (entry.injectDependents.length) {
      bits.push("另有 " + entry.injectDependents.length + " 个插件 inject");
    }
  } else if (entry.kind === "inject-dependency") {
    bits.push(
      "provide " +
        entry.provides.join("、") +
        " 无消费方，但被 " +
        entry.injectDependents.length +
        " 个插件 inject（" +
        entry.injectDependents.slice(0, 3).join("、") +
        "），依赖就绪需要它"
    );
  } else {
    bits.push("无副作用、无消费方、无插件 inject、无市场锚：纯包装/死代码候选（人工确认）");
    if (!entry.provides.length) bits.push("本插件不 provide 任何服务");
  }
  const duplicated = entry.provides.filter((service) => duplicates && duplicates[service]);
  if (duplicated.length) {
    bits.push(
      "duplicate 服务：" +
        duplicated
          .map((service) => service + "（" + duplicates[service].join(" / ") + "）")
          .join("、")
    );
  }
  if (entry.core) bits.push("core");
  return bits.join("；");
}

/* ------------------------------------------------------------------ */
/* 主体：buildAudit                                                    */
/* ------------------------------------------------------------------ */

/**
 * 纯函数：给定源文件（含路径与原文）、YAML 原文、注册表原文，生成完整清单文档。
 *
 * @param {Array<{path:string,text:string}>|Array<[string,string]>|Map<string,string>} files
 * @param {string|{text:string}} yaml
 * @param {string|{text:string}} registry
 * @returns {{_doc:string, version:number, entries:Array, duplicates:Object, registryDrift:Array, orphanMarketAnchors:string[], summary:Object}}
 */
export function buildAudit(files, yaml, registry) {
  const list = normalizeFiles(files);
  const fileSet = new Set(list.map((f) => f.path));
  const textByFile = new Map(list.map((f) => [f.path, f.text]));
  const strippedByFile = new Map(list.map((f) => [f.path, stripComments(f.text)]));
  const maskedByFile = new Map(
    list.map((f) => [f.path, maskStringContents(strippedByFile.get(f.path))])
  );

  const registryText = typeof registry === "string" ? registry : String(registry && registry.text ? registry.text : "");
  const yamlText = typeof yaml === "string" ? yaml : String(yaml && yaml.text ? yaml.text : "");

  const parsedRegistry = parseRegistry(registryText);
  const yamlEntries = parseYaml(yamlText);
  const market = parseMarketAnchors(textByFile.get(PATHS.market) || "");

  // 1) 扫每个文件的 provide / dynamic
  const infos = new Map();
  for (const file of list) {
    const found = extractProvides(strippedByFile.get(file.path), maskedByFile.get(file.path));
    if (found.provides.length || found.dynamic.length) {
      infos.set(file.path, {
        file: file.path,
        provides: new Set(found.provides),
        dynamic: new Set(found.dynamic),
        sideEffects: new Set(),
      });
    }
  }

  // 2) 注册表插件 → 文件；同一文件可能注册多个插件（squad / squad-manager）
  const registrations = [];
  const unresolvedPlugins = [];
  const pluginsPerFile = new Map();
  for (const reg of parsedRegistry.registrations) {
    const picked = pickExisting(reg.fileCandidates, fileSet);
    if (!picked) {
      unresolvedPlugins.push(reg.plugin);
      continue;
    }
    const file = resolveBarrel(picked, reg.loaderIdents || [], fileSet, textByFile);
    registrations.push({ ...reg, file });
    pluginsPerFile.set(file, (pluginsPerFile.get(file) || 0) + 1);
  }

  // 3) 候选文件 = 有 provide 的文件 ∪ 注册表映射到的文件；只为候选算副作用
  const candidateFiles = new Set(infos.keys());
  for (const reg of registrations) candidateFiles.add(reg.file);
  for (const file of candidateFiles) {
    if (!infos.has(file)) {
      infos.set(file, {
        file,
        provides: new Set(),
        dynamic: new Set(),
        sideEffects: new Set(),
      });
    }
    const info = infos.get(file);
    for (const effect of extractSideEffects(strippedByFile.get(file) || "")) {
      info.sideEffects.add(effect);
    }
  }

  // 4) inject 依赖（YAML + 注册表；同名插件合并 inject）
  const injectorMap = new Map();
  for (const reg of registrations) {
    if (!injectorMap.has(reg.plugin)) {
      injectorMap.set(reg.plugin, { plugin: reg.plugin, inject: new Set(), core: false });
    }
    const item = injectorMap.get(reg.plugin);
    for (const dep of reg.inject) item.inject.add(dep);
    item.core = item.core || reg.core;
  }
  for (const yamlEntry of yamlEntries) {
    if (!yamlEntry.name) continue;
    if (!injectorMap.has(yamlEntry.name)) {
      injectorMap.set(yamlEntry.name, {
        plugin: yamlEntry.name,
        inject: new Set(),
        core: false,
      });
    }
    const item = injectorMap.get(yamlEntry.name);
    for (const dep of yamlEntry.inject) item.inject.add(dep);
    item.core = item.core || yamlEntry.core;
  }
  const injectors = [...injectorMap.values()]
    .map((item) => ({ plugin: item.plugin, inject: [...item.inject].sort(cmp), core: item.core }))
    .sort((a, b) => cmp(a.plugin, b.plugin));

  // 5) 市场锚：codemAnchor → dsh 包名
  const anchorsByPlugin = new Map();
  for (const item of market) {
    if (!anchorsByPlugin.has(item.anchor)) anchorsByPlugin.set(item.anchor, []);
    anchorsByPlugin.get(item.anchor).push(item.dshName);
  }

  // 6) 生成条目
  const built = [];
  const coveredFiles = new Set();
  const yamlNameSet = new Set(yamlEntries.filter((e) => e.name).map((e) => e.name));

  for (const reg of registrations) {
    coveredFiles.add(reg.file);
    const info = infos.get(reg.file);
    const multi = (pluginsPerFile.get(reg.file) || 1) > 1;
    // 一个文件注册多个插件时，provides 以注册表为准（工厂参数在静态扫描里只能看到默认值）；
    // 单插件文件以**文件里真实扫到的 provide** 为准（注册表可能残留已拆分/已删除的声明，
    // 如 host-client 的 acp/bundle/client/host/sdk —— 那种漂移只让 inject 解析失真，
    // 不该把陈旧的「提供」算进 duplicate 与消费方）。扫描不到时才回退到注册表声明。
    const provides = multi
      ? uniqSorted(reg.provides)
      : uniqSorted(info.provides.size > 0 ? [...info.provides] : reg.provides);
    built.push({
      plugin: reg.plugin,
      file: reg.file,
      provides,
      kind: "wrapper",
      consumers: [],
      injectDependents: [],
      marketAnchors: [],
      sideEffects: [...info.sideEffects].sort(cmp),
      declaredSlots: uniqSorted(reg.slots),
      dynamicNames: [...info.dynamic].sort(cmp),
      statuses: {},
      core: reg.core || (injectorMap.get(reg.plugin) || { core: false }).core,
      source: "registry",
    });
  }

  for (const info of infos.values()) {
    if (coveredFiles.has(info.file)) continue;
    if (INFRA_PREFIXES.some((prefix) => info.file.startsWith(prefix))) continue;
    if (info.provides.size === 0 && info.dynamic.size === 0) continue;
    const plugin = derivePluginName(info.file);
    built.push({
      plugin,
      file: info.file,
      provides: [...info.provides].sort(cmp),
      kind: "wrapper",
      consumers: [],
      injectDependents: [],
      marketAnchors: [],
      sideEffects: [...info.sideEffects].sort(cmp),
      declaredSlots: [],
      dynamicNames: [...info.dynamic].sort(cmp),
      statuses: {},
      core: (injectorMap.get(plugin) || { core: false }).core,
      source: yamlNameSet.has(plugin) ? "yaml" : "derived",
    });
  }

  // 7) duplicate：同一服务被多个插件提供（先算出来，reason 里好标注）
  const providersByService = new Map();
  for (const entry of built) {
    for (const service of entry.provides) {
      if (!providersByService.has(service)) providersByService.set(service, []);
      providersByService.get(service).push(entry.plugin);
    }
  }
  const duplicates = {};
  for (const [service, plugins] of [...providersByService.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const unique = uniqSorted(plugins);
    if (unique.length > 1) duplicates[service] = unique;
  }

  // 8) 消费方扫描
  const providedServices = new Set();
  for (const entry of built) for (const service of entry.provides) providedServices.add(service);

  const consumersByService = new Map();
  // `?.get('x')` / `ctx?.get?.('x')` 也是真实消费（host-provider / SlotBridge / tools.ts 在用）
  const consumerRe =
    /(?:\b(getCtxService|_getOrFallback|waitForService|getServiceAsync|getServiceSync)\s*(?:<[^>]*>)?\s*(?:\?\.)?\s*\(|\??\.\s*get\s*(?:\?\.)?\s*\()\s*['"]([A-Za-z0-9_$]+)['"]/g;
  const ctxPropRe = /\bctx\.([A-Za-z_$][\w$]*)\b/g;

  for (const file of list) {
    if (CONSUMER_EXCLUDE.has(file.path)) continue;
    const masked = maskedByFile.get(file.path);
    const stripped = strippedByFile.get(file.path);
    const addConsumer = (service, method) => {
      if (!providedServices.has(service)) return;
      if (!consumersByService.has(service)) consumersByService.set(service, []);
      consumersByService.get(service).push(file.path + ":" + method);
    };

    // 服务名在字符串里，所以匹配必须跑在「只剥注释」的文本上；
    // 再用位置对照 masked 排除「整段调用写在字符串字面量里」的假命中。
    let match;
    consumerRe.lastIndex = 0;
    while ((match = consumerRe.exec(stripped))) {
      if (masked[match.index] !== stripped[match.index]) continue;
      addConsumer(match[2], match[1] || "get");
    }
    // ctx.x 属性读：属性名不是字符串，masked 与 stripped 一致，直接用 masked 更安全
    ctxPropRe.lastIndex = 0;
    while ((match = ctxPropRe.exec(masked))) {
      addConsumer(match[1], "ctx-prop");
    }
    if (file.path === PATHS.dshCompat) {
      // `alias(ctx, 'llm', buildLlm)` 的真实服务名是字面量，但调用是 ctx.get(变量)：
      // 用显式别名表把它补成「消费 llm / shell / fs / tools / session / settings」。
      const aliasRe = /ctx\.provide\s*\(\s*['"](dsh[A-Za-z]+)['"]/g;
      while ((match = aliasRe.exec(stripped))) {
        const real = DSH_ALIASES[match[1]];
        if (real) addConsumer(real, "dsh-alias");
      }
    }
  }

  // 9) 汇总到条目
  for (const entry of built) {
    const consumers = new Set();
    for (const service of entry.provides) {
      for (const record of consumersByService.get(service) || []) {
        if (record.startsWith(entry.file + ":")) continue;
        consumers.add(record);
      }
    }
    entry.consumers = [...consumers].sort(cmp);

    const dependents = new Set();
    for (const injector of injectors) {
      if (injector.plugin === entry.plugin) continue;
      if (injector.inject.some((service) => entry.provides.includes(service))) {
        dependents.add(injector.plugin);
      }
    }
    entry.injectDependents = [...dependents].sort(cmp);
    entry.marketAnchors = uniqSorted(anchorsByPlugin.get(entry.plugin) || []);
    entry.kind = classify(entry);
    entry.statuses = provideStatuses(entry, consumersByService, injectors);
    entry.reason = describeEntry(entry, entry.statuses, duplicates);
  }

  // 10) 注册表声明 vs 文件实际 provide 的漂移（多插件文件按注册表为准，不参与对比）
  const registryDrift = [];
  for (const reg of registrations) {
    if ((pluginsPerFile.get(reg.file) || 1) > 1) continue;
    const info = infos.get(reg.file);
    const scanned = uniqSorted([...(info ? info.provides : [])]);
    const declared = uniqSorted(reg.provides);
    const declaredNotProvided = declared.filter((service) => !scanned.includes(service));
    const providedNotDeclared = scanned.filter((service) => !declared.includes(service));
    if (declaredNotProvided.length || providedNotDeclared.length) {
      registryDrift.push({
        plugin: reg.plugin,
        file: reg.file,
        declaredNotProvided,
        providedNotDeclared,
      });
    }
  }
  registryDrift.sort((a, b) => cmp(a.plugin + "|" + a.file, b.plugin + "|" + b.file));

  // 11) 孤儿市场锚：市场目录指向了清单里不存在的插件
  const entryPlugins = new Set(built.map((entry) => entry.plugin));
  const orphanMarketAnchors = uniqSorted(
    market.filter((item) => !entryPlugins.has(item.anchor)).map((item) => item.dshName + " -> " + item.anchor)
  );

  // 12) 输出（去掉内部字段；排序保证字节稳定）
  const entries = built
    .slice()
    .sort((a, b) => cmp(a.plugin, b.plugin) || cmp(a.file, b.file))
    .map((entry) => ({
      plugin: entry.plugin,
      file: entry.file,
      provides: entry.provides,
      kind: entry.kind,
      consumers: entry.consumers,
      injectDependents: entry.injectDependents,
      marketAnchors: entry.marketAnchors,
      sideEffects: entry.sideEffects,
      switchable: false,
      reason: entry.reason,
    }));

  const kinds = {};
  for (const kind of KIND_ORDER) kinds[kind] = 0;
  for (const entry of entries) kinds[entry.kind] += 1;

  const wrappers = entries
    .filter((entry) => entry.kind === "wrapper")
    .map((entry) => ({ plugin: entry.plugin, file: entry.file, provides: entry.provides }));

  const registrationProvideUnused = built
    .filter((entry) => entry.kind === "registration")
    .map((entry) => ({
      plugin: entry.plugin,
      provides: entry.provides.filter((service) => entry.statuses[service] === "provide-unused"),
    }))
    .filter((item) => item.provides.length > 0)
    .sort((a, b) => cmp(a.plugin, b.plugin));

  const summary = {
    total: entries.length,
    kinds,
    wrappers,
    unclassified: built
      .filter((entry) => entry.source === "derived")
      .map((entry) => ({ plugin: entry.plugin, file: entry.file, provides: entry.provides }))
      .sort((a, b) => cmp(a.plugin, b.plugin) || cmp(a.file, b.file)),
    registrationProvideUnused,
    dynamic: entries.filter((entry) => entry.kind === "dynamic").map((entry) => entry.plugin),
    duplicates: Object.keys(duplicates).length,
    unresolvedPlugins: uniqSorted(unresolvedPlugins),
  };

  return {
    _doc: DOC,
    version: 1,
    entries,
    duplicates,
    registryDrift,
    orphanMarketAnchors,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* 扫描仓库                                                            */
/* ------------------------------------------------------------------ */

function walkSource(dir, out) {
  let children;
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const child of children) {
    if (child.name === "node_modules" || child.name === ".git") continue;
    const full = path.join(dir, child.name);
    if (child.isDirectory()) {
      // 测试目录不算生产 provide / 消费方（否则自测能把死代码救活）
      if (child.name === "test" && path.resolve(dir) === path.resolve(ROOT, "src")) continue;
      walkSource(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(child.name)) out.push(full);
  }
  return out;
}

/** 读取真实仓库：src/**\/*.ts(x) + YAML + 注册表 */
export function scanRepo(root) {
  const base = root || ROOT;
  const files = walkSource(path.join(base, "src"), []).map((full) => ({
    path: path.relative(base, full).replace(/\\/g, "/"),
    text: fs.readFileSync(full, "utf8"),
  }));
  const read = (rel) => {
    const full = path.join(base, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  };
  // 注册表本身也在 src 里；YAML 与市场目录（市场目录已在 files 中）按需读取
  return {
    files,
    yaml: read(PATHS.yaml),
    registry: read(PATHS.registry),
  };
}

/* ------------------------------------------------------------------ */
/* 漂移比对（--check 的内核，单测直接驱动）                              */
/* ------------------------------------------------------------------ */

/** 规范化 JSON：对象键排序、数组保持顺序，用于语义比较 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort(cmp)
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

/**
 * 比对「已提交清单」与「本次生成清单」。
 * 返回 { ok, added, removed, changed, other, parseError? }；--check 非 ok 即红。
 */
export function diffAudit(expected, actual) {
  const exp = expected && typeof expected === "object" ? expected : {};
  const act = actual && typeof actual === "object" ? actual : {};
  const entryKey = (entry) => String(entry.plugin) + "|" + String(entry.file);
  const expEntries = Array.isArray(exp.entries) ? exp.entries : [];
  const actEntries = Array.isArray(act.entries) ? act.entries : [];
  const expMap = new Map(expEntries.map((entry) => [entryKey(entry), entry]));
  const actMap = new Map(actEntries.map((entry) => [entryKey(entry), entry]));

  const added = [...actMap.keys()].filter((key) => !expMap.has(key)).sort(cmp);
  const removed = [...expMap.keys()].filter((key) => !actMap.has(key)).sort(cmp);
  const changed = [];
  for (const key of [...actMap.keys()].filter((key) => expMap.has(key)).sort(cmp)) {
    const actualEntry = actMap.get(key);
    const expectedEntry = expMap.get(key);
    const fields = [];
    for (const field of Object.keys(actualEntry)) {
      if (canonicalJson(actualEntry[field]) !== canonicalJson(expectedEntry[field])) {
        fields.push(field);
      }
    }
    for (const field of Object.keys(expectedEntry)) {
      if (!(field in actualEntry)) fields.push(field);
    }
    if (fields.length) changed.push({ key, fields: fields.sort(cmp) });
  }

  const other = {};
  for (const key of ["version", "duplicates", "registryDrift", "orphanMarketAnchors", "summary"]) {
    if (canonicalJson(exp[key]) !== canonicalJson(act[key])) other[key] = true;
  }

  return {
    ok: added.length === 0 && removed.length === 0 && changed.length === 0 && Object.keys(other).length === 0,
    added,
    removed,
    changed,
    other,
  };
}

/** --check 的入口：把生成结果与 JSON 文本比对（JSON 解析失败同样算红） */
export function checkAgainstJson(generated, jsonText) {
  let expected;
  try {
    expected = JSON.parse(String(jsonText));
  } catch (error) {
    return {
      ok: false,
      parseError: String((error && error.message) || error),
      added: [],
      removed: [],
      changed: [],
      other: {},
    };
  }
  return diffAudit(expected, generated);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function formatDiff(result) {
  const lines = [];
  if (result.parseError) {
    lines.push("  清单 JSON 解析失败：" + result.parseError);
  }
  if (result.added.length) lines.push("  新增条目：" + result.added.join("、"));
  if (result.removed.length) lines.push("  删除条目：" + result.removed.join("、"));
  for (const item of result.changed) {
    lines.push("  变更条目：" + item.key + "（字段：" + item.fields.join("、") + "）");
  }
  const otherKeys = Object.keys(result.other || {});
  if (otherKeys.length) lines.push("  顶层字段变化：" + otherKeys.join("、"));
  return lines.join("\n");
}

function printSummary(document) {
  const summary = document.summary;
  const kindText = KIND_ORDER.map((kind) => kind + " " + summary.kinds[kind]).join(" / ");
  console.log("provider-audit: 共 " + summary.total + " 条（" + kindText + "）");

  console.log("wrapper（" + summary.wrappers.length + "）：");
  for (const item of summary.wrappers) {
    const services = item.provides.length ? item.provides.join(", ") : "(无 provide)";
    console.log("  - " + item.plugin + " [" + item.file + "] -> " + services);
  }

  const duplicateKeys = Object.keys(document.duplicates);
  console.log("duplicate（" + duplicateKeys.length + "）：");
  for (const key of duplicateKeys) {
    console.log("  - " + key + " <- " + document.duplicates[key].join(", "));
  }

  console.log("未分类（" + summary.unclassified.length + "）：");
  for (const item of summary.unclassified) {
    console.log("  - " + item.plugin + " [" + item.file + "]");
  }

  if (summary.registrationProvideUnused.length) {
    console.log("registration 里 provide-unused（" + summary.registrationProvideUnused.length + "）：");
    for (const item of summary.registrationProvideUnused) {
      console.log("  - " + item.plugin + " -> " + item.provides.join(", "));
    }
  }
  if (summary.dynamic.length) {
    console.log("dynamic（" + summary.dynamic.length + "）：" + summary.dynamic.join("、"));
  }
  if (summary.unresolvedPlugins.length) {
    console.log("注册表插件无文件（" + summary.unresolvedPlugins.length + "）：" + summary.unresolvedPlugins.join("、"));
  }
  if (document.registryDrift.length) {
    console.log("注册表声明与文件实际的漂移（" + document.registryDrift.length + "）：");
    for (const item of document.registryDrift) {
      const parts = [];
      if (item.declaredNotProvided.length) parts.push("声明未 provide: " + item.declaredNotProvided.join(", "));
      if (item.providedNotDeclared.length) parts.push("provide 未声明: " + item.providedNotDeclared.join(", "));
      console.log("  - " + item.plugin + " [" + item.file + "] " + parts.join("；"));
    }
  }
  if (document.orphanMarketAnchors.length) {
    console.log("孤儿市场锚（" + document.orphanMarketAnchors.length + "）：" + document.orphanMarketAnchors.join("、"));
  }
}

function main(argv) {
  const wantWrite = argv.includes("--write");
  const wantCheck = argv.includes("--check");
  if (wantWrite && wantCheck) {
    console.error("provider-audit: --write 与 --check 不能同时使用");
    process.exitCode = 2;
    return;
  }
  const unknown = argv.filter((arg) => arg !== "--write" && arg !== "--check");
  if (unknown.length) {
    console.error("provider-audit: 未知参数 " + unknown.join(" "));
    console.error("用法: node tools/audit/provider-audit.mjs [--write|--check]");
    process.exitCode = 2;
    return;
  }

  const scanned = scanRepo(ROOT);
  const document = buildAudit(scanned.files, scanned.yaml, scanned.registry);
  printSummary(document);

  const outPath = path.join(ROOT, PATHS.out);
  if (wantWrite) {
    fs.writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n", "utf8");
    console.log("provider-audit: 已写入 " + PATHS.out);
    return;
  }
  if (wantCheck) {
    if (!fs.existsSync(outPath)) {
      console.error("provider-audit: 缺少清单 " + PATHS.out + "（先跑 --write）");
      process.exitCode = 1;
      return;
    }
    const result = checkAgainstJson(document, fs.readFileSync(outPath, "utf8"));
    if (result.ok) {
      console.log("provider-audit: 清单与代码一致（绿）");
      return;
    }
    console.error("provider-audit: 清单漂移（红）");
    console.error(formatDiff(result));
    console.error("修复: node tools/audit/provider-audit.mjs --write");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
