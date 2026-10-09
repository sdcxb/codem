/**
 * 变异自证运行器（第 191 波新增，**进 git** —— 这是 O-53 的答案）。
 *
 * ## 为什么这个文件在 `tools/mutate/` 而不是 `.preview-shot/`
 *
 * 第 187 波的变异脚本落在 `.preview-shot/_mutate-memory-187.mjs`，而该目录被 `.gitignore` 忽略
 * ⇒ clone 下来的人**看不到**任何变异证据，只能看到报告里的一句「每一条都实测能变红」。
 * 本仓纪律是「变异不做等于没测」，而「做了但证据不在仓库里」等价于**下一个人无法复核**。
 * 所以从本波开始：**变异脚本进 `tools/mutate/specs/`、结果进 `tools/mutate/results/`，两者都提交**；
 * `tools/mutate/check-artifacts.mjs` 是闸门（`npm run audit` 里跑），会检查
 * ① 结果文件存在；② `restored === true`；③ 每条变异都**实测红**；④ 规格文件的锚点**没有过期**。
 *
 * ## 一条变异是什么
 *
 * 「把实现改坏 → 跑该判据 → 期望变**红** → 原样还原」。若改坏了判据还是绿的，说明这条判据
 * 是**恒真**的（它根本没在测那件事）—— 这正是本工具要抓的东西。
 *
 * ## 用法
 *
 * ```
 * node tools/mutate/run.mjs <wave>              # 跑一个波次（specs/<wave>.mjs）
 * node tools/mutate/run.mjs <wave> --only MUT-3 # 只跑某几条（前缀匹配，逗号分隔）
 * node tools/mutate/run.mjs --list              # 列出所有波次与规格
 * ```
 *
 * ⚠️ 本仓在 Windows 上检出的是 **CRLF**：多行锚点在规格里写的是 LF，直接 `includes` 会「找不到目标」
 * （第 187 波第一版 8 条里有 7 条就是这么假失败的）。所以匹配在**归一化成 LF** 的副本上做，
 * 写回时还原该文件原本的行尾。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SPECS_DIR = path.join(ROOT, "tools", "mutate", "specs");
const RESULTS_DIR = path.join(ROOT, "tools", "mutate", "results");

/** 规格文件的**指纹**：锚点或判据一变，指纹就变 ⇒ 旧结果作废（check-artifacts 会红） */
export function specFingerprint(spec) {
  const shape = (spec.mutations ?? []).map((m) => ({
    id: m.id,
    patches: (m.patches ?? []).map((p) => ({ file: p.file, from: p.from, to: p.to })),
    tests: m.tests ?? [],
    expectRed: m.expectRed !== false,
  }));
  return createHash("sha1").update(JSON.stringify(shape)).digest("hex");
}

/** 所有变异引用的测试文件（去重、保序） */
export function specTests(spec) {
  const out = [];
  for (const m of spec.mutations ?? []) for (const t of m.tests ?? []) if (!out.includes(t)) out.push(t);
  return out;
}

const norm = (s) => s.replace(/\r\n/g, "\n");
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const readUtf8 = (p) => readFileSync(abs(p), "utf8");
const writeUtf8 = (p, text) => writeFileSync(abs(p), text);

/** 用 LF 归一化后的正文换掉一段锚点，再还原该文件原本的行尾 */
function patchText(before, from, to) {
  const crlf = before.includes("\r\n");
  const hay = norm(before);
  const needle = norm(from);
  const count = hay.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`锚点必须唯一命中（实际 ${count} 次）：${from.slice(0, 80).replace(/\n/g, "\\n")}`);
  }
  const replaced = hay.replace(needle, norm(to));
  return crlf ? replaced.replace(/\n/g, "\r\n") : replaced;
}

/** 规格里所有被改动的文件 */
export function specFiles(spec) {
  const out = [];
  for (const m of spec.mutations ?? []) for (const p of m.patches ?? []) if (!out.includes(p.file)) out.push(p.file);
  return out;
}

/**
 * 读一个波次的规格。
 *
 * ## 两种载体，**JSON 优先**
 *
 * - `specs/<wave>.json`：**首选**。规格是**数据**（id / why / patches / tests / expectRed），
 *   用 `JSON.parse` 读 —— 不经过任何模块加载器，所以在任何运行面（`node` 直跑、vitest 里被
 *   import、临时的判据夹具根目录）行为都一致。判据 `mutation-artifacts.test.ts` 的**反向对照**
 *   正是在一个临时根目录里摆一份规格 —— 用 `import()` 读它会被打包器的解析拦住
 *   （实测：`Cannot find module %TEMP%\…\specs\fake-wave.mjs imported from tools/mutate/run.mjs`）。
 * - `specs/<wave>.mjs`：兼容形态（`export default {...}`），只在项目内可用。
 *
 * 两种载体的**指纹与闸门口径完全一致**（`specFingerprint` 只看变异形状，不看载体）。
 */
export async function loadSpec(wave, root = process.cwd()) {
  const jsonFile = path.join(root, "tools", "mutate", "specs", `${wave}.json`);
  if (existsSync(jsonFile)) {
    const spec = JSON.parse(readFileSync(jsonFile, "utf8"));
    if (!spec || !Array.isArray(spec.mutations)) throw new Error(`规格 ${jsonFile} 没有 mutations 数组`);
    return spec;
  }
  const file = path.join(root, "tools", "mutate", "specs", `${wave}.mjs`);
  if (!existsSync(file)) throw new Error(`没有这个波次的规格（.json 或 .mjs）：${file}`);
  const mod = await import(pathToFileURL(file).href);
  const spec = mod.default ?? mod.spec;
  if (!spec || !Array.isArray(spec.mutations)) throw new Error(`规格 ${wave} 没有导出 default.mutations`);
  return spec;
}

export function listWaves() {
  if (!existsSync(SPECS_DIR)) return [];
  return readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith(".json") || f.endsWith(".mjs"))
    .map((f) => f.replace(/\.(json|mjs)$/, ""))
    .filter((w, i, all) => all.indexOf(w) === i)
    .sort();
}

/** 跑一次 vitest（退出码非 0 = 判据变红） */
function runVitest(tests, extra = []) {
  const started = Date.now();
  const r = spawnSync(`npx vitest run ${tests.join(" ")} --reporter=dot ${extra.join(" ")}`.trim(), {
    cwd: ROOT,
    shell: true,
    stdio: "inherit",
    encoding: "utf8",
  });
  return { red: (r.status ?? -1) !== 0, status: r.status ?? -1, ms: Date.now() - started };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list") || argv.length === 0) {
    const waves = listWaves();
    console.log("可用的变异波次（tools/mutate/specs/*.mjs）：");
    for (const w of waves) {
      const resultFile = path.join(RESULTS_DIR, `${w}.json`);
      const has = existsSync(resultFile) ? "有结果" : "**还没有结果**";
      console.log(`  - ${w}（${has}）`);
    }
    if (argv.length === 0) process.exitCode = 1;
    return;
  }

  const wave = argv[0];
  const spec = await loadSpec(wave);
  const onlyArg = argv.find((a) => a.startsWith("--only"));
  const only = onlyArg
    ? new Set((onlyArg.includes("=") ? onlyArg.split("=")[1] : argv[argv.indexOf(onlyArg) + 1]).split(","))
    : null;

  const files = specFiles(spec);
  const snapshot = new Map(files.map((f) => [f, readUtf8(f)]));

  const results = [];
  for (const mut of spec.mutations) {
    if (only && ![...only].some((k) => mut.id.startsWith(k))) continue;
    const expectRed = mut.expectRed !== false;
    const entry = {
      id: mut.id,
      why: mut.why ?? "",
      patches: (mut.patches ?? []).map((p) => ({ file: p.file, from: p.from, to: p.to })),
      tests: mut.tests ?? [],
      expectedRed: expectRed,
      observedRed: null,
      ok: false,
    };
    try {
      for (const p of mut.patches ?? []) {
        writeUtf8(p.file, patchText(readUtf8(p.file), p.from, p.to));
      }
      const run = runVitest(mut.tests ?? []);
      entry.observedRed = run.red;
      entry.exitCode = run.status;
      entry.ms = run.ms;
      entry.ok = run.red === expectRed;
      console.log(
        `\n=== ${mut.id} :: 期望${expectRed ? "红" : "绿"} / 实测${run.red ? "红" : "绿"} ⇒ ${entry.ok ? "变异自证通过" : "变异自证失败"} ===\n`,
      );
    } catch (e) {
      entry.error = String(e);
      console.log(`\n=== ${mut.id} :: 变异执行失败：${e} ===\n`);
    } finally {
      for (const p of mut.patches ?? []) writeUtf8(p.file, snapshot.get(p.file));
    }
    results.push(entry);
  }

  // 还原之后：规格覆盖到的全部判据必须恢复绿色（否则「变异自证」证明的是别的坏）
  const allTests = specTests(spec);
  const restore = allTests.length ? runVitest(allTests) : { red: false };
  const restored = files.every((f) => readUtf8(f) === snapshot.get(f)) && !restore.red;

  const out = {
    wave,
    description: spec.description ?? "",
    runAt: new Date().toISOString(),
    specFingerprint: specFingerprint(spec),
    files,
    tests: allTests,
    restored,
    results,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${wave}.json`);
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);

  console.log("\n================ 变异自证汇总 ================");
  for (const r of results) {
    console.log(
      `${r.ok ? "✅" : "❌"} ${r.id} —— 期望红=${r.expectedRed} 实测红=${r.observedRed}${r.error ? ` (${r.error})` : ""}`,
    );
  }
  console.log(`还原后判据全绿：${restored ? "是" : "否"}`);
  console.log(`结果已写入：${path.relative(ROOT, outFile)}`);
  if (!restored || results.some((r) => !r.ok)) process.exitCode = 1;
}

// 只有直接运行时才跑 main（被 import 时不跑）
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
