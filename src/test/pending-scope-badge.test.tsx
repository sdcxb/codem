/**
 * 第 199 波判据：**待批准条目必须显示作用域**（用户真机直报）。
 *
 * > 待批准的自动记忆，没显示类型是平台级、项目级、还是对话级，导致我没法判断是否批准，
 * > 要把类型体现出来。
 *
 * 作用域是"该不该批准"的第一依据（平台级处处生效 / 项目级对这个项目以后的每个对话生效 /
 * 对话级只影响当前对话），而面板的待批准区原来只有「标题 + 正文 + 批准/拒绝」。
 * 体检那边早就有这个徽标（`mc-scope-badge`）⇒ 这一波把面板补齐，并且**文案收敛到唯一一份表**
 * （`MEMORY_SCOPE_BADGE_LABEL`），免得两处各写一遍后分叉成两种说法。
 *
 * 判据（行为 + 反向对照）：
 * - `PENDSCOPE-1`：平台 / 项目 / 对话三种待批准条目各渲染出**自己的**作用域文案。
 * - `PENDSCOPE-2`（反向对照）：文案必须**跟着条目走** —— 把三条的作用域换成另一组，
 *   界面上的徽标必须跟着变（钉住"不是一个写死的常量"）。
 * - `PENDSCOPE-3`：认不出的旧作用域**原样显示**，不许假装成三者之一。
 * - `PENDSCOPE-4`：没有归属键的（批准也不会进上下文）必须显式标出「无归属」。
 * - `PENDSCOPE-5`（同源）：面板与体检的作用域徽标必须取自同一份表（不许各写一份字面量）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, cleanup, act } from "@testing-library/react";
import { createElement } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory } from "../core/storage/settings";
import {
  MemoryService,
  MEMORY_SCOPE_BADGE_LABEL,
  type MemoryEntry,
  type MemoryScope,
} from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { MemoryManager } from "../components/MemoryManager";

const PROJ = "c:\\work\\pendscoPE";
const SESSION = "sess-199";

/** 造一条待批准条目（三种作用域各一条，归属键按作用域给全） */
function seedPending(svc: MemoryService, scope: MemoryScope, key: string): MemoryEntry | undefined {
  const own =
    scope === "platform" ? {} : scope === "project" ? { projectId: PROJ } : { sessionId: SESSION };
  const r = svc.add({
    scope,
    ...own,
    key,
    content: `${key} 的正文内容（足够长以便入库）`,
    source: "auto",
    status: "pending",
    batchId: "batch-199",
  });
  return r.entry;
}

async function renderPanel(): Promise<HTMLElement> {
  const { container } = render(
    createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: SESSION } as never),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

/** 每一条待批准条目上的作用域徽标（按行取，行与徽标一一对应） */
function scopeBadges(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".memory-pending-item")).map(
    (row) => row.querySelector(".memory-pending-scope")?.textContent?.trim() ?? "(缺)",
  );
}

beforeEach(() => {
  saveMemory("");
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setStoragePort(null);
});

describe("PENDSCOPE：待批准条目的作用域徽标", () => {
  it("PENDSCOPE-1：三种作用域各显示自己的类型（这是「该不该批准」的第一依据）", async () => {
    const svc = new MemoryService();
    seedPending(svc, "platform", "平台级事实");
    seedPending(svc, "project", "项目级事实");
    seedPending(svc, "conversation", "对话级事实");
    vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    const container = await renderPanel();
    const rows = Array.from(container.querySelectorAll(".memory-pending-item"));
    expect(rows, "三条待批准都要渲染出来（前提）").toHaveLength(3);

    /* 按行取徽标 ⇒ 不能只看"文本里出现过平台级"，要确认**每一条**都有自己的类型 */
    const badges = scopeBadges(container);
    expect(badges.sort(), "三种类型都要出现，且一一对应").toEqual(
      [MEMORY_SCOPE_BADGE_LABEL.platform, MEMORY_SCOPE_BADGE_LABEL.project, MEMORY_SCOPE_BADGE_LABEL.conversation].sort(),
    );
  });

  it("PENDSCOPE-2（反向对照）：徽标跟着条目走（不是写死的常量）", async () => {
    const svc = new MemoryService();
    seedPending(svc, "conversation", "本来是对话级");
    vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
    let container = await renderPanel();
    expect(scopeBadges(container)).toEqual([MEMORY_SCOPE_BADGE_LABEL.conversation]);
    cleanup();

    /* 换一条**平台级**的：同一个位置必须改口（先把数据面清干净，否则上一条还会被加载进来） */
    saveMemory("");
    const svc2 = new MemoryService();
    seedPending(svc2, "platform", "换成平台级");
    vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc2);
    container = await renderPanel();
    expect(
      scopeBadges(container),
      "换成平台级之后徽标必须跟着变（写死常量的实现会在这里红）",
    ).toEqual([MEMORY_SCOPE_BADGE_LABEL.platform]);
  });

  it("PENDSCOPE-3：认不出的旧作用域**原样显示**（不许假装成三者之一）", async () => {
    /*
     * 造"旧数据"形态：**直接写持久化 payload**（作用域是老名字 `session`，且带 sessionId）。
     * ⚠️ 不能走 `add()`：那条路上未知作用域会被规范化成对话级（第一版就是这么写的，
     * 徽标一直是"对话级"）；真机上这种条目只可能来自**库里的旧 payload** ⇒ 夹具也得照这个形态造。
     */
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          "legacy-pending-1": {
            id: "legacy-pending-1",
            /* `session` 会被迁移改名成 conversation ⇒ 用**迁移不认识的**旧词，才是"作用域无法识别"的真形态 */
            scope: "workspace",
            sessionId: SESSION,
            key: "旧作用域的待批准",
            content: "作用域是迁移不认识的旧词 workspace",
            source: "auto",
            status: "pending",
            timestamp: 1_700_000_000_000,
          },
        },
        batches: [],
      }),
    );
    const svc = new MemoryService();
    expect(
      svc.listPending(undefined, { projectId: PROJ, sessionId: SESSION }),
      "前提：旧形态条目确实躺在待批准列表里",
    ).toHaveLength(1);
    vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    const container = await renderPanel();
    const badges = scopeBadges(container);
    expect(badges, "旧作用域要原样出现在徽标里").toContain("作用域：workspace");
    expect(
      badges.some((b) => b === MEMORY_SCOPE_BADGE_LABEL.project || b === MEMORY_SCOPE_BADGE_LABEL.platform),
      "不许把 workspace 猜成项目级/平台级",
    ).toBe(false);
  });

  it("PENDSCOPE-4：没有归属键的待批准条目要标出「无归属」（批准也不会进上下文）", async () => {
    const svc = new MemoryService();
    /* 项目级但没有 projectId = 旧的孤儿形态 */
    svc.add({ scope: "project", key: "无归属事实", content: "没有归属键的待批准内容", source: "auto", status: "pending" });
    vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    const container = await renderPanel();
    /*
     * ⚠️ 断言要落在**那一行的徽标**上，不能只看"整屏文本里有没有『无归属』"——
     * 面板别处本来就有这类字样，第一版那么写 ⇒ 把标记整段去掉的变异照样绿（假绿）。
     */
    const row = container.querySelector(".memory-pending-item");
    expect(row, "前提：那一行渲染出来了").toBeTruthy();
    expect(
      row!.querySelector(".memory-pending-noowner")?.textContent ?? "",
      "没有归属键 ⇒ 批准也进不了上下文，这件事必须写在那一行上",
    ).toContain("无归属");
  });

  it("PENDSCOPE-4b（反向对照）：有归属键的条目不许多一个「无归属」标记", async () => {
    const svc = new MemoryService();
    seedPending(svc, "project", "有归属的事实");
    vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);

    const container = await renderPanel();
    const row = container.querySelector(".memory-pending-item");
    expect(row, "前提：那一行渲染出来了").toBeTruthy();
    expect(
      row!.querySelector(".memory-pending-noowner"),
      "它有 projectId ⇒ 不该出现「无归属」（否则用户会以为批准没用）",
    ).toBeNull();
  });

  it("PENDSCOPE-5（同源）：面板与体检取自同一份作用域文案表（不许各写一份）", () => {
    const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const rel of ["src/components/MemoryManager.tsx", "src/components/MemoryCheckupView.tsx"]) {
      const src = read(rel);
      expect(src, `${rel} 必须用唯一那份作用域文案表`).toContain("MEMORY_SCOPE_BADGE_LABEL");
    }
    /*
     * 反向：**面板**里不许再有带「级」的字面量（它每一处作用域显示都该走文案表）。
     * ⚠️ 体检那边**允许**保留几处更长的说法（归位下拉的「平台级（所有项目）」「项目级 · 项目名」
     * 以及几句说明文字）—— 那些不是徽标文案，硬要求 0 处等于把"更长的说明"也一起禁掉（假要求）。
     */
    const panel = read("src/components/MemoryManager.tsx");
    const literals = [...panel.matchAll(/"(平台级|项目级|对话级)"/g)].length;
    expect(literals, `面板里还有 ${literals} 处带「级」的字面量（应当走 MEMORY_SCOPE_BADGE_LABEL）`).toBe(0);

    /*
     * 体检那边的**徽标函数本身**必须是锚定取段的源码断言：它的三态文案若退回自己写一份，
     * 渲染结果与文案表**逐字相同** ⇒ 任何行为判据都咬不住它（MUT-5 第一版就是因此漏网的）。
     */
    const checkup = read("src/components/MemoryCheckupView.tsx");
    const anchor = checkup.indexOf("function scopeBadgeLabel(");
    expect(anchor, "体检里必须有 scopeBadgeLabel（徽标文案的唯一入口）").toBeGreaterThan(-1);
    const body = checkup.slice(anchor, anchor + 400);
    expect(body, "体检的徽标函数必须走文案表").toContain("MEMORY_SCOPE_BADGE_LABEL");
    expect(
      [...body.matchAll(/"(平台级|项目级|对话级)"/g)].length,
      "体检的徽标函数里不许再写一遍三态字面量（两处各写一份必然分叉）",
    ).toBe(0);
  });
});
