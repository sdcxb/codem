/**
 * 生成 Codem stack 市场签名密钥对（RSA-PSS 3072 / SHA-256）。
 *
 * - **私钥**写到用户目录（默认 `%USERPROFILE%\codem-market-signing-key.pem`），
 *   绝不写进仓库；生成后请把它存进 GitHub Actions Secret（`CODEM_MARKET_SIGNING_KEY`），
 *   然后从磁盘删除。
 * - **公钥**写到 `tools/market/market-public-key.pem`，随 App 一起分发（只用于验签）。
 *
 * 用法：
 *   node tools/market/gen-key.mjs [私钥输出路径]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = process.argv[2] || path.join(os.homedir(), "codem-market-signing-key.pem");
if (fs.existsSync(out)) {
  console.error(`拒绝覆盖已存在的私钥：${out}`);
  process.exit(1);
}
if (fs.existsSync("tools/market/market-public-key.pem")) {
  console.error("tools/market/market-public-key.pem 已存在；轮换密钥请显式删除/改 path 后再生成");
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

fs.writeFileSync(out, privateKey, { mode: 0o600 });
fs.mkdirSync("tools/market", { recursive: true });
fs.writeFileSync("tools/market/market-public-key.pem", publicKey);

const der = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
const fingerprint = crypto.createHash("sha256").update(der).digest("hex");
console.log(`私钥：${out}（不要提交，不要放进安装包）`);
console.log("公钥：tools/market/market-public-key.pem");
console.log(`公钥指纹（SHA-256）：${fingerprint}`);
console.log("");
console.log("下一步：把私钥文件内容整段复制到 GitHub Actions Secret：CODEM_MARKET_SIGNING_KEY");
console.log("然后删除本地私钥文件（或存进密码管理器）。");
