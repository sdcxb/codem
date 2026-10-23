import { describe, it, expect, afterEach } from "vitest";
import { markSessionDeleted, clearSessionDeleted, isSessionDeleted } from "../core/storage/session-tombstones";

describe("会话删除墓碑（进程内）", () => {
  afterEach(() => clearSessionDeleted("sess-x"));

  it("TOMB-1：删除后置位，重建/覆盖时清除", () => {
    expect(isSessionDeleted("sess-x")).toBe(false);
    markSessionDeleted("sess-x");
    expect(isSessionDeleted("sess-x")).toBe(true);
    clearSessionDeleted("sess-x");
    expect(isSessionDeleted("sess-x")).toBe(false);
  });

  it("TOMB-2：空 id 不记账", () => {
    markSessionDeleted("");
    expect(isSessionDeleted("")).toBe(false);
  });
});
