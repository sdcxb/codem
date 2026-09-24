/**
 * 可达性审计（第 109 轮，从 `.preview-shot/_reachability-scan.mjs` 升级为**常驻门禁**）。
 *
 * ## 它解决什么
 *
 * 「功能写完了，但**没有任何生产代码调用它**」这一类缺陷，普通测试与 knip 都抓不到：
 *  - 测试能过（它自己 import 自己测的东西）；
 *  - knip 的 "Unused files" 在这个仓库里是**空的**（实测），因为它的入口配置把 `src/**` 都当成了可达；
 *  - 于是"宠物窗崩溃兜底从来没接上"（第 108 轮）这种东西能一直躺着。
 *
 * 这里做的是**模块解析 + 可达性**（不是字符串匹配 —— 第 105 轮那版按名字片段匹配，
 * 既漏又错，`dsh-compat` 明明被 `plugin-loader/builtin-registry.ts` import 却报 0）：
 *  1. 说明符按 Vite/Node 规则解析到具体文件（补 `.ts`/`.tsx`/`/index.ts`，剥 `?raw`）；
 *  2. 从入口 `src/main.tsx` / `src/pet-main.tsx` 做 BFS；
 *  3. 字面量 `import("…")` 算边；**非字面量**动态 import 记为该文件的"动态目标"，**不当死代码**；
 *  4. 报告：可达 / **仅测试可达或含动态命中**（未接线嫌疑）/ 完全不可达（孤儿）。
 *
 * ## 自检（不信就自己证明）
 *
 * 内置两条**已知答案**的对照：`src/components/MessageBubble.tsx` 必须可达、
 * `src/core/storage/sync-engine.ts` 必须不可达。对照不过 ⇒ `trustworthy: false`，
 * 调用方（用例 / `--check`）必须把它当失败处理，**不许**拿结论去下判断。
 *
 * ## 白名单
 *
 * `tools/audit/reachability-allowlist.json` 逐条登记"已知且已定性"的不可达文件
 * （barrel 转出口 / stubs / 类型声明 / 插件入口 / 仓库工具脚本 / 已登记的未接线模块），
 * 每条带类别。判据：**不可达集合必须 ⊆ 白名单**，且**白名单不许有过期条目**。
 *
 * 用法：node tools/audit/reachability-scan.mjs [--json out.json] [--check]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ALLOWLIST = "tools/audit/reachability-allowlist.json";

/**
 * 取"仓库里真实存在的源码文件"清单 —— 优先用 `git ls-files`。
 *
 * ⚠️ 为什么要这样取（第 109 轮踩到的坑）：直接用 `fs.readdir` 扫盘时，**全量测试运行期间**
 * 会有测试在 `src/` 下临时创建/删除文件（同一个套件里就有若干"往仓库里写夹具再删"的用例），
 * 于是扫描偶尔会看到一些**只在那一瞬间存在**的文件，把它们报成"不可达" ⇒ 门禁**偶发假红**
 * （实测：同一份代码，`npx vitest run` 单独跑通过、`npm run verify` 那一跑红过）。
 * 审计的对象是**仓库里的代码**，不是并发测试留下的临时产物，所以这里以 git 跟踪的文件为准；
 * git 不可用时回退到扫盘（并在结果里标注）。
 */
function listSourceFiles(root) {
  const rel = (f) => f.replace(/\\/g, "/");
  const git = spawnSync("git", ["ls-files", "src"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (git.status === 0 && git.stdout.trim()) {
    /*
     * **只算 git 跟踪的文件**（不含 `--others`）。
     *
     * 第 109 轮实测的坑：把"未跟踪文件"也算进来之后，这个门禁在**全量测试里偶发假红** ——
     * 同一个套件里有若干用例会往 `src/` 下写临时产物（写完就删），扫描恰好在那一瞬间看到它，
     * 就报"新出现的不可达文件"。同一份代码：单跑测试通过、`npm run verify` 有时红。
     * 审计对象是**仓库里的代码**，所以以 git 跟踪为准（刚写完还没 `git add` 的文件不参与，
     * 提交后自然会被算进来）。
     */
    const files = git.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /\.(ts|tsx)$/.test(s))
      .map(rel);
    return { files: [...new Set(files)], via: "git ls-files（只算已跟踪文件）" };
  }
  const out = [];
  const walkDir = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walkDir(full);
      } else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
    }
  };
  walkDir(path.join(root, "src"));
  return { files: out.map((f) => rel(path.relative(root, f))), via: "fs 扫盘（git 不可用）" };
}

/** 从入口出发做可达性分析；返回结论 + 自检结果 */
export function scanReachability(root = process.cwd(), entries = ["src/main.tsx", "src/pet-main.tsx"]) {
  const listed = listSourceFiles(root);
  const allFiles = listed.files;
  const isTest = (f) => f.startsWith("src/test/") || /\.test\.(ts|tsx)$/.test(f);
  const prod = allFiles.filter((f) => !isTest(f));
  const tests = allFiles.filter(isTest);
  const prodSet = new Set(prod);

  /** 说明符 → 真实文件（解析不到返回 null） */
  const resolveSpecifier = (importer, spec) => {
    if (!spec.startsWith(".")) return null; // 裸包名
    const clean = spec.split("?")[0].split("#")[0];
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), clean));
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (prodSet.has(c)) return c;
    }
    return null;
  };

  const edges = new Map();
  const dynamicTargets = new Set();

  for (const file of prod) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const deps = new Set();
    for (const m of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      const target = resolveSpecifier(file, m[1]);
      if (target) deps.add(target);
    }
    for (const m of text.matchAll(/import\(\s*([^)]*?)\s*\)/g)) {
      const arg = m[1].trim();
      const lit = /^["']([^"']+)["']$/.exec(arg);
      if (lit) {
        const target = resolveSpecifier(file, lit[1]);
        if (target) deps.add(target);
        else {
          const stem = lit[1].split("/").pop()?.replace(/\.(ts|tsx)$/, "");
          if (stem) for (const f of prod) if (path.posix.basename(f).replace(/\.(ts|tsx)$/, "") === stem) dynamicTargets.add(f);
        }
      } else {
        // 非字面量：把它里面的标识符按"文件名主干"匹配一遍（保守：命中即视为可能是动态目标）
        dynamicTargets.add(file);
        for (const w of arg.match(/[A-Za-z0-9_$/-]{3,}/g) ?? []) {
          for (const f of prod) {
            if (path.posix.basename(f).replace(/\.(ts|tsx)$/, "") === w) dynamicTargets.add(f);
          }
        }
      }
    }
    edges.set(file, deps);
  }

  const reached = new Set();
  const queue = entries.filter((e) => prodSet.has(e));
  for (const q of queue) reached.add(q);
  while (queue.length) {
    const cur = queue.shift();
    for (const dep of edges.get(cur) ?? []) {
      if (!reached.has(dep)) {
        reached.add(dep);
        queue.push(dep);
      }
    }
  }

  const testImports = new Set();
  for (const t of tests) {
    const text = fs.readFileSync(path.join(root, t), "utf8");
    for (const m of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      const target = resolveSpecifier(t, m[1]);
      if (target) testImports.add(target);
    }
  }

  const unreachable = prod.filter((f) => !reached.has(f));
  const onlyTests = unreachable.filter((f) => testImports.has(f) || dynamicTargets.has(f));
  const orphans = unreachable.filter((f) => !(testImports.has(f) || dynamicTargets.has(f)));

  const checks = {
    messageBubbleReachable: reached.has("src/components/MessageBubble.tsx"),
    syncEngineUnreachable: !reached.has("src/core/storage/sync-engine.ts"),
    entryMissing: entries.filter((e) => !prodSet.has(e)),
  };
  const trustworthy =
    checks.messageBubbleReachable && checks.syncEngineUnreachable && checks.entryMissing.length === 0;

  return {
    trustworthy,
    checks,
    counts: { prod: prod.length, tests: tests.length, reached: reached.size, unreachable: unreachable.length, onlyTests: onlyTests.length, orphans: orphans.length },
    onlyTests,
    orphans,
    unreachable,
  };
}

/** 读白名单 */
export function readAllowlist(root = process.cwd()) {
  const file = path.join(root, ALLOWLIST);
  if (!fs.existsSync(file)) return { entries: {} };
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

/** 对账：不可达集合 ⊆ 白名单，且白名单无过期条目 */
export function checkAgainstAllowlist(result, allowlist) {
  const allowed = new Set(Object.keys(allowlist.entries ?? {}));
  const unexpected = result.unreachable.filter((f) => !allowed.has(f));
  const stale = [...allowed].filter((f) => !result.unreachable.includes(f));
  return { unexpected, stale, ok: result.trustworthy && unexpected.length === 0 && stale.length === 0 };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isCli) {
  const result = scanReachability();
  const allowlist = readAllowlist();
  const verdict = checkAgainstAllowlist(result, allowlist);
  const jsonIdx = process.argv.indexOf("--json");
  if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
    fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ ...result, verdict }, null, 1), "utf8");
  }
  console.log(
    `生产文件 ${result.counts.prod}；可达 ${result.counts.reached}；不可达 ${result.counts.unreachable}` +
      `（仅测试可达/有动态命中 ${result.counts.onlyTests} + 孤儿 ${result.counts.orphans}）`,
  );
  console.log(
    `自检：MessageBubble 可达=${result.checks.messageBubbleReachable}｜sync-engine 不可达=${result.checks.syncEngineUnreachable}｜入口缺失=${result.checks.entryMissing.length}`,
  );
  if (!result.trustworthy) console.log("🔴 自检未通过：本次分析**不可信**");
  if (verdict.unexpected.length) {
    console.log(`\n🔴 新出现的不可达文件（${verdict.unexpected.length}）—— 要么接线、要么登记进白名单并写清理由：`);
    for (const f of verdict.unexpected) console.log("   " + f);
  }
  if (verdict.stale.length) {
    console.log(`\n🔴 白名单里的过期条目（${verdict.stale.length}）—— 这些文件现在可达了，请从白名单删掉：`);
    for (const f of verdict.stale) console.log("   " + f);
  }
  if (process.argv.includes("--check")) {
    console.log(verdict.ok ? "\n✅ 可达性门禁通过（不可达集合 ⊆ 白名单，且无过期条目）" : "\n🔴 可达性门禁未通过");
  }
  process.exit(verdict.ok ? 0 : 1);
}
