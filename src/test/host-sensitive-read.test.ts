/**
 * Host 工具层敏感读取审批（HSR-1..5）。
 *
 * 钉的是**行为**：批准才读、拒绝一个字节都不读、普通路径零审批、非共享工作区行为不变、
 * grep 一次审批覆盖本次调用的全部敏感文件（拒绝时明确说"已跳过"，不能画成"没有匹配"）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostToolRegistry } from "../../packages/host/src/tools";

const dirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codem-hsr-"));
  dirs.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".env"), "SECRET_TOKEN=not-for-model\n", "utf8");
  await writeFile(join(root, "src", "a.ts"), "export const needle = 1;\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function ctx(): never {
  return {} as never;
}

describe("HSR-1 敏感 read：批准后返回内容，审批只调一次且带路径/规则", () => {
  it("approve 收到 tool=read + path=.env + rule=env", async () => {
    const root = await tempWorkspace();
    const approve = vi.fn(async () => ({ allowed: true }));
    const registry = createHostToolRegistry(root, { approve, sensitiveRead: true });
    const result = await registry.get("read")!.execute({ path: ".env" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.output).toContain("SECRET_TOKEN");
    expect(approve).toHaveBeenCalledTimes(1);
    const req = approve.mock.calls[0][0] as unknown as { tool: string; details: Record<string, unknown> };
    expect(req.tool).toBe("read");
    expect(req.details.path).toBe(".env");
    expect(req.details.rule).toBe("env");
    expect(String(req.details.reason ?? "")).toContain("凭据");
    // 摘要必须说清"批准后发给模型"（用户真正要判断的事）
    expect(String((approve.mock.calls[0][0] as unknown as { summary: string }).summary)).toContain("发送给模型");
  });
});

describe("HSR-2 拒绝：不读正文、错误里给出明确的下一步", () => {
  it("拒绝后 output 不含文件内容，且要求用户直接提供", async () => {
    const root = await tempWorkspace();
    const approve = vi.fn(async () => ({ allowed: false, note: "不要读密钥" }));
    const registry = createHostToolRegistry(root, { approve, sensitiveRead: true });
    const result = await registry.get("read")!.execute({ path: "./.env" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("SECRET_TOKEN");
    expect(result.output).toContain("用户拒绝");
    expect(result.output).toContain("不要重试");
    expect(result.output).toContain("不要读密钥");
  });

  it("应用内部产物（快照）直接拒绝且不弹审批", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, ".codem-snapshots"), { recursive: true });
    await writeFile(join(root, ".codem-snapshots", "snap-1.json"), '{"files":[]}', "utf8");
    const approve = vi.fn(async () => ({ allowed: true }));
    const registry = createHostToolRegistry(root, { approve, sensitiveRead: true });
    const result = await registry.get("read")!.execute({ path: ".codem-snapshots/snap-1.json" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("应用内部产物");
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("HSR-3 普通路径零审批", () => {
  it("读 src/a.ts 不调用 approve（行为与共享前一致）", async () => {
    const root = await tempWorkspace();
    const approve = vi.fn(async () => ({ allowed: false }));
    const registry = createHostToolRegistry(root, { approve, sensitiveRead: true });
    const result = await registry.get("read")!.execute({ path: "src/a.ts" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.output).toContain("needle");
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("HSR-4 非共享工作区（sensitiveRead=false）行为不变", () => {
  it("不装敏感读取 hook：读 .env 零审批", async () => {
    const root = await tempWorkspace();
    const approve = vi.fn(async () => ({ allowed: false }));
    const registry = createHostToolRegistry(root, { approve });
    const result = await registry.get("read")!.execute({ path: ".env" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.output).toContain("SECRET_TOKEN");
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("HSR-5 grep：一次审批覆盖本次调用的敏感文件；拒绝则跳过并明说", () => {
  it("批准：敏感命中出现，且只弹一次卡", async () => {
    const root = await tempWorkspace();
    const approve = vi.fn(async () => ({ allowed: true }));
    const registry = createHostToolRegistry(root, { approve, sensitiveRead: true });
    const result = await registry.get("grep")!.execute({ pattern: "needle|SECRET" }, ctx());

    expect(approve).toHaveBeenCalledTimes(1);
    expect(String(result.output)).toContain(".env:1");
    expect(String(result.output)).toContain("src/a.ts:1");
    const details = (approve.mock.calls[0][0] as unknown as { details: Record<string, unknown> }).details;
    expect(details.files).toEqual([".env"]);
    expect(details.fileCount).toBe(1);
  });

  it("拒绝：敏感命中缺失，非敏感命中保留，并明确写出跳过数量", async () => {
    const root = await tempWorkspace();
    const approve = vi.fn(async () => ({ allowed: false }));
    const registry = createHostToolRegistry(root, { approve, sensitiveRead: true });
    const result = await registry.get("grep")!.execute({ pattern: "needle|SECRET" }, ctx());

    expect(String(result.output)).not.toContain("SECRET_TOKEN");
    expect(String(result.output)).toContain("src/a.ts:1");
    expect(String(result.output)).toContain("已跳过 1 个敏感文件");
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("非共享工作区：grep 照常命中 .env，零审批", async () => {
    const root = await tempWorkspace();
    const approve = vi.fn(async () => ({ allowed: false }));
    const registry = createHostToolRegistry(root, { approve });
    const result = await registry.get("grep")!.execute({ pattern: "SECRET" }, ctx());

    expect(String(result.output)).toContain(".env:1");
    expect(approve).not.toHaveBeenCalled();
  });
});
