/**
 * 大富翁「开始游戏」的**启动链**（第 45 轮：E2 在修 P2-16 时发现的**死路**）。
 *
 * ## 缺陷形态（可逐字复现）
 *
 * 角色选择 → `onSelect` 里先 `setScreen('map_select')` + `setPendingStart({…})`，
 * 而那个"待启动"分支渲染的是一个**只在 `pendingStart` 为真时存在**的 `.phaser-container`。
 * 紧接着的 effect 又**先** `setPendingStart(null)`、**下一帧**才 `initGame`：
 * 摘掉标记让 render 立刻落回"开始界面"那一支（此时 `started` 仍是 false）→
 * 容器被卸载 → `phaserRef.current` 变 null → 下一帧 `initGame` 一进门的守卫
 * `if (!phaserRef.current || gameRef.current) return;` 直接 return。
 * 于是引擎没建、`started` 没置真、界面停在开始页，而 `pendingStart` 已清空、
 * effect 不会再跑 —— **死路**：这个游戏的开始按钮永远进不去游戏。
 *
 * ## 这条用例的判据（行为级，不是源码级）
 *
 * 真正的判据只有一句：**创建 Phaser 实例时，交给它的 `parent` 必须是"已经挂在文档里"的那个容器**
 * —— 因为 Phaser 把画布 `appendChild` 到 parent 上；parent 不在了，画布就跟着没了。
 * 所以这里 mock 掉 `phaser`，驱动真实界面（开始 → 选择角色 → 确认选择），
 * 然后断言 `new Phaser.Game` 收到的 `parent.isConnected === true`。
 *
 * 改前这条必然红：parent 是那个随后被卸载的过客容器（或直接 null）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, act, fireEvent } from "@testing-library/react";

/** 每次 `new Phaser.Game(cfg)` 都记下它的 parent（判据就落在这里） */
const gameConstructions: Array<{ parent: Element | null | undefined; connectedAtConstruction: boolean }> = [];
const destroyed: number[] = [];

vi.mock("phaser", () => {
  class FakeGame {
    scene = { add: () => {}, getScene: () => null };
    constructor(cfg: { parent?: Element | null }) {
      gameConstructions.push({
        parent: cfg?.parent ?? null,
        connectedAtConstruction: Boolean((cfg?.parent as Element | undefined)?.isConnected),
      });
    }
    destroy() {
      destroyed.push(1);
    }
  }
  class FakeScene {
    constructor(..._args: unknown[]) {}
  }
  return {
    default: {
      Game: FakeGame,
      Scene: FakeScene,
      AUTO: 0,
      Scale: { RESIZE: "RESIZE", FIT: "FIT", CENTER_BOTH: "CENTER_BOTH" },
      Types: {},
    },
  };
});

/** AI 玩家对这条用例没有任何贡献，直接替身掉（避免把游戏 AI 的实现细节拖进来） */
vi.mock("../../src/plugins/monopoly-game/engine/AIPlayer", () => ({
  AIPlayer: class {
    setDifficulty() {}
    getAction() {
      return null;
    }
  },
}));

import { GameView } from "../plugins/monopoly-game/components/GameView";

async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  gameConstructions.length = 0;
  destroyed.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("大富翁启动链（GameView：开始 → 选角色 → 确认）", () => {
  it("MSC-1: 确认选择之后必须真的创建 Phaser 实例，且 parent 是**已挂载**的容器", async () => {
    const { container } = render(createElement(GameView));
    await settle();

    // ① 开始界面 → 角色选择
    const toCharSelect = container.querySelector("button.game-start-btn");
    expect(toCharSelect, "开始界面上应当有进入角色选择的按钮").toBeTruthy();
    await act(async () => {
      fireEvent.click(toCharSelect!);
    });
    await settle();

    // ② 确认选择（CharacterSelect 的确认按钮）
    const confirm = container.querySelector("button.game-start-btn");
    expect(confirm, "角色选择界面应当有「确认选择」按钮").toBeTruthy();
    await act(async () => {
      fireEvent.click(confirm!);
    });
    await settle(8);

    expect(
      gameConstructions.length,
      "确认选择之后必须创建 Phaser 实例 —— 一条都没有就说明启动链又断了（原实现死在 ref 守卫上）",
    ).toBeGreaterThan(0);
    expect(
      gameConstructions[0].connectedAtConstruction,
      "创建 Phaser 实例时 parent 必须**已经挂在文档里**：Phaser 把画布 append 到它上面，" +
        "parent 随后被卸载 = 画布跟着消失（这正是原实现那条死路的核心）",
    ).toBe(true);
  });

  it("MSC-2: 游戏内界面真的出现（启动链通了的第二个必要条件）", async () => {
    const { container } = render(createElement(GameView));
    await settle();

    await act(async () => {
      fireEvent.click(container.querySelector("button.game-start-btn")!);
    });
    await settle();
    await act(async () => {
      fireEvent.click(container.querySelector("button.game-start-btn")!);
    });
    await settle(8);

    expect(
      container.querySelector(".game-layout"),
      "started 置真之后应当渲染游戏内布局（有 .game-layout 与承载画布的 .phaser-container）",
    ).toBeTruthy();
    expect(container.querySelector(".phaser-container"), "画布容器必须还在（不能被过客分支卸载掉）").toBeTruthy();
  });
});
