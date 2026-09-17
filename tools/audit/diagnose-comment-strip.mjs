/**
 * 诊断：注释剥离是否会误吞真实代码
 *
 * `wasm-removal-readiness.mjs` 用 `/\/\*[\s\S]*?\*\//g` 粗暴剥块注释。
 * 如果**字符串字面量或正则**里出现 `/*`（例如 glob `src/**`、正则里的 `/*`），
 * 这个正则就会把后面一大段**真实代码**当成注释吞掉 → L3 计数偏小，
 * 「已门控 = 旧库调用数」可能提前成立，而真实回退点还在。
 *
 * 用法：node tools/audit/diagnose-comment-strip.mjs <file> [...]
 */
import { readFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, "utf8");
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // 逐行找"疑似字符串/正则里的 /*"
  const suspicious = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const noLineComment = line.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const idx = noLineComment.indexOf("/*");
    if (idx < 0) return;
    // 行首就是 /* 或是缩进后的 /*，视为真注释
    if (/^\s*\/\*/.test(noLineComment)) return;
    // 前面出现引号 → 疑似字符串/正则里的 /*
    const before = noLineComment.slice(0, idx);
    if (/["'`]/.test(before)) suspicious.push({ line: i + 1, text: line.trim() });
  });

  const real = (text.match(/getDatabase\(\)/g) ?? []).length;
  const seen = (stripped.match(/getDatabase\(\)/g) ?? []).length;
  console.log(`${file}`);
  console.log(`  原文 getDatabase() 出现 ${real} 次，剥离注释后 ${seen} 次`);
  if (suspicious.length) {
    console.log(`  ⚠️ 疑似字符串/正则里的 /* （会导致剥离器吞代码）：`);
    for (const s of suspicious) console.log(`     ${s.line}: ${s.text}`);
  } else {
    console.log(`  未发现字符串/正则里的 /*`);
  }
}
