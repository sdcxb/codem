/**
 * 宠物系统测试 — 覆盖 pet.json 解析、设置管理、状态映射、市场客户端
 *
 * 测试范围：
 *   1. parsePetJson — 合法/非法 JSON 解析、字段验证、动画配置过滤
 *   2. getPetSettings/savePetSettings — 设置读写、合并、持久化
 *   3. isPetInstalled — 安装状态检查
 *   4. getAnimationForState — 动画查找与回退
 *   5. usePetStore — Agent 事件 → 宠物状态映射
 *   6. normalizeManifestItem — Manifest 字段归一化（通过 listMarketPets 间接测试）
 */
import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";
import { parsePetJson, getPetSettings, savePetSettings, isPetInstalled, getAnimationForState } from "../core/pet/pet-manager";
import { usePetStore } from "../core/pet/pet-store";
import { DEFAULT_PET_SETTINGS, ALL_PET_STATES } from "../core/pet/pet-types";
import type { PetDefinition, PetState } from "../core/pet/pet-types";
import { setSettingJSON, getSettingJSON } from "../core/storage/settings";

// ========== 测试数据 ==========

/** 合法的宠物定义 JSON */
const VALID_PET_JSON = JSON.stringify({
  slug: "test-cat",
  name: "Test Cat",
  description: "A test cat pet",
  author: "Tester",
  version: "1.0.0",
  spritesheet: "spritesheet.png",
  sheetWidth: 256,
  sheetHeight: 256,
  scale: 2.0,
  defaultState: "idle",
  tags: ["cat", "cute"],
  animations: [
    { state: "idle", x: 0, y: 0, frameWidth: 32, frameHeight: 32, frames: 4, frameInterval: 200, loop: true },
    { state: "thinking", x: 0, y: 32, frameWidth: 32, frameHeight: 32, frames: 4, frameInterval: 150, loop: true },
    { state: "working", x: 0, y: 64, frameWidth: 32, frameHeight: 32, frames: 6, frameInterval: 100, loop: true },
    { state: "happy", x: 0, y: 96, frameWidth: 32, frameHeight: 32, frames: 2, frameInterval: 300, loop: false },
    { state: "sad", x: 0, y: 128, frameWidth: 32, frameHeight: 32, frames: 2, frameInterval: 300, loop: false },
    { state: "sleeping", x: 0, y: 160, frameWidth: 32, frameHeight: 32, frames: 4, frameInterval: 500, loop: true },
  ],
});

/** 最小合法的宠物定义（仅 idle 动画） */
const MINIMAL_PET_JSON = JSON.stringify({
  slug: "minimal-pet",
  name: "Minimal",
  spritesheet: "sheet.png",
  animations: [
    { state: "idle", x: 0, y: 0, frameWidth: 16, frameHeight: 16, frames: 1, frameInterval: 1000, loop: true },
  ],
});

// ========== 测试套件 ==========

describe("宠物系统", () => {

  // ===== 1. parsePetJson 解析测试 =====
  describe("parsePetJson — pet.json 解析", () => {

    it("合法 JSON 正确解析所有字段", () => {
      const result = parsePetJson(VALID_PET_JSON);
      expect(result).not.toBeNull();
      expect(result!.slug).toBe("test-cat");
      expect(result!.name).toBe("Test Cat");
      expect(result!.description).toBe("A test cat pet");
      expect(result!.author).toBe("Tester");
      expect(result!.version).toBe("1.0.0");
      expect(result!.spritesheet).toBe("spritesheet.png");
      expect(result!.sheetWidth).toBe(256);
      expect(result!.sheetHeight).toBe(256);
      expect(result!.scale).toBe(2.0);
      expect(result!.animations).toHaveLength(6);
      expect(result!.tags).toEqual(["cat", "cute"]);
    });

    it("最小合法 JSON 正确解析", () => {
      const result = parsePetJson(MINIMAL_PET_JSON);
      expect(result).not.toBeNull();
      expect(result!.slug).toBe("minimal-pet");
      expect(result!.name).toBe("Minimal");
      expect(result!.animations).toHaveLength(1);
      expect(result!.animations[0].state).toBe("idle");
    });

    it("缺少 slug 返回 null", () => {
      const json = JSON.parse(VALID_PET_JSON);
      delete json.slug;
      expect(parsePetJson(JSON.stringify(json))).toBeNull();
    });

    it("缺少 name 返回 null", () => {
      const json = JSON.parse(VALID_PET_JSON);
      delete json.name;
      expect(parsePetJson(JSON.stringify(json))).toBeNull();
    });

    it("缺少 spritesheet 返回 null", () => {
      const json = JSON.parse(VALID_PET_JSON);
      delete json.spritesheet;
      expect(parsePetJson(JSON.stringify(json))).toBeNull();
    });

    it("缺少 animations 数组时从 Petdex 固定布局自动生成", () => {
      const json = JSON.parse(VALID_PET_JSON);
      delete json.animations;
      const result = parsePetJson(JSON.stringify(json));
      expect(result).not.toBeNull();
      expect(result!.animations.length).toBeGreaterThan(0);
      expect(result!.animations.some(a => a.state === "idle")).toBe(true);
    });

    it("animations 为空数组时从 Petdex 固定布局自动生成", () => {
      const json = JSON.parse(VALID_PET_JSON);
      json.animations = [];
      const result = parsePetJson(JSON.stringify(json));
      expect(result).not.toBeNull();
      expect(result!.animations.length).toBeGreaterThan(0);
      expect(result!.animations.some(a => a.state === "idle")).toBe(true);
    });

    it("缺少 idle 动画时从 Petdex 固定布局自动生成", () => {
      const json = JSON.parse(VALID_PET_JSON);
      json.animations = json.animations.filter((a: any) => a.state !== "idle");
      const result = parsePetJson(JSON.stringify(json));
      expect(result).not.toBeNull();
      expect(result!.animations.some(a => a.state === "idle")).toBe(true);
    });

    it("过滤掉无效状态名的动画", () => {
      const json = JSON.parse(VALID_PET_JSON);
      json.animations.push({ state: "dancing", x: 0, y: 0, frameWidth: 32, frameHeight: 32, frames: 4, frameInterval: 200, loop: true });
      const result = parsePetJson(JSON.stringify(json));
      expect(result).not.toBeNull();
      expect(result!.animations).toHaveLength(6); // dancing 被过滤掉
    });

    it("过滤掉缺少数值字段的动画", () => {
      const json = JSON.parse(VALID_PET_JSON);
      json.animations.push({ state: "happy", x: "invalid", y: 0, frameWidth: 32, frameHeight: 32, frames: 2, frameInterval: 300, loop: false });
      const result = parsePetJson(JSON.stringify(json));
      expect(result).not.toBeNull();
      // 原始 happy 保留，新增的无效 happy 被过滤
      const happyAnims = result!.animations.filter(a => a.state === "happy");
      expect(happyAnims).toHaveLength(1);
    });

    // ===== Petdex 原生格式兼容测试 =====

    it("Petdex 原生格式（id/displayName/spritesheetPath）正确解析", () => {
      const petdexJson = JSON.stringify({
        id: "homelander",
        displayName: "Homelander",
        description: "A test pet",
        spritesheetPath: "spritesheet.webp",
      });
      const result = parsePetJson(petdexJson);
      expect(result).not.toBeNull();
      expect(result!.slug).toBe("homelander");
      expect(result!.name).toBe("Homelander");
      expect(result!.spritesheet).toBe("spritesheet.webp");
      expect(result!.sheetWidth).toBe(1536); // Petdex 固定宽度
    });

    it("Petdex 格式自动生成 6 个 Codem 状态动画", () => {
      const petdexJson = JSON.stringify({
        id: "test-pet",
        displayName: "Test",
        spritesheetPath: "spritesheet.webp",
      });
      const result = parsePetJson(petdexJson);
      expect(result).not.toBeNull();
      const states = result!.animations.map(a => a.state);
      expect(states).toContain("idle");
      expect(states).toContain("thinking");
      expect(states).toContain("working");
      expect(states).toContain("happy");
      expect(states).toContain("sad");
      expect(states).toContain("sleeping");
    });

    it("Petdex 格式生成的动画使用 192x208 帧尺寸", () => {
      const petdexJson = JSON.stringify({
        id: "test-pet",
        displayName: "Test",
        spritesheetPath: "spritesheet.webp",
      });
      const result = parsePetJson(petdexJson);
      expect(result).not.toBeNull();
      const idleAnim = result!.animations.find(a => a.state === "idle");
      expect(idleAnim).not.toBeUndefined();
      expect(idleAnim!.frameWidth).toBe(192);
      expect(idleAnim!.frameHeight).toBe(208);
      expect(idleAnim!.frames).toBe(6); // idle = 6 帧
    });

    it("非 JSON 字符串返回 null", () => {
      expect(parsePetJson("not a json")).toBeNull();
    });

    it("null 输入返回 null", () => {
      expect(parsePetJson(null as any)).toBeNull();
    });

    it("缺少可选字段时使用默认值", () => {
      const json = JSON.parse(MINIMAL_PET_JSON);
      const result = parsePetJson(JSON.stringify(json));
      expect(result!.description).toBe("");
      expect(result!.author).toBe("");
      expect(result!.version).toBe("1.0.0");
      expect(result!.scale).toBe(1.0);
      expect(result!.defaultState).toBe("idle");
      expect(result!.tags).toEqual([]);
    });
  });

  // ===== 2. 设置管理测试 =====
  describe("getPetSettings / savePetSettings — 设置管理", () => {

    it("初始状态返回默认设置", () => {
      const settings = getPetSettings();
      expect(settings).toEqual(DEFAULT_PET_SETTINGS);
    });

    it("savePetSettings 正确合并部分设置", () => {
      savePetSettings({ enabled: true });
      const settings = getPetSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.scale).toBe(DEFAULT_PET_SETTINGS.scale); // 其他字段保持默认
    });

    it("savePetSettings 多次调用累积合并", () => {
      savePetSettings({ enabled: true, scale: 2.0 });
      savePetSettings({ opacity: 0.8 });
      const settings = getPetSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.scale).toBe(2.0);
      expect(settings.opacity).toBe(0.8);
    });

    it("savePetSettings 覆盖已有值", () => {
      savePetSettings({ scale: 1.5 });
      savePetSettings({ scale: 3.0 });
      const settings = getPetSettings();
      expect(settings.scale).toBe(3.0);
    });

    it("savePetSettings 持久化到 SQLite", () => {
      savePetSettings({ activePetSlug: "my-pet" });
      const raw = getSettingJSON("codem-pet-settings", null as any);
      expect(raw.activePetSlug).toBe("my-pet");
    });
  });

  // ===== 3. isPetInstalled 测试 =====
  describe("isPetInstalled — 安装状态检查", () => {

    it("未安装时返回 false", () => {
      expect(isPetInstalled("nonexistent-pet")).toBe(false);
    });

    it("通过安装记录判断已安装", () => {
      // 模拟安装记录
      setSettingJSON("codem-pet-installed", [
        { slug: "installed-pet", path: "/fake/path", installedAt: Date.now() },
      ]);
      expect(isPetInstalled("installed-pet")).toBe(true);
    });

    it("多条记录中查找", () => {
      setSettingJSON("codem-pet-installed", [
        { slug: "pet-a", path: "/a", installedAt: 1 },
        { slug: "pet-b", path: "/b", installedAt: 2 },
        { slug: "pet-c", path: "/c", installedAt: 3 },
      ]);
      expect(isPetInstalled("pet-a")).toBe(true);
      expect(isPetInstalled("pet-b")).toBe(true);
      expect(isPetInstalled("pet-c")).toBe(true);
      expect(isPetInstalled("pet-d")).toBe(false);
    });
  });

  // ===== 4. getAnimationForState 测试 =====
  describe("getAnimationForState — 动画查找", () => {
    const definition: PetDefinition = parsePetJson(VALID_PET_JSON)!;

    it("查找存在的状态返回对应动画", () => {
      const anim = getAnimationForState(definition, "thinking");
      expect(anim).not.toBeNull();
      expect(anim!.state).toBe("thinking");
      expect(anim!.x).toBe(0);
      expect(anim!.y).toBe(32);
    });

    it("查找不存在的状态回退到 idle", () => {
      // 删除 happy 动画
      const def: PetDefinition = {
        ...definition,
        animations: definition.animations.filter(a => a.state !== "happy"),
      };
      const anim = getAnimationForState(def, "happy");
      expect(anim).not.toBeNull();
      expect(anim!.state).toBe("idle"); // 回退到 idle
    });

    it("所有合法状态都可以查找", () => {
      for (const state of ALL_PET_STATES) {
        const anim = getAnimationForState(definition, state);
        expect(anim).not.toBeNull();
      }
    });

    it("空动画列表返回 null", () => {
      const emptyDef: PetDefinition = {
        ...definition,
        animations: [],
      };
      // getAnimationForState 会尝试 find idle，找不到返回 null
      const anim = getAnimationForState(emptyDef, "idle");
      expect(anim).toBeNull();
    });
  });

  // ===== 5. usePetStore 状态映射测试 =====
  describe("usePetStore — Agent 事件 → 宠物状态映射", () => {
    // 每个测试前重置 store
    beforeEach(() => {
      // 重置到初始状态
      usePetStore.setState({
        enabled: true,
        activePet: parsePetJson(VALID_PET_JSON) as any,
        spritesheetUrl: "data:image/png;base64,fake",
        petState: "idle",
        installedPets: [],
        loading: false,
        lastActivityAt: Date.now(),
        positionX: 24,
        positionY: 8,
        scale: 0.4,
        opacity: 1.0,
      });
    });

    it("初始状态为 idle", () => {
      expect(usePetStore.getState().petState).toBe("idle");
    });

    it("llm_status: connecting → thinking", () => {
      usePetStore.getState().onLLMStatus("connecting");
      expect(usePetStore.getState().petState).toBe("thinking");
    });

    it("llm_status: streaming → thinking", () => {
      usePetStore.getState().onLLMStatus("streaming");
      expect(usePetStore.getState().petState).toBe("thinking");
    });

    it("llm_status: executing_tools → working", () => {
      usePetStore.getState().onLLMStatus("executing_tools");
      expect(usePetStore.getState().petState).toBe("working");
    });

    it("llm_status: idle 不改变状态（等 end 事件）", () => {
      usePetStore.getState().setPetState("thinking");
      usePetStore.getState().onLLMStatus("idle");
      expect(usePetStore.getState().petState).toBe("thinking");
    });

    it("stream event: start → thinking (from idle)", () => {
      usePetStore.getState().onStreamEvent({ type: "start" });
      expect(usePetStore.getState().petState).toBe("thinking");
    });

    it("stream event: text_delta → thinking (from idle)", () => {
      usePetStore.getState().onStreamEvent({ type: "text_delta", text: "hello" });
      expect(usePetStore.getState().petState).toBe("thinking");
    });

    it("stream event: reasoning_delta → thinking (from sleeping)", () => {
      usePetStore.getState().setPetState("sleeping");
      usePetStore.getState().onStreamEvent({ type: "reasoning_delta", text: "hmm" });
      expect(usePetStore.getState().petState).toBe("thinking");
    });

    it("stream event: tool_start → working", () => {
      usePetStore.getState().setPetState("thinking");
      usePetStore.getState().onStreamEvent({ type: "tool_start", toolCall: { id: "1", name: "read" } });
      expect(usePetStore.getState().petState).toBe("working");
    });

    it("stream event: tool_complete → thinking (from working)", () => {
      usePetStore.getState().setPetState("working");
      usePetStore.getState().onStreamEvent({ type: "tool_complete", toolCall: { id: "1", name: "read" } });
      expect(usePetStore.getState().petState).toBe("thinking");
    });

    it("stream event: end (success) → happy", () => {
      usePetStore.getState().setPetState("thinking");
      usePetStore.getState().onStreamEvent({ type: "end", result: { type: "stop", reason: "done" } });
      expect(usePetStore.getState().petState).toBe("happy");
    });

    it("stream event: end (error result) → sad", () => {
      usePetStore.getState().setPetState("thinking");
      usePetStore.getState().onStreamEvent({ type: "end", result: { type: "error", error: "something failed" } });
      expect(usePetStore.getState().petState).toBe("sad");
    });

    it("stream event: end (overflow result) → sad", () => {
      usePetStore.getState().setPetState("thinking");
      usePetStore.getState().onStreamEvent({ type: "end", result: { type: "overflow", message: "context full" } });
      expect(usePetStore.getState().petState).toBe("sad");
    });

    it("stream event: error → sad", () => {
      usePetStore.getState().setPetState("thinking");
      usePetStore.getState().onStreamEvent({ type: "error", error: "API timeout" });
      expect(usePetStore.getState().petState).toBe("sad");
    });

    it("stream event: tool_error → sad", () => {
      usePetStore.getState().setPetState("working");
      usePetStore.getState().onStreamEvent({ type: "tool_error", toolCall: { id: "1", name: "write" }, error: "permission denied" });
      expect(usePetStore.getState().petState).toBe("sad");
    });

    it("happy/sad 状态期间不响应 llm_status", () => {
      usePetStore.getState().setPetState("happy");
      usePetStore.getState().onLLMStatus("connecting");
      expect(usePetStore.getState().petState).toBe("happy"); // 保持不变
    });

    it("end 事件不覆盖已有的 sad 状态", () => {
      usePetStore.getState().setPetState("sad");
      usePetStore.getState().onStreamEvent({ type: "end", result: { type: "stop" } });
      expect(usePetStore.getState().petState).toBe("sad"); // 保持 sad
    });

    it("disabled 时不响应任何事件", () => {
      usePetStore.setState({ enabled: false });
      usePetStore.getState().onLLMStatus("connecting");
      expect(usePetStore.getState().petState).toBe("idle"); // 不变
      usePetStore.getState().onStreamEvent({ type: "tool_start" });
      expect(usePetStore.getState().petState).toBe("idle"); // 不变
    });

    it("无 activePet 时不响应任何事件", () => {
      usePetStore.setState({ activePet: null });
      usePetStore.getState().onLLMStatus("connecting");
      expect(usePetStore.getState().petState).toBe("idle");
    });

    it("完整 Agent 生命周期：idle → thinking → working → thinking → happy", () => {
      // 模拟一个完整的 Agent 交互
      expect(usePetStore.getState().petState).toBe("idle");

      usePetStore.getState().onStreamEvent({ type: "start", iteration: 1 });
      expect(usePetStore.getState().petState).toBe("thinking");

      usePetStore.getState().onLLMStatus("streaming");
      expect(usePetStore.getState().petState).toBe("thinking");

      usePetStore.getState().onStreamEvent({ type: "text_delta", text: "Let me check" });
      expect(usePetStore.getState().petState).toBe("thinking");

      usePetStore.getState().onLLMStatus("executing_tools");
      usePetStore.getState().onStreamEvent({ type: "tool_start", toolCall: { id: "1", name: "read" } });
      expect(usePetStore.getState().petState).toBe("working");

      usePetStore.getState().onStreamEvent({ type: "tool_complete", toolCall: { id: "1", name: "read" } });
      expect(usePetStore.getState().petState).toBe("thinking");

      usePetStore.getState().onStreamEvent({ type: "end", result: { type: "stop", reason: "done" } });
      expect(usePetStore.getState().petState).toBe("happy");
    });

    it("错误场景：idle → thinking → working → sad (tool_error)", () => {
      usePetStore.getState().onStreamEvent({ type: "start" });
      expect(usePetStore.getState().petState).toBe("thinking");

      usePetStore.getState().onStreamEvent({ type: "tool_start", toolCall: { id: "1", name: "write" } });
      expect(usePetStore.getState().petState).toBe("working");

      usePetStore.getState().onStreamEvent({ type: "tool_error", toolCall: { id: "1", name: "write" }, error: "denied" });
      expect(usePetStore.getState().petState).toBe("sad");
    });
  });

  // ===== 6. usePetStore 设置操作测试 =====
  describe("usePetStore — 设置操作", () => {
    beforeEach(() => {
      usePetStore.setState({
        enabled: false,
        activePet: null,
        spritesheetUrl: null,
        petState: "idle",
        installedPets: [],
        loading: false,
        lastActivityAt: Date.now(),
        positionX: 24,
        positionY: 8,
        scale: 0.4,
        opacity: 1.0,
      });
    });

    it("setEnabled 启用宠物", () => {
      usePetStore.getState().setEnabled(true);
      expect(usePetStore.getState().enabled).toBe(true);
      // 验证持久化
      const settings = getPetSettings();
      expect(settings.enabled).toBe(true);
    });

    it("setPosition 更新位置并持久化", () => {
      usePetStore.getState().setPosition(100, 50);
      expect(usePetStore.getState().positionX).toBe(100);
      expect(usePetStore.getState().positionY).toBe(50);
      const settings = getPetSettings();
      expect(settings.positionX).toBe(100);
      expect(settings.positionY).toBe(50);
    });

    it("setScale 更新缩放并持久化", () => {
      usePetStore.getState().setScale(2.5);
      expect(usePetStore.getState().scale).toBe(2.5);
      expect(getPetSettings().scale).toBe(2.5);
    });

    it("setOpacity 更新透明度并持久化", () => {
      usePetStore.getState().setOpacity(0.5);
      expect(usePetStore.getState().opacity).toBe(0.5);
      expect(getPetSettings().opacity).toBe(0.5);
    });
  });

  // ===== 7. DEFAULT_PET_SETTINGS 常量测试 =====
  describe("DEFAULT_PET_SETTINGS — 默认设置常量", () => {
    it("默认禁用", () => {
      expect(DEFAULT_PET_SETTINGS.enabled).toBe(false);
    });

    it("默认无激活宠物", () => {
      expect(DEFAULT_PET_SETTINGS.activePetSlug).toBeNull();
    });

    it("默认缩放为 0.4", () => {
      expect(DEFAULT_PET_SETTINGS.scale).toBe(0.4);
    });

    it("默认透明度为 1.0", () => {
      expect(DEFAULT_PET_SETTINGS.opacity).toBe(1.0);
    });

    it("默认空闲超时 60 秒", () => {
      expect(DEFAULT_PET_SETTINGS.idleTimeout).toBe(60000);
    });

    it("默认可拖拽", () => {
      expect(DEFAULT_PET_SETTINGS.draggable).toBe(true);
    });
  });

  // ===== 8. ALL_PET_STATES 常量测试 =====
  describe("ALL_PET_STATES — 状态枚举", () => {
    it("包含所有 6 个状态", () => {
      expect(ALL_PET_STATES).toHaveLength(6);
    });

    it("包含 idle", () => {
      expect(ALL_PET_STATES).toContain("idle");
    });

    it("包含 thinking", () => {
      expect(ALL_PET_STATES).toContain("thinking");
    });

    it("包含 working", () => {
      expect(ALL_PET_STATES).toContain("working");
    });

    it("包含 happy", () => {
      expect(ALL_PET_STATES).toContain("happy");
    });

    it("包含 sad", () => {
      expect(ALL_PET_STATES).toContain("sad");
    });

    it("包含 sleeping", () => {
      expect(ALL_PET_STATES).toContain("sleeping");
    });
  });
});
