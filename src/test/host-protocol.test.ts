/**
 * `packages/protocol` 的判据（PROTO-*）。
 *
 * 这一组守的是**线上契约**，不是实现细节：
 * - 版本协商只有一处判定（Host 的每个方法里不许各判一遍）；
 * - 参数校验失败必须**明确指向字段**（远程场景下静默兜底 = "手机发错了但 PC 看起来正常"）；
 * - 错误码表必须覆盖 `HostErrorKind` 的每一个取值（漏一个 ⇒ 客户端拿到 undefined）。
 */
import { describe, expect, it } from "vitest";

import {
  METHODS,
  MIN_CLIENT_VERSION,
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  ProtocolValidationError,
  asBoolean,
  asInt,
  asObject,
  asString,
  checkProtocolVersion,
} from "../../packages/protocol/src/index";

describe("PROTO-1 版本协商", () => {
  it("接受 [MIN_CLIENT_VERSION, PROTOCOL_VERSION]", () => {
    expect(checkProtocolVersion(MIN_CLIENT_VERSION).ok).toBe(true);
    expect(checkProtocolVersion(PROTOCOL_VERSION).ok).toBe(true);
  });

  it("过低要求升级客户端、过高要求升级 Host", () => {
    const low = checkProtocolVersion(MIN_CLIENT_VERSION - 1);
    expect(low.ok).toBe(false);
    expect(String((low as { reason: string }).reason)).toContain("升级客户端");

    const high = checkProtocolVersion(PROTOCOL_VERSION + 1);
    expect(high.ok).toBe(false);
    expect(String((high as { reason: string }).reason)).toContain("升级");
  });

  it("非整数直接拒绝（不接受字符串/浮点）", () => {
    expect(checkProtocolVersion(1.5).ok).toBe(false);
    expect(checkProtocolVersion(Number.NaN).ok).toBe(false);
  });
});

describe("PROTO-2 参数校验", () => {
  it("asObject 把 undefined/null 当空对象，拒绝数组", () => {
    expect(asObject(undefined)).toEqual({});
    expect(asObject(null)).toEqual({});
    expect(() => asObject([])).toThrow(ProtocolValidationError);
  });

  it("asString 报错时必须点名字段", () => {
    try {
      asString(42, "sessionId");
      throw new Error("应当抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolValidationError);
      expect((e as ProtocolValidationError).field).toBe("sessionId");
    }
  });

  it("asInt 支持缺省值与上下界", () => {
    expect(asInt(undefined, "limit", { fallback: 50 })).toBe(50);
    expect(asInt(10, "limit", { min: 1, max: 100 })).toBe(10);
    expect(() => asInt(0, "limit", { min: 1 })).toThrow(/不能小于 1/);
    expect(() => asInt(1.5, "limit")).toThrow(/必须是整数/);
  });

  it("asBoolean 不接受字符串 'true'（避免隐式转换）", () => {
    expect(asBoolean(undefined, "visibleOnly", false)).toBe(false);
    expect(() => asBoolean("true", "visibleOnly")).toThrow(/必须是布尔值/);
  });
});

describe("PROTO-3 错误码完整", () => {
  it("HostErrorKind 的每个取值都有稳定的 JSON-RPC 数值", () => {
    const kinds = [
      "PARSE_ERROR",
      "INVALID_REQUEST",
      "METHOD_NOT_FOUND",
      "INVALID_PARAMS",
      "UNAUTHORIZED",
      "VERSION_MISMATCH",
      "NOT_FOUND",
      "CONFLICT",
      "LEASE_HELD",
      "UNSUPPORTED",
      "BUSY",
      "APPROVAL_REQUIRED",
      "INTERNAL",
    ] as const;
    const seen = new Set<number>();
    for (const kind of kinds) {
      const code = RPC_ERROR_CODES[kind];
      expect(typeof code, kind).toBe("number");
      expect(seen.has(code), `${kind} 与其它 kind 撞码`).toBe(false);
      seen.add(code);
    }
    /*
     * 敏感读取的两阶段审批码必须稳定：客户端按 `kind` 分支（不是解析 message），
     * 老客户端不认识它时会落到通用错误分支 —— fail-closed（只显示错误、不返回正文）。
     */
    expect(RPC_ERROR_CODES.APPROVAL_REQUIRED).toBe(-32008);
  });
});

describe("PROTO-4 方法名唯一且稳定", () => {
  it("没有任何两个方法共用同一个字符串", () => {
    const names = Object.values(METHODS);
    expect(new Set(names).size).toBe(names.length);
  });

  it("关键方法名不得改名（客户端硬编码/日志/判据都引用它）", () => {
    expect(METHODS.hello).toBe("host.hello");
    expect(METHODS.promptSend).toBe("prompt.send");
    expect(METHODS.sessionWatch).toBe("session.watch");
    expect(METHODS.approvalRespond).toBe("approval.respond");
    expect(METHODS.workspaceRead).toBe("workspace.read");
    expect(METHODS.sessionChanges).toBe("session.changes");
    expect(METHODS.sessionChangeDiff).toBe("session.change.diff");
  });
});
