/**
 * 文件工具判据（FOP-1..4，G-7）：
 * - 写操作必须审批：拒绝时**文件不存在**（不是只返回一句拒绝）；
 * - 路径逃逸（绝对路径 / `..`）直接拒绝；
 * - edit 必须唯一命中（0 次/多次都给明确错误），拒绝时不改动内容；
 * - grep 能跨文件命中、支持 glob、跳过 node_modules。
 */
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { collectSensitiveGrepFiles, editWorkspaceFile, grepWorkspace, writeWorkspaceFile } from "../../packages/host/src/file-ops";

const allow = async () => ({ allowed: true });
const deny = async () => ({ allowed: false, note: "测试拒绝" });

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codem-fops-"));
}

describe("FOP-1 写文件审批", () => {
  it("拒绝时不落盘", async () => {
    const root = await tmp();
    const r = await writeWorkspaceFile({ root, path: "a.txt", content: "hello", approve: deny });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("用户拒绝");
    await expect(stat(join(root, "a.txt"))).rejects.toThrow();
  });

  it("允许时写入并可读回", async () => {
    const root = await tmp();
    const r = await writeWorkspaceFile({ root, path: "sub/a.txt", content: "hello", approve: allow });
    expect(r.isError).toBe(false);
    await expect(readFile(join(root, "sub/a.txt"), "utf8")).resolves.toBe("hello");
  });
});

describe("FOP-2 路径边界", () => {
  it("拒绝绝对路径与 ..", async () => {
    const root = await tmp();
    await expect(writeWorkspaceFile({ root, path: "../x.txt", content: "x", approve: allow })).rejects.toThrow(/逃出工作区/);
    await expect(writeWorkspaceFile({ root, path: "/etc/passwd", content: "x", approve: allow })).rejects.toThrow(/相对工作区/);
    await expect(writeWorkspaceFile({ root, path: "C:\\x.txt", content: "x", approve: allow })).rejects.toThrow(/相对工作区/);
  });
});

describe("FOP-3 edit 唯一命中", () => {
  it("0 次 / 多次都报错，且不改动", async () => {
    const root = await tmp();
    await writeFile(join(root, "f.txt"), "aaa", "utf8");
    const miss = await editWorkspaceFile({ root, path: "f.txt", oldText: "zzz", newText: "y", approve: allow });
    expect(miss.isError).toBe(true);
    expect(miss.output).toContain("未命中");

    await writeFile(join(root, "g.txt"), "x x", "utf8");
    const multi = await editWorkspaceFile({ root, path: "g.txt", oldText: "x", newText: "y", approve: allow });
    expect(multi.isError).toBe(true);
    expect(multi.output).toContain("必须唯一");
    await expect(readFile(join(root, "g.txt"), "utf8")).resolves.toBe("x x");
  });

  it("唯一命中时替换成功；拒绝时不动", async () => {
    const root = await tmp();
    await writeFile(join(root, "f.txt"), "hello world", "utf8");
    const ok = await editWorkspaceFile({ root, path: "f.txt", oldText: "world", newText: "codem", approve: allow });
    expect(ok.isError).toBe(false);
    await expect(readFile(join(root, "f.txt"), "utf8")).resolves.toBe("hello codem");

    const refused = await editWorkspaceFile({ root, path: "f.txt", oldText: "codem", newText: "nope", approve: deny });
    expect(refused.isError).toBe(true);
    await expect(readFile(join(root, "f.txt"), "utf8")).resolves.toBe("hello codem");
  });
});

describe("FOP-4 grep", () => {
  it("跨文件命中、支持 glob、跳过 node_modules", async () => {
    const root = await tmp();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "const needle = 1;\n", "utf8");
    await writeFile(join(root, "src/b.md"), "needle in md\n", "utf8");
    await writeFile(join(root, "node_modules/c.ts"), "needle in deps\n", "utf8");

    const all = await grepWorkspace({ root, pattern: "needle" });
    expect(all.matches.map((m) => m.path).sort()).toEqual(["src/a.ts", "src/b.md"]);

    const onlyTs = await grepWorkspace({ root, pattern: "needle", glob: "*.ts" });
    expect(onlyTs.matches.map((m) => m.path)).toEqual(["src/a.ts"]);
    expect(all.matches[0].line).toBe(1);
  });
});

describe("FOP-5 grep 的敏感文件放行/跳过（共享工作区的审批结果）", () => {
  it("默认跳过由 skipPath 命中的文件，并如实报出跳过数量；给 allowlist 后能命中", async () => {
    const root = await tmp();
    await writeFile(join(root, ".env"), "SECRET=needle\n", "utf8");
    await writeFile(join(root, "a.ts"), "const needle = 1;\n", "utf8");

    const skipped = await grepWorkspace({
      root,
      pattern: "needle",
      skipPath: (rel) => rel === ".env",
    });
    expect(skipped.matches.map((m) => m.path)).toEqual(["a.ts"]);
    expect(skipped.skippedSensitive, "跳过的数量必须可见（否则会把'跳过'画成'没有匹配'）").toBe(1);

    const allowed = await grepWorkspace({
      root,
      pattern: "needle",
      skipPath: () => false,
    });
    expect(allowed.matches.map((m) => m.path).sort()).toEqual([".env", "a.ts"]);
    expect(allowed.skippedSensitive).toBe(0);
  });

  it("collectSensitiveGrepFiles 只读列名、不读内容；与 grep 的跳过目录一致", async () => {
    const root = await tmp();
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(join(root, ".codem-snapshots"), { recursive: true });
    await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");
    await writeFile(join(root, "sub", ".env.local"), "SECRET=2\n", "utf8");
    await writeFile(join(root, "sub", "a.ts"), "x\n", "utf8");
    await writeFile(join(root, ".codem-snapshots", ".env"), "SECRET=3\n", "utf8");

    const found = await collectSensitiveGrepFiles({
      root,
      isSensitive: (rel) => rel.endsWith(".env") || rel.includes(".env."),
    });
    expect(found.files.sort()).toEqual([".env", "sub/.env.local"]);
    expect(found.truncated).toBe(false);
  });
});
