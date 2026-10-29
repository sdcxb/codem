/**
 * MARKET-SIG：仓库里的 `stacks/index.json.sig` 必须能被 App 内置公钥验证。
 *
 * 这是“发布件本身”的判据：索引被改一个字就应验签失败；防止提交了索引忘了重签。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyStackIndexSignature } from "../core/skill/market-signature";

const root = process.cwd();
const body = fs.readFileSync(path.join(root, "stacks", "index.json"), "utf8");
const sig = fs.readFileSync(path.join(root, "stacks", "index.json.sig"), "utf8");

describe("MARKET-SIG", () => {
  it("MS-1: 仓库里的索引与签名匹配（App 内置公钥可验）", async () => {
    await expect(verifyStackIndexSignature(body, sig)).resolves.toBe(true);
  });

  it("MS-2: 索引被改一个字 → 验签失败（fail-closed）", async () => {
    await expect(verifyStackIndexSignature(body.replace("review-pack", "review-pack-x"), sig)).resolves.toBe(false);
  });
});
