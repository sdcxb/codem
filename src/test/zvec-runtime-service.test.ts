/**
 * zvec-grep 运行时模块单测 — 纯函数层（路径规划 / node 解析与决策 / 模型目录）。
 */

import { describe, it, expect } from "vitest";
import {
  buildZvecPaths,
  zgCliPathOf,
  parseNodeVersion,
  pickNodeWinZipUrl,
  pickNodeLtsVersion,
  resolveNodeExe,
} from "../core/zvec-grep/runtime";
import { errMsg } from "../core/zvec-grep/service";
import { ZVEC_MODELS, ZVEC_MCP_SERVER, ZVEC_MIN_NODE_MAJOR, NODE_OFFICIAL_DIST, NODE_MIRROR_DIST } from "../core/zvec-grep/types";

describe("zvec-grep runtime 路径规划", () => {
  it("buildZvecPaths 拼接运行时目录（win 风格）", () => {
    const p = buildZvecPaths("C:\\Users\\me\\AppData\\Roaming\\com.codem.app\\.codem\\");
    expect(p.baseDir.endsWith("\\zvec-grep")).toBe(true);
    expect(p.zgDir).toContain("runtime\\zg");
    expect(p.nodeDir).toContain("runtime\\node");
    expect(p.modelsDir).toContain("\\models");
    expect(p.stateDir).toContain("\\state");
    expect(p.metaFile).toContain("install-meta.json");
  });

  it("buildZvecPaths 处理 posix 风格 appData", () => {
    const p = buildZvecPaths("/home/u/.local/share/com.codem.app/.codem/");
    expect(p.baseDir.endsWith("/zvec-grep")).toBe(true);
    expect(p.zgDir.startsWith("/home/u/")).toBe(true);
    expect(p.nodeDir.includes("/runtime/node")).toBe(true);
  });

  it("zgCliPathOf 指向 dist/cli/index.js", () => {
    expect(zgCliPathOf("D:\\zg").endsWith("dist\\cli\\index.js")).toBe(true);
    expect(zgCliPathOf("/opt/zg").endsWith("/dist/cli/index.js")).toBe(true);
  });
});

describe("zvec-grep node 解析与决策", () => {
  it("parseNodeVersion 解析 v 前缀与纯数字", () => {
    expect(parseNodeVersion("v24.19.0\n")).toEqual([24, 19, 0]);
    expect(parseNodeVersion("22.3.1")).toEqual([22, 3, 1]);
  });

  it("parseNodeVersion 非法输入返回 null", () => {
    expect(parseNodeVersion("")).toBeNull();
    expect(parseNodeVersion("not a version")).toBeNull();
    expect(parseNodeVersion("v1.2")).toBeNull();
  });

  it("pickNodeWinZipUrl 跳过非 LTS、选中最新 LTS 代号", () => {
    const index = [
      { version: "v25.0.0", lts: false },
      { version: "v24.12.0", lts: "Krypton" },
      { version: "v24.11.0", lts: "Krypton" },
      { version: "v22.16.0", lts: "Jod" },
    ];
    expect(pickNodeWinZipUrl(index)).toBe(
      "https://nodejs.org/dist/v24.12.0/node-24.12.0-win-x64.zip",
    );
  });

  it("pickNodeWinZipUrl 无 LTS 返回 null", () => {
    expect(pickNodeWinZipUrl([{ version: "v25.0.0", lts: false }])).toBeNull();
  });

  it("pickNodeLtsVersion 返回纯版本号（供官方/镜像 dist 复用）", () => {
    const index = [
      { version: "v25.0.0", lts: false },
      { version: "v24.12.0", lts: "Krypton" },
      { version: "v22.16.0", lts: "Jod" },
    ];
    expect(pickNodeLtsVersion(index)).toBe("24.12.0");
    expect(pickNodeLtsVersion([{ version: "v25.0.0", lts: false }])).toBeNull();
  });

  it("node dist 常量：官方 + npmmirror 镜像", () => {
    expect(NODE_OFFICIAL_DIST).toBe("https://nodejs.org/dist");
    expect(NODE_MIRROR_DIST).toBe("https://npmmirror.com/mirrors/node");
  });

  it("errMsg 归一化各种错误形态（修复 undefined 报错）", () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
    expect(errMsg("HTTP 504: timeout")).toBe("HTTP 504: timeout");
    expect(errMsg(new Error(""))).not.toContain("undefined");
    expect(errMsg(undefined)).not.toContain("undefined");
    expect(errMsg(null)).not.toContain("undefined");
    expect(errMsg({ code: 7 })).toContain("7");
  });

  it("resolveNodeExe：系统 node ≥ 22 → 用系统 node", async () => {
    const r = await resolveNodeExe(
      async () => ({ ok: true, version: [24, 19, 0] as [number, number, number] }),
      async () => null,
      ZVEC_MIN_NODE_MAJOR,
    );
    expect(r.exe).toBe("node");
    expect(r.via).toBe("system");
    expect(r.systemVersion).toBe("v24.19.0");
  });

  it("resolveNodeExe：系统 node 过旧 → 回退 portable", async () => {
    const r = await resolveNodeExe(
      async () => ({ ok: true, version: [20, 11, 0] as [number, number, number] }),
      async () => "C:\\rt\\node\\node.exe",
      ZVEC_MIN_NODE_MAJOR,
    );
    expect(r.exe).toBe("C:\\rt\\node\\node.exe");
    expect(r.via).toBe("portable");
  });

  it("resolveNodeExe：系统失败且无 portable → null", async () => {
    const r = await resolveNodeExe(
      async () => ({ ok: false, version: null }),
      async () => null,
      ZVEC_MIN_NODE_MAJOR,
    );
    expect(r.exe).toBeNull();
    expect(r.via).toBeNull();
  });
});

describe("zvec-grep 模型目录与常量", () => {
  it("ZVEC_MODELS 含默认 code-16m 且 id 带 local/ 前缀", () => {
    expect(ZVEC_MODELS.length).toBeGreaterThan(0);
    expect(ZVEC_MODELS[0].id).toBe("local/potion-code-16m-v2");
    for (const m of ZVEC_MODELS) {
      expect(m.id.startsWith("local/")).toBe(true);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.dirHint.length).toBeGreaterThan(0);
    }
  });

  it("MCP server 名固定为 zvec_grep", () => {
    expect(ZVEC_MCP_SERVER).toBe("zvec_grep");
  });
});
