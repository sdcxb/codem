/**
 * 敏感读策略（第 17 轮）。
 *
 * 规则表本身在 `packages/host/src/sensitive-paths.ts`（Host 共享工作区已用）；
 * 这里守桌面侧的归一化、模板放行、读写动作和 shell 文本识别。
 */
import { describe, expect, it } from "vitest";
import {
  classifySensitiveRead,
  detectSensitiveShellAccess,
  isSensitiveReadPath,
  normalizeSensitivePath,
  isFileLikeResourceUri,
  sensitiveReadAction,
  toWorkspaceRelative,
} from "../core/security/sensitive-read";

describe("SENS-17：路径归一化与模板放行", () => {
  it("反斜杠 / 绝对路径 / ADS 都归一", () => {
    expect(normalizeSensitivePath("C:\\ws\\.env")).toBe("C:/ws/.env");
    expect(normalizeSensitivePath("\\\\?\\C:\\ws\\.env")).toBe("C:/ws/.env");
    expect(normalizeSensitivePath(".env:stream")).toBe(".env");
    expect(toWorkspaceRelative("C:/ws/sub/.env", "C:/ws")).toBe("sub/.env");
    expect(toWorkspaceRelative("/home/u/.env", "/home/u")).toBe(".env");
  });

  it("`.env` 全家敏感，但示例/模板放行", () => {
    for (const p of [".env", ".env.local", "C:\\ws\\.env", "sub\\.env", "~/.envrc"]) {
      expect(isSensitiveReadPath(p, "C:/ws"), `应敏感：${p}`).toBe(true);
    }
    for (const p of [".env.example", ".env.sample", ".env.template", "sub/.env.example"]) {
      expect(isSensitiveReadPath(p, "C:/ws"), `应放行：${p}`).toBe(false);
    }
  });

  it("git/ssh/私钥/云凭据都命中；普通文件不命中", () => {
    for (const p of [".git/config", ".ssh/id_rsa", "certs/server.pem", ".aws/credentials", "service-account-x.json", ".npmrc", "prod.tfvars"]) {
      expect(isSensitiveReadPath(p, "C:/ws"), `应敏感：${p}`).toBe(true);
    }
    for (const p of ["src/a.ts", "README.md", "package.json", "certs/server.crt"]) {
      expect(isSensitiveReadPath(p, "C:/ws"), `不应敏感：${p}`).toBe(false);
    }
  });

  it("Windows ADS 备用数据流按敏感处理（默认视图看不到内容）", () => {
    for (const p of ["C:\\ws\\notes.txt:secret", "notes.txt:$DATA"]) {
      expect(isSensitiveReadPath(p, "C:/ws"), p).toBe(true);
    }
    expect(isSensitiveReadPath("C:\\ws\\notes.txt", "C:/ws")).toBe(false);
  });

  it("应用内部目录 deny；用户附件 allow", () => {
    expect(sensitiveReadAction(".codem-snapshots/x.json", "C:/ws")).toBe("deny");
    expect(sensitiveReadAction(".codem-tool-results/x.json", "C:/ws")).toBe("deny");
    expect(sensitiveReadAction(".codem-attachments/a__x.env", "C:/ws")).toBe("allow");
  });
});

describe("SENS-17：shell 文本识别", () => {
  const read = (cmd: string) => detectSensitiveShellAccess(cmd, "C:/ws", "C:/ws");

  it("常见读取写法被识别", () => {
    for (const cmd of [
      "cat .env",
      "type .env",
      "Get-Content -LiteralPath .env",
      "Select-String KEY .env",
      "rg KEY .env",
      "base64 .env",
      "tar -cf - .env",
      "git show HEAD:.env",
      "git cat-file -p HEAD:.env",
      "cd .. && cat .env",
      "cat $env:USERPROFILE\\.env",
    ]) {
      expect(read(cmd).reads.length, `应识别读：${cmd}`).toBeGreaterThan(0);
    }
  });

  it("写/删敏感文件进 writes（用于硬拒绝）", () => {
    for (const cmd of ["echo x > .env", "Set-Content .env x", "Out-File .env", "cp x .env", "rm .env", "sed -i s/a/b/ .env"]) {
      expect(read(cmd).writes.length, `应识别写：${cmd}`).toBeGreaterThan(0);
    }
  });

  it("不误报：普通命令/模式里的 .env 字样不算读", () => {
    expect(read("echo .env").reads).toEqual([]);
    expect(read("grep '\\.env' src/a.ts").reads).toEqual([]);
    expect(read("git status").reads).toEqual([]);
    expect(read("npm run test").reads).toEqual([]);
  });

  it("读与写同时存在时分别归类", () => {
    const a = read("type .env > copy.txt");
    expect(a.reads.length).toBeGreaterThan(0);
    expect(a.writes.length).toBe(0);
    const b = read("cp .env backup.txt");
    expect(b.writes.length).toBeGreaterThan(0);
  });
});

describe("SENS-17：verdict 形状", () => {
  it("敏感 verdict 带 rule/action/label，模板为 null", () => {
    const v = classifySensitiveRead(".env", "C:/ws");
    expect(v?.rule).toBe("env");
    expect(v?.action).toBe("ask");
    expect(classifySensitiveRead(".env.example", "C:/ws")).toBeNull();
    expect(classifySensitiveRead("src/a.ts", "C:/ws")).toBeNull();
  });
});

describe("SENS-17 P1：MCP 资源 URI 的文件形态", () => {
  it("file://、绝对路径、UNC 可判；memory://db:// 等未知 scheme 不可判", () => {
    for (const uri of ["file:///C:/ws/.env", "/home/u/.env", "C:\\ws\\.env", "\\\\server\\share\\.env"]) {
      expect(isFileLikeResourceUri(uri), uri).toBe(true);
    }
    for (const uri of ["memory://secret", "db://users", "resource://x", ""]) {
      expect(isFileLikeResourceUri(uri), uri).toBe(false);
    }
  });
});
