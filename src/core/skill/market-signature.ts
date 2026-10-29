/**
 * stack 市场索引验签（RSA-PSS / SHA-256 / saltLength 32）。
 *
 * 这里只放**公钥**；私钥在发布者机器/GitHub Actions Secret 里，永远不会随 App 分发。
 * 验签失败一律拒绝索引（fail-closed），不退化成“没签名也照用”。
 */

/** 与 `tools/market/market-public-key.pem` 同一把钥匙（指纹 bf214468…cfff7） */
const MARKET_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA0wN5pclxV9xC8kY30LQK
mPV7wDh341F0eHZkaZerjNxvxtlZvBjF+Hq3tHTWyiiwC7kPu1Te0Ih8TZC8+GzU
mQXA+3VFgMcJiT7oF9K+6JbfKSb/fkEhuFt70BCDJitPiizvHu1jAcmOoY/rawYC
ZW/NxvQil6pQJYn3HDpoLm7Lrhxjod2FACjuUW6E2lFzVNZ8MAloQV7xO/h+vz+I
SDWSUJnBv0NM1q9OvzswPw8M6PcVKjL7np7pPbcIbZCIMe6PV3OSfLrUm6tEnaYV
o1AhNw+FJF+zNt1+A7D9zsQPVHoqqt20qm0PhxYw2y7LCeV6kmDA1eSMjWIZS5aZ
tp2KTQ6UY2H2cgX1OWikBd5oSiN7TQN3TX4CjfQPWu6s/WUKGy6leETF+thIhOYC
UF/ImQI/YDZ0OY1JMyiHipqlEAJatvkz8Qt0NW9jLUzFmfKwHlZLUcdyez8SfUbU
WNyf2+6oZoKO7jTKhXcxL/yF11WejmG7CUn2YkhV7Zw3AgMBAAE=
-----END PUBLIC KEY-----`;

function pemToBytes(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer as ArrayBuffer;
}

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer as ArrayBuffer;
}

/** 验证 `stacks/index.json` 的签名；返回 false = 内容被改过/签名不匹配 */
export async function verifyStackIndexSignature(body: string, signatureBase64: string): Promise<boolean> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前运行环境不支持 WebCrypto，无法验证市场签名");
  }
  const key = await crypto.subtle.importKey(
    "spki",
    pemToBytes(MARKET_PUBLIC_KEY_PEM),
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    base64ToBytes(signatureBase64),
    new TextEncoder().encode(body),
  );
}
