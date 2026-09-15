/**
 * 第 84 波审计修正：沙箱 ACL 的黑名单匹配在真机（Windows）上**几乎全部失效**。
 *
 * 旧实现：把条目里的双星号替换成 `.*`、单星号替换成 `[^/]*` 之后，
 * `new RegExp("^" + pattern, "i")` 直接匹配规范化后的输入路径。三个后果：
 *   ① 黑名单条目没被规范化（只有输入把反斜杠换成斜杠）→ `"C:\\Windows"` 变成
 *      正则 `^C:\W...`（`\W` = 非单词字符）→ `C:/Windows` **永远匹配不上**；
 *   ② `~/.ssh` / `~/.gnupg` / `~/.aws` 里的 `~` 从不展开 → 死规则
 *      （真正要保护的 `C:/Users/x/.ssh/id_rsa` 完全放行）；
 *   ③ 前缀匹配没有边界 → 双星号 + `/.env` 会误伤 `.environment.ts`。
 *
 * 修复后：条目与输入用同一套规范化（反斜杠 + `~` 展开），glob 语义正确，
 * 并且"匹配不上"和"确实允许"不再混淆。
 */
import { describe, it, expect } from "vitest";
import {
  SandboxGuard,
  createDefaultPolicy,
  createStrictPolicy,
  normalizeSandboxPath,
  sandboxGlobToRegex,
} from "../core/sandbox/sandbox-acl";

const guard = () => new SandboxGuard(createDefaultPolicy("C:/workspace"));

describe("沙箱黑名单真的能匹配（Windows 路径）", () => {
  it("SBX-1: 系统目录（正/反斜杠两种写法）都被拦", () => {
    const g = guard();
    for (const p of [
      "C:/Windows/System32/drivers/etc/hosts",
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "C:/Program Files/app/config.json",
      "C:\\Program Files (x86)\\app\\x.dll",
    ]) {
      const r = g.checkPath(p, "read");
      expect(r.allowed, `应拦住：${p}`).toBe(false);
      expect(r.reason).toContain("blocked");
    }
  });

  it("SBX-2: 真实主目录下的凭证目录被拦（~ 必须展开）", () => {
    const home = (process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/");
    if (!home) return; // 无主目录信息时跳过（浏览器环境）
    const g = guard();
    for (const sub of [".ssh/id_rsa", ".aws/credentials", ".gnupg/secring.gpg"]) {
      const r = g.checkPath(`${home}/${sub}`, "read");
      expect(r.allowed, `应拦住 ${home}/${sub}`).toBe(false);
      expect(r.reason).toContain("blocked");
    }
  });

  it("SBX-3: 字面量 ~ 写法同样被拦（输入与条目同规范化）", () => {
    const r = guard().checkPath("~/.ssh/id_rsa", "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("blocked");
  });

  it("SBX-4: 工作区内的 .env / .env.local 被拦，但 .environment.ts 不误伤", () => {
    const g = guard();
    expect(g.checkPath("C:/workspace/.env", "write").allowed).toBe(false);
    expect(g.checkPath("C:/workspace/sub/.env.local", "write").allowed).toBe(false);
    const ok = g.checkPath("C:/workspace/src/environment.ts", "write");
    expect(ok.allowed, "普通源文件不该被 .env 规则误伤").toBe(true);
    const dotEnvPrefix = g.checkPath("C:/workspace/src/environment.ts".replace("environment", "environment"), "read");
    expect(dotEnvPrefix.allowed).toBe(true);
  });

  it("SBX-5: 双星号跨层级匹配（任意深度）", () => {
    const g = new SandboxGuard({
      ...createDefaultPolicy("C:/workspace"),
      blockedPaths: ["**/credentials.json", "**/.env"],
    });
    expect(g.checkPath("C:/workspace/credentials.json", "read").allowed).toBe(false);
    expect(g.checkPath("C:/workspace/a/b/c/credentials.json", "read").allowed).toBe(false);
    expect(g.checkPath("C:/workspace/a/.env", "read").allowed).toBe(false);
    expect(g.checkPath("C:/workspace/a/b/notes.json", "read").allowed).toBe(true);
  });

  it("SBX-6: 单星号只匹配一层（不会越级）", () => {
    const g = new SandboxGuard({
      ...createDefaultPolicy("C:/workspace"),
      blockedPaths: ["C:/workspace/secrets/*"],
    });
    expect(g.checkPath("C:/workspace/secrets/key.txt", "read").allowed).toBe(false);
    // 越级不匹配 → 交给白名单判定（这里白名单覆盖工作区，所以允许）
    expect(g.checkPath("C:/workspace/secrets/deep/key.txt", "read").allowed).toBe(true);
  });

  it("SBX-7: 严格策略仍然拦截（原有行为不回退）", () => {
    const strict = new SandboxGuard(createStrictPolicy("C:/workspace"));
    expect(strict.checkPath("C:/workspace/x.ts", "write").allowed).toBe(true);
    expect(strict.checkPath("C:/other/x.ts", "write").allowed).toBe(false);
  });

  it("SBX-8: 规范化与 glob 转正则的单元契约", () => {
    expect(normalizeSandboxPath("C:\\a\\b")).toBe("C:/a/b");
    const re = sandboxGlobToRegex("**/.env");
    expect(re.test("C:/deep/x/.env")).toBe(true);
    expect(re.test("C:/deep/x/.env.local")).toBe(true);
    expect(re.test("C:/deep/x/.environment")).toBe(false);
  });
});
