/**
 * LO-SCENE-UI — 「场景图片」设置卡（上传 / 切换 / 微调 / 删除）
 *
 * 覆盖：
 * - LO-SCENE-UI-1 画廊渲染（内置预设 + 我的上传），点选切换 sceneImageId
 * - LO-SCENE-UI-2 选择文件上传 → 写入 IndexedDB、启用、切到 custom、给出成功提示
 * - LO-SCENE-UI-3 拖拽到上传区同样生效
 * - LO-SCENE-UI-4 非法文件 → 明确报错且不改变当前场景
 * - LO-SCENE-UI-5 微调滑杆收敛并实时反映到对位预览
 * - LO-SCENE-UI-6 删除我的上传 → 回到内置预设
 * - LO-SCENE-UI-7 启动时从 IndexedDB 恢复已上传的图片
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent, cleanup } from "@testing-library/react";
import { SceneImageCard } from "../plugins/library-ops/components/monitor/SceneImageCard";
import { SCENE_PRESETS } from "../plugins/library-ops/data/pixel-art";
import { CUSTOM_SCENE_KEY, type SceneImageRecord } from "../plugins/library-ops/core/scene-image-db";
import { useLibraryOps } from "../plugins/library-ops/store";

/** 内存版 IndexedDB 层（替换模块，保留其余真实实现） */
const db = vi.hoisted(() => ({ map: new Map<string, unknown>(), available: true }));

vi.mock("../plugins/library-ops/core/scene-image-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/library-ops/core/scene-image-db")>();
  return {
    ...actual,
    putSceneImage: async (record: SceneImageRecord) => {
      db.map.set(record.id, record);
    },
    getSceneImage: async (id: string) => (db.map.get(id) as SceneImageRecord | undefined) ?? null,
    deleteSceneImage: async (id: string) => {
      db.map.delete(id);
    },
    isSceneImageDbAvailable: () => db.available,
  };
});

function makeFile(name = "场景.png", type = "image/png", size = 1024): File {
  return new File([new Uint8Array(Math.min(size, 32))], name, { type });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("LO-SCENE-UI 场景图片设置卡", () => {
  let createUrl: typeof URL.createObjectURL | undefined;
  let revokeUrl: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    cleanup();
    db.map.clear();
    db.available = true;
    useLibraryOps.getState()._reset();
    localStorage.clear();
    // 解码尺寸：happy-dom 没有 createImageBitmap / 图片解码，注入替身
    vi.stubGlobal("createImageBitmap", async () => ({ width: 2752, height: 1536, close: () => undefined }));
    createUrl = URL.createObjectURL;
    revokeUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "blob:uploaded" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (createUrl) Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createUrl });
    if (revokeUrl) Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revokeUrl });
    cleanup();
  });

  it("LO-SCENE-UI-1: 画廊列出全部预设 + 上传位，点选即切换", async () => {
    const utils = render(<SceneImageCard zh />);
    const options = [...utils.container.querySelectorAll<HTMLButtonElement>(".lo-scene-option")];
    expect(options.length).toBe(SCENE_PRESETS.length + 1);
    expect(options[options.length - 1].className).toContain("lo-scene-option--custom");
    expect(utils.container.textContent).toContain("上传图片");

    // 当前是默认预设
    expect(useLibraryOps.getState().settings.sceneImageId).toBe(SCENE_PRESETS[1].id);
    await act(async () => {
      fireEvent.click(options[0]);
    });
    expect(useLibraryOps.getState().settings.sceneImageId).toBe(SCENE_PRESETS[0].id);
    expect(options[0].className).toContain("is-active");
    utils.unmount();
  });

  it("LO-SCENE-UI-2: 选择文件 → 持久化 + 启用 + 提示", async () => {
    const utils = render(<SceneImageCard zh />);
    const input = utils.container.querySelector<HTMLInputElement>(".lo-scene-upload__input")!;
    const file = makeFile("我的图书馆.png");
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await flush();

    const state = useLibraryOps.getState();
    expect(state.customScene).not.toBeNull();
    expect(state.customScene!.name).toBe("我的图书馆.png");
    expect(state.customScene!.url).toBe("blob:uploaded");
    expect(state.customScene!.width).toBe(2752);
    expect(state.customScene!.height).toBe(1536);
    expect(state.settings.sceneImageId).toBe("custom");
    expect(state.sceneImageError).toBeNull();
    expect(state.sceneImageNotice).toContain("已启用");
    expect(db.map.get(CUSTOM_SCENE_KEY)).toBeTruthy();
    expect(utils.container.textContent).toContain("我的上传");
    utils.unmount();
  });

  it("LO-SCENE-UI-3: 拖拽到上传区同样生效", async () => {
    const utils = render(<SceneImageCard zh />);
    const zone = utils.container.querySelector(".lo-scene-upload") as HTMLElement;
    const file = makeFile("拖进来的.webp", "image/webp");
    await act(async () => {
      fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], files: [] } });
    });
    expect(zone.className).toContain("is-over");
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [file] } });
    });
    await flush();
    expect(zone.className).not.toContain("is-over");
    expect(useLibraryOps.getState().customScene!.name).toBe("拖进来的.webp");
    utils.unmount();
  });

  it("LO-SCENE-UI-4: 非法文件 → 报错且不切换场景", async () => {
    const utils = render(<SceneImageCard zh />);
    const input = utils.container.querySelector<HTMLInputElement>(".lo-scene-upload__input")!;
    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("恶意.txt", "text/plain")] } });
    });
    await flush();
    const state = useLibraryOps.getState();
    expect(state.customScene).toBeNull();
    expect(state.sceneImageError).toContain("不支持的图片格式");
    expect(state.settings.sceneImageId).toBe(SCENE_PRESETS[1].id);
    expect(utils.container.querySelector(".lo-scene-msg.is-error")).toBeTruthy();
    expect(db.map.size).toBe(0);
    utils.unmount();
  });

  it("LO-SCENE-UI-5: 微调滑杆收敛并反映到对位预览", async () => {
    const utils = render(<SceneImageCard zh />);
    const ranges = [...utils.container.querySelectorAll<HTMLInputElement>(".lo-align__controls .lo-range")];
    expect(ranges.length).toBe(3);
    await act(async () => {
      fireEvent.change(ranges[1], { target: { value: "150" } });
    });
    await act(async () => {
      fireEvent.change(ranges[2], { target: { value: "-80" } });
    });
    await act(async () => {
      fireEvent.change(ranges[0], { target: { value: "1.25" } });
    });
    const adjust = useLibraryOps.getState().settings.sceneImageAdjust;
    expect(adjust).toEqual({ scale: 1.25, x: 150, y: -80 });

    const image = utils.container.querySelector<HTMLImageElement>(".lo-align__image")!;
    // 百分比换算：150/1920 = 7.813%，-80/1072 = -7.463%
    expect(image.style.transform).toBe("translate(7.813%, -7.463%) scale(1.25)");
    expect(utils.container.querySelectorAll(".lo-align__room").length).toBe(12);

    const reset = [...utils.container.querySelectorAll<HTMLButtonElement>(".lo-btn")].find((b) => b.textContent?.includes("重置微调"))!;
    await act(async () => {
      fireEvent.click(reset);
    });
    expect(useLibraryOps.getState().settings.sceneImageAdjust).toEqual({ scale: 1, x: 0, y: 0 });
    utils.unmount();
  });

  it("LO-SCENE-UI-6: 删除我的上传 → 回到内置预设", async () => {
    const utils = render(<SceneImageCard zh />);
    const input = utils.container.querySelector<HTMLInputElement>(".lo-scene-upload__input")!;
    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile()] } });
    });
    await flush();
    expect(useLibraryOps.getState().customScene).not.toBeNull();

    const del = [...utils.container.querySelectorAll<HTMLButtonElement>(".lo-btn")].find((b) => b.textContent?.includes("删除我的上传"))!;
    expect(del).toBeTruthy();
    await act(async () => {
      fireEvent.click(del);
    });
    await flush();
    const state = useLibraryOps.getState();
    expect(state.customScene).toBeNull();
    expect(state.settings.sceneImageId).toBe("ai-library-01");
    expect(db.map.size).toBe(0);
    utils.unmount();
  });

  it("LO-SCENE-UI-7: 启动时从 IndexedDB 恢复已上传的图片", async () => {
    db.map.set(CUSTOM_SCENE_KEY, {
      id: CUSTOM_SCENE_KEY,
      blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
      name: "上次的图.png",
      type: "image/png",
      width: 2752,
      height: 1536,
      size: 1024,
      addedAt: 1,
    } satisfies SceneImageRecord);
    useLibraryOps.getState().updateSettings({ sceneImageId: "custom" });

    const utils = render(<SceneImageCard zh />);
    await flush();
    const state = useLibraryOps.getState();
    expect(state.customScene!.name).toBe("上次的图.png");
    expect(state.customScene!.url).toBe("blob:uploaded");
    expect(utils.container.querySelector(".lo-scene-current__name")!.textContent).toContain("上次的图.png");
    utils.unmount();
  });

  it("LO-SCENE-UI-8: 「手动对位编辑器」跳到场景视图并进入对位模式", async () => {
    const utils = render(<SceneImageCard zh />);
    const btn = [...utils.container.querySelectorAll<HTMLButtonElement>(".lo-btn")].find((b) =>
      b.textContent?.includes("手动对位编辑器"),
    )!;
    expect(btn).toBeTruthy();
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(useLibraryOps.getState().editingLayout).toBe(true);
    // v1.15.0：场景归「子智能体」页签 → 切的是 sceneTab，并派发宿主切页签事件
    expect(useLibraryOps.getState().sceneTab).toBe("scene");

    // 有对位调整后，卡片上出现「重置对位」按钮并显示计数
    useLibraryOps.getState().setNodeOverride("GW1", { x: 500, y: 500 });
    await act(async () => {});
    const reset = [...utils.container.querySelectorAll<HTMLButtonElement>(".lo-btn")].find((b) =>
      b.textContent?.includes("重置对位"),
    )!;
    expect(reset.textContent).toContain("1 节点");
    await act(async () => {
      fireEvent.click(reset);
    });
    expect(useLibraryOps.getState().layoutOverrides["ai-library-01"]).toBeUndefined();
    utils.unmount();
  });
});
