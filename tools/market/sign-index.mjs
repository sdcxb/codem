/**
 * 给 `stacks/index.json` 签名（RSA-PSS / SHA-256 / saltLength 32）。
 *
 * 私钥来源（二选一，绝不落进仓库）：
 *   - 环境变量 `CODEM_MARKET_SIGNING_KEY`（PEM 全文；GitHub Actions Secret 用这个）
 *   - `--key <path>`（本地离线签名）
 *
 * 用法：
 *   node tools/market/sign-index.mjs --key <私钥.pem> [--in stacks/index.json] [--out stacks/index.json.sig]
 *   CODEM_MARKET_SIGNING_KEY="$(cat key.pem)" node tools/market/sign-index.mjs
 *   node tools/market/sign-index.mjs --verify [--in ...] [--sig ...]   # 用公钥验签
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const inFile = arg("--in", "stacks/index.json");
const outFile = arg("--out", `${inFile}.sig`);
const sigFile = arg("--sig", outFile);
const verify = args.includes("--verify");
const publicKeyFile = path.join("tools", "market", "market-public-key.pem");

if (!fs.existsSync(inFile)) {
  console.error(`找不到索引：${inFile}`);
  process.exit(1);
}
const data = fs.readFileSync(inFile);

if (verify) {
  if (!fs.existsSync(publicKeyFile)) {
    console.error(`找不到公钥：${publicKeyFile}`);
    process.exit(1);
  }
  const sig = Buffer.from(fs.readFileSync(sigFile, "utf8").trim(), "base64");
  const ok = crypto.verify(
    "sha256",
    data,
    { key: fs.readFileSync(publicKeyFile, "utf8"), padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    sig,
  );
  console.log(ok ? "✓ 签名有效" : "✗ 签名无效");
  process.exit(ok ? 0 : 1);
}

let key = process.env.CODEM_MARKET_SIGNING_KEY;
const keyPath = arg("--key", "");
if (!key && keyPath) key = fs.readFileSync(keyPath, "utf8");
if (!key) {
  console.error("缺少私钥：设置 CODEM_MARKET_SIGNING_KEY 或传 --key <path>");
  process.exit(1);
}
const sig = crypto.sign("sha256", data, {
  key,
  padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: 32,
});
fs.writeFileSync(outFile, sig.toString("base64") + "\n");
console.log(`已签名：${inFile} → ${outFile}（${sig.length} 字节）`);
