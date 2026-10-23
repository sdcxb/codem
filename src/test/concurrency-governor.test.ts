import { describe, it, expect, beforeEach } from "vitest";
import { getActiveExecutionCount, getConcurrencyLimit, startSessionExecution, endSessionExecution } from "../core/session";

function setMachine(cores: number, mem: number): void {
  Object.defineProperty(navigator, "hardwareConcurrency", { value: cores, configurable: true });
  Object.defineProperty(navigator, "deviceMemory", { value: mem, configurable: true });
}

describe("机器感知的并发上限", () => {
  beforeEach(() => {
    for (const id of ["c1", "c2", "c3", "c4"]) endSessionExecution(id);
  });

  it("CC-1：4 核 / 8 核 / 16 核分别 1 / 2 / 3；低内存压到 1", () => {
    setMachine(4, 16);
    expect(getConcurrencyLimit()).toBe(1);
    setMachine(8, 16);
    expect(getConcurrencyLimit()).toBe(2);
    setMachine(16, 32);
    expect(getConcurrencyLimit()).toBe(3);
    setMachine(32, 4);
    expect(getConcurrencyLimit()).toBe(1);
  });

  it("CC-2：活跃计数随登记/注销变化，不泄漏", () => {
    const before = getActiveExecutionCount();
    startSessionExecution("c1");
    startSessionExecution("c1");
    expect(getActiveExecutionCount()).toBe(before + 1);
    startSessionExecution("c2");
    expect(getActiveExecutionCount()).toBe(before + 2);
    endSessionExecution("c1");
    endSessionExecution("c2");
    expect(getActiveExecutionCount()).toBe(before);
  });
});
