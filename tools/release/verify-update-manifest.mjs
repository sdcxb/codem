/**
 * 发布期校验：**更新清单 ↔ 产物 ↔ 公钥**三者必须对得上（第 54 轮新增）。
 *
 * ## 为什么需要它
 *
 * 第 54 轮真机撞出：「检查更新」从来没成功过 —— `latest.json` 的平台键写的是 v1 的
 * `windows`，而 v2 更新器按 `windows-x86_64[-nsis]` 找键（`updater.rs:578-597`）。
 * 那一类错误**在开发机上完全看不出来**（清单生成了、资产上传了、端点也 200），
 * 只有真的拿应用去点"检查更新"才会暴露。所以把它变成发布期的一次机器校验。
 *
 * ## 这一步在验什么（四件事，全部**本地可复核**）
 *
 * 1. `latest.json` 的平台键是 v2 写法（`windows-x86_64` 必须有、`windows-x86_64-nsis` 该有、
 *    v1 的 `windows` 必须没有）；
 * 2. 清单里的 `signature` / `url` 与**本地产物**一致（url 指向本版本、签名字节与 `.sig` 相同）；
 * 3. **签名真的能用配置里的公钥验过**（minisign：Ed25519 + BLAKE2b-512 预哈希）——
 *    这正是更新器在 `download()` 里做的事（`updater.rs:712` 的 `verify_signature`）；
 * 4. 可选 `--remote`：把远端 release 资产的 sha256 与本地产物比一次（证明"上传没有坏"）。
 *
 * ## 用法
 *
 * ```text
 * node tools/release/verify-update-manifest.mjs                 # 本地四步
 * node tools/release/verify-update-manifest.mjs --remote        # 额外比对 GitHub 上的 sha256
 * ```
 *
 * 退出码 0 = 全部通过；非 0 = 有一步没过（每一步都会说明**为什么**这一步重要）。
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}
function ok(msg) {
  notes.push(msg);
}

// ---------- ① 清单的平台键 ----------
const manifest = JSON.parse(readFileSync(`${ROOT}/latest.json`, "utf8"));
const keys = Object.keys(manifest.platforms ?? {});
if (!keys.includes("windows-x86_64")) {
  fail(`latest.json 缺 windows-x86_64（更新器只认 {os}-{arch} 形式，v1 的 windows 永远找不到）`);
}
if (!keys.includes("windows-x86_64-nsis")) {
  fail("latest.json 缺 windows-x86_64-nsis（装了 NSIS 包时更新器**先**找这个键）");
}
if (keys.includes("windows")) {
  fail("latest.json 里有 v1 的 windows 键：它不会被读到，只会让人以为键写全了");
}
if (problems.length === 0) ok(`平台键正确：${keys.join(", ")}`);

// ---------- ② 清单与本地产物一致 ----------
const entry = manifest.platforms["windows-x86_64"];
const artifact = `${ROOT}/src-tauri/target/release/bundle/nsis/Codem_${manifest.version}_x64-setup.exe`;
const sigPath = `${artifact}.sig`;
const expectUrl = `https://github.com/sdcxb/codem/releases/download/v${manifest.version}/Codem_${manifest.version}_x64-setup.exe`;
if (entry.url !== expectUrl) fail(`清单 URL 与产物不符：\n  清单：${entry.url}\n  期望：${expectUrl}`);
const sigText = readFileSync(sigPath, "utf8").trim();
if (entry.signature !== sigText) fail("清单里的 signature 与 .sig 文件内容不一致");
/**
 * ⚠️ `.sig` 文件本身是 **base64 文本**（单行、416 字符），解出来才是 minisign 的
 * "untrusted comment / base64 签名 / trusted comment / base64 全局签名" 四行文本。
 * 第一版把文件内容当成了已经是纯文本 —— 于是"第二行"取到的是注释本身，
 * 算法字段读出 `"un"`（`untrusted…` 的前两个字符）。这里显式解一层。
 */
const sigPlain = Buffer.from(sigText, "base64").toString("utf8");
const nsisEntry = manifest.platforms["windows-x86_64-nsis"];
if (nsisEntry && (nsisEntry.url !== entry.url || nsisEntry.signature !== entry.signature)) {
  fail("两个平台键必须指向同一个包与同一份签名（否则装了 NSIS 的机器会拿到别的东西）");
}
if (!problems.length) ok("清单 URL/签名与本地产物一致");

// ---------- ③ 签名用配置里的公钥验过（minisign） ----------
/**
 * minisign 公钥/签名的格式（都包在 `untrusted comment:` 文本里）：
 * - 公钥第二行 base64 → 8 字节 key id + 32 字节 Ed25519 公钥；
 * - 签名第二行 base64 → 2 字节算法（"Ed" = 预哈希 BLAKE2b-512 / "ED" = 原始）
 *   + 8 字节 key id + 64 字节签名。
 * Ed25519 的 SPKI DER 前缀固定：302a300506032b6570032100 + 32 字节裸公钥。
 */
/**
 * minisign 的**二进制布局**（都是"文本行 → base64 → 定长字节"三层，实测出来的）：
 *
 * | 对象 | 第二行 base64 解出来的字节 |
 * | --- | --- |
 * | 公钥 | `2 字节算法("Ed") + 8 字节 key id + 32 字节 Ed25519 公钥` = **42 字节** |
 * | 签名 | `2 字节算法 + 8 字节 key id + 64 字节签名` = **74 字节** |
 *
 * ⚠️ 公钥里那个 2 字节算法前缀**很容易被漏掉**：第一版按"8 字节 key id + 32 字节公钥"
 * 取 `subarray(8)`，于是拿到的"公钥"其实是 `keyid 后 2 字节 + 真公钥前 30 字节`——
 * 形状合法（32 字节）、能建成 key object，但**永远验不过**。是"按字节 print 出来对比 key id"
 * 才看出来的（公钥注释里那串十六进制是 key id 的**逆序**写法，与签名里的 key id 对得上）。
 */
function decodeBase64Lines(text) {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const b64 = lines.find((l) => !l.startsWith("untrusted comment:") && !l.startsWith("trusted comment:"));
  return Buffer.from(b64, "base64");
}

const conf = JSON.parse(readFileSync(`${ROOT}/src-tauri/tauri.conf.json`, "utf8"));
const pubkeyB64 = conf?.plugins?.updater?.pubkey;
if (!pubkeyB64) {
  fail("tauri.conf.json 里没有 plugins.updater.pubkey —— 无法验证签名");
} else {
  const pubText = Buffer.from(pubkeyB64, "base64").toString("utf8");
  const pubRaw = decodeBase64Lines(pubText);
  if (pubRaw.length !== 42) {
    fail(`公钥第二行解出 ${pubRaw.length} 字节（期望 42 = 2 算法 + 8 key id + 32 公钥）`);
  }
  const pubKeyId = pubRaw.subarray(2, 10);
  const pubKey = pubRaw.subarray(10); // ← 2 字节算法 + 8 字节 key id 之后才是公钥
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubKey]);
  const keyObject = createPublicKey({ key: spki, format: "der", type: "spki" });

  const sigRaw = decodeBase64Lines(sigPlain);
  if (sigRaw.length !== 74) {
    fail(`签名第二行解出 ${sigRaw.length} 字节（期望 74 = 2 算法 + 8 key id + 64 签名）`);
  }
  const sigKeyId = sigRaw.subarray(2, 10);
  const alg = sigRaw.subarray(0, 2).toString("latin1");
  const sigBytes = sigRaw.subarray(10);
  const fileBytes = readFileSync(artifact);

  /**
   * key id 必须一致：这是"这份签名是不是**配置里那把钥匙**签的"的判据。
   * 不一致的话更新器会在 `download()` 的验签处直接失败（而清单看起来一切正常）。
   */
  if (!pubKeyId.equals(sigKeyId)) {
    fail(
      `签名的 key id 与配置公钥不是同一把：\n  签名 ${sigKeyId.toString("hex")}\n  公钥 ${pubKeyId.toString("hex")}`,
    );
  } else {
    ok(`key id 一致：${pubKeyId.toString("hex")}`);
  }

  /**
   * 签的是什么，**以实测为准**，不靠记忆里的约定：
   *
   * - 两个候选消息：① 文件的 BLAKE2b-512 摘要（minisign 的"预哈希"模式）
   *   ② 整个文件内容（legacy 模式）；
   * - Tauri 1.16.85 产出的签名字段是 `"ED"`，而**实测通过的是 ①**
   *   （我按"ED = legacy 原始签名"的旧印象先写了 ②，验不过；把两种都跑一遍才对上）。
   * 所以这里两种都试，并**打印出命中的是哪一种** —— 这样既不会因为约定记错而假红，
   * 也不会把"侥幸通过"藏起来。两种都不过才是真失败（更新器的 download() 同样会拒）。
   */
  const candidates = [
    { how: "BLAKE2b-512 预哈希", msg: createHash("blake2b512").update(fileBytes).digest() },
    { how: "原始文件内容", msg: fileBytes },
  ];
  const hit = candidates.find((c) => {
    try {
      return cryptoVerify(null, c.msg, keyObject, sigBytes);
    } catch {
      return false;
    }
  });
  if (!hit) {
    const why = alg === "Ed" || alg === "ED" ? "" : `（算法字段 ${JSON.stringify(alg)} 也不认识）`;
    fail(`签名**验不过**：两种模式都试了${why} —— 更新器在 download() 里会以同样方式拒绝这个包`);
  } else {
    ok(`签名验过（算法字段 ${JSON.stringify(alg)}，实际签的是「${hit.how}」，key id=${pubKeyId.toString("hex")}）`);
  }
}

const localSha = createHash("sha256").update(readFileSync(artifact)).digest("hex");
ok(`本地产物 sha256=${localSha}`);

// ---------- ④ 可选：远端资产 sha256 ----------
if (process.argv.includes("--remote")) {
  try {
    const tag = `v${manifest.version}`;
    const json = execFileSync("gh", ["release", "view", tag, "--json", "assets"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    const assets = JSON.parse(json.replace(/^\uFEFF/, "")).assets;
    const name = `Codem_${manifest.version}_x64-setup.exe`;
    const asset = assets.find((a) => a.name === name);
    if (!asset) fail(`远端 release ${tag} 上没有资产 ${name}`);
    else {
      const remoteSha = String(asset.digest ?? "").replace(/^sha256:/, "");
      if (!remoteSha) fail("远端资产没有 sha256 摘要（gh 没返回 digest）");
      else if (remoteSha !== localSha) {
        fail(`远端资产与本地产物**不是同一个文件**：\n  远端 ${remoteSha}\n  本地 ${localSha}`);
      } else ok(`远端资产 sha256 与本地产物一致（上传没有坏）`);
    }
    const mAsset = assets.find((a) => a.name === "latest.json");
    if (!mAsset) fail("远端 release 上没有 latest.json（更新器读的就是它）");
    else ok(`远端有 latest.json（${(mAsset.size / 1024).toFixed(1)} KB）`);
  } catch (e) {
    fail(`--remote 校验失败（gh 调用或网络）：${String(e).slice(0, 200)}`);
  }
}

for (const n of notes) console.log(`  ✓ ${n}`);
for (const p of problems) console.error(`  ✗ ${p}`);
console.log(`[update-manifest] 通过 ${notes.length} 项 / 问题 ${problems.length} 项`);
process.exit(problems.length ? 1 : 0);
