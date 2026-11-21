/**
 * 第 17 轮：同一个插件不许被装配两次。
 *
 * 线上实例：dsh-compat 同时出现在 config/codem.base.yml 与 App.tsx 的直接 ctx.plugin；
 * 第二个 fiber 的 provide 会抛 "service ... has been registered"，被 Cordis 吞成 FAILED，
 * 而 disable 只能卸载 YAML 那个 fiber。这里用源码对账钉住（零例外，不靠运行时偶然）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const yaml = readFileSync("config/codem.base.yml", "utf8");
const app = readFileSync("src/App.tsx", "utf8");

describe("PLUGIN-17：单次装配", () => {
  it("dsh-compat 只在 YAML 装配一次，App 不再直接 ctx.plugin", () => {
    expect(yaml).toMatch(/- id: dsh-compat/);
    expect(app).not.toMatch(/ctx\.plugin\(\s*dshCompatPlugin/);
    expect(app).not.toMatch(/from "\.\/core\/dsh-compat\/index\.ts"/);
  });
});
