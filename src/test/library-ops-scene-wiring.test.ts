/**
 * LO-WIRING —— **每个渲染场景的地方都必须把 `onSelectZone` 接上**（回归）。
 *
 * ## 真机背景（这是"看起来能点、实际不响应"这一类缺陷的第 2 次出现）
 *
 * `PixelLibraryScene` / `LibraryScene` 的 `onSelectZone` 是**可选 prop**。可选 prop 的危险是
 * 漏传时 TypeScript **不报错**，而组件内部已经给房间/岗位热区加上了
 * `role="button"` + `tabIndex={0}` + `cursor:pointer` —— 界面明确承诺"这里可以点"，
 * 点击却什么都不发生。
 *
 *  - 第 1 次：`LibraryPanel`（馆内页签）两个场景都漏传（真机 1.16.112 实测：房间里命中归属
 *    修好之后，点击仍然不选中任何岗位）；
 *  - 第 2 次：`OverviewPanel`（概览页签）的「场景实况」大卡只传了 `onSelectActor`
 *    —— 同一处漏接线在另一个面板里原样复现（概览页里那是唯一能直接点角色的入口）。
 *
 * 两次都是"人去看才发现"，所以这里把它变成**结构性判据**：
 * 插件目录里凡出现 `<PixelLibraryScene` / `<LibraryScene` 的地方，该处 JSX 必须传 `onSelectZone`。
 *
 * ## 为什么用静态扫描而不是渲染测试
 *
 * 渲染测试只能证明"传了 prop 的组件会回调"（`library-ops-pixel-hit-area.test.tsx` 已经钉住了），
 * **测不到"面板有没有传"** —— 那正是缺陷所在的那一层。
 * 扫描的代价是它会因为写法变化而失败（例如多行属性、改名），所以下面同时钉了
 * **控制组**（必须先扫到 2 个文件 4 个调用点），避免"扫到 0 处 → 全部通过"的假绿。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src", "plugins", "library-ops");

/** 递归收集 `.tsx`（插件自己的组件目录；测试文件在 src/test，不在这里） */
function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectTsx(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * 抽出一个 JSX 开标签的文本。
 *
 * 用大括号配平来跨过 `{...}` 里的对象/箭头函数，遇到"大括号深度为 0 时的 `>`"才算标签结束 ——
 * 否则 `initialScene={(x as SceneState | null) ?? undefined}` 里的 `>`（联合类型）
 * 会被误判成标签结尾，扫描就会漏掉后面的属性（第一版扫描的坑）。
 */
function openTagAt(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

const sites = collectTsx(ROOT).flatMap((file) => {
  const src = readFileSync(file, "utf8");
  const found: Array<{ file: string; tag: string; hasZone: boolean }> = [];
  const re = /<(PixelLibraryScene|LibraryScene)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = openTagAt(src, m.index);
    found.push({ file: relative(ROOT, file).replace(/\\/g, "/"), tag, hasZone: /\bonSelectZone\s*=/.test(tag) });
  }
  return found;
});

describe("LO-WIRING 场景组件的可选 prop 必须真的接上", () => {
  it("LO-WIRING-0（控制组）：扫描必须真的扫到场景调用点，否则本文件测的是空", () => {
    expect(sites.length, "插件里应当有 4 处场景调用（2 个面板 × pixel/iso 各一）").toBe(4);
    expect([...new Set(sites.map((s) => s.file))].sort()).toEqual([
      "components/monitor/LibraryPanel.tsx",
      "components/monitor/OverviewPanel.tsx",
    ]);
  });

  it("LO-WIRING-1：每一处都必须传 onSelectZone（两个面板都已修，不许回退）", () => {
    const missing = sites.filter((s) => !s.hasZone).map((s) => `${s.file}: ${s.tag.slice(0, 60)}…`);
    expect(
      missing,
      "房间/岗位热区带 role=button + tabIndex + cursor:pointer，漏传 onSelectZone = 点了没反应的可点击控件",
    ).toEqual([]);
  });

  it("LO-WIRING-2：每一处也都必须传 onSelectActor（角色点击同样不许漏）", () => {
    const missing = sites.filter((s) => !/\bonSelectActor\s*=/.test(s.tag)).map((s) => s.file);
    expect(missing).toEqual([]);
  });

  it("LO-WIRING-3：面板接的是 store 的 selectZone（不是自造的空函数）", () => {
    for (const rel of ["components/monitor/LibraryPanel.tsx", "components/monitor/OverviewPanel.tsx"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} 应当从 store 取 selectZone`).toMatch(/useLibraryOps\(\(s\) => s\.selectZone\)/);
      expect(src, `${rel} 应当把它传给场景`).toMatch(/onSelectZone=\{selectZone\}/);
    }
  });
});
