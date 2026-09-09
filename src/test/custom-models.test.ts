/**
 * 手动添加自定义模型（服务器列表外的内测/测试模型）：
 * codem-custom-models 存储 + mergeCustomModels 合并逻辑。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setSettingJSON, getSettingJSON } from "../core/storage/settings";
import {
  getCustomModels,
  addCustomModel,
  removeCustomModel,
  customNamesFor,
  mergeCustomModels,
} from "../core/llm/custom-models";

const KEY = "codem-custom-models";

beforeEach(() => {
  // setup.ts 已重置数据库；这里清掉用例间残留
  setSettingJSON(KEY, []);
});

describe("custom-models 存储", () => {
  it("addCustomModel 写入后可读回，且 trimmed", () => {
    expect(addCustomModel("deepseek", "  deepseek-v4.1-flash-expires-on-0910  ")).toBe(true);
    const list = getCustomModels();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      provider: "deepseek",
      name: "deepseek-v4.1-flash-expires-on-0910",
    });
    expect(typeof list[0].addedAt).toBe("number");
  });

  it("空 provider / 空名 / 纯空白拒绝", () => {
    expect(addCustomModel("", "m1")).toBe(false);
    expect(addCustomModel("deepseek", "")).toBe(false);
    expect(addCustomModel("deepseek", "   ")).toBe(false);
    expect(getCustomModels()).toHaveLength(0);
  });

  it("同 provider 同名去重返回 false，不同 provider 可同名", () => {
    expect(addCustomModel("deepseek", "beta-model")).toBe(true);
    expect(addCustomModel("deepseek", "beta-model")).toBe(false);
    expect(addCustomModel("deepseek", "  beta-model  ")).toBe(false); // trim 后仍重复
    expect(addCustomModel("openai", "beta-model")).toBe(true);
    expect(getCustomModels()).toHaveLength(2);
  });

  it("removeCustomModel 只删目标项", () => {
    addCustomModel("deepseek", "m-a");
    addCustomModel("deepseek", "m-b");
    addCustomModel("openai", "m-a");
    removeCustomModel("deepseek", "m-a");
    expect(customNamesFor("deepseek")).toEqual(["m-b"]);
    expect(customNamesFor("openai")).toEqual(["m-a"]);
    expect(getCustomModels()).toHaveLength(2);
  });

  it("customNamesFor 只返回该 provider 且保持添加顺序", () => {
    addCustomModel("deepseek", "d1");
    addCustomModel("openai", "o1");
    addCustomModel("deepseek", "d2");
    expect(customNamesFor("deepseek")).toEqual(["d1", "d2"]);
    expect(customNamesFor("openai")).toEqual(["o1"]);
    expect(customNamesFor("nobody")).toEqual([]);
  });

  it("脏存储（非数组/坏条目）被过滤为合法列表", () => {
    setSettingJSON(KEY, { provider: "x" });
    expect(getCustomModels()).toEqual([]);
    setSettingJSON(KEY, [null, { provider: "deepseek", name: "" }, { provider: "", name: "m" }, { name: "no-prov" }]);
    expect(getCustomModels()).toEqual([]);
    setSettingJSON(KEY, [{ provider: "deepseek", name: "ok", addedAt: 1 }, 42]);
    expect(getCustomModels()).toEqual([{ provider: "deepseek", name: "ok", addedAt: 1 }]);
  });
});

describe("mergeCustomModels", () => {
  it("无自定义模型时原样返回（同引用）", () => {
    const stored = { deepseek: [{ id: "a", name: "a" }] };
    expect(mergeCustomModels(stored)).toBe(stored);
  });

  it("有自定义时合并进已有 provider 列表（不修改入参）", () => {
    addCustomModel("deepseek", "beta-1");
    const stored = {
      deepseek: [{ id: "deepseek-chat", name: "deepseek-chat", contextWindow: 131072 }],
    };
    const merged = mergeCustomModels(stored);
    expect(stored.deepseek).toHaveLength(1); // 入参未被修改
    expect(merged).not.toBe(stored);
    expect(merged.deepseek).toHaveLength(2);
    expect(merged.deepseek[1]).toEqual({ id: "beta-1", name: "beta-1" }); // contextWindow 留给运行时推断
  });

  it("id 或 name 与服务器模型相同则跳过（不重复）", () => {
    addCustomModel("deepseek", "deepseek-chat"); // name 与服务器 id 相同
    const stored = { deepseek: [{ id: "deepseek-chat", name: "deepseek-chat" }] };
    const merged = mergeCustomModels(stored);
    expect(merged.deepseek).toHaveLength(1);
  });

  it("provider 无列表时新建该 provider 数组", () => {
    addCustomModel("openai", "gpt-test-model");
    const merged = mergeCustomModels({ deepseek: [] });
    expect(Object.keys(merged).sort()).toEqual(["deepseek", "openai"]);
    expect(merged.openai).toEqual([{ id: "gpt-test-model", name: "gpt-test-model" }]);
  });

  it("删除自定义模型后 merge 不再出现", () => {
    addCustomModel("deepseek", "gone");
    addCustomModel("deepseek", "kept");
    removeCustomModel("deepseek", "gone");
    const merged = mergeCustomModels({});
    expect(merged.deepseek).toEqual([{ id: "kept", name: "kept" }]);
  });

  it("空/缺失存储也能合并出仅自定义 provider 的视图", () => {
    addCustomModel("mimo", "mimo-test-1");
    const merged = mergeCustomModels({});
    expect(merged.mimo).toHaveLength(1);
    expect(getSettingJSON(KEY, [])).toHaveLength(1); // 合并不写回 codem-custom-models
  });
});
