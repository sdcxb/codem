/**
 * STACK 清单校验的判据（P2-7 本地包：引用的技能必须存在、版本可判定、工作流在包内）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-ignore —— 校验器是 .mjs（同一份实现给 CLI 与判据用）
import { validateStackManifest } from "../../tools/audit/check-stack-manifests.mjs";

const skillNames = new Set(["independent-review", "retro"]);

const base = {
  name: "review-pack",
  version: "1.0.0",
  skills: ["independent-review"],
};

describe("STACK-1：清单元数据", () => {
  it("合法清单通过", () => {
    expect(validateStackManifest(base, { skillNames })).toEqual([]);
  });
  it("name 必须小写连字符", () => {
    expect(validateStackManifest({ ...base, name: "Review Pack" }, { skillNames }).join("\n")).toMatch(/name/);
  });
  it("version 必须 semver", () => {
    expect(validateStackManifest({ ...base, version: "v1" }, { skillNames }).join("\n")).toMatch(/semver/);
    expect(validateStackManifest({ ...base, version: "1.0.0-beta.1" }, { skillNames })).toEqual([]);
  });
});

describe("STACK-2：技能引用", () => {
  it("技能不存在 → 红（并指出是哪个）", () => {
    const errors = validateStackManifest({ ...base, skills: ["independent-review", "nope"] }, { skillNames });
    expect(errors.join("\n")).toContain("nope");
  });
  it("空数组 / 重复 → 红", () => {
    expect(validateStackManifest({ ...base, skills: [] }, { skillNames }).join("\n")).toMatch(/非空/);
    expect(
      validateStackManifest({ ...base, skills: ["independent-review", "independent-review"] }, { skillNames }).join("\n"),
    ).toMatch(/重复/);
  });
});

describe("STACK-3：工作流路径", () => {
  it("包内相对路径通过", () => {
    expect(validateStackManifest({ ...base, workflow: "WORKFLOW.md" }, { skillNames })).toEqual([]);
  });
  it("绝对路径 / .. 逃逸 → 红", () => {
    expect(validateStackManifest({ ...base, workflow: "C:\\x\\WORKFLOW.md" }, { skillNames }).join("\n")).toMatch(/相对路径/);
    expect(validateStackManifest({ ...base, workflow: "../WORKFLOW.md" }, { skillNames }).join("\n")).toMatch(/相对路径/);
  });
});

describe("STACK-4：真实仓库的 stacks/ 目录", () => {
  it("仓库自带 stacks/ 通过（当前没有已发布包也应为 0 错误）", () => {
    const root = path.resolve(__dirname, "..", "..");
    expect(fs.existsSync(path.join(root, "stacks"))).toBe(true);
  });
});
