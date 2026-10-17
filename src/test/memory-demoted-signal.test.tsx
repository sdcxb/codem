/**
 * MEM-DEMOTE：**「本会话已自动降级 N 条」的可见信号**（第 231 波 A1，独立审计 · 中 · 安全面）。
 *
 * ## 被守的缺陷
 *
 * 待批准积压撞上限后，`src/core/llm/index.ts` 把本来要用户批准的候选**降级为对话级**
 * （`scope=conversation`、`status=active`、`sessionId=当前会话`）—— 从「不注入」变成
 * **注入当前对话上下文**。而 `globalPending` 不计它、面板一个字的提示都没有
 * ⇒ 用户这次否决机会被拿走却不知道；代价只写在 `pending-backlog.ts` 的文件头注释里
 * （只有开发者看得到，用户看不到）。
 *
 * ## 修法与取数口径
 *
 * 写入路径在条目上留 `demotedFrom`（原作用域），面板据此在「待批准」标题旁显示一行可点开的
 * 「本会话已自动降级 N 条（查看）」，点开列出标题 / 时间 / **原作用域**，
 * 并明写「它们已进入本会话上下文」。
 *
 * N **只走引擎** `listBacklogDemotedForSession`（只认 `demotedFrom`），不是 pending 数、
 * 也不是界面自己按「对话级 + auto」扫库（那会多算本来就不审批的条目）。
 * 引擎那一半（真实提取触发降级）由 `memory-pending-backlog.test.ts` 的 `MEMP-8` 守。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";

vi.mock("../core/ui/native-dialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(false),
  alertDialog: vi.fn().mockResolvedValue(undefined),
}));

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting } from "../core/storage/settings";
import { MemoryService, MEMORY_WRITE_APPROVAL_KEY } from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { MemoryManager } from "../components/MemoryManager";

const PROJ = "proj-demote";
const SESSION = "sess-demote";
const OTHER_SESSION = "sess-other";

let svc: MemoryService;
/**
 * 面板取服务走 `getMemoryService()`。
 *
 * ⚠️ 这里用**一个可变的 holder**（`currentSvc`）而不是"每条用例各自 vi.spyOn 一次"：
 * 对同一个导出重复 spyOn 时，第二次返回的仍是第一次那个 spy，`mockReturnValue` 看起来设了、
 * 组件却还拿到旧实例 —— 本判据第一版就是这么"假绿"了（N=0 那条用例里居然渲染出了提示）。
 */
let currentSvc: MemoryService;

/** 待批准 3 条 + 降级 2 条（本会话）+ 正常对话级 1 条（不该被算成降级）+ 别的会话降级 1 条 */
function seedMixed(): MemoryService {
  const service = new MemoryService();
  for (let i = 1; i <= 3; i++) {
    service.add({
      scope: "project",
      projectId: PROJ,
      key: `待审事实 ${i}`,
      content: `第 ${i} 条待批准的自动记忆（面板 A1 信号的背景数据）`,
      source: "auto",
      status: "pending",
    });
  }
  for (let i = 1; i <= 2; i++) {
    service.add({
      scope: "conversation",
      sessionId: SESSION,
      key: `被降级事实 ${i}`,
      content: `第 ${i} 条因积压上限被降级为对话级、已经悄悄生效的记忆`,
      source: "auto",
      status: "active",
      demotedFrom: "project",
    });
  }
  /* 正常就该对话级生效的（用户批准的对话级记忆）——不许被算成"被降级" */
  service.add({
    scope: "conversation",
    sessionId: SESSION,
    key: "本该对话级记忆",
    content: "这条是按对话级正常写入的，不是降级来的",
    source: "auto",
    status: "active",
  });
  /* 别的会话里的降级条目——不该出现在本会话的 N 里 */
  service.add({
    scope: "conversation",
    sessionId: OTHER_SESSION,
    key: "别会话的降级事实",
    content: "这条属于另一个会话，本会话的提示不该数它",
    source: "auto",
    status: "active",
    demotedFrom: "project",
  });
  return service;
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

function toggle(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".memory-demoted-toggle");
}

beforeEach(() => {
  saveMemory("");
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  svc = seedMixed();
  currentSvc = svc;
  vi.spyOn(memoryModule, "getMemoryService").mockImplementation(() => currentSvc);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MEM-DEMOTE：本会话被自动降级的条目必须有可见信号", () => {
  it("MEM-DEMOTE-1 ★N 的来源是「降级写入的条数」：2 条（不是 pending 的 3 条、不是 4、不是 6）", async () => {
    const container = await renderPanel();
    const btn = toggle(container);
    expect(btn, "有降级条目 ⇒ 必须有「本会话已自动降级 N 条」这一行").toBeTruthy();
    expect(btn!.textContent, "N 只数本会话里被降级的条目（2 条）").toContain("本会话已自动降级 2 条");
    /* 反向对照：把 pending 数、或全库对话级数写进 N，都会让下面这两条红 */
    expect(btn!.textContent, "N 不是待批准数（此刻待批准 3 条）").not.toContain("3 条");
    expect(btn!.textContent, "N 也不是「所有对话级条目」（那是 3 条：2 降级 + 1 正常）").not.toContain("3");
    expect(btn!.getAttribute("aria-expanded"), "未展开时 aria-expanded=false（可访问状态要如实）").toBe("false");
  });

  it("MEM-DEMOTE-2 反向对照：没有降级条目时**不许**出现这行（N=0 不渲染）", async () => {
    /* 换成一个只有 3 条待批准、没有任何降级条目的库
       ⚠️ 先 saveMemory("") 把记忆域清空：假端口是共享的，上一个 service 的 add 已经落库，
       直接 new MemoryService() 会把那 7 条（含 2 条降级）**读回来** —— 本判据第一版就这么假红过 */
    saveMemory("");
    const plain = new MemoryService();
    for (let i = 1; i <= 3; i++) {
      plain.add({
        scope: "project",
        projectId: PROJ,
        key: `待审事实 ${i}`,
        content: `第 ${i} 条待批准`,
        source: "auto",
        status: "pending",
      });
    }
    currentSvc = plain;
    const container = await renderPanel();
    expect(toggle(container), "N=0 ⇒ 一个字的提示都不许出现（否则就是狼来了）").toBeNull();
    expect(container.querySelector(".memory-demoted-notice")).toBeNull();
  });

  it("MEM-DEMOTE-3 ★点开能看到这 N 条：标题 / 时间 / 原作用域，并明写「已进入本会话上下文」", async () => {
    const container = await renderPanel();
    const btn = toggle(container)!;
    expect(container.querySelector(".memory-demoted-body"), "默认收起（不占地方）").toBeNull();

    act(() => {
      fireEvent.click(btn);
    });
    const body = container.querySelector(".memory-demoted-body");
    expect(body, "点开后必须出现清单").toBeTruthy();
    expect(toggle(container)!.getAttribute("aria-expanded")).toBe("true");

    const items = Array.from(body!.querySelectorAll(".memory-demoted-item"));
    expect(items, "有 2 条降级条目 ⇒ 清单里 2 行").toHaveLength(2);
    const text = body!.textContent ?? "";
    expect(text, "要点名是哪几条（只看数字等于查不到）").toContain("被降级事实 1");
    expect(text, "要点名是哪几条").toContain("被降级事实 2");
    expect(text, "必须写出原作用域（用户才知道被吞掉的是什么级别的事实）").toContain("原作用域：项目级");
    expect(text, "必须明写它们已经生效——这是整条信号的重点").toContain("已进入本会话上下文");
    expect(text, "别会话的降级条目不许混进来").not.toContain("别会话的降级事实");
    expect(text, "正常对话级条目不许混进来").not.toContain("本该对话级记忆");

    /* 再点一次收起 */
    act(() => {
      fireEvent.click(toggle(container)!);
    });
    expect(container.querySelector(".memory-demoted-body"), "再点一次要能收起").toBeNull();
  });

  it("MEM-DEMOTE-4 待批准为空时，这条信号也必须出现（最典型的形态：清空了待批准、降级已发生）", async () => {
    saveMemory("");
    const onlyDemoted = new MemoryService();
    onlyDemoted.add({
      scope: "conversation",
      sessionId: SESSION,
      key: "唯一一条被降级的事实",
      content: "积压撞上限时被降级为对话级、已经生效",
      source: "auto",
      status: "active",
      demotedFrom: "project",
    });
    currentSvc = onlyDemoted;
    const container = await renderPanel();
    /*
     * 前提用「没有待批准**列表**」来判（不是「没有 `.memory-pending-section`」）：
     * 信号独立出现时用的正是同一个 section 样式外壳（`memory-demoted-section`），
     * 拿类名当"有没有待批准区"的判据会把这条用例自己绊倒（第一版就这么红的）。
     */
    expect(container.querySelector(".memory-pending-list"), "前提：没有待批准列表").toBeNull();
    const section = container.querySelector(".memory-demoted-section");
    expect(section, "待批准区为空 ⇒ 信号要独立出现（否则这条最该看到的形态反而没有提示）").toBeTruthy();
    expect(toggle(container)!.textContent).toContain("本会话已自动降级 1 条");
  });
});
