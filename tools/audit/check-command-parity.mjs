/**
 * 通信链路门禁：渲染侧协议命令 ↔ Rust `COMMANDS` 白名单**双向对齐**。
 *
 * ## 为什么需要它（第 48 轮补的审计轴）
 *
 * 项目里已有一整套存储门禁（静默写 / 假成功 / 守卫绕过 / 存储边界 / 未路由 DB /
 * schema 一致 / 覆盖率），但它们全部只看**渲染侧**。而这条链路是两种语言写的：
 *
 * ```
 * 渲染侧 JS ──(命令名字符串)──> Tauri invoke ──> Rust dispatch(COMMANDS 白名单) ──> SQLite
 * ```
 *
 * 两段之间唯一的契约就是**命令名这个字符串**，它没有任何编译期检查：
 *
 * | 方向 | 出问题的形态 | 用户看到什么 |
 * | --- | --- | --- |
 * | 渲染 → Rust | 渲染侧发了一条白名单里没有的命令（拼错 / 改名后的残留） | 引擎回 `UNSUPPORTED`，调用方的"回落"分支把失败吃掉 → **功能静默不生效** |
 * | Rust → 渲染 | 白名单里有命令但没人发 | 见下：**这不一定是缺陷** |
 *
 * ## 只强制一个方向（判据是第二版改过的，第一版的 37 条"错误"里没有一条是真缺陷）
 *
 * 第一版把"白名单里有命令没人发"一律当错误，报出 37 处。逐个查完之后发现：
 *
 * 1. **引擎是独立产物**：`codem-db` 有自己的 CLI（`invoke <command>`）与迁移工具，
 *    `import.*` / `digest.*` / `legacy.read_table` / `migration.*` 属于那条链路，
 *    渲染侧本来就不该发（这些已被"工具"这一档收进来）；
 * 2. **引擎有自己的一层 API 契约**：`sessions.delete` / `projects.list` 之类只被引擎
 *    自己的用例发，那是"引擎作为库"的正常形态，不是"测试替不存在的链路背书"；
 * 3. **渲染侧已切到表驱动面**：应用读写会话/项目/消息走 `crud.* + 表名`，
 *    于是 `sessions.upsert` / `messages.create` 这些**领域专用命令**在渲染侧没有调用点 ——
 *    这是架构选择的后果，删掉它们反而砍掉引擎的对外表面。
 *
 * 把"信息"当"错误"会逼出一堆假修复，比漏报更糟。所以反方向以**信息**形式报出来
 * （`--list` / `--json`），供审计判断。
 *
 * ## 另一条刻意不检查的：启动能力守卫的清单
 *
 * `bootstrap.ts::CRITICAL_ENGINE_COMMANDS` 与"生产实际发送的命令集合"并不重合
 * （实测：应用会发但守卫没查 26 条；守卫在查但应用从不发 10 条）。
 * 这**不是**缺陷 —— 那个清单在源码里写明了用途是"陈旧二进制的判据"，
 * 刻意只收"任何一个健康引擎都必然具备"的老命令，加新命令反而会让守卫误报。
 * 它是一份"引擎版本代理"清单，不是"需求清单"。
 *
 * ## 判据怎么定准的（三次修正，每次都是因为报出来的东西不对劲）
 *
 * 1. 候选字面量从"形如 `a.b` 且前缀眼熟"收窄到**只认发送点**，
 *    否则 `storage.bootstrap`（Tauri 命令名）、`settings.panel`（槽位 id）、
 *    `agent.run`（发给 DSH SDK 的方法名）这类同形不同命名空间的东西全被算进来；
 * 2. 发送点的调用形状补全成三种（第 1 参数直呼 / 第 2 参数 / `cmd:` 字段）——
 *    本仓库最主流的是 `call(this.t, "messages.list", …)`（命令在第 2 个参数），
 *    漏了它会把大部分命令误判成"没人用"；
 * 3. 调用方范围补上 Node 工具与 Rust 内部，并且**把测试从生产里剔干净**：
 *    Rust 集成测试目录（`codem-db/tests/*.rs`）与 `#[cfg(test)]` 之后的代码都算测试。
 *
 * ## 金丝雀（必须有）
 *
 * 抽取器一旦失效，"零发现"就会伪装成"全部对齐" —— 本文件第一版就踩过：
 * 一个自毁 bug（先把字符串删掉、再在结果里找字符串）让生产侧命中 0 条，
 * 脚本却一本正经地报了 77 条"死命令"。所以生产命中数与白名单条数都有下限，
 * 低于下限**按失败处理**，不报绿。
 *
 * ## 诚实交代的边界
 *
 * - 命令名由**变量**拼出来的发送点抓不到（例如 `cmd` 从表名推导）。
 *   这类漏检是"少报"，不会造成假绿：`--list` 会把它显示成"没有生产调用方"。
 * - 前缀本身拼错（`mesages.list`）的调用抓不到 —— 那种情况与白名单完全无交集，
 *   属于另一个门禁（未路由 DB）的领域。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RUST_LIB = "src-tauri/codem-db/src/lib.rs";

/**
 * 剥注释：注释换成空白，**字符串字面量原样保留**（发送点判据需要它们）。
 *
 * 本仓库注释里大量逐字引用命令名（举例、讲历史坑），不剥注释就会把它们当调用点。
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let state = "code"; // code | line | block
  let inString = false;
  let quote = "";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; out += "  "; i += 2; continue; }
      if (c === "\n") out += "\n";
      i += 1;
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === quote) { inString = false; quote = ""; }
      i += 1;
      continue;
    }
    if (c === "/" && c2 === "/") { state = "line"; i += 2; continue; }
    if (c === "/" && c2 === "*") { state = "block"; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { inString = true; quote = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 发送点：命令名作为某个调用点的参数出现。
 *
 * 名字清单是**从实现里核对出来的**，不是猜的 —— 少收一种形状就会把"发过的命令"
 * 误判成没人用（第一版就漏了 `writeThrough` 与 `invokeCli`）：
 *
 * | 形状 | 例子 |
 * | --- | --- |
 * | 传输层/封装直呼（第 1 参数） | `__codemDb("settings.get_all")`、`writeThrough("quick_phrases.save", …)` |
 * | 命令在**第 2 个参数**（本仓库最主流） | `call(this.t, "messages.list", …)`、`persistWriteThrough(table, "crud.upsert", …)`、`invokeCli(db, "legacy.read_table", …)` |
 * | 对象字段 | `{ cmd: "crud.delete" }`（`domain-store.ts` 的待重放队列） |
 */
const SEND_PATTERNS = [
  /\b(?:__codemDb|invokeCommand|callCommand|sendCommand|rawCommand|writeThrough|query|execute|command|invoke|dispatch|call)\s*(?:<[^<>()]{0,120}>)?\s*\(\s*["'`]([a-z][a-z0-9_]*\.[a-z0-9_.]+)["'`]/g,
  /\b(?:call|invoke|dispatch|query|execute|command|invokeCommand|callCommand|sendCommand|persistWriteThrough|invokeCli|callWithRetry)\s*(?:<[^<>()]{0,120}>)?\s*\(\s*[^,()]{1,80},\s*["'`]([a-z][a-z0-9_]*\.[a-z0-9_.]+)["'`]/g,
  /\b(?:cmd|command|op)\s*:\s*["'`]([a-z][a-z0-9_]*\.[a-z0-9_.]+)["'`]/g,
];

function sendSites(src) {
  const code = stripComments(src);
  const found = [];
  for (const re of SEND_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) found.push(m[1]);
  }
  return found;
}

function walk(dir, exts, acc = []) {
  let names;
  try { names = readdirSync(dir); } catch { return acc; }
  for (const name of names) {
    if (name === "node_modules" || name === ".git" || name === "target") continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, acc);
    else if (exts.test(name)) acc.push(p);
  }
  return acc;
}

/**
 * 分析入口。
 *
 * 导出（而不是只做 CLI）是为了让用例能**在进程内**驱动它 —— 与其它门禁扫描器一致：
 * `audit-gates.test.ts` 里"门禁必须会咬"那组就是这么测的（给故意写坏的样本，
 * 断言它真的报出来）。一个只会报绿的扫描器比没有扫描器更危险。
 *
 * @param {{root?: string}} opts 仓库根（用例传临时目录做夹具）
 */
export function analyzeCommandParity({ root = process.cwd() } = {}) {
  const ROOT = root;
  const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");

  /** 收集发送点：命令 → 文件集合 */
  const collect = (list) => {
    const hits = new Map();
    for (const f of list) {
      for (const cmd of sendSites(readFileSync(f, "utf8"))) {
        if (!hits.has(cmd)) hits.set(cmd, new Set());
        hits.get(cmd).add(rel(f));
      }
    }
    return hits;
  };

  // ------------------------------------------------------------ 1. Rust 白名单

  const rustSrc = readFileSync(join(ROOT, RUST_LIB), "utf8");
  const blockMatch = rustSrc.match(/pub const COMMANDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\n\];/);
  if (!blockMatch) {
    throw new Error("[command-parity] 读不到 Rust COMMANDS 白名单 —— 门禁失效，按失败处理");
  }
  const rustCommands = [...blockMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const rustSet = new Set(rustCommands);
  const prefixes = new Set(
    rustCommands.map((c) => (c.includes(".") ? c.slice(0, c.indexOf(".")) : c)),
  );

  // ------------------------------------------------------------ 2. 四档调用方

  const srcFiles = walk(join(ROOT, "src"), /\.(ts|tsx)$/);
  const prodFiles = srcFiles.filter((f) => !rel(f).startsWith("src/test/"));
  const testFiles = srcFiles.filter((f) => rel(f).startsWith("src/test/"));
  const toolFiles = [
    ...walk(join(ROOT, "tools"), /\.(mjs|js|ts)$/),
    ...walk(join(ROOT, "scripts"), /\.(mjs|js|ts)$/),
  ].filter((f) => !rel(f).includes("check-command-parity")); // 门禁自己不能算调用方

  const prodHits = collect(prodFiles);
  const testHits = collect(testFiles);
  const toolHits = collect(toolFiles);

  /**
   * Rust 内部调用点。必须排除三类，否则这个方向会**恒绿**（自己给自己当调用方）：
   * 1. `COMMANDS` 数组本身；
   * 2. `dispatch` 里 `"cmd" => …` 的 match 臂 —— 那是实现，不是调用方；
   * 3. **测试**：集成测试目录（`codem-db/tests/` 下的 `.rs`）整文件都是测试，
   *    同文件里 `#[cfg(test)]` 之后也是。第一版只排了第 3 类的一半，
   *    于是"Rust 内部 44 条有调用方"看起来一片繁荣 —— 实际全是用例。
   */
  const rustHits = new Map();
  const rustTestHits = new Map();
  for (const f of walk(join(ROOT, "src-tauri"), /\.rs$/)) {
    const isIntegrationTest = /\/tests\//.test(rel(f));
    let text = readFileSync(f, "utf8");
    if (rel(f) === RUST_LIB) text = text.replace(/pub const COMMANDS:[\s\S]*?\n\];/, "");
    const cut = text.search(/#\[cfg\(test\)\]/);
    const prodPart = isIntegrationTest ? "" : cut === -1 ? text : text.slice(0, cut);
    const testPart = isIntegrationTest ? text : cut === -1 ? "" : text.slice(cut);
    const scan = (part, sink) => {
      for (const line of stripComments(part).split("\n")) {
        if (line.includes("=>")) continue; // match 臂 = 实现
        for (const re of [
          /\bcall\s*\(\s*&?\w+\s*,\s*"([a-z][a-z0-9_]*\.[a-z0-9_.]+)"/g,
          /\bdispatch\s*\([^,]+,\s*"([a-z][a-z0-9_]*\.[a-z0-9_.]+)"/g,
        ]) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line)) !== null) {
            if (!sink.has(m[1])) sink.set(m[1], new Set());
            sink.get(m[1]).add(rel(f));
          }
        }
      }
    };
    scan(prodPart, rustHits);
    scan(testPart, rustTestHits);
  }

  // ------------------------------------------------------------ 3. 判据

  const errors = [];

  // 方向一（唯一强制的方向）：渲染侧生产代码不许发未知命令
  for (const [cmd, where] of prodHits) {
    const prefix = cmd.includes(".") ? cmd.slice(0, cmd.indexOf(".")) : cmd;
    // 前缀过滤：`agent.run`（发给 DSH SDK 的方法名）之类与引擎白名单无关
    if (!prefixes.has(prefix)) continue;
    if (!rustSet.has(cmd)) {
      errors.push(
        `渲染侧发出 Rust 白名单里不存在的命令：\`${cmd}\`（${[...where].join(", ")}）` +
          ` —— 引擎会回 UNSUPPORTED，失败通常被"回落"分支吃掉 → 功能静默不生效`,
      );
    }
  }

  // 金丝雀：抽取器/解析器失效时，"零发现"不许伪装成"全部对齐"
  if (prodHits.size < 20) {
    errors.push(
      `渲染侧只抽到 ${prodHits.size} 条命令（预期 ≥ 20）—— 抽取器可能失效，这种"绿"没有意义`,
    );
  }
  if (rustCommands.length < 50) {
    errors.push(`Rust 白名单只解析出 ${rustCommands.length} 条（预期 ≥ 50）—— 解析器可能失效`);
  }

  /** 白名单里没有生产调用方的命令（**信息**，非失败，理由见文件头） */
  const noProdCaller = rustCommands.filter(
    (c) =>
      (prodHits.get(c)?.size ?? 0) + (toolHits.get(c)?.size ?? 0) + (rustHits.get(c)?.size ?? 0) === 0,
  );

  const testOnly = [
    ...new Set([
      ...[...testHits.keys()].filter((c) => rustSet.has(c)),
      ...[...rustTestHits.keys()],
    ]),
  ].sort();

  /**
   * ## 第 53 轮：顺带把**错误码**的对齐也钉住（同一条链路的另一半）
   *
   * 命令名对齐了，错误码不对齐同样会静默失真：
   * - 引擎返回一个渲染侧不认识的 code → 渲染侧映射成 `OTHER` → **错误码这个"值"丢了**；
   * - 两侧的 `retryable` 规则不一致 → 要么"一直在重试引擎说别重试的失败"，
   *   要么"引擎说可重试、渲染侧一次就放弃"。
   *
   * 当前**实测是对齐的**（10 个 code 逐一相同、4 个 retryable 相同、`hint` 也接到了
   * `StorageError.detail`），但此前**没有任何东西守着它** —— 改一侧忘了另一侧不会红。
   */
  const errCodes = compareErrorCodes({ root: ROOT });
  errors.push(...errCodes.errors);

  return {
    rustCommands,
    prodHits,
    toolHits,
    rustHits,
    testOnly,
    noProdCaller,
    errors,
    errorCodes: errCodes.summary,
  };
}

/**
 * 错误码契约的对齐（第 53 轮）。见 `analyzeCommandParity` 里的调用点注释。
 *
 * 解析两侧源码的字面量，**不做语义推断**：`as_str()` 的字符串、`retryable()` 的
 * `matches!` 列表、`hint()` 覆盖的变体、渲染侧的联合类型与 `RETRYABLE` 集合，全是字面量。
 */
export function compareErrorCodes({ root = process.cwd() } = {}) {
  const errors = [];
  const rustErr = readFileSync(join(root, "src-tauri/codem-db/src/error.rs"), "utf8");
  const portSrc = readFileSync(join(root, "src/core/storage/port.ts"), "utf8");

  // ---- 引擎侧：as_str() 的映射（变体名 → 线上字符串） ----
  const asStrBlock = rustErr.match(/pub fn as_str\(self\)\s*->\s*&'static str\s*\{([\s\S]*?)\n\s*\}/);
  const engineMap = new Map();
  if (asStrBlock) {
    for (const m of asStrBlock[1].matchAll(/ErrorCode::(\w+)\s*=>\s*"([A-Z_]+)"/g)) {
      engineMap.set(m[1], m[2]);
    }
  }

  // ---- 引擎侧：retryable() 的 matches! 列表 ----
  const retryBlock = rustErr.match(/pub fn retryable\(self\)\s*->\s*bool\s*\{([\s\S]*?)\n\s*\}/);
  const engineRetryable = new Set();
  if (retryBlock) {
    for (const m of retryBlock[1].matchAll(/ErrorCode::(\w+)/g)) engineRetryable.add(m[1]);
  }

  // ---- 引擎侧：hint() 覆盖了哪些变体 ----
  const hintBlock = rustErr.match(/pub fn hint\(self\)\s*->\s*&'static str\s*\{([\s\S]*?)\n\s*\}/);
  const engineHints = new Set();
  if (hintBlock) {
    for (const m of hintBlock[1].matchAll(/ErrorCode::(\w+)/g)) engineHints.add(m[1]);
  }

  // ---- 渲染侧：StorageErrorCode 联合类型 ----
  const unionBlock = portSrc.match(/export type StorageErrorCode\s*=([\s\S]*?);/);
  const rendererCodes = new Set();
  if (unionBlock) {
    for (const m of unionBlock[1].matchAll(/"([A-Z_]+)"/g)) rendererCodes.add(m[1]);
  }

  // ---- 渲染侧：RETRYABLE 集合 ----
  const retrySet = portSrc.match(
    /const RETRYABLE:\s*ReadonlySet<StorageErrorCode>\s*=\s*new Set<StorageErrorCode>\(\[([^\]]*)\]\)/,
  );
  const rendererRetryable = new Set();
  if (retrySet) {
    for (const m of retrySet[1].matchAll(/"([A-Z_]+)"/g)) rendererRetryable.add(m[1]);
  }

  // ---- 金丝雀：解析器失效不许伪装成"对齐"（第 48 轮那条教训） ----
  if (engineMap.size < 5 || rendererCodes.size < 5 || !retryBlock || !retrySet) {
    errors.push(
      `错误码解析器可能失效（引擎 ${engineMap.size} 个 / 渲染侧 ${rendererCodes.size} 个 / ` +
        `retryable 块 ${retryBlock ? "有" : "无"} / RETRYABLE 块 ${retrySet ? "有" : "无"}）—— 这种"绿"没有意义`,
    );
    return { errors, summary: { engine: engineMap.size, renderer: rendererCodes.size } };
  }

  // ---- 判据 1：字符串集合必须一致（两向都查） ----
  const engineStrings = new Set(engineMap.values());
  for (const s of engineStrings) {
    if (!rendererCodes.has(s)) {
      errors.push(
        `引擎会发错误码 \`${s}\`，但渲染侧 StorageErrorCode 里没有它 → 会被静默映射成 OTHER（错误码丢失）`,
      );
    }
  }
  for (const s of rendererCodes) {
    if (!engineStrings.has(s)) {
      errors.push(`渲染侧声明了错误码 \`${s}\`，但引擎 as_str() 永远不会发它（两侧声明了对不上的值）`);
    }
  }

  // ---- 判据 2：retryable 一致（把变体名换算成线上字符串再比） ----
  const engineRetryableStrings = new Set(
    [...engineRetryable].map((v) => engineMap.get(v) ?? `?${v}`),
  );
  for (const s of engineRetryableStrings) {
    if (!rendererRetryable.has(s)) {
      errors.push(`引擎认为 \`${s}\` 可重试，但渲染侧 RETRYABLE 里没有 → 引擎说可重试、渲染侧一次就放弃`);
    }
  }
  for (const s of rendererRetryable) {
    if (!engineRetryableStrings.has(s)) {
      errors.push(`渲染侧把 \`${s}\` 当可重试，但引擎没把它算作可重试 → 可能在重试一个明确不该重试的失败`);
    }
  }

  // ---- 判据 3：每个 code 都要有 hint（界面与日志的可执行建议） ----
  for (const v of engineMap.keys()) {
    if (!engineHints.has(v)) {
      errors.push(`引擎错误码 \`${engineMap.get(v)}\` 没有 hint（界面与日志就拿不到可执行建议）`);
    }
  }

  return {
    errors,
    summary: {
      engineCodes: [...engineStrings].sort(),
      rendererCodes: [...rendererCodes].sort(),
      engineRetryable: [...engineRetryableStrings].sort(),
      rendererRetryable: [...rendererRetryable].sort(),
      hintCovered: engineHints.size,
    },
  };
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const result = analyzeCommandParity();
  const { rustCommands, prodHits, toolHits, rustHits, testOnly, noProdCaller, errors, errorCodes } = result;
  const jsonMode = process.argv.includes("--json");
  const listMode = process.argv.includes("--list");

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          rustCommands: rustCommands.length,
          prod: [...prodHits.keys()].sort(),
          tools: [...toolHits.keys()].sort(),
          rustInternal: [...rustHits.keys()].sort(),
          testOnly,
          noCaller: noProdCaller,
          errors,
        },
        null,
        2,
      ),
    );
    process.exit(errors.length > 0 ? 1 : 0);
  }

  if (listMode) {
    const fmt = (m) =>
      [...m.entries()].map(
        ([k, v]) => `${k}(${[...v].map((p) => p.replace(/^src(-tauri)?\//, "")).join(" ")})`,
      );
    console.log("== 生产（渲染侧发送点）==");
    for (const line of fmt(prodHits)) console.log("  " + line);
    console.log("== 工具（引擎 CLI / 迁移）==");
    for (const line of fmt(toolHits)) console.log("  " + line);
    console.log("== Rust 生产 ==");
    for (const line of fmt(rustHits)) console.log("  " + line);
    console.log(`== 白名单里没有生产调用方（${noProdCaller.length} 条，信息，非失败）==`);
    console.log("  " + noProdCaller.join(", "));
    process.exit(errors.length > 0 ? 1 : 0);
  }

  console.log(
    `[command-parity] Rust 白名单 ${rustCommands.length} 条；调用方分布：` +
      `渲染侧生产 ${prodHits.size} / 工具 ${toolHits.size} / Rust 生产 ${rustHits.size}；` +
      `无生产调用方 ${noProdCaller.length} 条（信息，见 --list）`,
  );
  // 错误码契约也一并报出来（第 53 轮）：对齐**必须看得见**，否则"绿"可能只是没跑
  if (errorCodes?.engineCodes) {
    console.log(
      `[error-parity] 错误码 ${errorCodes.engineCodes.length} 个两侧一致` +
        `（引擎/渲染侧集合相同）；可重试 ${errorCodes.engineRetryable.length} 个一致：` +
        `${errorCodes.engineRetryable.join(", ")}；hint 覆盖 ${errorCodes.hintCovered} 个`,
    );
  }

  if (errors.length > 0) {
    console.error(`\n[command-parity] ✗ ${errors.length} 处不一致：`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(
    "[command-parity] ✓ 渲染侧没有发出引擎不认识的命令（`--list` 看完整分布、`--json` 取机读结果）",
  );
}
