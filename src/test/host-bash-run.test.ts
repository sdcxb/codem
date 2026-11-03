/**
 * 命令执行判据（BASH-1..5，G-7）：
 * - 审批拒绝 ⇒ **不执行**（用写文件命令取证，不是只看返回文本）；
 * - 审批放行 ⇒ 真执行，stdout 进 output；
 * - cwd 逃出工作区 ⇒ 拒绝（不 spawn）；
 * - 超时 ⇒ 杀进程树并标记 isError；
 * - 取消（abort）⇒ 同样杀树。
 *
 * 跨平台：命令用 `echo`；"是否执行"用**写文件**取证，避免把平台差异当成产品行为。
 */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { executeBash } from "../../packages/host/src/bash-run";

const isWin = process.platform === "win32";
const echo = (text: string) => (isWin ? `echo ${text}` : `echo ${text}`);
const writeFileCmd = (file: string) => (isWin ? `echo made> "${file}"` : `printf made > "${file}"`);
const sleepCmd = (ms: number) => (isWin ? `ping -n ${Math.ceil(ms / 1000) + 1} 127.0.0.1 > nul` : `sleep ${Math.ceil(ms / 1000)}`);

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "codem-bash-"));
}

describe("BASH-1 审批拒绝不执行", () => {
  it("deny 时不创建文件，并明确写「用户拒绝」", async () => {
    const ws = await workspace();
    const marker = join(ws, "should-not-exist.txt");
    const r = await executeBash({
      command: writeFileCmd(marker),
      workspace: ws,
      approve: async () => ({ allowed: false, note: "测试拒绝" }),
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("用户拒绝");
    await expect(stat(marker)).rejects.toThrow();
  });
});

describe("BASH-2 审批放行真执行", () => {
  it("allow 时 stdout 出现在 output 里", async () => {
    const ws = await workspace();
    const r = await executeBash({ command: echo("BASH_OK"), workspace: ws, approve: async () => ({ allowed: true }) });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("BASH_OK");
  });

  it("allow 时返回真实退出码（0）", async () => {
    const ws = await workspace();
    const r = await executeBash({ command: echo("made"), workspace: ws, approve: async () => ({ allowed: true }) });
    expect(r.isError).toBe(false);
    expect(r.exitCode).toBe(0);
  });
});

describe("BASH-3 工作区边界", () => {
  it("cwd 逃出工作区直接拒绝（连审批都不该发生）", async () => {
    const ws = await workspace();
    let approved = false;
    const r = await executeBash({
      command: echo("x"),
      workspace: ws,
      cwd: "..",
      approve: async () => {
        approved = true;
        return { allowed: true };
      },
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("逃出工作区");
    expect(approved).toBe(false);
  });
});

describe("BASH-4 超时杀树", () => {
  it("超时返回 isError 且 timedOut", async () => {
    const ws = await workspace();
    const r = await executeBash({
      command: sleepCmd(5000),
      workspace: ws,
      timeoutMs: 1000,
      approve: async () => ({ allowed: true }),
    });
    expect(r.timedOut).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("已超时");
  }, 20000);
});

describe("BASH-5 取消", () => {
  it("abort 后返回 isError", async () => {
    const ws = await workspace();
    const controller = new AbortController();
    const pending = executeBash({
      command: sleepCmd(5000),
      workspace: ws,
      timeoutMs: 15000,
      signal: controller.signal,
      approve: async () => ({ allowed: true }),
    });
    setTimeout(() => controller.abort(), 300);
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.output).toContain("已超时");
  }, 20000);
});
