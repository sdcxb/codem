import { describe, it, expect, afterEach } from "vitest";
import {
  THREAD_DISABLED_TOOLS,
  clearSessionDisabledTools,
  filterToolDefsForSession,
  isToolDisabledForSession,
  setSessionDisabledTools,
} from "../core/llm/tool-policy";

const DEFS = [
  { name: "read" },
  { name: "write" },
  { name: "delegate_to_session" },
  { name: "wait_for_delegation" },
  { name: "handoff_to_new_session" },
];

describe("项目 thread 工具策略", () => {
  afterEach(() => clearSessionDisabledTools("s-thread"));

  it("POL-1：thread 里委派/交接工具不可见，普通工具保留", () => {
    setSessionDisabledTools("s-thread", THREAD_DISABLED_TOOLS);
    const visible = filterToolDefsForSession("s-thread", DEFS).map((d) => d.name);
    expect(visible).toEqual(["read", "write"]);
    expect(isToolDisabledForSession("s-thread", "wait_for_delegation")).toBe(true);
    expect(isToolDisabledForSession("other", "wait_for_delegation")).toBe(false);
  });

  it("POL-2：清理后恢复，不泄漏到别的会话", () => {
    setSessionDisabledTools("s-thread", ["delegate_to_session"]);
    clearSessionDisabledTools("s-thread");
    expect(filterToolDefsForSession("s-thread", DEFS)).toHaveLength(DEFS.length);
  });
});
