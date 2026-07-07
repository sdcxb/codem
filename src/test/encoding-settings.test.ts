/**
 * 测试 13：编码测试 — 中文和 Emoji 在 Settings 值中的存储
 *
 * 改动影响：
 *   - 所有 settings 从 localStorage 迁移到 SQLite
 *   - SQLite 的 TEXT 类型存储 UTF-8，但需验证 JSON 序列化/反序列化不会破坏多字节字符
 *   - 特别关注：复合 emoji（多 codepoint）、零宽字符、混合中英文
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "../core/storage/settings";

describe("编码测试 — 中文和 Emoji 在 Settings 值中", () => {
  beforeEach(async () => {
    await initDatabase();
  });

  // ===== 基本中文 =====
  it("纯中文字符串存储", () => {
    setSetting("codem-test", "你好世界，这是一个测试");
    expect(getSetting("codem-test")).toBe("你好世界，这是一个测试");
  });

  it("中英混合字符串存储", () => {
    const val = "Hello 世界 World 你好";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("中文标点符号", () => {
    const val = "「你好」，「世界」。这是——测试……";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  // ===== 基本 Emoji =====
  it("单个 emoji 存储和读取", () => {
    setSetting("codem-test", "⚡");
    expect(getSetting("codem-test")).toBe("⚡");
  });

  it("多个 emoji 连续存储", () => {
    const val = "⚡🤖🦊🐱🔮🌙🎯💎🚀🧠🎭🌊";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  // ===== 复合 Emoji（多 codepoint） =====
  it("复合 emoji（肤色修饰符）存储", () => {
    const val = "🧑‍💻👨‍👩‍👧‍👦🦄";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("国旗 emoji 存储", () => {
    const val = "🇨🇳🇺🇸🇯🇵🇬🇧";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("Emoji + ZWJ（零宽连接符）序列", () => {
    const val = "👨‍💻👩‍🎨👮‍♀️";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  // ===== JSON 对象中的中文/Emoji =====
  it("codem-settings 包含中文 provider 名称和 emoji", () => {
    const settings = {
      mode: "api" as const,
      model: "gpt-4o",
      theme: "dark" as const,
      providers: [
        { id: "openai", name: "OpenAI 开放平台", apiKey: "sk-中文key", baseUrl: "https://api.openai.com/v1" },
        { id: "deepseek", name: "深度求索 🔍", apiKey: "sk-ds", baseUrl: "https://api.deepseek.com/v1" },
      ],
    };
    setSettingJSON("codem-settings", settings);
    const loaded = getSettingJSON<typeof settings>("codem-settings", null as any);
    expect(loaded).not.toBeNull();
    expect(loaded.providers[0].name).toBe("OpenAI 开放平台");
    expect(loaded.providers[0].apiKey).toBe("sk-中文key");
    expect(loaded.providers[1].name).toBe("深度求索 🔍");
  });

  it("codem-identity 包含中文身份描述和 emoji 标志", () => {
    const identity = {
      name: "小闪电 ⚡",
      creature: "赛博管家 🤖",
      vibe: "犀利、幽默、毒舌 😏",
      emoji: "⚡",
      avatar: "",
      raw: "",
    };
    setSettingJSON("codem-identity", identity);
    const loaded = getSettingJSON<typeof identity>("codem-identity", null as any);
    expect(loaded.name).toBe("小闪电 ⚡");
    expect(loaded.creature).toBe("赛博管家 🤖");
    expect(loaded.vibe).toBe("犀利、幽默、毒舌 😏");
  });

  it("codem-user 包含中文用户信息和备注", () => {
    const user = {
      name: "张三丰",
      callBy: "老张",
      pronouns: "他/他的",
      timezone: "Asia/Shanghai",
      notes: "喜欢用 Python 🐍，讨厌 Java ☕",
      context: "正在做一个全栈项目，前端 React + 后端 FastAPI",
      raw: "",
    };
    setSettingJSON("codem-user", user);
    const loaded = getSettingJSON<typeof user>("codem-user", null as any);
    expect(loaded.name).toBe("张三丰");
    expect(loaded.notes).toBe("喜欢用 Python 🐍，讨厌 Java ☕");
    expect(loaded.context).toContain("FastAPI");
  });

  it("codem-app-identity 包含中文和 emoji", () => {
    const identity = {
      name: "代码精灵 🧚",
      creature: "AI 助手",
      vibe: "温暖、耐心、鼓励型",
      emoji: "🧚",
      avatar: "",
      onboarded: true,
    };
    setSettingJSON("codem-app-identity", identity);
    const loaded = getSettingJSON<typeof identity>("codem-app-identity", null as any);
    expect(loaded.name).toBe("代码精灵 🧚");
    expect(loaded.emoji).toBe("🧚");
  });

  // ===== 特殊编码场景 =====
  it("包含 Unicode 转义序列的 JSON 值", () => {
    const val = { text: "\\u4f60\\u597d", emoji: "\\u26a1" };
    setSettingJSON("codem-test", val);
    const loaded = getSettingJSON<typeof val>("codem-test", null as any);
    expect(loaded.text).toBe("\\u4f60\\u597d");
    expect(loaded.emoji).toBe("\\u26a1");
  });

  it("包含换行符和 Tab 的中文文本", () => {
    const val = "第一行\n第二行\t缩进\n第三行「你好」";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("超长中文字符串（10000字）", () => {
    const val = "你好世界".repeat(2500);
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
    expect(getSetting("codem-test")!.length).toBe(10000);
  });

  it("混合 emoji、中文、英文、数字、符号的复杂字符串", () => {
    const val = "Hello 世界 123！⚡🤖 \n\t 这是一条「测试」消息 🚀✨";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("null 字节不出现在值中（SQLite TEXT 不支持 null 字节）", () => {
    // SQLite TEXT 类型不支持中间嵌入 null 字节
    // 如果值中有 \0，应被正确处理或移除
    const val = "hello\x00world";
    setSetting("codem-test", val);
    const loaded = getSetting("codem-test");
    // SQLite 可能截断或保留 \0，验证至少不崩溃
    expect(loaded).not.toBeNull();
    expect(loaded!.startsWith("hello")).toBe(true);
  });

  it("MCP 服务器配置包含中文命令路径", () => {
    const configs = [
      { name: "中文服务器", transport: "stdio" as const, command: "D:\\程序\\工具\\server.exe" },
    ];
    setSettingJSON("codem-mcp-servers", configs);
    const loaded = getSettingJSON<typeof configs>("codem-mcp-servers", []);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("中文服务器");
    expect(loaded[0].command).toBe("D:\\程序\\工具\\server.exe");
  });

  it("Cost tracker 数据包含中文模型描述", () => {
    const costData = {
      totalCost: 9.99,
      records: [
        { model: "gpt-4o", provider: "OpenAI 开放平台", cost: 0.01 },
        { model: "mimo-v2.5-pro", provider: "小米MiMo ⚡", cost: 0.003 },
      ],
    };
    setSettingJSON("codem-cost-tracker", costData);
    const loaded = getSettingJSON<typeof costData>("codem-cost-tracker", null as any);
    expect(loaded.records[1].provider).toBe("小米MiMo ⚡");
  });
});
