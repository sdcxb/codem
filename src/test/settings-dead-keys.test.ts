/**
 * 设置「死键 / 假成功」回归契约（第 45 轮：D-2/3/4/5/8/9/10/11/12/18/21/23）。
 *
 * ## 为什么单独一个文件
 *
 * `.preview-shot/_audit/SETTINGS-LOOP.md` 的教训是：**只看"有没有 getSetting 调用"判不出死设置**。
 * 现有的 `settings-keys-symmetry.test.ts`（SKEY-1..4）只对账"键有没有读写方"，
 * `settings-effect.test.ts`（SKEY-E1..E3）只对账"键名与调用形状" —— 这两类断言恰好把 D-1
 * 那种 bug（写 JSON、读裸串）**钉成了契约**。所以这里的每条用例都尽量断言**值形状往返**
 * （写进去的类型/单位与读出来、被消费的一致），而不是"某函数被调用过"。
 *
 * 用例命名 `SKEY-D<n>-<i>` 对应审计条目编号。
 *
 * ## 读代码时注意
 *
 * 被测的新 API 一律用 `await import(...)` 在**用例内部**取，而不是文件顶部静态 import ——
 * 这样"改前会红"的取证可以逐个条目做：把某一个源文件换成 `git show HEAD:<path>` 的旧版后，
 * 只有该条目对应的用例会红，其他条目不受 import 解析失败牵连。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { render, cleanup, fireEvent, renderHook, waitFor, act } from "@testing-library/react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { getSetting, setSetting, setSettingJSON, getSettingJSON } from "../core/storage/settings";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** 读源码并剥掉注释：本仓库的注释里大量逐字引用被修掉的坏写法，不剥注释会把自己绊倒 */
const readCode = (rel: string) => stripComments(read(rel));

/** 递归列出 `src` 下的源码文件（与 settings-effect.test.ts 同一口径） */
function walkSrc(dir = join(ROOT, "src"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "target", ".git", "__snapshots__"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSrc(full, out);
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 只读 grep：统计 `var(--x` 的消费方（用于证明"生效点真的有人消费"）。
 *
 * 两条纪律：
 * - **先剥注释**：本仓库的注释里会逐字引用被修掉的坏写法（否则测试自己就是"消费方"）；
 * - **跳过 `src/test/`**：测试里的引用不能算"应用会消费"（与 `settings-effect.test.ts` 同口径）。
 */
function varConsumers(varName: string): { count: number; hits: string[] } {
  const hits: string[] = [];
  let count = 0;
  for (const file of walkSrc()) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel.startsWith("src/test/")) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    for (const line of src.split("\n")) {
      // 令牌**定义**行不算消费方（`--font-ui: …` 里没有 var(）
      const matches = line.match(new RegExp(`var\\(\\s*${varName.replace(/[-]/g, "\\-")}`, "g"));
      if (!matches) continue;
      count += matches.length;
      hits.push(`${rel}:${line.trim().slice(0, 80)}`);
    }
  }
  return { count, hits };
}

beforeEach(() => {
  resetPersistFailures();
});

// ==========================================================================
// D-2 语言：首帧读不到 ≠ 用户选了默认值
// ==========================================================================

describe("D-2 codem-language 断链（首帧缓存默认值）", () => {
  /**
   * ⚠️ 这条用例**必须在本文件最先跑**：`cachedLang` 一旦被写值就只在 `setLang` 处重赋值
   * （这正是缺陷本身）。它验证的是"先无端口首帧、后端口就绪"这个真实启动顺序。
   */
  it("SKEY-D2-1: 端口未注册时不缓存默认值；端口就绪后语言自愈并广播", async () => {
    const { getLang, setLang } = await import("../core/i18n/lang");

    // ① 模拟 App 首帧：存储端口还没注册（真实顺序：useEffect 里异步 registerRustStoragePort）
    setStoragePort(null);
    const seen: string[] = [];
    const onChange = () => seen.push("codem-language-changed");
    window.addEventListener("codem-language-changed", onChange);
    try {
      // 读不到 ⇒ 暂用默认值，但**绝不能**把它当"用户的选择"缓存下来
      expect(getLang()).toBe("zh");

      // ② 端口注册（真实实现先 warmup 再注册，所以注册后读到的一定是库里的真值）
      const port = createFakeStoragePort();
      port.config.set("codem-language", "en"); // 用户上次选的是英文
      setStoragePort(port);

      // 值形状往返：库里存的是字符串 "en"，读出来必须也是 "en"（而不是被首帧默认值钉死）
      expect(getLang(), "端口刚就绪时就必须读到真值").toBe("en");

      // ③ 界面必须能跟上：重同步要广播事件（useLang() 靠它重渲染）
      await waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 1500 });

      // ④ 缓存里落的是真值（后续 getLang 不再依赖定时器）
      expect(getLang()).toBe("en");
    } finally {
      window.removeEventListener("codem-language-changed", onChange);
      setLang("zh"); // 复位模块缓存，避免污染后续用例
    }
  });
});

// ==========================================================================
// D-3 全局字体：生效点是 --font-ui
// ==========================================================================

describe("D-3 codem-font-family 无生效点", () => {
  it("SKEY-D3-1: 字体写在 --font-ui（有消费方），默认档 removeProperty 保住 fallback 栈", async () => {
    const { applyUiFontFamily, applyStoredUiFontFamily, readStoredUiFontFamily, DEFAULT_FONT_FAMILY } =
      await import("../core/ui-font");
    const root = document.documentElement;

    // ① 生效点确实有消费方（只读 grep）：--font-ui 必须有人 var() 引用
    const ui = varConsumers("--font-ui");
    expect(ui.count, `var(--font-ui 的消费方计数：${ui.count}\n${ui.hits.join("\n")}`).toBeGreaterThan(0);
    expect(ui.hits.some((h) => h.startsWith("src/styles.css"))).toBe(true);
    // ② 反向：旧写法写的那个变量全项目没有任何消费方（它只是给外部插件留的别名）
    const legacy = varConsumers("--font-family");
    expect(legacy.count, `var(--font-family 不该有消费方：\n${legacy.hits.join("\n")}`).toBe(0);

    // ③ 值形状往返：设置里的字体串 → CSS 变量 → 被 CSS 消费
    applyUiFontFamily("Georgia, serif");
    expect(root.style.getPropertyValue("--font-ui")).toBe("Georgia, serif");
    // 默认档：**删掉行内覆盖**（而不是写一个裸字体名把整条 fallback 栈覆盖掉）
    applyUiFontFamily(DEFAULT_FONT_FAMILY);
    expect(root.style.getPropertyValue("--font-ui")).toBe("");

    // ④ 启动路径：读库里的值（默认档 → 没有行内覆盖）
    setSetting("codem-font-family", "Inter, sans-serif");
    expect(applyStoredUiFontFamily()).toBe("Inter, sans-serif");
    expect(root.style.getPropertyValue("--font-ui")).toBe("Inter, sans-serif");
    setSetting("codem-font-family", DEFAULT_FONT_FAMILY);
    expect(readStoredUiFontFamily()).toBe(DEFAULT_FONT_FAMILY);
    applyStoredUiFontFamily();
    expect(root.style.getPropertyValue("--font-ui")).toBe("");
  });

  it("SKEY-D3-2: styles.css 的默认字体栈有唯一定义处，两个写入方都不再写没人读的 --font-family", () => {
    const css = read("src/styles.css");
    // 默认栈提到 token 里，默认档 = "没有行内覆盖"
    expect(css, "--font-ui 应引用默认栈令牌").toMatch(/--font-ui:\s*var\(--font-ui-default\)/);
    expect(css, "默认栈令牌本身必须存在").toMatch(/--font-ui-default:\s*'AlimamaFangYuanTi'/);

    const panel = readCode("src/components/SettingsPanel.tsx");
    const sidebar = readCode("src/components/Sidebar.tsx");
    // ① 反向（本条的病灶本体）：两个写入方都不得再往"全项目 0 处消费"的 --font-family 上写值
    expect(panel, "设置页不得再写无消费方的 --font-family").not.toMatch(/setProperty\(\s*"--font-family"/);
    expect(sidebar, "侧栏不得再写无消费方的 --font-family").not.toMatch(/setProperty\(\s*"--font-family"/);
    // ② 正向：都走统一入口（写 --font-ui）
    expect(panel, "设置页应走统一入口").toMatch(/applyUiFontFamily\(/);
    expect(sidebar, "侧栏重启回读应走同一入口").toMatch(/applyStoredUiFontFamily\(\)/);
  });
});

// ==========================================================================
// D-4 窗口状态：成对的物理坐标
// ==========================================================================

describe("D-4 codem-window-state 恢复载荷形状", () => {
  /** 复刻 `@tauri-apps/api/window.js` 的真实包装与序列化（`instanceof Size ? … : new Size(…)`） */
  async function makeFakeWindow(opts: { failSetSize?: boolean } = {}) {
    const { Size, Position, PhysicalSize, PhysicalPosition } = await import("@tauri-apps/api/dpi");
    const calls: Array<{ op: string; payload: unknown }> = [];
    const win = {
      maximize: async () => {
        calls.push({ op: "maximize", payload: null });
      },
      setSize: async (value: unknown) => {
        if (opts.failSetSize) throw new Error("plugin:window|set_size 被拒绝");
        // 真实现的这一步：value instanceof Size ? value : new Size(value)
        calls.push({ op: "setSize", payload: new Size(value as never).toJSON() });
      },
      setPosition: async (value: unknown) => {
        calls.push({ op: "setPosition", payload: new Position(value as never).toJSON() });
      },
      outerSize: async () => new PhysicalSize(1280, 800),
      outerPosition: async () => new PhysicalPosition(100, 60),
      isMaximized: async () => false,
      onResized: async () => () => {},
      onMoved: async () => () => {},
    };
    (window as any).__TAURI__ = { window: { getCurrentWindow: () => win } };
    return { win, calls };
  }

  it("SKEY-D4-1: 保存的是物理像素 ⇒ 恢复必须给 Physical 值（裸对象会变成 {\"undefined\":…}）", async () => {
    const { calls } = await makeFakeWindow();
    localStorage.setItem(
      "codem-window-state",
      JSON.stringify({ width: 1280, height: 800, x: 100, y: 60, maximized: false }),
    );
    const { useWindowState } = await import("../hooks/useWindowState");

    const { unmount } = renderHook(() => useWindowState());
    try {
      await waitFor(() => expect(calls.some((c) => c.op === "setSize")).toBe(true), { timeout: 1500 });
      expect(calls.find((c) => c.op === "setSize")!.payload).toEqual({
        Physical: { width: 1280, height: 800 },
      });
      expect(calls.find((c) => c.op === "setPosition")!.payload).toEqual({
        Physical: { x: 100, y: 60 },
      });
    } finally {
      unmount();
      delete (window as any).__TAURI__;
    }
  });

  it("SKEY-D4-2: 恢复失败不静默（有告警留痕 + 走统一失败上报）", async () => {
    await makeFakeWindow({ failSetSize: true });
    localStorage.setItem(
      "codem-window-state",
      JSON.stringify({ width: 1280, height: 800, x: 100, y: 60, maximized: false }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { useWindowState } = await import("../hooks/useWindowState");
      const { unmount } = renderHook(() => useWindowState());
      try {
        await waitFor(
          () => expect(getPersistFailures().some((f) => f.area === "useWindowState.restore")).toBe(true),
          { timeout: 1500 },
        );
        expect(
          warn.mock.calls.some((c) => String(c[0]).includes("窗口尺寸/位置恢复失败")),
          "恢复失败必须有可诊断的告警留痕",
        ).toBe(true);
      } finally {
        unmount();
      }
    } finally {
      warn.mockRestore();
      delete (window as any).__TAURI__;
    }
  });
});

// ==========================================================================
// D-5 Hub 皮肤：data-skin=hub ⇒ data-theme=dark
// ==========================================================================

describe("D-5 Hub 皮肤的 data-theme 不变式", () => {
  it("SKEY-D5-1: 用户档位是 light 时，Hub 皮肤仍必须把 data-theme 钉成 dark", async () => {
    const { ThemeManager } = await import("../core/theme/theme-manager");
    const root = document.documentElement;
    try {
      setSetting("codem-theme", "light"); // 用户点过浅色主题
      setSetting("skin-id", "hub"); // 皮肤是 Hub（暗色皮肤）
      ThemeManager.init();

      expect(root.getAttribute("data-skin")).toBe("hub");
      expect(root.getAttribute("data-theme"), "Hub 皮肤下 data-theme 必须被钉成 dark").toBe("dark");
    } finally {
      // 复位：切回默认皮肤应当恢复用户档位（幂等，也顺带验证清理路径没被写坏）
      setSetting("skin-id", "default");
      setSetting("codem-theme", "light");
      ThemeManager.init();
      expect(root.getAttribute("data-theme")).toBe("light");
      expect(root.getAttribute("data-skin")).toBeNull();
    }
  });
});

// ==========================================================================
// D-8 图片附件提示的模型来源
// ==========================================================================

describe("D-8 视觉提示读不到模型（localStorage 无写入方）", () => {
  it("SKEY-D8-1: 模型来源不再是 localStorage 的 codem-settings；前缀判定保持保守", async () => {
    const src = readCode("src/components/InputArea.tsx");
    expect(
      src,
      "codem-settings 在 localStorage 里没有任何写入方，读它等于恒为空",
    ).not.toMatch(/localStorage\.getItem\(\s*["']codem-settings["']/);
    expect(src, "模型应取组件自己的 prop（活性来源）").toMatch(/modelSupportsVision\(model/);

    const { modelSupportsVision } = await import("../components/InputArea");
    // 值形状往返：模型 id（字符串）→ 判定结果
    for (const id of ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", "claude-4-opus", "gemini-2.5-pro", "o3", "o4-mini"]) {
      expect(modelSupportsVision(id), `${id} 应判定为支持视觉`).toBe(true);
    }
    for (const id of ["deepseek-v4-pro", "mimo-v2.5-pro", "", "  "]) {
      expect(modelSupportsVision(id), `${id} 应保守判定为不支持（未知模型不撒谎）`).toBe(false);
    }
  });
});

// ==========================================================================
// D-9 「CLI 模式」按钮点不动
// ==========================================================================

describe("D-9 CLI 模式按钮的写入形状", () => {
  it("SKEY-D9-1: 切 CLI 必须同时把模型换成 MiMo 模型（否则被脏数据自愈翻回 api）", async () => {
    const { SettingsPanel } = await import("../components/SettingsPanel");
    setSettingJSON("codem-settings", {
      mode: "api",
      model: "deepseek-v4-flash",
      fontSize: 13,
      language: "zh",
      providers: [{ id: "deepseek", name: "DeepSeek", apiKey: "sk-test", baseUrl: "https://api.deepseek.com/v1" }],
    });

    const { container } = render(createElement(SettingsPanel, { onClose: () => {} }));
    try {
      const modeButtons = [...container.querySelectorAll(".mode-btn")] as HTMLElement[];
      expect(modeButtons.length).toBeGreaterThanOrEqual(2);
      await act(async () => {
        fireEvent.click(modeButtons[1]); // 第二个是「CLI 模式」
      });

      const saved = getSettingJSON<any>("codem-settings", null);
      expect(saved.mode).toBe("cli");
      expect(String(saved.model).startsWith("mimo-"), `model 必须是 MiMo 模型，实际 ${saved.model}`).toBe(true);

      // 复刻 App.tsx 的"历史脏数据"判据（App.tsx:1701-1711）：它**不该**再触发
      const m = saved.model || "";
      const looksLikeApiModel =
        m.startsWith("deepseek") || m.startsWith("claude") || m.startsWith("gpt") ||
        m.startsWith("o3") || m.startsWith("gemini") || m.startsWith("moonshot");
      expect(looksLikeApiModel, "CLI 模式下带着 API 模型前缀 ⇒ configureEngine 会把 mode 翻回 api").toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ==========================================================================
// D-10 preset 预设写错键
// ==========================================================================

describe("D-10 preset 预设的键名与取值", () => {
  it("SKEY-D10-1: 应用预设写的是真实键 codem-security-mode，且取值是合法枚举", async () => {
    const { presetProvider } = await import("../core/provider/preset-provider");
    const { getGlobalSecurityMode } = await import("../core/permission/security-mode");

    const provided: Record<string, any> = {};
    const ctx = {
      provide: (name: string, api: any) => {
        provided[name] = api;
        return () => {};
      },
      emit: () => {},
    };
    presetProvider(ctx as any);
    expect(provided.preset, "preset 服务应被注册").toBeTruthy();

    await provided.preset.apply("strict_security");
    // 真实读取方（security-mode.ts）必须能读到 —— 旧实现写的是 `security-mode`，读回永远是默认值
    expect(getSetting("codem-security-mode")).toBe("ask");
    expect(getGlobalSecurityMode()).toBe("ask");

    // 三个"没有读取方"的键名不得再出现（写它们 = 死写入）
    expect(getSetting("security-mode")).toBeNull();
    expect(getSetting("auto-approve-tools")).toBeNull();
    expect(getSetting("telemetry-enabled")).toBeNull();

    // 自证必须诚实：应用完要能判出"正在生效"（旧实现因 getSettingJSON 读裸串而永远判不出）
    expect(provided.preset.getActivePreset()).toBe("strict_security");

    await provided.preset.apply("relaxed");
    expect(getSetting("codem-security-mode")).toBe("full");
    expect(getGlobalSecurityMode()).toBe("full");
    expect(provided.preset.getActivePreset()).toBe("relaxed");
  });
});

// ==========================================================================
// D-11 「恢复默认设置」名不副实
// ==========================================================================

describe("D-11 恢复默认界面设置", () => {
  it("SKEY-D11-1: 删掉 DB 里的界面偏好键 + 清镜像，且不碰 API Key / 身份 / 会话配置", async () => {
    const { resetUiPreferencesToDefaults, UI_PREFERENCE_KEYS } = await import("../core/settings/ui-preferences");
    const { readStoredUiFontPx, FONT_BASE_PX } = await import("../core/ui-font");

    // 造一份"用户调过很多东西"的状态
    setSetting("codem-theme", "dark");
    setSetting("skin-id", "hub");
    setSetting("codem-language", "en");
    setSetting("codem-font-size", "17");
    setSetting("codem-font-family", "Georgia, serif");
    setSetting("codem-font-weight", "620");
    setSetting("codem-close-behavior", "tray");
    setSetting("codem-display-mode", "segmented");
    setSetting("codem-sidebar-width", "420");
    setSettingJSON("codem-settings", {
      mode: "api",
      model: "deepseek-v4-flash",
      fontSize: 17,
      language: "en",
      providers: [{ id: "deepseek", name: "DeepSeek", apiKey: "sk-secret", baseUrl: "https://api.deepseek.com/v1" }],
    });
    setSetting("codem-mcp-servers", "[]");
    localStorage.setItem("codem-window-state", JSON.stringify({ width: 1280, height: 800, x: 1, y: 2, maximized: false }));
    localStorage.setItem("codem-theme-cache", "dark");

    const result = resetUiPreferencesToDefaults();

    // ① DB 键回到默认档
    for (const key of UI_PREFERENCE_KEYS) {
      if (key === "dream-config") continue; // 本用例没写过它
      expect(getSetting(key), `${key} 应被删掉（回到默认档）`).toBeNull();
    }
    expect(result.removedKeys).toContain("codem-close-behavior");
    expect(result.removedKeys).toContain("codem-theme");
    // ② 字号真的回到基准（值形状：数字 13，不是字符串）
    expect(getSettingJSON<any>("codem-settings", {}).fontSize).toBe(FONT_BASE_PX);
    expect(readStoredUiFontPx()).toBe(FONT_BASE_PX);
    expect(getSettingJSON<any>("codem-settings", {}).language).toBe("zh");
    // ③ localStorage 镜像清掉
    expect(localStorage.getItem("codem-window-state")).toBeNull();
    expect(localStorage.getItem("codem-theme-cache")).toBeNull();
    expect(result.clearedLocalKeys).toContain("codem-window-state");
    // ④ **不碰**数据面：API Key / 模型 / 会话与项目配置原样保留
    const after = getSettingJSON<any>("codem-settings", {});
    expect(after.providers[0].apiKey).toBe("sk-secret");
    expect(after.model).toBe("deepseek-v4-flash");
    expect(after.mode).toBe("api");
    expect(getSetting("codem-mcp-servers")).toBe("[]");
    expect(result.failed).toEqual([]);
  });

  it("SKEY-D11-2: 设置页有真正可点的「恢复默认界面设置」入口（不是只改文案）", () => {
    const panel = read("src/components/SettingsPanel.tsx");
    expect(panel, "设置页应调用真正的复位实现").toMatch(/resetUiPreferencesToDefaults\(/);
    expect(panel, "复位后必须把 DOM 也复位（字号/字体）").toMatch(/applyStoredUiFontFamily\(\)/);
  });
});

// ==========================================================================
// D-12 限额清空 = 写 undefined → 默认上限复活
// ==========================================================================

describe("D-12 codem-cost-limits 的 null 哨兵", () => {
  it("SKEY-D12-1: 清空输入框 → 落库保留键且值为 null ⇒ 重启后 $5 默认上限不复活", async () => {
    const { UsageStats } = await import("../components/UsageStats");
    const { CostTracker, getCostTracker } = await import("../core/llm/cost-tracker");

    const { container } = render(createElement(UsageStats, { onClose: () => {} }));
    try {
      const limitsTab = [...container.querySelectorAll(".usage-tab")].find((b) =>
        (b.textContent || "").includes("限额"),
      ) as HTMLElement;
      expect(limitsTab, "应能切到「限额」页签").toBeTruthy();
      await act(async () => {
        fireEvent.click(limitsTab);
      });

      const inputs = container.querySelectorAll(".usage-limit-input");
      expect(inputs.length).toBeGreaterThanOrEqual(1);
      // 用户把「每会话限额」清空 = 不限
      await act(async () => {
        fireEvent.change(inputs[0], { target: { value: "" } });
      });
      const saveBtn = container.querySelector(".usage-save-btn") as HTMLElement;
      expect(saveBtn).toBeTruthy();
      await act(async () => {
        fireEvent.click(saveBtn);
      });

      const saved = getSettingJSON<Record<string, unknown> | null>("codem-cost-limits", null);
      expect(saved, "限额应落库").toBeTruthy();
      // **值形状往返的关键**：键必须在（旧实现写 undefined → JSON.stringify 把它丢掉）
      expect(
        Object.prototype.hasOwnProperty.call(saved, "perSession"),
        `落库对象少了 perSession 键：${JSON.stringify(saved)}`,
      ).toBe(true);
      expect(saved!.perSession).toBeNull();

      // 模拟重启：新实例从同一份存储读回，**不该**把默认 $5 上限 merge 回来
      const restarted = new CostTracker();
      const limits = restarted.getLimits();
      expect(limits.perSession ?? null, `重启后 perSession 应为"不限"，实际 ${String(limits.perSession)}`).toBeNull();
      expect(limits.perDay).toBe(20); // 没动过的每日限额仍是默认值
      void getCostTracker;
    } finally {
      cleanup();
    }
  });
});

// ==========================================================================
// D-18 字号两套来源（旧扁平键优先）
// ==========================================================================

describe("D-18 codem-font-size 双键迁移", () => {
  it("SKEY-D18-1: 启动应用字号时把旧键迁进权威键并删掉旧键（此后只有一个来源）", async () => {
    const { applyStoredUiFont, readStoredUiFontPx, FONT_BASE_PX } = await import("../core/ui-font");

    // 场景：用户在设置页把字号调到 18（写在权威键里），库里还留着更早的旧扁平键 16
    setSetting("codem-font-size", "16");
    setSettingJSON("codem-settings", { fontSize: 18, mode: "api", model: "deepseek-v4-flash" });

    const applied = applyStoredUiFont();
    expect(applied, "权威键（codem-settings.fontSize=18）必须生效").toBe(18);
    expect(readStoredUiFontPx()).toBe(18);
    expect(
      document.documentElement.style.getPropertyValue("--ui-font-scale"),
      "CSS 变量随之缩放（18/13）",
    ).toBe((18 / FONT_BASE_PX).toFixed(3));

    // 迁移结果：旧键消失、权威键被写回数字
    expect(getSetting("codem-font-size"), "迁移后旧键必须被删掉").toBeNull();
    expect(getSettingJSON<any>("codem-settings", {}).fontSize).toBe(18);

    // 幂等：再跑一次不会把字号改回去
    expect(applyStoredUiFont()).toBe(18);

    // 老用户场景：旧键 16（真的拖过滑杆），权威键恰好是旧默认 14（保存设置时被一起写进去的默认值）
    // ⇒ 用户的选择不能被"默认档"顶掉
    setSetting("codem-font-size", "16");
    setSettingJSON("codem-settings", { fontSize: 14, mode: "api" });
    expect(applyStoredUiFont()).toBe(16);
    expect(getSetting("codem-font-size")).toBeNull();
    expect(getSettingJSON<any>("codem-settings", {}).fontSize).toBe(16);

    // 反向保护：从没拖过滑杆的老用户（权威键是旧默认 14、没有旧键）仍回落到基准 13
    setSettingJSON("codem-settings", { fontSize: 14, mode: "api" });
    expect(applyStoredUiFont()).toBe(FONT_BASE_PX);
  });
});

// ==========================================================================
// D-21 「已保存」是无条件显示
// ==========================================================================

describe("D-21 保存反馈必须建立在落库确认上", () => {
  /** 一个"接受写入但永远落不了库"的配置面端口（与真端口同形：内存先改、失败走计数） */
  function makeUnpersistablePort() {
    const base = createFakeStoragePort();
    const memory = new Map<string, unknown>();
    let failures = 0;
    const config = {
      async warmup() {
        return memory.size;
      },
      get<T>(key: string, fallback: T): T {
        return memory.has(key) ? (memory.get(key) as T) : fallback;
      },
      set(key: string, value: unknown) {
        memory.set(key, value); // 内存即时生效（与真端口一致）
        failures += 1; // ……但这次落库失败了（真端口会走 onFailure 上报并计数）
      },
      remove(key: string) {
        memory.delete(key);
        failures += 1;
      },
      stats: () => ({ warmed: true, keys: memory.size, pendingWrites: 0, failures }),
    };
    return { ...base, config } as typeof base;
  }

  it("SKEY-D21-1: 落库失败时不得显示「已保存」（并如实显示未确认）", async () => {
    setStoragePort(makeUnpersistablePort() as any);
    const { SettingsPanel } = await import("../components/SettingsPanel");
    setSettingJSON("codem-settings", { mode: "api", model: "deepseek-v4-flash", fontSize: 13, language: "zh", providers: [] });

    const { container } = render(createElement(SettingsPanel, { onClose: () => {} }));
    try {
      const saveBtn = [...container.querySelectorAll("button")].find((b) =>
        (b.textContent || "").includes("保存设置"),
      ) as HTMLElement;
      expect(saveBtn).toBeTruthy();
      await act(async () => {
        fireEvent.click(saveBtn);
      });

      const text = container.textContent || "";
      expect(text.includes("✅ 已保存"), "写入没落库却显示「已保存」= 假成功").toBe(false);
      expect(/未确认保存/.test(text), "必须如实显示「未确认保存」及原因").toBe(true);
    } finally {
      cleanup();
    }
  });

  it("SKEY-D21-2: 落库正常时仍然显示「已保存」（不能因为修归因把成功也否掉）", async () => {
    const { SettingsPanel } = await import("../components/SettingsPanel");
    setSettingJSON("codem-settings", { mode: "api", model: "deepseek-v4-flash", fontSize: 13, language: "zh", providers: [] });

    const { container } = render(createElement(SettingsPanel, { onClose: () => {} }));
    try {
      const saveBtn = [...container.querySelectorAll("button")].find((b) =>
        (b.textContent || "").includes("保存设置"),
      ) as HTMLElement;
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      await waitFor(() => expect((container.textContent || "").includes("已保存")).toBe(true), { timeout: 2000 });
      expect(/未确认保存/.test(container.textContent || "")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ==========================================================================
// D-23 保存时的陈旧快照覆盖别处刚写入的 model
// ==========================================================================

describe("D-23 保存基座必须用保存这一刻的库值", () => {
  it("SKEY-D23-1: 面板打开期间别处改了 model ⇒ 保存不得把它顶回面板里的旧值", async () => {
    const { SettingsPanel } = await import("../components/SettingsPanel");
    setSettingJSON("codem-settings", {
      mode: "api",
      model: "deepseek-v4-flash",
      fontSize: 13,
      language: "zh",
      providers: [{ id: "deepseek", name: "DeepSeek", apiKey: "sk-test", baseUrl: "https://api.deepseek.com/v1" }],
    });

    const { container } = render(createElement(SettingsPanel, { onClose: () => {} }));
    try {
      // 面板打开后，别处（header 的模型切换 / configureEngine 落盘）把 model 改成更晚的值
      const fresh = getSettingJSON<any>("codem-settings", {});
      setSettingJSON("codem-settings", { ...fresh, model: "deepseek-v4-pro" });

      const saveBtn = [...container.querySelectorAll("button")].find((b) =>
        (b.textContent || "").includes("保存设置"),
      ) as HTMLElement;
      await act(async () => {
        fireEvent.click(saveBtn);
      });

      const after = getSettingJSON<any>("codem-settings", {});
      expect(after.model, "面板的陈旧快照把别处刚写入的 model 顶回去了").toBe("deepseek-v4-pro");

      // 但用户在面板里**自己**改过的模型仍必须由面板说了算（别把这条修成"面板改不动"）
      const modelSelect = container.querySelector(".sp-select-flex") as HTMLSelectElement;
      expect(modelSelect, "应能找到模型下拉").toBeTruthy();
      const option = [...modelSelect.options].find((o) => o.value === "deepseek-v4-flash");
      expect(option, "模型下拉里应有 deepseek-v4-flash").toBeTruthy();
      await act(async () => {
        fireEvent.change(modelSelect, { target: { value: "deepseek-v4-flash" } });
      });
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      expect(getSettingJSON<any>("codem-settings", {}).model, "面板里改过的模型必须落库").toBe("deepseek-v4-flash");
    } finally {
      cleanup();
    }
  });
});
