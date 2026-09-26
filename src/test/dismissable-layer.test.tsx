/**
 * useDismissableLayer 的行为用例（第 173 轮 P2-6）。
 *
 * 每一条都对着"手写版没写的那件事"来：
 *   ESC-1 Escape 触发关闭；
 *   ESC-2 `open: false` 时不响应（还没打开 / 已经关掉）；
 *   ESC-3 **两层叠着时只关最上面那一层**（手写版 22 份里没有一份处理过这件事）；
 *   ESC-4 关闭后焦点**还给打开它的那个元素**（手写版普遍把焦点丢在 body）；
 *   ESC-5 `inertBackground` 会给 #root 加/去 `inert`；
 *   ESC-6 非 Escape 按键不触发（别把任何按键都当关闭）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { useDismissableLayer } from "../hooks/useDismissableLayer";

function Layer({
  open = true,
  onDismiss,
  restoreFocus = true,
  inertBackground = false,
  label = "layer",
}: {
  open?: boolean;
  onDismiss: () => void;
  restoreFocus?: boolean;
  inertBackground?: boolean;
  label?: string;
}) {
  useDismissableLayer({ open, onDismiss, restoreFocus, inertBackground });
  return <div data-testid={label} />;
}

/** 发一个 keydown（document 级监听就是靠这个触发的） */
function pressEscape(target: EventTarget = document) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}
function pressKey(key: string) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("useDismissableLayer", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });
  afterEach(() => {
    cleanup();
    root.remove();
  });

  it("ESC-1：Escape 触发 onDismiss", () => {
    const onDismiss = vi.fn();
    render(<Layer onDismiss={onDismiss} />);
    pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ESC-2：open:false 时不响应", () => {
    const onDismiss = vi.fn();
    render(<Layer open={false} onDismiss={onDismiss} />);
    pressEscape();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("ESC-3：两层叠着时只有最上面那层响应（这是手写版从没处理过的一条）", () => {
    const bottom = vi.fn();
    const top = vi.fn();
    const { rerender } = render(<Layer label="bottom" onDismiss={bottom} />);
    rerender(
      <>
        <Layer label="bottom" onDismiss={bottom} />
        <Layer label="top" onDismiss={top} />
      </>,
    );
    pressEscape();
    expect(top, "后打开的那层应该关掉").toHaveBeenCalledTimes(1);
    expect(bottom, "下层不该被 Esc 关掉").not.toHaveBeenCalled();
  });

  it("ESC-4：关闭后焦点还给打开它的元素", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开浮层";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const onDismiss = vi.fn();
    /* 焦点在**浮层内部**的元素上（真实场景：浮层里有个输入框自动聚焦）。
       卸载时这个输入框跟着浮层一起被移除 ⇒ activeElement 落回 body ⇒ hook 兜底还原。
       （第一版把输入框挂在 body 上、卸载后它还在文档里，焦点自然没回到触发器 —— 那是**测试不真实**，
       不是 hook 的问题；同时也暴露了"只在没人接管焦点时才归还"这条规则的必要性。） */
    const { unmount, getByTestId } = render(<Layer onDismiss={onDismiss} />);
    const inside = getByTestId("layer");
    inside.tabIndex = 0;
    inside.focus();
    expect(document.activeElement).toBe(inside);
    unmount();
    expect(document.activeElement, "关闭后应回到触发它的按钮上，而不是 body").toBe(trigger);
    trigger.remove();
  });

  it("ESC-5：inertBackground 会给 #root 加 inert、关闭后去掉", () => {
    const { unmount } = render(<Layer inertBackground onDismiss={() => {}} />);
    expect(root.hasAttribute("inert"), "打开期间背景应该是 inert 的").toBe(true);
    unmount();
    expect(root.hasAttribute("inert"), "关闭后必须去掉（否则整个应用都点不动了）").toBe(false);
  });

  it("ESC-7：**浮层自己 autofocus** 时也要记住打开前的焦点（1.16.173 装机复核抓到的真问题）", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开浮层";
    document.body.appendChild(trigger);
    trigger.focus();

    /* 模拟 SearchDialog：组件里先写自己的 `useEffect(() => input.focus())`，再调用本 hook ——
       被动 effect 按注册顺序执行，所以"记上一个焦点"如果也放在被动 effect 里，
       拿到的会是浮层里的输入框（它的 autofocus 先跑），关闭时那个输入框已经随浮层移除 ⇒
       焦点回不去（装机版实测：SearchDialog 关掉后焦点落在 body）。 */
    function AutofocusLayer({ onDismiss }: { onDismiss: () => void }) {
      const inputRef = useRef<HTMLInputElement | null>(null);
      useEffect(() => {
        inputRef.current?.focus();
      }, []);
      useDismissableLayer({ onDismiss });
      return <input ref={inputRef} data-testid="auto" />;
    }

    const { unmount, getByTestId } = render(<AutofocusLayer onDismiss={() => {}} />);
    expect(document.activeElement, "浮层里的输入框应该已经自动聚焦").toBe(getByTestId("auto"));
    unmount();
    expect(document.activeElement, "关闭后必须回到触发器，而不是 body").toBe(trigger);
    trigger.remove();
  });

  it("ESC-6：非 Escape 按键不触发关闭", () => {
    const onDismiss = vi.fn();
    render(<Layer onDismiss={onDismiss} />);
    pressKey("Enter");
    pressKey("a");
    pressKey("Tab");
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

/**
 * OVERLAY-1：浮层关闭必须走唯一实现（第 173 轮 P2-6）。
 *
 * 依据（实测，见 `.preview-shot/_measure-overlays.mjs`）：全仓 **22 处**手写 `Escape`
 * （方案里写的是 14 处）。逐条看下来是两族：
 *   A. **document/window 级的浮层关闭**（纯 Escape）—— 本轮全部迁到 `useDismissableLayer`，**现在是 0 处**；
 *   B. 元素级 `onKeyDown` 里的一个分支（输入框 Enter/Esc、菜单方向键导航、画布 Esc 取消选择）——
 *      那是**元素自己的按键语义**，搬到 document 级反而是错的，**按名字白名单保留**。
 *
 * 判据（都可机检）：
 * ① `useDismissableLayer` 存在且被 **≥8 个文件**采用（迁移面够宽）；
 * ② **document/window 级 `keydown` 监听里不许再出现 Escape**（白名单只放：hook 自身、
 *    两处"注释里在讲这个约定"、一处生成 HTML 的模板字符串）；
 * ③ 棘轮：`Escape` 字样总数只许降（口径 = 同时含 `Escape` 与 `key|Key` 的行数；本轮 22 → 18）。
 * 变异：把某处的 hook 换回手写监听 / 把 hook 调用删掉 ⇒ ②③ 必须红。
 */
describe("OVERLAY-1：浮层关闭的唯一实现", () => {
  const ROOT = process.cwd();
  const SRC = path.join(ROOT, "src");

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "test") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(full);
    }
    return out;
  }

  const ALLOW_ESCAPE_IN_LISTENER = [
    "src/hooks/useDismissableLayer.ts",   // 它就是那个唯一实现（注释里必然出现 Escape）
    "src/components/InputArea.tsx",       // 注释里在说明"Escape 由各自的 handler 处理"
    "src/components/McpMarketplace.tsx",  // 注释里在引用这个约定
    "src/components/ppt/PPTEditor.tsx",   // 生成 HTML 的模板字符串里含 Escape 字样
  ];

  it("OVERLAY-1a：hook 存在且被 ≥8 个文件采用", () => {
    const hookPath = path.join(SRC, "hooks/useDismissableLayer.ts");
    expect(existsSync(hookPath), "找不到 useDismissableLayer 的实现").toBe(true);
    const hookSrc = readFileSync(hookPath, "utf8");
    expect(/export function useDismissableLayer/.test(hookSrc), "hook 没有导出 useDismissableLayer").toBe(true);
    /* 只关最上层：模块级栈是这条能力的实现方式，缺了它两层叠着时会被一起关掉 */
    /* 只关最上层：模块级栈 + "比对自己是不是最后一个"的守卫，两样都得在。
       ⚠️ 第一版只断言 `/layerStack/` —— 变异把**声明**改名成 `layerStackRemoved` 照样通过
       （子串仍在，且别处还在用它）；第二版断言 `\blayerStack\b` 也还不够：要求**守卫那一行**在。 */
    expect(/\blayerStack\b[^\n]*\.push\(/.test(hookSrc), "hook 没有把当前层压进栈（没法判断谁在最上面）").toBe(true);
    expect(/layerStack\[\s*layerStack\.length\s*-\s*1\s*\]\s*!==\s*id\s*\)\s*return/.test(hookSrc),
      "hook 缺少「只关最上层」的守卫 —— 两层叠着按 Esc 会把下面那层也关掉").toBe(true);

    const users = walk(SRC).filter((f) => /useDismissableLayer/.test(readFileSync(f, "utf8")) && !/useDismissableLayer\.ts$/.test(f));
    const rels = users.map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
    expect(rels.length, `只有 ${rels.length} 个文件用了 hook（迁移面不足）：${rels.join(" ")}`).toBeGreaterThanOrEqual(8);
  });

  it("OVERLAY-1b：document/window 级的 keydown 里不许再手写 Escape", () => {
    /*
     * ⚠️ 口径细节（三次假结果换来的，值得写下来）：
     * ① 必须**配对到那个回调本身**，不能"注册点前后 12 行里有没有 Escape"——
     *    后者会把同文件里**别的**函数里的 Escape 也算进来（第一版报了一堆假红）；
     * ② 回调**通常定义在注册之前**（`const h = …; addEventListener("keydown", h)`），
     *    所以必须顺着**回调名**去找定义；
     * ③ 只有**纯 Escape 关闭**才算违规：像 PPT 演示、画布、搜索框这些 handler
     *    是**键盘导航/画布语义**（方向键、Enter、Home/End…），Escape 只是其中一个分支 ——
     *    把它们搬到 document 级 hook 反而是错的。判据：回调体里除了 Escape 还处理别的键 ⇒ 放行。
     */
    const bad: string[] = [];
    for (const full of walk(SRC)) {
      const rel = path.relative(ROOT, full).replace(/\\/g, "/");
      if (ALLOW_ESCAPE_IN_LISTENER.includes(rel)) continue;
      const lines = readFileSync(full, "utf8").split(/\r?\n/);
      lines.forEach((l, i) => {
        const m = /addEventListener\(\s*["']keydown["']\s*,\s*([A-Za-z_$][\w$]*)/.exec(l);
        if (!m) return;
        const name = m[1];
        const defIdx = lines.findIndex((dl) => new RegExp(`(const|let|var|function)\\s+${name}\\b`).test(dl));
        if (defIdx < 0) return; // 定义在别处（内联箭头函数等）⇒ 无法判定，不误报
        let end = Math.min(lines.length, defIdx + 40);
        for (let k = defIdx; k < end; k++) {
          if (/^\s*\};\s*$/.test(lines[k]) || /^\s*\}\s*$/.test(lines[k])) { end = k + 1; break; }
        }
        const body = lines.slice(defIdx, end).join("\n");
        if (!/Escape/.test(body)) return;
        /* 这个回调还处理了哪些键？（`e.key === "X"` / `case 'X':` / `['X'].includes(e.key)`） */
        const otherKeys = new Set<string>();
        for (const km of body.matchAll(/(?:\.key\s*===\s*["']([^"']+)["']|case\s+["']([^"']+)["']|\[([^\]]*)\]\.includes\(\s*\w+\.key)/g)) {
          const raw = km[1] ?? km[2] ?? km[3] ?? "";
          for (const part of raw.split(",")) {
            const key = part.trim().replace(/^["']|["']$/g, "");
            if (key && key !== "Escape") otherKeys.add(key);
          }
        }
        if (otherKeys.size > 0) return; // 导航/语义 handler：Escape 只是其中一支
        bad.push(`${rel}:${i + 1}（回调 ${name} 定义在 ${defIdx + 1} 行，且只处理 Escape）`);
      });
    }
    expect(bad,
      "这些文件又自己写 document/window 级的 Escape 关闭了（请用 useDismissableLayer —— 它会顺带给你"
      + "「只关最上层」和「关闭后焦点归还」）：\n  - " + bad.join("\n  - "),
    ).toEqual([]);
  });

  it("OVERLAY-1c：棘轮 —— Escape 字样只许降", () => {
    /* 口径：同时含 `Escape` 与 `key`/`Key` 的**行数**（注释与模板串也算，口径固定才好复现）。
       迁移前实测 **22**，迁移后 **16**（`.preview-shot/_count-escape-lines.mjs` 逐行列出）。
       ⚠️ 基线必须用**门禁自己这套口径**数出来的数（16），不是"手写监听还剩几处"（0）——
       两个数指的不是一个东西，混用会让棘轮永远不响（第一版写成 18 就是这种情况）。 */
    const BASELINE = 16;
    let total = 0;
    for (const full of walk(SRC)) {
      for (const l of readFileSync(full, "utf8").split(/\r?\n/)) {
        if (/Escape/.test(l) && /key|Key/.test(l)) total++;
      }
    }
    expect(total, `Escape 相关行数 ${total} 超过基线 ${BASELINE}（新写的浮层请走 useDismissableLayer）`).toBeLessThanOrEqual(BASELINE);
  });
});

/**
 * PORTAL-1：**浮层的挂载入口只有一个**（第 180 轮 P2-6 收口）。
 *
 * ## 依据（方案实测）
 *
 * `createPortal` 手写 **48 处 / 21 个生产文件**，每个文件自己 `import { createPortal } from "react-dom"`
 * 再自己决定往哪儿挂（实测量过：**21 处全是 `document.body`**，只有 `SelectionTooltip`
 * 用 `containerRef.current || document.body`）。代价有三条，都不是"代码不好看"：
 * ① 容器策略散在 21 个文件里 —— 改一次要动 21 处；
 * ② 门禁**无法回答**"新浮层有没有走共享层"，因为共享层根本不存在；
 * ③ 无 DOM 环境要各自判断，而今天没人判断（只是碰巧都在浏览器里跑）。
 *
 * ## 判据
 *
 * ① 共享入口 `src/components/ui/portal.ts` 存在，且**只有它**从 `react-dom` 取 `createPortal`；
 * ② 它必须默认 `document.body`、且在没有 `document` 时**安全返回 null**（不是抛错）；
 * ③ 生产文件里**不再有**"把 `document.body` 当容器实参显式传"的调用（那是冗余，默认值就是它）；
 * ④ 自定义宿主仍然允许（`SelectionTooltip` 那种），但必须从共享入口传 `container`。
 *
 * 变异：把某个文件的 import 改回 `react-dom` / 把 `document.body` 塞回某个调用 ⇒ 必红。
 */
describe("PORTAL-1：浮层挂载入口的唯一实现", () => {
  const ROOT = process.cwd();
  const SRC = path.join(ROOT, "src");
  const SHARED = "src/components/ui/portal.ts";

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "test") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(full);
    }
    return out;
  }
  const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");

  it("PORTAL-1a：共享入口存在，且只有它从 react-dom 拿 createPortal", () => {
    const sharedPath = path.join(ROOT, SHARED);
    expect(existsSync(sharedPath), `找不到共享入口 ${SHARED}`).toBe(true);
    const src = readFileSync(sharedPath, "utf8");
    expect(/createPortal\s+as\s+reactCreatePortal/.test(src),
      "共享入口必须从 react-dom 取 createPortal（并起个别名，避免与自己同名）").toBe(true);
    /* 默认宿主 */
    expect(/container\s*\?\?\s*document\.body/.test(src),
      "共享入口必须默认挂到 document.body（今天 21 处全是它）").toBe(true);
    /* 无 DOM 时安全返回 null —— 与 React 自己会抛错不同，这是本仓库的选择，要有断言钉住 */
    expect(/typeof document\s*===\s*["']undefined["']\s*\)\s*return null/.test(src),
      "共享入口在无 document 时必须安全返回 null（而不是让整页崩掉）").toBe(true);

    const offenders: string[] = [];
    for (const full of walk(SRC)) {
      const r = rel(full);
      if (r === SHARED) continue;
      const text = readFileSync(full, "utf8");
      /* 只看**代码**：注释里提到 react-dom 是允许的（本文件的文档块就提到了） */
      const code = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, " ");
      if (/import\s*\{[^}]*createPortal[^}]*\}\s*from\s*["']react-dom["']/.test(code)) {
        offenders.push(`${r}（请改成 from "${path.relative(path.dirname(full), path.join(ROOT, "src/components/ui/portal")).replace(/\\/g, "/")}"）`);
      }
    }
    expect(offenders,
      "这些文件又直接从 react-dom 取 createPortal 了（浮层必须走共享入口）：\n  - " + offenders.join("\n  - "),
    ).toEqual([]);
  });

  it("PORTAL-1b：不再把 document.body 当容器实参显式传（默认值就是它）", () => {
    const offenders: string[] = [];
    for (const full of walk(SRC)) {
      const r = rel(full);
      if (r === SHARED) continue;
      const code = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, " ");
      /* 口径：`createPortal(` … `, document.body)` 的**最后一个实参恰好是 document.body**。
         用字符扫描找配对括号（正则数括号必然数错：JSX 里 `onClick={() => x()}` 很常见）。 */
      let idx = 0;
      while ((idx = code.indexOf("createPortal(", idx)) >= 0) {
        const open = idx + "createPortal".length;
        let depth = 0, end = -1;
        for (let i = open; i < code.length; i++) {
          const c = code[i];
          if (c === "(" || c === "[" || c === "{") depth++;
          else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) break;
        const body = code.slice(open + 1, end);
        let d2 = 0, lastComma = -1;
        for (let i = 0; i < body.length; i++) {
          const c = body[i];
          if (c === "(" || c === "[" || c === "{") d2++;
          else if (c === ")" || c === "]" || c === "}") d2--;
          else if (c === "," && d2 === 0) lastComma = i;
        }
        if (lastComma >= 0 && body.slice(lastComma + 1).trim() === "document.body") {
          offenders.push(`${r}（createPortal 的容器实参是 document.body —— 删掉它，默认就是）`);
        }
        idx = end;
      }
    }
    expect(offenders, offenders.length ? "这些调用还显式传了 document.body：\n  - " + offenders.join("\n  - ") : "").toEqual([]);
  });
});
