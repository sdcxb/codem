/**
 * 「检查失败 ⇒ 返回否定值」闸门的**自证**（第 87 轮）。
 *
 * 背景：第 86 轮修掉了一个 fail-open（切换执行模式的防丢提示问不到就当干净），
 * 第 87 轮把这一形态**系统扫一遍**，结果 15 处，其中只有 1 处是安全开关
 * （`isSandboxAclEnabled`：用户开着的沙箱在一次读失败后静默失效）—— 已修（C-18）。
 *
 * 这个文件守两件事：
 *  ① 那 14 处无害的（能力探测 / 读取型）**不能悄悄变多**：新增一处 ⇒ 闸门红，逼人定性（FOG-1/2/3）；
 *  ② 沙箱那处**不能回退**：只要有人把 `catch { … return false }` 写回去，FOG-5 立刻红。
 *
 * 为什么不是"扫一遍就完了"：扫描器的结论依赖人判，所以把人的判断**落成白名单**，
 * 让"下一个 fail-open 溜进来"变成机器能拦的事。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(__dirname, "..", "..");
const SCANNER = join(ROOT, "tools", "audit", "scan-fail-open-guards.mjs");
const ALLOWLIST = join(ROOT, "tools", "audit", "fail-open-guard-allowlist.json");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScanner(args: string[]): RunResult {
  const res = spawnSync(process.execPath, [SCANNER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

interface Finding {
  rel: string;
  name: string;
  line: number;
  returns: string;
}
function findings(): Finding[] {
  const res = runScanner(["--json"]);
  expect(res.status, `扫描器自身崩了：${res.stderr.slice(0, 400)}`).toBe(0);
  return (JSON.parse(res.stdout) as { findings: Finding[] }).findings;
}

/** 造一棵最小可扫的假树，用于变异自证（不动真仓库） */
function fakeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fog-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return dir;
}

const FAIL_OPEN_SRC = [
  "export async function isThingOk(): Promise<boolean> {",
  "  try {",
  "    return await probe();",
  "  } catch {",
  "    return false;",
  "  }",
  "}",
  "",
].join("\n");

describe("fail-open 闸门（第 87 轮）", () => {
  it("FOG-1 真实仓库：闸门通过，且每处都在白名单里（新增 0 / 过期 0）", () => {
    const res = runScanner(["--check"]);
    expect(res.stderr, `闸门报出了未定性的站点：\n${res.stderr}`).toBe("");
    expect(res.status, `--check 应为 0，实际 ${res.status}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("fail-open 闸门通过");
  });

  it("FOG-2 白名单与真实命中**逐个对齐**（不多不少）", () => {
    const allow = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as {
      allowed: { site: string; reason: string; direction: string }[];
    };
    const allowedSites = allow.allowed.map((a) => a.site).sort();
    const realSites = findings()
      .map((f) => `${f.rel}::${f.name}`)
      .sort();

    expect(realSites, "白名单与真实命中不一致（少写的会被闸门当新增，多写的会被当过期）").toEqual(allowedSites);
    // 每一处都必须写了理由与方向 —— 白名单不是"忽略名单"，是"定性记录"
    for (const a of allow.allowed) {
      expect(a.reason.length, `${a.site} 缺理由`).toBeGreaterThan(10);
      expect(["conservative", "read-error"], `${a.site} 的 direction 不合法`).toContain(a.direction);
    }
  });

  it("FOG-3 变异：新出现一处未定性的 fail-open ⇒ 闸门必须红", () => {
    const tree = fakeTree({ "src/fake/new-guard.ts": FAIL_OPEN_SRC });
    try {
      const res = runScanner(["--check", "--root", tree]);
      expect(res.status, `未定性的 fail-open 竟然放过了：\n${res.stdout}${res.stderr}`).toBe(1);
      expect(res.stderr).toContain("new-guard.ts");
      expect(res.stderr).toContain("isThingOk");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it("FOG-4 变异：白名单过期（代码里已不存在）⇒ 闸门必须红", () => {
    const tree = fakeTree({ "src/fake/ok.ts": "export const x = 1;\n" });
    const allowPath = join(tree, "allow.json");
    writeFileSync(
      allowPath,
      JSON.stringify({ allowed: [{ site: "src/gone.ts::isGone", reason: "x".repeat(20), direction: "conservative" }] }),
      "utf8",
    );
    try {
      const res = runScanner(["--check", "--root", tree, "--allowlist", allowPath]);
      expect(res.status, "白名单过期没被发现，闸门会永远绿").toBe(1);
      expect(res.stderr).toContain("白名单过期");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it("FOG-5 沙箱开关那处**不许回退**（C-18 锁死）", () => {
    // 修完以后，`isSandboxAclEnabled` 的 catch 里不再有 return false ⇒ 扫描器不该再列出它
    const hits = findings().filter((f) => f.rel.includes("sandbox-acl"));
    expect(hits, "沙箱开关又变回 fail-open 了（用户开着的沙箱会被静默关掉）").toEqual([]);

    // 并且代码里必须有"沿用上次的值 + 上报"这两件事（光删 return false 不够）
    const src = readFileSync(join(ROOT, "src", "core", "sandbox", "sandbox-acl.ts"), "utf8");
    expect(src, "缺少「记住上次成功读到的值」").toMatch(/lastKnownSandboxEnabled/);
    expect(src, "读失败必须走上报通道，不能只在控制台 warn").toMatch(/sandbox\.readSetting/);
  });
});
