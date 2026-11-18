/**
 * v2 覆盖层的开关 + **作用域闸**（Batch 0 的核心判据）。
 *
 * ## 拼死也要有这一条的理由
 *
 * 覆盖层默认关闭，验收时打开；如果某天有人把一条选择器写成 `body { … }` 或 `.message-bubble {…}`
 * （漏了 `[data-ui="v2"]` 前缀），后果是**所有用户**的界面立刻变样，而截图对比只在验收时跑 ——
 * 这种"静默生效"正是本仓库最反对的形态。所以把"每条选择器都必须带前缀"变成判据：
 * 覆盖层里出现一条不带前缀的规则，这里立刻红，而不是等某个人打开应用才发现。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyUiLayer,
  readUiLayer,
  setStoredUiLayer,
  UI_LAYER_ATTRIBUTE,
  UI_LAYER_STORAGE_KEY,
  type UiLayerRoot,
} from "../core/theme/ui-layer";

const ROOT = join(__dirname, "..", "..");
const OVERLAY = join(ROOT, "src", "styles", "unslop-v2.css");

/** 按**顶层**逗号切选择器列表：`:is(a, b)` 里的逗号不是分隔符 */
function splitSelectorList(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of prelude) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** 极简 CSS 规则切分：返回每条规则的 prelude（选择器或 at-rule） */
function rulePreludes(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = buf.trim().replace(/\s+/g, " ");
      if (prelude) out.push(prelude);
      buf = "";
      i += 1;
      continue;
    }
    if (ch === "}" || ch === ";") {
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  return out;
}

function fakeRoot(initial: Record<string, string> = {}) {
  const attrs = new Map<string, string>(Object.entries(initial));
  const calls = { set: 0, remove: 0 };
  const root: UiLayerRoot = {
    setAttribute: (name, value) => {
      calls.set += 1;
      attrs.set(name, value);
    },
    removeAttribute: (name) => {
      calls.remove += 1;
      attrs.delete(name);
    },
    getAttribute: (name) => attrs.get(name) ?? null,
  };
  return { root, attrs, calls };
}

describe("UI 覆盖层开关（data-ui）", () => {
  it("默认档是 v1：读不到存储、没有 ?ui 时不动", () => {
    expect(readUiLayer({ storage: null, search: "" })).toBe("v1");
    expect(readUiLayer({ storage: { getItem: () => null }, search: "" })).toBe("v1");
    // 存储里是坏值也回到 v1（不能让一个拼错的值把界面切成半迁移态）
    expect(readUiLayer({ storage: { getItem: () => "V2" }, search: "" })).toBe("v1");
    expect(readUiLayer({ storage: { getItem: () => "" }, search: "" })).toBe("v1");
  });

  it("存储写 v2 就生效；?ui=v2 一次性生效且**不读也不写**存储", () => {
    expect(readUiLayer({ storage: { getItem: () => "v2" }, search: "" })).toBe("v2");
    let reads = 0;
    const storage = {
      getItem: () => {
        reads += 1;
        return null;
      },
    };
    expect(readUiLayer({ storage, search: "?ui=v2" })).toBe("v2");
    expect(reads, "?ui=v2 是 QA 覆盖，不该顺带读存储（否则行为取决于机器状态）").toBe(0);
  });

  it("applyUiLayer 只在 v2 时写属性；默认档必须是**移除**属性（关掉 = 与未引入一致）", () => {
    const v2 = fakeRoot();
    applyUiLayer(v2.root, "v2");
    expect(v2.attrs.get(UI_LAYER_ATTRIBUTE)).toBe("v2");

    const v1 = fakeRoot({ [UI_LAYER_ATTRIBUTE]: "v2" });
    applyUiLayer(v1.root, "v1");
    expect(v1.attrs.has(UI_LAYER_ATTRIBUTE)).toBe(false);
  });

  it("幂等：值没变时不碰 DOM（避免每次启动都触发一次属性变更）", () => {
    const a = fakeRoot({ [UI_LAYER_ATTRIBUTE]: "v2" });
    applyUiLayer(a.root, "v2");
    expect(a.calls.set, "已经是 v2 还重复 setAttribute").toBe(0);

    const b = fakeRoot();
    applyUiLayer(b.root, "v1");
    expect(b.calls.remove, "本来就没有属性还 removeAttribute").toBe(0);
  });

  it("setStoredUiLayer 写/清持久档", () => {
    const store = new Map<string, string>();
    const storage = {
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    setStoredUiLayer("v2", storage);
    expect(store.get(UI_LAYER_STORAGE_KEY)).toBe("v2");
    setStoredUiLayer("v1", storage);
    expect(store.has(UI_LAYER_STORAGE_KEY)).toBe(false);
  });
});

describe("v2 覆盖层的作用域闸", () => {
  const css = readFileSync(OVERLAY, "utf8");

  it("覆盖层不是空文件（否则下面的闸是空转）", () => {
    const rules = rulePreludes(css).filter((p) => !p.startsWith("@"));
    expect(rules.length, "unslop-v2.css 里一条规则都没有 —— 作用域闸会变成空转").toBeGreaterThan(0);
  });

  it("选择器切分不把 :is(a, b) 里的逗号当分隔符（否则作用域闸会假红）", () => {
    expect(splitSelectorList('[data-ui="v2"] .a:is(:hover, :focus-visible)')).toEqual(['[data-ui="v2"] .a:is(:hover, :focus-visible)']);
    expect(splitSelectorList('[data-ui="v2"] .a, [data-ui="v2"] .b')).toEqual(['[data-ui="v2"] .a', '[data-ui="v2"] .b']);
  });

  it("每一条选择器都必须以 [data-ui=\"v2\"] 开头", () => {
    const offenders = rulePreludes(css)
      .filter((prelude) => !prelude.startsWith("@"))
      .flatMap((prelude) => splitSelectorList(prelude))
      .filter((selector) => selector.length > 0 && !selector.startsWith('[data-ui="v2"]'));
    expect(
      offenders,
      `这些选择器没带 [data-ui="v2"] 前缀，会在**默认档**下生效（覆盖层默认关闭必须等于没引入）：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("覆盖层不许写死颜色（颜色只能来自令牌）", () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const literals = body.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? [];
    expect(literals, "覆盖层出现颜色字面量；请改为 var(--ui-*) 或 color-mix(… var(--…))").toEqual([]);
  });
});
