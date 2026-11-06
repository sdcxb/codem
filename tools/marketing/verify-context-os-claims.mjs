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

// 4) gate 模式：只检查指定 tier 的 verified 报告
if (mode === 'gate') {
  if (!fs.existsSync(path.resolve(ROOT, verificationPath))) {
    fail('缺少 verification 报告: ' + verificationPath);
    console.error('      先跑测试/截图，再按 docs/marketing/CONTEXT-OS-ACCEPTANCE.md 填写。');
    process.exit(1);
  }
  const verification = readJson(verificationPath);
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
