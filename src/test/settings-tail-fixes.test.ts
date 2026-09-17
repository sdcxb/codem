/**
 * 设置链路审计「尾批」回归契约（第 45 轮：D-7/13/14/15/16/17/19/20/22/24）。
 *
 * ## 为什么单独一个文件
 *
 * 与 `settings-dead-keys.test.ts`（D-1..D-6/D-8..D-12/D-18/D-21/D-23）同源，但覆盖审计报告
 * 里**剩下那批**条目。审计报告 `.preview-shot/_audit/SETTINGS-LOOP.md` 的核心教训是：
 *
 * > 判定"死设置"必须看**生效点**，不能只看"有没有 getSetting 调用"。
 *
 * 所以这里每条断言都尽量落在**行为**上：值形状往返（写进去的类型与读出来/被消费的一致）、
 * 生效点存在（写了 CSS 变量 / 按键真的触发回调）、重启后仍生效（镜像 + 启动读取）。
 * 用例命名 `SKEY-D<n>-<i>` 对应审计条目编号。
 *
 * ## 读代码时注意
 *
 * 被测的新 API 一律在**用例内部** `await import(...)`：这样"改前会红"的取证可以逐条做
 * （把某一源文件换成 `git show HEAD:<path>` 的旧版，只有该条目的用例会红）。
 *
 * D-19 / D-20 的现状（App 侧快速访问区块是死 UI、缺少"上次会话"恢复）**无法在本批次内修好**
 * ——它们必须改 `src/App.tsx`（本批次的禁区）。这里只放"守门"用例：把**当前的真实状态**
 * 钉成断言，这样一旦有人补上（或改坏），测试立刻给出准确信号，而不是让条目悄悄消失。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook, act } from "@testing-library/react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { setSetting, setSettingJSON } from "../core/storage/settings";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = join(__dirname, "..", "..");
/** 读源码并剥注释：本仓库注释里大量逐字引用被修掉的坏写法，不剥注释会把自己绊倒 */
const readCode = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"));


beforeEach(() => {
  setStoragePort(null);
  localStorage.clear();
  document.documentElement.removeAttribute("data-skin");
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

/**
 * 建一个**已预热**的假端口并注册。
 *
 * 真实启动顺序是 `RustStoragePort.start()` 先 `await config.warmup()` 再 `setStoragePort(port)`
 * ——也就是说"端口注册"这一刻配置面已经可读。不 warmup 直接注册的话，`getSetting` 会返回 null
 * （配置面未预热），那是**端口没就绪**的形态，不是本文件要验的东西。
 */
async function installPort(seed: Record<string, string> = {}) {
  const port = createFakeStoragePort({
    seed: { settings: Object.entries(seed).map(([key, value]) => ({ key, value })) },
  });
  await port.config.warmup(); // 与真端口一致：注册前先预热
  setStoragePort(port);
  return port;
}

// ==========================================================================
// D-7 分层设置（SettingsManager）：「导出所有设置」导出 `{}` + 策略读值查错层级
// ==========================================================================

describe("D-7 分层设置：来源装载、导出、策略读值", () => {
  it("SKEY-D7-1: 按来源读（不再拼第二次来源名），导出带出来源数据与形状", async () => {
    const { SettingsManager } = await import("../core/settings/settings");
    const mgr = new SettingsManager("C:/proj");
    // 先走一次装载（测试环境没有 Tauri → 磁盘来源装载失败但**不会抛**，来源形状固定下来）
    await mgr.loadAll();

    // 灌入来源数据（真实运行时由 `loadAll()` 读磁盘 / `applyPolicyFromDb()` 读 DB 填进来）
    mgr.importSettings(
      { permissions: [{ tool: "bash", action: "allow" }], features: { "new-ui": true }, mcpServers: { project: { cmd: "x" } } },
      "project",
    );
    mgr.importSettings({ permissions: [{ tool: "write", action: "ask" }] }, "local");

    // ① 值形状往返：来源内的键是**相对**的 permissions（旧写法查 data[source].permissions → 恒空）
    expect(mgr.getPermissionRules().map((r) => r.tool).sort()).toEqual(["bash", "write"]);
    expect(mgr.isFeatureEnabled("new-ui"), "features.<name> 必须能被读到").toBe(true);
    expect(mgr.isFeatureEnabled("not-set"), "没声明的开关必须是 false（不能凭空为真）").toBe(false);
    expect(Object.keys(mgr.getMCPServers())).toEqual(["project"]);

    // ② 导出必须带出来源数据（旧实现 exportSettings() 恒为 {}），且**不能把灌进去的数据清掉**
    const exported = await mgr.exportSettings();
    expect(Object.keys(exported).sort()).toEqual(["cli", "default", "flag", "local", "policy", "project", "user"]);
    expect((exported.project as any).permissions[0].tool).toBe("bash");
    expect((exported.local as any).permissions[0].tool).toBe("write");
    expect((exported.project as any).features["new-ui"]).toBe(true);
    // 导出是只读动作：导完再读一次，值必须还在
    expect(mgr.getPermissionRules().map((r) => r.tool).sort()).toEqual(["bash", "write"]);
  });

  it("SKEY-D7-1b: exportSettings 会先 await loadAll（装载失败的来源如实带 loadError）", async () => {
    const { SettingsManager } = await import("../core/settings/settings");
    const mgr = new SettingsManager("C:/proj");
    expect(mgr.isLoaded(), "未装载前必须是 false，面板据此区分'无数据'与'还没装载'").toBe(false);

    // 测试环境里 file-api 的 readFile 会失败（没有 Tauri）→ 来源必须记下原因，而不是静默当空
    const exported = await mgr.exportSettings();
    expect(mgr.isLoaded()).toBe(true);
    const localSource = mgr.getAllSources().find((s) => s.source === "local")!;
    expect(localSource.loadError, "读不到文件必须留原因").toBeTruthy();
    expect(exported.local).toEqual({});
    expect((exported as any).policy).toEqual({});
  });

  it("SKEY-D7-2: 策略来自 DB 的 codem-policy（未配置时不得假装'检查通过'）", async () => {
    await installPort();

    const { SettingsManager, POLICY_SETTING_KEY } = await import("../core/settings/settings");
    const mgr = new SettingsManager("C:/proj");

    // ① 没配策略：必须如实返回"没有限制"，而不是抛错
    await mgr.loadAll();
    expect(mgr.isBypassDisabled()).toBe(false);
    expect(mgr.getBlockedModels()).toEqual([]);

    // ② 库里放一份真实策略 → 三个 getter 必须都按**真实值**回答
    setSettingJSON(POLICY_SETTING_KEY, {
      blockedModels: ["gpt-4o"],
      blockedProviders: ["openai"],
      bypassPermissionsDisabled: true,
    });
    expect(mgr.applyPolicyFromDb()).toBe(true);
    expect(mgr.isBypassDisabled()).toBe(true);
    expect(mgr.getBlockedModels()).toEqual(["gpt-4o"]);
    expect(mgr.getBlockedProviders()).toEqual(["openai"]);
    // 策略必须真的拦得住（消费者是 isModelAllowed / isProviderAllowed）
    expect(mgr.isModelAllowed("gpt-4o")).toBe(false);
    expect(mgr.isModelAllowed("deepseek-v4-pro")).toBe(true);
    expect(mgr.isProviderAllowed("openai")).toBe(false);

    // ③ 导出里也能看到策略来源（否则"导出所有设置"仍然漏掉策略）
    const exported = await mgr.exportSettings();
    expect((exported.policy as any).blockedModels).toEqual(["gpt-4o"]);
  });

  it("SKEY-D7-3: 单例换项目必须换实例（旧实现把首个路径固化）", async () => {
    const { getSettingsManager, __resetSettingsManagerForTests } = await import("../core/settings/settings");
    __resetSettingsManagerForTests();

    const a = getSettingsManager("C:/proj-a");
    expect(a.getProjectPath()).toBe("C:/proj-a");
    expect(getSettingsManager("C:/proj-a")).toBe(a); // 同路径复用

    const b = getSettingsManager("C:/proj-b");
    expect(b.getProjectPath()).toBe("C:/proj-b");
    expect(getSettingsManager("C:/proj-b")).toBe(b);
    __resetSettingsManagerForTests();
  });

  it("SKEY-D7-4: 面板的导出按钮必须 await（否则 JSON.stringify(Promise) 又变成 {}）", () => {
    const src = readCode("src/components/LayeredSettingsPanel.tsx");
    expect(src, "导出必须 await mgr.exportSettings()").toMatch(/await\s+mgr\.exportSettings\(\)/);
    expect(src, "面板必须真的装载来源，否则永远'无数据'").toMatch(/\.loadAll\(\)/);
  });
});

// ==========================================================================
// D-13 apiKeys 只有读、没有写入方 → 凭证层拿不到用户在设置里填的密钥
// ==========================================================================

describe("D-13 凭证层必须能读到用户真正填的密钥", () => {
  it("SKEY-D13-1: codem-settings.providers[].apiKey 是活性来源，credentials.get 必须取到它", async () => {
    await installPort();
    // 设置页写的形状（SettingsPanel.tsx:1607-1613）
    setSettingJSON("codem-settings", {
      mode: "api",
      providers: [{ id: "mimo", name: "MiMo", apiKey: "sk-mimo-123", baseUrl: "https://api.mimo.ai/v1" }],
    });

    const { credentialsProvider } = await import("../core/provider/credentials-provider");
    let service: any = null;
    credentialsProvider({ provide: (_name: string, value: any) => { service = value; return () => {}; } } as any);

    // 值形状往返：用户在设置里填的字符串，经凭证层取出来必须**逐字相同**
    expect(service.get("MIMO_API_KEY")).toBe("sk-mimo-123");
    expect(service.has("MIMO_API_KEY")).toBe(true);
    // 没配过的仍然是"没有"（不能凭空造一个空串，那会让 isConfigured 撒谎）
    expect(service.get("OPENAI_API_KEY")).toBeUndefined();
  });

  it("SKEY-D13-2: set() 走混淆存储并落进 apiKeys 键（往返可读）", async () => {
    const port = await installPort();
    const { credentialsProvider } = await import("../core/provider/credentials-provider");
    let service: any = null;
    credentialsProvider({ provide: (_name: string, value: any) => { service = value; return () => {}; } } as any);

    service.set("DEEPSEEK_API_KEY", "sk-plain-abc");
    const raw = port.config.get<string>("apiKeys", "");
    expect(String(raw), "apiKeys 必须真的被写入（旧实现全仓没有写入方）").toContain("DEEPSEEK_API_KEY");
    expect(String(raw), "落库的不能是明文").not.toContain("sk-plain-abc");
    expect(service.get("DEEPSEEK_API_KEY")).toBe("sk-plain-abc");
  });
});

// ==========================================================================
// D-14 宣称的快捷键大多没有 handler + macOS 标签硬编码 Ctrl + ARIA 写法不合法
// ==========================================================================

describe("D-14 快捷键：标签与按键处理同源", () => {
  const keyEvent = (key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });

  it("SKEY-D14-1: 表里每条都给出 ARIA 规范写法，且不显示平台不支持的项", async () => {
    const { buildAppShortcuts } = await import("../core/shortcuts/app-shortcuts");
    const win = buildAppShortcuts(false);
    const mac = buildAppShortcuts(true);

    const byId = (list: any[], id: string) => list.find((s) => s.id === id);
    expect(byId(win, "new-chat").label).toBe("Ctrl+N");
    expect(byId(win, "new-chat").aria).toBe("Control+N");
    expect(byId(mac, "new-chat").label).toBe("⌘N");
    expect(byId(mac, "new-chat").aria).toBe("Meta+N");
    // macOS 的 ⌘Q 由系统菜单处理：不显示、不注册（旧实现印着一个不存在的快捷键）
    expect(byId(mac, "close").label).toBeNull();
    expect(byId(mac, "close").enabled).toBe(false);
    // 所有非空标签都必须是"平台主修饰键 + 键名"的展示形，且 aria 必须是规范形
    for (const spec of [...win, ...mac]) {
      if (spec.label === null) continue;
      expect(/^(Ctrl\+|⌘)/.test(spec.label), `${spec.id} 标签形态`).toBe(true);
      expect(/^(Control|Meta)\+/.test(spec.aria!), `${spec.id} aria 形态`).toBe(true);
    }
  });

  it("SKEY-D14-2: 按键真的打到回调（Ctrl+N/B/`/,），可编辑控件里不抢 B", async () => {
    const { buildAppShortcuts, matchesShortcut } = await import("../core/shortcuts/app-shortcuts");
    const specs = buildAppShortcuts(false);
    const fire = (spec: any, target: EventTarget | null) => {
      const e = new KeyboardEvent("keydown", { key: spec.key, ctrlKey: true, bubbles: true });
      if (target) Object.defineProperty(e, "target", { value: target });
      return matchesShortcut(e, spec, false);
    };
    const spec = (id: string) => specs.find((s) => s.id === id)!;

    const input = document.createElement("input");
    const button = document.createElement("button");

    expect(fire(spec("new-chat"), button)).toBe(true);
    expect(fire(spec("settings"), button)).toBe(true);
    expect(fire(spec("sidebar"), button)).toBe(true);
    expect(fire(spec("terminal"), button)).toBe(true);
    expect(fire(spec("search"), input), "搜索在任何地方都能唤起").toBe(true);

    // Ctrl+B 在输入框里是"光标左移"、Ctrl+` 会打断输入 —— 不许抢
    expect(fire(spec("sidebar"), input)).toBe(false);
    expect(fire(spec("terminal"), input)).toBe(false);
    // 少了主修饰键不算命中
    expect(matchesShortcut(new KeyboardEvent("keydown", { key: "n" }), spec("new-chat"), false)).toBe(false);
  });

  it("SKEY-D14-3: TitleBar 的菜单标签与 handler 同源（不再手写 Ctrl 字符串）", async () => {
    const src = readCode("src/components/TitleBar.tsx");
    expect(src, "快捷键标签必须来自 APP_SHORTCUTS").toMatch(/shortcutLabel\(/);
    expect(src, "aria-keyshortcuts 必须来自 APP_SHORTCUTS").toMatch(/shortcutAria\(/);
    expect(src, "按键匹配必须走同一张表").toMatch(/matchesShortcut\(/);
    expect(src, "不许再手写 Ctrl+/⌘ 标签").not.toMatch(/Ctrl\+|⌘/);

    // 表里每条（除平台不支持的 close）都要在 TitleBar 里有对应动作映射
    const { buildAppShortcuts } = await import("../core/shortcuts/app-shortcuts");
    const actionsMap = src.slice(src.indexOf("const actions: Record<string, (() => void) | undefined>"));
    for (const spec of buildAppShortcuts(false)) {
      if (spec.enabled === false) continue;
      // 键可能带引号也可能不带（`"new-chat":` / `search:`）
      expect(actionsMap, `${spec.id} 必须有对应的动作映射`).toMatch(new RegExp(`["']?${spec.id}["']?\\s*:`));
    }
  });

  it("SKEY-D14-4: AppMenuBar 用规范 ARIA 字段而不是展示字符串", () => {
    const src = readCode("src/components/AppMenuBar.tsx");
    expect(src).toMatch(/ariaShortcut/);
    expect(src).toMatch(/aria-keyshortcuts=\{item\.ariaShortcut/);
  });
});

// ==========================================================================
// D-15 ModelSelector / 两个 UI 服务不可达（含会抛异常的"空 props 注册"）
// ==========================================================================

describe("D-15 ModelSelector 与模型 UI 服务", () => {
  it("SKEY-D15-1: 服务从档案槽位取模型（旧实现 listProfiles?.() 恒 undefined）", async () => {
    const { collectModelsFromProfiles } = await import("../core/provider/ui-model-selection-provider");
    const models = collectModelsFromProfiles([
      { id: "p1", slots: { chat: { provider: "deepseek", model: "deepseek-v4-pro" } } },
      { id: "p2", slots: { chat: { provider: "deepseek", model: "deepseek-v4-pro" }, fast: { provider: "mimo", model: "mimo-v2.5-pro" } } },
    ]);
    expect(models.map((m) => m.id).sort()).toEqual(["deepseek-v4-pro", "mimo-v2.5-pro"]);
    // 非数组输入不炸（服务可能在 modelProfile 缺席时被调用）
    expect(collectModelsFromProfiles(undefined as any)).toEqual([]);
  });

  it("SKEY-D15-2: 服务提供者读到的必须是真实 manager 的 getAll()（不是空）", async () => {
    const { ModelProfileManager } = await import("../core/llm/model-profile");
    const { collectModelsFromProfiles } = await import("../core/provider/ui-model-selection-provider");
    const mgr = new ModelProfileManager();
    // 值形状往返：manager.getAll() → 服务里的"可用模型"必须非空
    const models = collectModelsFromProfiles(mgr.getAll());
    expect(models.length, "内置档案的槽位里必须有模型，否则模型选择器是空的").toBeGreaterThan(0);
    // 反过来钉住旧 bug：listProfiles 在真实对象上不存在
    expect(typeof (mgr as any).listProfiles).toBe("undefined");
  });

  it("SKEY-D15-3: uiSettingsModels 调用的方法必须真实存在，服务缺席时如实失败", async () => {
    const { uiSettingsModelsProvider } = await import("../core/provider/ui-settings-models-provider");

    // ① 有真实 manager：render 返回档案，addModel 建出档案（旧实现返回 {id:'model-…'} 假值、库里什么都没写）
    const { ModelProfileManager } = await import("../core/llm/model-profile");
    const mgr = new ModelProfileManager();
    let svc: any = null;
    uiSettingsModelsProvider({ get: (n: string) => (n === "modelProfile" ? mgr : undefined), provide: (_n: string, v: any) => { svc = v; return () => {}; } } as any);
    const rendered = svc.render();
    expect(Array.isArray(rendered.models)).toBe(true);
    expect(rendered.available).toBe(true);

    const added = await svc.addModel({ name: "我的档案", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(added.ok).toBe(true);
    expect(mgr.getAll().some((p) => p.name === "我的档案")).toBe(true);

    // ② 没有 manager：必须**如实**返回失败，而不是伪造成功
    let svc2: any = null;
    uiSettingsModelsProvider({ get: () => undefined, provide: (_n: string, v: any) => { svc2 = v; return () => {}; } } as any);
    expect(svc2.render().available).toBe(false);
    expect((await svc2.setDefault("x")).ok).toBe(false);
  });

  it("SKEY-D15-4: ModelSelector 空 props 渲染不抛错（Slot 就是这么渲染它的）", async () => {
    const { render, cleanup } = await import("@testing-library/react");
    const React = await import("react");
    const { ModelSelector } = await import("../components/ModelSelector");
    try {
      const { container, unmount } = render(React.createElement(ModelSelector as any, {}));
      expect(container.querySelector(".model-selector-inline"), "必须渲染出一个可点的模型按钮").toBeTruthy();
      unmount();
    } finally {
      cleanup();
    }
    // 旧实现的 models.find(...) 会在这一行抛 TypeError（被 SlotErrorBoundary 吞掉 → 空白）
  });

  it("SKEY-D15-5: 没有出口的 app.model-selector slot 已不再声明/注册", () => {
    expect(readCode("src/core/slots/declare-slots.ts")).not.toContain("app.model-selector");
    expect(readCode("src/core/ui-plugins/ui-panels/index.ts")).not.toContain("app.model-selector");
    expect(
      readCode("src/core/provider/ui-model-selection-provider.ts"),
      "provider 里也不该再注册这个无出口的 slot",
    ).not.toContain("app.model-selector");
  });
});

// ==========================================================================
// D-16 theme-provider 暴露的 5 个方法在 ThemeManager 上都不存在
// ==========================================================================

describe("D-16 theme 服务的方法必须真的存在", () => {
  it("SKEY-D16-1: 服务上每个方法调用后都落到 ThemeManager 的真实行为（无 TypeError）", async () => {
    const { ThemeManager } = await import("../core/theme/theme-manager");
    const { themeProvider } = await import("../core/provider/theme-provider");

    let svc: any = null;
    const dispose = themeProvider({ provide: (_n: string, v: any) => { svc = v; return () => {}; } } as any);
    expect(typeof dispose).toBe("function");

    const setSkinSpy = vi.spyOn(ThemeManager, "setSkin");
    try {
      // ① 五个成员必须都是函数（旧实现 getCurrent/setTheme/listThemes/registerTheme/onThemeChange 全不存在）
      for (const name of ["getCurrent", "setTheme", "listThemes", "onThemeChange", "getFirstPaintSkin"]) {
        expect(typeof svc[name], `${name} 必须是函数`).toBe("function");
      }
      // ② setTheme 真的切换皮肤（值形状往返：set → get 一致，且落库为字符串）
      svc.setTheme("hub");
      expect(setSkinSpy).toHaveBeenCalledWith("hub");
      expect(svc.getCurrent()).toBe("hub");
      expect(document.documentElement.getAttribute("data-skin")).toBe("hub");

      // ③ listThemes 的条目形状与 getAvailableSkins 一致
      const themes = svc.listThemes();
      expect(themes.map((t: any) => t.name).sort()).toEqual(["default", "dream", "hub"]);

      // ④ onThemeChange 真的会被通知（不是空实现）
      const seen: string[] = [];
      const off = svc.onThemeChange((s: string) => seen.push(s));
      svc.setTheme("dream");
      expect(seen).toEqual(["dream"]);
      off();
      svc.setTheme("default");
      expect(seen).toEqual(["dream"]);
    } finally {
      setSkinSpy.mockRestore();
      // 复位（避免污染后续用例）
      ThemeManager.setSkin("default");
      dispose?.();
    }
  });

  it("SKEY-D16-2: 源码里不再出现 ThemeManager 上没有的方法名", () => {
    const src = readCode("src/core/provider/theme-provider.ts");
    for (const missing of ["themeMgr.getCurrent(", "themeMgr.setTheme(", "themeMgr.listThemes(", "themeMgr.registerTheme(", "themeMgr.onThemeChange("]) {
      expect(src, `ThemeManager 上没有 ${missing}`).not.toContain(missing);
    }
  });
});

// ==========================================================================
// D-17 首屏镜像：data-skin 无镜像 + hub/dream 下切换主题只写 DB 不写镜像
// ==========================================================================

describe("D-17 皮肤/主题的首屏镜像", () => {
  it("SKEY-D17-1: 镜像在每次 setSkin 时写入，且下次启动 init() 能同步读到", async () => {
    const { ThemeManager, readCachedSkin } = await import("../core/theme/theme-manager");
    ThemeManager.setSkin("hub");
    // 值形状往返：镜像里是字符串 "hub"（index.html 那种同步读取能直接用）
    expect(localStorage.getItem("codem-skin-cache")).toBe("hub");
    expect(readCachedSkin()).toBe("hub");

    // 模拟"下次启动"：DB 还读不到（端口未注册）→ init() 用镜像兜底，首帧不再是默认皮肤
    setStoragePort(null);
    document.documentElement.removeAttribute("data-skin");
    ThemeManager.init();
    expect(readCachedSkin()).toBe("hub");
    expect(ThemeManager.getSkin()).toBe("hub");
    expect(document.documentElement.getAttribute("data-skin")).toBe("hub");
  });

  it("SKEY-D17-2: DB 就绪后必须用 DB 校正镜像（过期镜像不能一直骗人）", async () => {
    const { ThemeManager } = await import("../core/theme/theme-manager");
    const { setupThemeSkinResync } = await import("../core/theme/theme-resync");

    // 镜像说 dream（过期），DB 里其实是 default
    localStorage.setItem("codem-skin-cache", "dream");
    setStoragePort(null);
    ThemeManager.init();
    expect(ThemeManager.getSkin()).toBe("dream"); // 首帧按镜像预测

    const off = setupThemeSkinResync();
    try {
      // 真实值：DB 里是 default（端口注册前已预热，与真端口一致）
      await installPort({ "skin-id": "default" });
      expect(ThemeManager.getSkin(), "端口就绪后必须采信 DB 真值").toBe("default");
      expect(document.documentElement.getAttribute("data-skin")).toBeNull();
      expect(localStorage.getItem("codem-skin-cache")).toBe("default");
    } finally {
      off();
      ThemeManager.setSkin("default");
    }
  });

  it("SKEY-D17-3: hub/dream 皮肤下切换主题也要写首屏镜像（旧写法提前 return）", () => {
    const src = readCode("src/components/TitleBar.tsx");
    const toggle = src.slice(src.indexOf("const toggleTheme"), src.indexOf("// 项目变化时加载执行模式"));
    expect(toggle, "toggleTheme 必须写镜像").toMatch(/cacheTheme\(next\)/);
    const cacheIdx = toggle.indexOf("cacheTheme(next)");
    const returnIdx = toggle.indexOf("return;");
    expect(cacheIdx, "镜像写入必须在过早 return 之前（hub/dream 分支）").toBeLessThan(returnIdx);
  });

  it("SKEY-D17-4: mimo-theme → codem-theme 迁移时补写镜像", () => {
    const src = readCode("src/core/storage/migration.ts");
    expect(src).toMatch(/cacheTheme\(/);
  });
});

// ==========================================================================
// D-19 / D-20 只能守门（修它们要改 src/App.tsx —— 本批次禁区）
// ==========================================================================

describe("D-19 / D-20 守门（真实状态钉成断言）", () => {
  it("SKEY-D19-1: App 侧快速访问区块仍然没有任何 `setShowQuickAccess(true)`（死 UI 未接线）", () => {
    const src = readCode("src/App.tsx");
    expect(src).toContain("showQuickAccess");
    const setTrue = /setShowQuickAccess\(\s*true\s*\)/.test(src);
    // 断言当前状态：一旦有人补上接线，这条会红 —— 那时请把这一段改成"可达性"用例
    expect(setTrue, "App 级快速访问区块目前不可达（需要 App.tsx 的所有者接线或删除）").toBe(false);
    // 活着的入口在 ChatPanel（初值 true）
    const chat = readCode("src/components/ChatPanel.tsx");
    expect(chat).toMatch(/useState\(true\)/);
  });

  it("SKEY-D20-1: 仍然没有任何'上次会话/项目'的恢复键（能力缺失未补）", () => {
    const app = readCode("src/App.tsx");
    for (const key of ["codem-last-session", "codem-last-project", "lastOpened", "restoreLast"]) {
      expect(app.includes(key), `${key} 目前不存在（需要 App.tsx + store 的所有者实现）`).toBe(false);
    }
  });
});

// ==========================================================================
// D-22 同类偏好两种介质：面板宽度只写 localStorage
// ==========================================================================

describe("D-22 面板宽度的持久化介质", () => {
  it("SKEY-D22-1: 端口就绪后读 DB 的值（跨清 localStorage 仍生效）", async () => {
    const { usePaneResize } = await import("../hooks/usePaneResize");
    await installPort({ "right-sidebar-width": "480" });
    localStorage.clear(); // 清掉 localStorage：DB 是权威

    const { result } = renderHook(() => usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "right-sidebar-width" }));
    expect(result.current.width, "必须读 DB 里的宽度（与 codem-sidebar-width 同介质）").toBe(480);
  });

  it("SKEY-D22-2: 旧 localStorage 值会被迁移进 DB，并清掉旧键", async () => {
    const { usePaneResize } = await import("../hooks/usePaneResize");
    const port = await installPort();
    localStorage.setItem("right-sidebar-width", "500"); // 老版本留下的值

    const { result } = renderHook(() => usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "right-sidebar-width" }));
    expect(result.current.width, "旧值必须仍然生效（迁移不能把用户宽度弄丢）").toBe(500);

    // 读取处就完成迁移（不等用户拖一次）
    expect(port.config.get("right-sidebar-width", ""), "必须写进 DB").toBe("500");
    expect(localStorage.getItem("right-sidebar-width"), "迁移后旧键要清掉（否则两种介质长期并存）").toBeNull();

    // 再走一次"拖拽结束"的落盘路径：仍然写 DB，且不会复活旧键
    act(() => {
      result.current.endResize();
    });
    expect(port.config.get("right-sidebar-width", "")).toBe("500");
    expect(localStorage.getItem("right-sidebar-width")).toBeNull();
  });

  it("SKEY-D22-3: 越界/脏值仍有夹取（搬介质不能丢掉校验）", async () => {
    const { usePaneResize } = await import("../hooks/usePaneResize");
    await installPort({ "right-sidebar-width": "9999" });
    const { result } = renderHook(() => usePaneResize({ min: 360, max: 620, initial: 420, storageKey: "right-sidebar-width" }));
    expect(result.current.width).toBe(420); // 越界 → 回落 initial
  });
});

// ==========================================================================
// D-24 ui-language 的默认值与全应用默认相反
// ==========================================================================

describe("D-24 contextInfo.getLang 的兜底", () => {
  const mount = async () => {
    const { contextInfoProvider } = await import("../core/provider/context-info-provider");
    let svc: any = null;
    contextInfoProvider({ provide: (_n: string, v: any) => { svc = v; return () => {}; }, get: () => undefined } as any);
    return svc;
  };

  it("SKEY-D24-1: 没有 ui-language 时兜底必须与应用默认语言一致（zh，不是 en）", async () => {
    await installPort();
    const svc = await mount();
    const { DEFAULT_LANG } = await import("../core/i18n/lang");
    expect(DEFAULT_LANG).toBe("zh");
    expect(svc.getLang(), "旧实现兜底 'en'，与应用默认 zh 相反").toBe("zh");
    expect(svc.assemble()).toContain("Language: zh");
  });

  it("SKEY-D24-2: 兼容通道仍在 —— ui-language 有值就优先，且跟随 codem-language", async () => {
    const port = await installPort({ "ui-language": "en" });
    let svc = await mount();
    expect(svc.getLang()).toBe("en");

    // 去掉兼容键 → 跟随真实语言设置（setLang 会同步清掉 getLang 的模块级缓存）
    port.config.remove("ui-language");
    const { setLang } = await import("../core/i18n/lang");
    setLang("en");
    svc = await mount();
    expect(svc.getLang(), "codem-language=en 时必须返回 en").toBe("en");

    // 复位模块缓存，避免污染后续用例（语言是模块级单例状态）
    setLang("zh");
  });
});
