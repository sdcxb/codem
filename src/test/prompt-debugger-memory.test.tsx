/**
 * DBG-MEM-1（第 189 波 A6）：**设置 → 系统提示词调试器必须真的带记忆段**。
 *
 * ## 修复前的缺陷形态
 *
 * `PromptDebugger` 构造 `SystemPromptConfig` 时既没有 `memoryInstructions` 也没有
 * `memoryTailInstructions` ⇒ 用户按这个界面核对"记忆有没有进提示、缓存边界在哪"时，
 * 看到的是**与真实发送不同形**的提示：记忆块、缓存边界哨兵、权威句、date 段
 * （`toLocaleDateString` 而不是引擎的分钟精度时间）全部缺席。
 *
 * ## 判据风格
 *
 * 走**真实渲染**（真实组件 + 真实 `MemoryService` + 真实 `composeMemoryBlock`），
 * 断言渲染出来的提示文本里**真的**有：稳定记忆块、缓存边界哨兵、权威句、易变记忆块。
 * 这四条正好是"用户想核对时看不见"的那几段；任何一条缺失都会红。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory } from "../core/storage/settings";
import {
  MemoryService,
  MEMORY_AUTHORITY_NOTE,
  MEMORY_STABLE_HEADER,
  MEMORY_VOLATILE_HEADER,
} from "../core/memory/memory";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../core/prompt/prompt";
import { setLang } from "../core/i18n/lang";
import { PromptDebugger } from "../components/PromptDebugger";

/** 造一个真实 `MemoryService`（平台级手动 ⇒ 稳定侧；项目级 ⇒ 易变侧） */
function makeService(projectPath: string): MemoryService {
  saveMemory("");
  const svc = new MemoryService();
  svc.add({ scope: "platform", key: "平台约定", content: "DEBUGGER_STABLE_MARKER", source: "manual" });
  svc.add({ scope: "project", projectId: projectPath, key: "项目约定", content: "DEBUGGER_VOLATILE_MARKER", source: "manual" });
  return svc;
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  setLang("zh");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("DBG-MEM-1：提示词调试器与真实发送同形（含记忆段与缓存边界）", () => {
  it("渲染出的提示必须含稳定记忆 / 边界哨兵 / 权威句 / 易变记忆", async () => {
    /*
     * 调试器默认工作目录是 `D:\project\my-app`（组件内的初始 state）⇒ 项目级条目要挂在
     * 同一个 projectId 上才会被注入（这也顺带证明调试器**真的**在做作用域过滤）。
     */
    const memoryModule = await import("../core/memory/memory");
    const { projectIdFromCwd } = memoryModule;
    const svc = makeService(projectIdFromCwd("D:\\project\\my-app")!);
    const spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    const { container } = render(<PromptDebugger />);
    const text = container.textContent ?? "";

    expect(text, "稳定记忆块必须出现在调试器里").toContain(MEMORY_STABLE_HEADER);
    expect(text, "稳定记忆正文必须在").toContain("DEBUGGER_STABLE_MARKER");
    expect(text, "缓存边界哨兵必须在（否则用户核对不到边界在哪）").toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(text, "权威句必须在（它挂在记忆块上）").toContain(MEMORY_AUTHORITY_NOTE);
    expect(text, "易变记忆块必须在").toContain(MEMORY_VOLATILE_HEADER);
    expect(text, "易变记忆正文必须在").toContain("DEBUGGER_VOLATILE_MARKER");

    // 段序：稳定记忆 → … → 哨兵 → 易变记忆（调试器里也必须与引擎同形）
    expect(text.indexOf(MEMORY_STABLE_HEADER)).toBeLessThan(text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY));
    expect(text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY)).toBeLessThan(text.indexOf(MEMORY_VOLATILE_HEADER));

    // date 段必须与引擎同形（分钟精度 + 真实时区偏移），不是 toLocaleDateString 的日期
    expect(text, "date 段必须在（调试器原先用的是日期字符串）").toContain("# Current Date");
    const dateMatch = /Current Date\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000[+-]\d{2}:\d{2})/.exec(text);
    expect(dateMatch, "调试器的 date 必须是引擎同形的分钟精度时间串（带真实偏移）").toBeTruthy();

    spy.mockRestore();
  });
});
