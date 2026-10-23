import { describe, expect, it, vi, beforeEach } from "vitest";

const files = new Map<string, string>();
const commands: Array<{ cmd: string; cwd?: string }> = [];
const mockState = vi.hoisted(() => ({
  view: '"0.4.1"',
  installExit: 0,
  installVersion: "0.4.1",
}));

vi.mock("../core/file-api", () => ({
  getAppDataDir: vi.fn(async () => "C:\\Users\\tester\\AppData\\Roaming"),
  readFile: vi.fn(async (path: string) => {
    const v = files.get(path.replace(/\\/g, "/"));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }),
  executeCommand: vi.fn(async (cmd: string, cwd?: string) => {
    commands.push({ cmd, cwd });
    if (cmd.includes("npm view dsh-ops")) return { stdout: mockState.view, stderr: "", exitCode: mockState.view ? 0 : 1 };
    if (cmd.includes("npm install dsh-ops@")) {
      if (mockState.installExit !== 0) return { stdout: "", stderr: "npm ERR! install failed", exitCode: mockState.installExit };
      files.set(
        "C:/Users/tester/.dsh/profiles/desktop/node_modules/dsh-ops/package.json",
        JSON.stringify({ name: "dsh-ops", version: mockState.installVersion }),
      );
      return { stdout: "added 1 package", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }),
}));

import {
  checkDshPluginUpdates,
  compareVersions,
  dshProfilePath,
  homeFromAppData,
  readDshInstalledPlugins,
  upgradeDshPlugin,
} from "../core/plugin-market/external-dsh-plugins";

const PROFILE = "C:/Users/tester/.dsh/profiles/desktop";

beforeEach(() => {
  files.clear();
  commands.length = 0;
  files.set(
    `${PROFILE}/package.json`.replace(/\\/g, "/"),
    JSON.stringify({ dependencies: { "dsh-ops": "0.4.0", "@deepseek-ai/dsh-base": "1.0.0" } }),
  );
  files.set(
    `${PROFILE}/node_modules/dsh-ops/package.json`.replace(/\\/g, "/"),
    JSON.stringify({ name: "dsh-ops", version: "0.4.0" }),
  );
});

describe("外部 DSH 插件更新", () => {
  it("EXT-1：home/profile 路径与 semver 比较", () => {
    expect(homeFromAppData("C:\\Users\\tester\\AppData\\Roaming")).toBe("C:\\Users\\tester");
    expect(homeFromAppData("C:\\Users\\tester\\AppData\\Roaming\\com.codem.app\\")).toBe("C:\\Users\\tester");
    expect(dshProfilePath("C:\\Users\\tester")).toBe("C:\\Users\\tester/.dsh/profiles/desktop");
    expect(compareVersions("0.4.1", "0.4.0")).toBe(1);
    expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("0.4.0-beta.1", "0.4.0")).toBe(-1);
  });

  it("EXT-2：只读 dependencies 里的插件，不把传递依赖/官方包当插件", async () => {
    const list = await readDshInstalledPlugins();
    expect(list.map((p) => p.name)).toEqual(["dsh-ops"]);
    expect(list[0].installedVersion).toBe("0.4.0");
    expect(list[0].path).toContain("node_modules/dsh-ops");
  });

  it("EXT-3：检查到 0.4.1 时标记 updateAvailable", async () => {
    const list = await checkDshPluginUpdates();
    expect(list[0].latestVersion).toBe("0.4.1");
    expect(list[0].updateAvailable).toBe(true);
    expect(commands.some((c) => c.cmd === "npm view dsh-ops version --json")).toBe(true);
  });

  it("EXT-4：升级后必须回读 package.json 才算成功", async () => {
    const r = await upgradeDshPlugin("dsh-ops", "0.4.1");
    expect(r).toMatchObject({ ok: true, from: "0.4.0", to: "0.4.1" });
    expect(commands.some((c) => c.cmd.includes("npm install dsh-ops@0.4.1"))).toBe(true);
  });

  it("EXT-5：npm view 失败必须报 error，不许伪装成已是最新", async () => {
    mockState.view = "";
    const list = await checkDshPluginUpdates();
    expect(list[0].latestVersion).toBeNull();
    expect(list[0].updateAvailable).toBe(false);
    expect(list[0].error).toContain("npm view 失败");
  });

  it("EXT-6：npm install 非 0 退出必须返回 ok=false，且版本不变", async () => {
    mockState.installExit = 1;
    const r = await upgradeDshPlugin("dsh-ops", "0.4.1");
    expect(r.ok).toBe(false);
    expect(r.from).toBe("0.4.0");
    expect(r.to).toBe("0.4.0");
    expect(r.error).toContain("install failed");
  });
});
