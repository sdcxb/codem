/**
 * PPT 技能收集器在**非 Vite 宿主**下不许炸（PPT-GLOB-1）。
 *
 * 背景（真事故，见 ADR-0001 §4.1）：`ppt-skill-registry.ts` 在**模块求值阶段**调用
 * `import.meta.glob`。它是 Vite 专属 API，在 Node（`codem-host`）里是 `undefined`，
 * 直接调用会抛 `TypeError: (intermediate value).glob is not a function`。
 * 而本文件位于 `tools.ts → generate-ppt → ppt-generator → 本文件` 这条**静态**导入链上，
 * 于是一个 PPT 技能表能把**整个 agent 循环**带走（症状看起来像"Host 不支持 PPT"）。
 *
 * 修法是 try/catch 包住**字面量调用**：Vite 仍在构建期把它替换成对象字面量（Web 行为不变），
 * Node 里退化成空表。这条判据在 vitest（Vite 环境）里跑，断言的是"**Vite 路径没被改坏**"；
 * Node 路径由 `packages/host/scripts/spike-a.mjs` 真实执行证明。
 */
import { describe, expect, it } from "vitest";

import { registerOhMyPptSkills } from "../../src/core/knowledge/ppt-skill-registry";

describe("PPT-GLOB-1 技能收集", () => {
  it("在 Vite 环境下仍能收集到内置风格技能（非空）", () => {
    const registeredNames: string[] = [];
    const count = registerOhMyPptSkills({
      register: (skill) => {
        registeredNames.push(skill.name);
      },
      get: () => undefined,
    });
    // 仓库里自带 76 个风格 + 4 个产品技能；这里不钉死具体数字（会随资源增删），
    // 只要求"确实收集到了"，否则说明 glob 被 try/catch 吞成了空表。
    expect(count).toBeGreaterThan(0);
    expect(registeredNames.some((n) => n.startsWith("ppt-style-"))).toBe(true);
  });

  it("幂等：重复注册返回 0，不会重复塞技能", () => {
    const seen: string[] = [];
    registerOhMyPptSkills({ register: (s) => seen.push(s.name), get: () => undefined });
    const second = registerOhMyPptSkills({ register: (s) => seen.push(s.name), get: () => undefined });
    expect(second).toBe(0);
  });
});
