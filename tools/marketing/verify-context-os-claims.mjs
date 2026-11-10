#!/usr/bin/env node
/**
 * Context OS 宣传页 — 承诺追溯门禁。
 *
 * 这个脚本不判断“功能好不好”，它只回答三个问题：
 * 1) 页面上的每条承诺，是否都能在 claims 清单里找到？
 * 2) 清单里的每条承诺，是否有可复查的证据路径？
 * 3) 被标记为 verified 的 P0/P1 承诺，是否真的出现在 verification 报告里？
 *
 * 它故意不运行测试：测试由实现方跑，证据由复核者看。
 * 门禁只防止“页面说了，但没有人能证明”。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const DEFAULTS = {
  page: 'docs/marketing/context-os.html',
  claims: 'docs/marketing/context-os.claims.json',
  verification: 'docs/marketing/context-os.verification.json',
};

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes('--' + name);
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.resolve(ROOT, file))).digest('hex');
}
function exists(rel) {
  try { return fs.existsSync(path.resolve(ROOT, rel)); } catch { return false; }
}
function fail(msg) {
  console.error('FAIL  ' + msg);
  process.exitCode = 1;
}
function ok(msg) { console.log('OK    ' + msg); }
function warn(msg) { console.log('WARN  ' + msg); }

const pagePath = arg('page', DEFAULTS.page);
const claimsPath = arg('claims', DEFAULTS.claims);
const verificationPath = arg('verification', DEFAULTS.verification);
const mode = arg('mode', 'traceability');
const tier = arg('tier', 'P0');

if (!['traceability', 'gate'].includes(mode)) {
  console.error('用法: node tools/marketing/verify-context-os-claims.mjs --mode traceability|gate [--tier P0|P1|all]');
  process.exit(2);
}
if (flag('print-hash')) {
  console.log(sha256(pagePath));
  process.exit(0);
}

const page = fs.readFileSync(path.resolve(ROOT, pagePath), 'utf8');
const manifest = readJson(claimsPath);
const pageSha = sha256(pagePath);
const htmlClaims = [...page.matchAll(/data-claim="([^"]+)"/g)]
  .flatMap((m) => m[1].split(/\s+/).filter(Boolean));
const uniqueHtmlClaims = [...new Set(htmlClaims)];
const claims = Array.isArray(manifest.claims) ? manifest.claims : [];
const manifestIds = new Set(claims.map((c) => c.id));
const htmlIds = new Set(uniqueHtmlClaims);

console.log('Context OS claims gate');
console.log('page=' + pagePath);
console.log('sha256=' + pageSha);
console.log('mode=' + mode + (mode === 'gate' ? ' tier=' + tier : ''));

// 1) 页面与清单互相覆盖
for (const id of uniqueHtmlClaims) {
  if (!manifestIds.has(id)) fail('页面引用了清单中不存在的 claim: ' + id);
}
for (const id of manifestIds) {
  if (!htmlIds.has(id)) fail('清单中的 claim 没有出现在页面: ' + id);
}
if (uniqueHtmlClaims.length === 0) fail('页面没有任何 data-claim；宣传页无法被追溯');

// 2) 页面冻结：页面一改，旧验收自动失效
if (!manifest.pageSha256 || manifest.pageSha256 === 'TO_BE_FILLED') {
  fail('claims 清单没有 pageSha256；请先冻结页面并写入哈希');
} else if (manifest.pageSha256 !== pageSha) {
  fail('页面哈希与 claims 清单不一致：页面已变更，旧验收不能继续使用');
  console.log('      清单=' + manifest.pageSha256);
  console.log('      页面=' + pageSha);
  console.log('      处理：重新评审页面 → 更新 pageSha256 → 重新生成 verification');
}

// 3) 状态与证据的基本约束
let shipped = 0;
let partial = 0;
let target = 0;
for (const c of claims) {
  if (!c.id || !c.title || !c.tier || !c.status) {
    fail('claim 缺字段: ' + JSON.stringify(c));
    continue;
  }
  if (!['target', 'partial', 'shipped', 'not-applicable'].includes(c.status)) {
    fail(c.id + ' 的 status 非法: ' + c.status);
  }
  if (c.status === 'shipped') {
    shipped += 1;
    if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
      fail(c.id + ' 标记 shipped，但没有 evidence');
    }
  }
  if (c.status === 'partial') partial += 1;
  if (c.status === 'target') target += 1;
  if (Array.isArray(c.evidence)) {
    for (const e of c.evidence) {
      if (typeof e !== 'string' || e.length === 0) {
        fail(c.id + ' 的 evidence 含空值');
      } else if ((e.startsWith('src/') || e.startsWith('docs/') || e.startsWith('tools/')) && !exists(e)) {
        fail(c.id + ' 的 evidence 路径不存在: ' + e);
      }
    }
  }
}

ok('claims=' + claims.length + ' shipped=' + shipped + ' partial=' + partial + ' target=' + target);

// 4) 交叉校验：报告状态不能比清单更乐观
//
// 为什么必须有这一层：只检查「verified 有 evidence」挡不住最危险的一种写法 ——
// 清单里明明还是 target（没实现），报告里却写 verified（有证据）。两边各自格式都对，
// 合起来是假的。所以把两个文件的状态放在一起比：
//   verification=verified ⇒ claims 必须 shipped（有实现、有可复查证据）
//   verification=partial  ⇒ claims 必须是 shipped|partial（target 不许拿 partial 兜底）
// 不满足就 FAIL，并把两边的状态打印出来（只说「不一致」而不给状态，复核者还得自己翻文件）。
const verificationAbs = path.resolve(ROOT, verificationPath);
const hasVerification = fs.existsSync(verificationAbs);
let verification = null;
if (hasVerification) {
  verification = readJson(verificationPath);
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const vClaims = verification.claims && typeof verification.claims === 'object' ? verification.claims : {};
  let crossChecked = 0;
  for (const [id, v] of Object.entries(vClaims)) {
    const c = claimById.get(id);
    if (!c) {
      fail('verification 记录了清单中不存在的 claim: ' + id);
      continue;
    }
    if (!v || typeof v !== 'object') {
      fail(id + ' 的 verification 记录不是对象');
      continue;
    }
    if (!['verified', 'partial', 'target'].includes(v.status)) {
      fail(id + ' 的 verification.status 非法: ' + v.status);
      continue;
    }
    crossChecked += 1;
    if (v.status === 'verified' && c.status !== 'shipped') {
      fail(id + ' 状态不一致：verification=verified，claims=' + c.status + '（只有 shipped 才能 verified）');
    }
    if (v.status === 'partial' && !['shipped', 'partial'].includes(c.status)) {
      fail(id + ' 状态不一致：verification=partial，claims=' + c.status + '（target 不能用 partial 兜底）');
    }
  }
  ok('交叉校验: verification 条目=' + crossChecked + '（verified↔shipped / partial↔shipped|partial）');
} else {
  warn('没有 verification 报告（' + verificationPath + '），跳过交叉校验');
}

// 5) gate 模式：只检查指定 tier 的 verified 报告
if (mode === 'gate') {
  if (!hasVerification) {
    fail('缺少 verification 报告: ' + verificationPath);
    console.error('      先跑测试/截图，再按 docs/marketing/CONTEXT-OS-ACCEPTANCE.md 填写。');
    process.exit(1);
  }
  if (verification.schema !== 'codem.context-os.verification.v1') {
    fail('verification.schema 不匹配');
  }
  if (verification.pageSha256 !== pageSha) {
    fail('verification.pageSha256 与当前页面不一致');
  }
  const ids = tier === 'all'
    ? claims.map((c) => c.id)
    : (manifest.tiers?.[tier] || []);
  if (!ids.length) fail('未知 tier 或 tier 为空: ' + tier);
  for (const id of ids) {
    const v = verification.claims?.[id];
    if (!v) { fail(id + ' 没有 verification 记录'); continue; }
    if (v.status !== 'verified') { fail(id + ' 不是 verified（当前=' + v.status + '）'); continue; }
    if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
      fail(id + ' verified 但 evidence 为空');
      continue;
    }
    for (const e of v.evidence) {
      if (typeof e !== 'string' || !e.trim()) {
        fail(id + ' evidence 含空值');
      } else if ((e.startsWith('src/') || e.startsWith('docs/') || e.startsWith('tools/')) && !exists(e)) {
        fail(id + ' evidence 路径不存在: ' + e);
      }
    }
    ok(id + ' verified: ' + v.evidence.join(' | '));
  }
}

if (process.exitCode) {
  console.error('\nGATE FAILED');
} else {
  console.log('\nGATE PASSED');
}
