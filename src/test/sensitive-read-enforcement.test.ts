/**
 * 敏感读的**执行层**判据（第 17 轮）。
 *
 * 策略单测在 `sensitive-read-policy.test.ts`；这里守「真的读不出来/真的被过滤」：
 * file-api 的 readFile/readFileLines 默认拒绝敏感文件，显式 allowSensitive 才放行；
 * grep/glob 过滤器会隐藏并计数。
 */
import { describe, expect, it } from "vitest";
import { assertSensitiveReadAllowed } from "../core/file-api";
import {
  filterSensitiveGlobFiles,
  filterSensitiveGrepMatches,
  grepLinePath,
} from "../core/security/sensitive-read";

describe("SENS-17：grep/glob 过滤器", () => {
  const rows = [
    "C:/ws/.env:1:SECRET=1",
    "C:/ws/src/a.ts:2:const SECRET = 1",
    "C:/ws/sub/.env.local:3:TOKEN=2",
    "C:/ws/.git/config:4:url=https://u:p@x",
  ];

  it("grep 过滤敏感文件并保留普通文件；允许显式审批的那个路径", () => {
    const filtered = filterSensitiveGrepMatches(rows, "C:/ws");
    expect(filtered.matches).toEqual(["C:/ws/src/a.ts:2:const SECRET = 1"]);
    expect(filtered.skipped).toBe(3);

    const approved = filterSensitiveGrepMatches(rows, "C:/ws", "C:/ws/.env");
    expect(approved.matches.some((l) => l.includes(".env:1"))).toBe(true);
    /* 权限层拿到的 searchPath 可能是相对路径（grep 工具的 args.path=".env"）。 */
    const approvedRel = filterSensitiveGrepMatches(rows, "C:/ws", ".env");
    expect(approvedRel.matches.some((l) => l.includes(".env:1"))).toBe(true);
    expect(approved.matches.some((l) => l.includes(".env.local"))).toBe(false);
  });

  it("盘符冒号不会被当成行号分隔", () => {
    expect(grepLinePath("C:\\ws\\.env:12:KEY=1")).toBe("C:\\ws\\.env");
  });

  it("glob 隐藏敏感文件名并计数", () => {
    const filtered = filterSensitiveGlobFiles(
      ["C:/ws/src/a.ts", "C:/ws/.env", "C:/ws/.ssh/id_rsa", "C:/ws/README.md"],
      "C:/ws",
    );
    expect(filtered.files).toEqual(["C:/ws/src/a.ts", "C:/ws/README.md"]);
    expect(filtered.skipped).toBe(2);
  });
});

describe("SENS-17：file-api 默认拒绝敏感读（SDK/内部调用没有审批通道）", () => {
  it("默认拒绝 .env/.git/私钥；模板文件与显式 allowSensitive 放行", () => {
    expect(() => assertSensitiveReadAllowed("C:/ws/.env")).toThrow(/SENSITIVE_READ/);
    expect(() => assertSensitiveReadAllowed("C:/ws/.git/config")).toThrow(/SENSITIVE_READ/);
    expect(() => assertSensitiveReadAllowed("C:/ws/certs/key.pem")).toThrow(/SENSITIVE_READ/);
    expect(() => assertSensitiveReadAllowed("C:/ws/.env.example")).not.toThrow();
    expect(() => assertSensitiveReadAllowed("C:/ws/.env", true)).not.toThrow();
  });
});
