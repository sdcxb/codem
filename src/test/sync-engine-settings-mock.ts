/**
 * `sync-engine.test.ts` 专用的 settings mock（把"库 + vi.mock 注册"放在**同一个模块**里）。
 *
 * ## 为什么单独一个文件，而不是写在用例文件里
 *
 * 用例文件里的 `vi.mock` 工厂**不能引用该文件的顶层变量**（`const mockStore = new Map()`
 * 在被提到顶部的工厂里是 TDZ：实测 `ReferenceError: Cannot access 'mockStore' before initialization`）。
 * 而 `sync-engine.test.ts` 的每条用例都要先 `mockStore.clear()`、并且断言读的是同一份库 ——
 * 所以"库"与"注册"必须写在同一个模块里（这里），再由用例文件 import 进来：
 * 被 import 模块里的 `vi.mock` 同样会被 vitest 提升生效（本仓实测通过）。
 *
 * 语义全部来自共享基座 `./settings-mock`（单一实现，见那里的文件头）——
 * 本文件**一个导出都不自己实现**，包括 `mergeDefaults`（第 181 波 T-2 那条）：
 * 基座里那份就是 `settings.ts` 的同语义实现。
 */
import { vi } from "vitest";
import { createSettingsMock } from "./settings-mock";

/** 本用例文件的"设置表"：mock 与断言共用同一份 */
export const mockStore = new Map<string, string>();

const mock = createSettingsMock({ store: { raw: mockStore } });

vi.mock("../core/storage/settings", () => mock);
