/**
 * 远程选择判据 —— S4-1..S4-5（旧 LAN 在场/页面判据随配对一起删除）。
 *
 * 守的是：远端不能绕过服务端判定自行放宽权限档；目录必须同时给出模型与
 * 权限档，并在服务端给出 `remoteAllowed` / `scope`。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isLoosening,
  verdictForRemoteSecurityChange,
  SECURITY_ORDER,
} from "../core/remote/remote-selections";

const read = (p: string) => readFileSync(p, "utf8");
const ENGINE = "src/core/remote/desktop-engine.ts";

describe("远端选择与权限档", () => {
  it("S4-1: 严格程度有全序；未知档位一律按放宽处理（fail-closed）", () => {
    expect(SECURITY_ORDER.ask).toBeLessThan(SECURITY_ORDER.auto);
    expect(SECURITY_ORDER.auto).toBeLessThan(SECURITY_ORDER.full);

    expect(isLoosening("full", "ask")).toBe(false);
    expect(isLoosening("auto", "ask")).toBe(false);
    expect(isLoosening("ask", "auto")).toBe(true);
    expect(isLoosening("ask", "full")).toBe(true);
    expect(isLoosening("auto", "full")).toBe(true);
    expect(isLoosening("ask", "ask")).toBe(false);

    // 未知档位必须按放宽处理 —— 也就是拒绝
    expect(isLoosening("ask", "yolo")).toBe(true);
    expect(isLoosening("yolo", "ask")).toBe(true);
    expect(isLoosening("", "ask")).toBe(true);
  });

  it("S4-2/S4-3: 只校验档位是否存在；未知档位拒绝并说清可用档位", () => {
    const tighten = verdictForRemoteSecurityChange("full", "ask");
    expect(tighten.ok).toBe(true);
    expect(tighten.ok === true && tighten.kind).toBe("tighten");

    const same = verdictForRemoteSecurityChange("auto", "auto");
    expect(same.ok === true && same.kind).toBe("same");

    const loosen = verdictForRemoteSecurityChange("ask", "full");
    expect(loosen.ok, "与 DSH 一致 ⇒ 允许放宽").toBe(true);
    expect(loosen.ok === true && loosen.kind).toBe("loosen");

    const unknown = verdictForRemoteSecurityChange("ask", "yolo");
    expect(unknown.ok).toBe(false);
    if (unknown.ok === false) {
      expect(unknown.code).toBe("permission_not_in_catalog");
      expect(unknown.message).toMatch(/ask \/ auto \/ full/);
    }
    expect(verdictForRemoteSecurityChange("ask", "").ok).toBe(false);
  });

  it("S4-4: 判定必须在服务端做（界面自己猜规则 = 可绕过）", () => {
    const src = read(ENGINE);
    expect(src).toContain("verdictForRemoteSecurityChange(");
    const idx = src.indexOf("const verdict = verdictForRemoteSecurityChange(");
    expect(idx).toBeGreaterThan(0);
    const after = src.slice(idx, idx + 700);
    expect(after, "拒绝必须回 403").toContain("403");
    expect(after, "拒绝要把原因回给客户端").toContain("message: verdict.message");
    expect(src).not.toMatch(/if\s*\(\s*body\.remoteAllowed/);
  });

  it("S4-5: 目录接口同时给模型与权限档，且每档带 remoteAllowed", () => {
    const src = read(ENGINE);
    expect(src).toContain('case "catalog"');
    expect(src).toContain("getConfiguredApiModels()");
    expect(src).toContain("MIMO_MODELS");
    expect(src).toContain("remoteAllowed:");
    expect(src).toContain("scope:");
  });
});
