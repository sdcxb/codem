/**
 * 第 16 轮：退役的 6 个沙箱插件不许以任何形式回潮。
 *
 * 它们曾经同时出现在四处：内置注册表、装配 YAML、插件管理器目录、插件市场目录。
 * 只删一处会被另外三处（以及 `plugin-assembly-path` 的 SO-8/SO-9/CAT-1）救回来，
 * 所以判据必须逐处点名，而不是只扫一个 grep。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const RETIRED = [
  "@codem/sandbox-local",
  "@codem/sandbox-policy",
  "@codem/bash-sandbox",
  "@codem/pwsh-sandbox",
  "@codem/fs-sandbox",
  "@codem/sandbox-windows-acl",
];

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("RSP-16：退役沙箱插件不许回潮", () => {
  it("四处登记（注册表 / 装配 YAML / 插件目录 / 市场目录 / codem.yml）都不许再出现", () => {
    const places = [
      "src/core/plugin-loader/builtin-registry.ts",
      "config/codem.base.yml",
      "src/core/provider/plugin-registry-provider.ts",
      "src/core/plugin-market/dsh-market-catalog.ts",
      "codem.yml",
    ];
    for (const rel of places) {
      const text = read(rel);
      for (const id of RETIRED) {
        expect(text, `${rel} 仍登记已退役插件 ${id}`).not.toContain(id);
      }
    }
  });

  it("provider 文件已物理删除（不是只从注册表摘掉）", () => {
    for (const file of [
      "src/core/provider/sandbox-provider.ts",
      "src/core/provider/sandbox-policy-provider.ts",
      "src/core/provider/bash-sandbox-provider.ts",
      "src/core/provider/pwsh-sandbox-provider.ts",
      "src/core/provider/fs-sandbox-provider.ts",
      "src/core/provider/sandbox-windows-acl-provider.ts",
    ]) {
      expect(existsSync(join(ROOT, file)), `${file} 应已删除`).toBe(false);
    }
  });

  it("对应服务已从「provide 无 get」基线里消失", () => {
    const baseline = JSON.parse(read("tools/audit/unconsumed-services-baseline.json")) as {
      services: Record<string, unknown>;
    };
    for (const svc of [
      "sandbox",
      "sandboxPolicy",
      "bashSandbox",
      "fsSandbox",
      "pwshSandbox",
      "sandboxWindowsAcl",
    ]) {
      expect(baseline.services, `基线仍把 ${svc} 当作存量死服务`).not.toHaveProperty(svc);
    }
  });
});
