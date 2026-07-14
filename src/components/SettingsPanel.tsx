import { useState, useEffect } from "react";
import type { IdentityConfig, UserConfig, AppIdentity } from "../core/types";
import { saveAppIdentity } from "../core/config/loader";
import { getMiMoAuth } from "../core/auth/mimo";
import type { LoginResult } from "../core/auth/mimo";
import { getSettingJSON, setSettingJSON, getSetting, setSetting, removeSetting } from "../core/storage/settings";
import { setLang, useLang, S, type Language } from "../core/i18n/lang";
import { ModelProfilePanel } from "./ModelProfilePanel";
import { getPermissionManager, type PermissionRule, type PermissionAction } from "../core/permission/permission";
import { SECURITY_MODES, getGlobalSecurityMode, setGlobalSecurityMode, type SecurityMode } from "../core/permission/security-mode";
import { MultimodalPanel } from "./MultimodalPanel";

interface ProviderKey {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
}

interface Settings {
  mode: "cli" | "api";
  mimoPath: string;
  model: string;
  theme: "dark" | "light";
  fontSize: number;
  autoApprove: boolean;
  language: Language;
  providers: ProviderKey[];
}

const defaultProviders: ProviderKey[] = [
  { id: "mimo", name: "MiMo (小米)", apiKey: "", baseUrl: "https://api.mimo.ai/v1" },
  { id: "openai", name: "OpenAI", apiKey: "", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", apiKey: "", baseUrl: "https://api.anthropic.com/v1" },
  { id: "deepseek", name: "DeepSeek", apiKey: "", baseUrl: "https://api.deepseek.com/v1" },
  { id: "moonshot", name: "Moonshot (Kimi)", apiKey: "", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "gemini", name: "Google Gemini", apiKey: "", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
];

const defaultSettings: Settings = {
  mode: "api",
  mimoPath: "D:\\mimo\\mimo.exe",
  model: "mimo-v2.5-pro",
  theme: "dark",
  fontSize: 14,
  autoApprove: false,
  language: "zh",
  providers: defaultProviders,
};

interface SettingsPanelProps {
  onClose: () => void;
  onSessionRecovery?: () => void;
  onUsageStats?: () => void;
}

const defaultIdentity: IdentityConfig = {
  name: "Codem",
  creature: "AI 助手",
  vibe: "靠谱、直接、有观点",
  emoji: "⚡",
  avatar: "",
  raw: "",
};

const defaultUser: UserConfig = {
  name: "",
  callBy: "",
  pronouns: "",
  timezone: "Asia/Shanghai",
  notes: "",
  context: "",
  raw: "",
};

export function SettingsPanel({ onClose, onSessionRecovery, onUsageStats }: SettingsPanelProps) {
  const lang = useLang();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [identity, setIdentity] = useState<IdentityConfig>(defaultIdentity);
  const [userConfig, setUserConfig] = useState<UserConfig>(defaultUser);
  const [saved, setSaved] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [mimoAccount, setMimoAccount] = useState<{ email: string; uid: string } | null>(null);
  const [loginStatus, setLoginStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    const stored = getSettingJSON<Settings | null>("codem-settings", null);
    if (stored) {
      const parsed = stored;
      if (!parsed.providers) {
        parsed.providers = defaultProviders;
      } else {
        // 补全缺失的 provider（兼容旧版本设置）
        const existingIds = parsed.providers.map((p: ProviderKey) => p.id);
        for (const dp of defaultProviders) {
          if (!existingIds.includes(dp.id)) {
            parsed.providers.push(dp);
          }
        }
      }
      setSettings({ ...defaultSettings, ...parsed });
    }

    // Load language setting (also stored separately for fast access)
    const storedLang = getSetting("codem-language");
    if (storedLang === "en" || storedLang === "zh") {
      setSettings(prev => ({ ...prev, language: storedLang }));
    }

    const storedIdentity = getSettingJSON<IdentityConfig | null>("codem-identity", null);
    if (storedIdentity) {
      const parsed = storedIdentity;
      setIdentity({
        name: parsed.name || defaultIdentity.name,
        creature: parsed.creature || defaultIdentity.creature,
        vibe: parsed.vibe || defaultIdentity.vibe,
        emoji: parsed.emoji || defaultIdentity.emoji,
        avatar: parsed.avatar || "",
        raw: parsed.raw || "",
      });
    }

    // Load user config (name, callBy, timezone, etc.)
    const storedUser = getSettingJSON<UserConfig | null>("codem-user", null);
    console.log("[SettingsPanel] Loading codem-user:", JSON.stringify(storedUser));
    if (storedUser) {
      setUserConfig({
        name: storedUser.name || "",
        callBy: storedUser.callBy || "",
        pronouns: storedUser.pronouns || "",
        timezone: storedUser.timezone || "Asia/Shanghai",
        notes: storedUser.notes || "",
        context: storedUser.context || "",
        raw: storedUser.raw || "",
      });
    }

    // Check MiMo auth.json
    const auth = getMiMoAuth();
    auth.loadFromAuthJson().then((account) => {
      if (account) {
        setMimoAccount({ email: account.email, uid: account.id });
      }
    }).catch(() => {});
  }, []);

  const handleSave = () => {
    setSettingJSON("codem-settings", settings);
    setLang(settings.language);

    const identityToSave: IdentityConfig = {
      name: identity.name,
      creature: identity.creature,
      vibe: identity.vibe,
      emoji: identity.emoji,
      avatar: identity.avatar || "",
      raw: identity.raw || "",
    };
    setSettingJSON("codem-identity", identityToSave);

    const appIdentity: AppIdentity = {
      name: identity.name || "Codem",
      creature: identity.creature,
      vibe: identity.vibe,
      emoji: identity.emoji,
      avatar: identity.avatar || "",
      onboarded: true,
    };
    saveAppIdentity(appIdentity);

    const userToSave: UserConfig = {
      name: userConfig.name,
      callBy: userConfig.callBy || userConfig.name,
      pronouns: userConfig.pronouns || "",
      timezone: userConfig.timezone,
      notes: userConfig.notes || "",
      context: userConfig.context || "",
      raw: userConfig.raw || "",
    };
    setSettingJSON("codem-user", userToSave);

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleLogin = async () => {
    setLoginStatus("loading");
    setLoginError(null);
    try {
      const auth = getMiMoAuth();
      // First try loading from existing auth.json
      const existing = await auth.loadFromAuthJson();
      if (existing) {
        setLoginStatus("success");
        setMimoAccount({ email: existing.email, uid: existing.id });
        window.dispatchEvent(new Event("codem-settings-changed"));
        return;
      }
      // If no existing auth, run mimo providers login
      const result: LoginResult = await auth.login();
      if (result.success) {
        setLoginStatus("success");
        setMimoAccount({ email: "MiMo User", uid: "" });
        window.dispatchEvent(new Event("codem-settings-changed"));
      } else {
        setLoginStatus("error");
        setLoginError(result.error || "Login failed");
      }
    } catch (e) {
      setLoginStatus("error");
      setLoginError(String(e));
    }
  };

  const handleLogout = async () => {
    const auth = getMiMoAuth();
    const account = auth.getActiveAccount();
    if (account) {
      await auth.logout(account.id);
      setMimoAccount(null);
      setLoginStatus("idle");
      window.dispatchEvent(new Event("codem-settings-changed"));
    }
  };

  const [testResult, setTestResult] = useState<string>("");
  const [showModelProfiles, setShowModelProfiles] = useState(false);
  const [showMultimodal, setShowMultimodal] = useState(false);
  const runLoginTest = async () => {
    const lines: string[] = [];
    const log = (msg: string) => { lines.push(msg); console.log(msg); };

    // Test 1: Read auth.json
    log("=== 1. 读取 auth.json ===");
    try {
      const { invoke } = (window as any).__TAURI__.core;
      const auth = await invoke("mimo_read_auth");
      if (auth?.xiaomi?.key) {
        log("✅ key: " + auth.xiaomi.key.substring(0, 10) + "...");
        log("  uid: " + auth.xiaomi.metadata?.uid);
        log("  url: " + auth.xiaomi.metadata?.base_url);
      } else {
        log("❌ auth.json 无 key");
      }
    } catch (e) {
      log("❌ " + e);
      setTestResult(lines.join("\n"));
      return;
    }

    // Test 2: AccountStorage.createAccount upsert
    log("\n=== 2. createAccount upsert ===");
    try {
      const AccountStorage = await import("../core/storage/account");
      const testId = "test-" + Date.now();
      const testAcc = { id: testId, email: "test", url: "https://t", accessToken: "k", isActive: true, createdAt: Date.now(), updatedAt: Date.now() };
      AccountStorage.createAccount(testAcc);
      log("  首次创建: OK");
      AccountStorage.createAccount({ ...testAcc, email: "updated" });
      log("  重复创建(upsert): OK");
      AccountStorage.deleteAccount(testId);
      log("✅ createAccount upsert 正常");
    } catch (e) {
      log("❌ " + e);
    }

    // Test 3: loadFromAuthJson
    log("\n=== 3. loadFromAuthJson ===");
    try {
      const { getMiMoAuth } = await import("../core/auth/mimo");
      const auth = getMiMoAuth();
      const account = await auth.loadFromAuthJson();
      if (account) {
        log("✅ id: " + account.id);
        log("  email: " + account.email);
        log("  token: " + account.accessToken.substring(0, 10) + "...");
      } else {
        log("❌ 返回 null");
      }
    } catch (e) {
      log("❌ " + e);
    }

    // Test 4: getActiveAccount
    log("\n=== 4. getActiveAccount ===");
    try {
      const { getMiMoAuth } = await import("../core/auth/mimo");
      const active = getMiMoAuth().getActiveAccount();
      log(active ? "✅ " + active.email : "❌ null");
    } catch (e) {
      log("❌ " + e);
    }

    // Test 5: API call
    log("\n=== 5. MiMo API 调用 ===");
    try {
      const { getMiMoAuth } = await import("../core/auth/mimo");
      const acc = getMiMoAuth().getActiveAccount();
      if (acc) {
        // Test non-streaming
        log("  测试非 streaming...");
        const r = await fetch(acc.url + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + acc.accessToken },
          body: JSON.stringify({ model: "mimo-v2.5-pro", messages: [{ role: "user", content: "say hi" }], max_tokens: 20 }),
        });
        log("  非streaming HTTP " + r.status);
        if (r.ok) {
          const d = await r.json();
          log("✅ 非streaming 响应: " + JSON.stringify(d).substring(0, 120));
        } else {
          log("❌ " + (await r.text()).substring(0, 100));
        }

        // Test streaming
        log("  测试 streaming...");
        const rs = await fetch(acc.url + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + acc.accessToken },
          body: JSON.stringify({ model: "mimo-v2.5-pro", messages: [{ role: "user", content: "say hi" }], max_tokens: 20, stream: true }),
        });
        log("  streaming HTTP " + rs.status);
        if (rs.ok && rs.body) {
          const reader = rs.body.getReader();
          const decoder = new TextDecoder();
          let chunks = 0;
          let text = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks++;
            text += decoder.decode(value, { stream: true });
          }
          log("✅ streaming OK: " + chunks + " chunks, " + text.length + " bytes");
        } else {
          log("❌ streaming failed: " + rs.status);
        }
      } else {
        log("❌ 无活跃账号");
      }
    } catch (e) {
      log("❌ " + e);
    }

    // Summary
    const passed = lines.filter((l) => l.startsWith("✅")).length;
    const failed = lines.filter((l) => l.startsWith("❌")).length;
    log("\n=== 结果: " + passed + " 通过, " + failed + " 失败 ===");
    setTestResult(lines.join("\n"));
  };

  const updateProvider = (id: string, update: Partial<ProviderKey>) => {
    setSettings({
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === id ? { ...p, ...update } : p
      ),
    });
  };

  const toggleShowKey = (id: string) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>{S.settings.title[lang]}</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          <div className="settings-mode-switch">
            <label className="mode-label">{S.settings.runMode[lang]}</label>
            <div className="mode-options">
              <button
                className={`mode-btn ${settings.mode === "api" ? "active" : ""}`}
                onClick={() => {
                  const newSettings = { ...settings, mode: "api" as const };
                  setSettings(newSettings);
                  setSettingJSON("codem-settings", newSettings);
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
              >
                <span className="mode-icon">🔑</span>
                <span className="mode-title">{S.settings.apiMode[lang]}</span>
                <span className="mode-desc">{S.settings.apiModeDesc[lang]}</span>
              </button>
              <button
                className={`mode-btn ${settings.mode === "cli" ? "active" : ""}`}
                onClick={() => {
                  const newSettings = { ...settings, mode: "cli" as const };
                  setSettings(newSettings);
                  setSettingJSON("codem-settings", newSettings);
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
              >
                <span className="mode-icon">⚡</span>
                <span className="mode-title">{S.settings.cliMode[lang]}</span>
                <span className="mode-desc">{S.settings.cliModeDesc[lang]}</span>
              </button>
            </div>
          </div>

          {settings.mode === "cli" && (
            <div className="setting-group">
              <label>MiMo 账号</label>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
                登录小米账号，mimo-v2.5-pro 模型免费
              </div>

              {mimoAccount ? (
                <div style={{
                  padding: "8px 12px",
                  background: "var(--bg-secondary)",
                  borderRadius: 6,
                  border: "1px solid var(--border-primary)",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}>
                  <span>✅ 已登录</span>
                  <button
                    onClick={handleLogout}
                    style={{
                      padding: "4px 8px",
                      background: "var(--bg-tertiary)",
                      border: "1px solid var(--border-primary)",
                      borderRadius: 4,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    登出
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleLogin}
                  disabled={loginStatus === "loading"}
                  style={{
                    padding: "8px 16px",
                    background: loginStatus === "loading" ? "var(--bg-tertiary)" : "var(--accent)",
                    color: "var(--text-on-accent)",
                    border: "none",
                    borderRadius: 6,
                    fontSize: 13,
                    cursor: loginStatus === "loading" ? "wait" : "pointer",
                    width: "100%",
                  }}
                >
                  {loginStatus === "loading" ? "正在打开浏览器..." : "⚡ 登录小米账号"}
                </button>
              )}

              {loginStatus === "error" && (
                <div style={{ fontSize: 12, color: "var(--error)", marginTop: 6 }}>
                  {loginError}
                </div>
              )}

              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                点击后会打开浏览器，在浏览器中完成授权即可。
              </div>

              <button
                onClick={runLoginTest}
                style={{
                  marginTop: 12,
                  padding: "6px 12px",
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: 4,
                  fontSize: 12,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                🔍 运行登录测试
              </button>

              {testResult && (
                <pre style={{
                  marginTop: 8,
                  padding: 8,
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: 4,
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  maxHeight: 300,
                  overflow: "auto",
                }}>
                  {testResult}
                </pre>
              )}
            </div>
          )}

          <div className="setting-group">
            <label>{S.settings.model[lang]}</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                style={{ flex: 1 }}
              >
              {settings.mode === "cli" ? (
                <>
                  <option value="mimo-v2.5-pro">MiMo v2.5 Pro (免费)</option>
                  <option value="mimo-v2.5">MiMo v2.5</option>
                  <option value="mimo-v2-pro">MiMo v2 Pro</option>
                  <option value="mimo-v2-flash">MiMo v2 Flash</option>
                </>
              ) : (
                <>
                  {settings.providers.filter(p => p.apiKey).map(p => {
                    const models: Record<string, Array<{id: string, name: string}>> = {
                      openai: [{id:"gpt-4o",name:"GPT-4o"},{id:"gpt-4o-mini",name:"GPT-4o Mini"},{id:"o3",name:"o3"}],
                      anthropic: [{id:"claude-sonnet-4-20250514",name:"Claude Sonnet 4"},{id:"claude-opus-4-20250514",name:"Claude Opus 4"}],
                      deepseek: [
                        {id:"deepseek-v4-flash",name:"DeepSeek V4 Flash"},
                        {id:"deepseek-v4-pro",name:"DeepSeek V4 Pro"},
                      ],
                      moonshot: [{id:"moonshot-v1-8k",name:"Moonshot 8K"},{id:"moonshot-v1-32k",name:"Moonshot 32K"},{id:"moonshot-v1-128k",name:"Moonshot 128K"}],
                      gemini: [{id:"gemini-2.5-flash",name:"Gemini 2.5 Flash"},{id:"gemini-2.5-pro",name:"Gemini 2.5 Pro"},{id:"gemini-2.0-flash",name:"Gemini 2.0 Flash"}],
                    };
                    return (models[p.id] || []).map(m => (
                      <option key={m.id} value={m.id}>{p.name} - {m.name}</option>
                    ));
                  })}
                  {!settings.providers.some(p => p.apiKey && p.id !== "mimo") && (
                    <option value="" disabled>请先配置 API Key</option>
                  )}
                </>
              )}
            </select>
              <button
                onClick={() => setShowModelProfiles(true)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 4,
                  border: "1px solid var(--border-primary)",
                  background: "var(--bg-secondary)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                }}
              >
                {lang === "zh" ? "⚙️ 配置方案" : "⚙️ Profiles"}
              </button>
            </div>
          </div>

          {showModelProfiles && (
            <ModelProfilePanel onClose={() => setShowModelProfiles(false)} />
          )}

          <div className="setting-group">
            <label>{S.settings.theme[lang]}</label>
            <select
              value={settings.theme}
              onChange={(e) => setSettings({ ...settings, theme: e.target.value as "dark" | "light" })}
            >
              <option value="dark">{S.settings.dark[lang]}</option>
              <option value="light">{S.settings.light[lang]}</option>
            </select>
          </div>

          <div className="setting-group">
            <label>语言 / Language</label>
            <select
              value={settings.language}
              onChange={(e) => {
                const lang = e.target.value as Language;
                setLang(lang);
                const newSettings = { ...settings, language: lang };
                setSettings(newSettings);
                setSettingJSON("codem-settings", newSettings);
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>

          <div className="setting-group">
            <label>{S.settings.fontSize[lang]}</label>
            <input
              type="range"
              min="10"
              max="20"
              value={settings.fontSize}
              onChange={(e) => setSettings({ ...settings, fontSize: parseInt(e.target.value) })}
            />
            <span>{settings.fontSize}px</span>
          </div>

          {/* Security Mode — three-tier approval policy */}
          <div className="setting-group">
            <label>{lang === "zh" ? "🔒 安全策略" : "🔒 Security Policy"}</label>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
              {lang === "zh"
                ? "控制 AI 执行操作时的审批级别。项目级设置可覆盖全局策略。"
                : "Control the approval level for AI operations. Per-project settings can override this."}
            </div>
            <SecurityModeSelector
              currentMode={getGlobalSecurityMode()}
              onModeChange={(mode) => {
                setGlobalSecurityMode(mode);
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
              lang={lang}
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.closeBehavior[lang]}</label>
            <select
              value={getSetting("codem-close-behavior") || "ask"}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "ask") {
                  removeSetting("codem-close-behavior");
                } else {
                  setSetting("codem-close-behavior", val);
                }
              }}
            >
              <option value="ask">{S.settings.closeAsk[lang]}</option>
              <option value="tray">{S.settings.closeTray[lang]}</option>
              <option value="close">{S.settings.closeQuit[lang]}</option>
            </select>
          </div>

          <div className="settings-divider" />

          <div className="settings-section-title">{S.settings.identityConfig[lang]}</div>

          <div className="setting-group">
            <label>{S.settings.callMe[lang]}</label>
            <input
              type="text"
              value={identity.name}
              onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
                placeholder="CODEM、小助手、或者随便什么..."
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.whatAmI[lang]}</label>
            <div className="identity-options">
              {["AI 助手", "数字精灵", "代码伙伴", "赛博管家", "电子幽灵"].map((opt) => (
                <button
                  key={opt}
                  className={`identity-option ${identity.creature === opt ? "selected" : ""}`}
                  onClick={() => setIdentity({ ...identity, creature: opt })}
                >
                  {opt}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={identity.creature}
              onChange={(e) => setIdentity({ ...identity, creature: e.target.value })}
              placeholder="或者自己写..."
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.whatStyle[lang]}</label>
            <div className="identity-options">
              {["靠谱、直接、有观点", "温暖、耐心、鼓励型", "犀利、幽默、毒舌", "冷静、专业、简洁", "随性、自然、像朋友"].map((opt) => (
                <button
                  key={opt}
                  className={`identity-option ${identity.vibe === opt ? "selected" : ""}`}
                  onClick={() => setIdentity({ ...identity, vibe: opt })}
                >
                  {opt}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={identity.vibe}
              onChange={(e) => setIdentity({ ...identity, vibe: e.target.value })}
              placeholder="或者自己描述..."
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.myIcon[lang]}</label>
            <div className="identity-emoji-grid">
              {["⚡", "🤖", "🦊", "🐱", "🔮", "🌙", "🎯", "💎", "🚀", "🧠", "🎭", "🌊"].map((e) => (
                <button
                  key={e}
                  className={`identity-emoji ${identity.emoji === e ? "selected" : ""}`}
                  onClick={() => setIdentity({ ...identity, emoji: e })}
                >
                  {e}
                </button>
              ))}
            </div>
            <input
              type="text"
              className="identity-emoji-input"
              value={identity.emoji}
              onChange={(e) => setIdentity({ ...identity, emoji: e.target.value })}
              placeholder="或输入任意 emoji"
            />
          </div>

          <div className="settings-divider" />

          <div className="settings-section-title">{S.settings.aboutYou[lang]}</div>

          <div className="setting-group">
            <label>{S.settings.yourName[lang]}</label>
            <input
              type="text"
              value={userConfig.name}
              onChange={(e) => setUserConfig({ ...userConfig, name: e.target.value })}
              placeholder="怎么称呼你"
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.callYou[lang]}</label>
            <input
              type="text"
              value={userConfig.callBy}
              onChange={(e) => setUserConfig({ ...userConfig, callBy: e.target.value })}
              placeholder="（可选，默认用名字）"
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.yourTimezone[lang]}</label>
            <input
              type="text"
              value={userConfig.timezone}
              onChange={(e) => setUserConfig({ ...userConfig, timezone: e.target.value })}
              placeholder="Asia/Shanghai"
            />
          </div>

          <div className="settings-divider" />

          <div className="settings-section-title">{S.settings.apiConfig[lang]}</div>

          {settings.providers.map((provider) => (
            <div key={provider.id} className="provider-group">
              <div className="provider-header">
                <span className="provider-name">{provider.name}</span>
                {provider.apiKey && <span className="provider-status">✓</span>}
              </div>

              <div className="setting-group">
                <label>API Key</label>
                <div className="api-key-input">
                  <input
                    type={showKeys[provider.id] ? "text" : "password"}
                    value={provider.apiKey}
                    onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                    placeholder={`输入 ${provider.name} API Key`}
                  />
                  <button
                    className="api-key-toggle"
                    onClick={() => toggleShowKey(provider.id)}
                    title={showKeys[provider.id] ? "隐藏" : "显示"}
                  >
                    {showKeys[provider.id] ? "🙈" : "👁️"}
                  </button>
                </div>
              </div>

              <div className="setting-group">
                <label>Base URL</label>
                <input
                  type="text"
                  value={provider.baseUrl}
                  onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
                />
              </div>

              <button
                onClick={() => {
                  // Save settings
                  const newSettings = { ...settings };
                  setSettingJSON("codem-settings", newSettings);
                  // Trigger engine reconfigure
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
                style={{
                  padding: "6px 16px",
background: "var(--accent)",
color: "var(--text-on-accent)",
border: "none",
borderRadius: 4,
fontSize: 12,
cursor: "pointer",
marginTop: 4,
                }}
              >
                {S.settings.saveRefresh[lang]}
              </button>
            </div>
          ))}

          <div className="settings-divider" />

          {/* S5: Sandbox Mode */}
          <div className="setting-group">
            <label>
              <input
                type="checkbox"
                checked={getSetting("codem-sandbox-enabled") === "true"}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSetting("codem-sandbox-enabled", "true");
                  } else {
                    removeSetting("codem-sandbox-enabled");
                  }
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
              />
              {lang === "zh" ? "🔒 沙箱模式（限制写入范围到工作目录）" : "🔒 Sandbox Mode (restrict writes to workspace)"}
            </label>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
              {lang === "zh"
                ? "开启后，AI 助手只能在当前工作目录及其子目录中写入文件，防止意外修改项目外部文件。"
                : "When enabled, the AI assistant can only write files within the current workspace directory and its subdirectories."}
            </div>
          </div>

          {/* F4: Multimodal Settings Entry */}
          <div className="setting-group">
            <label>{lang === "zh" ? "🎨 多模态能力" : "🎨 Multimodal"}</label>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
              {lang === "zh"
                ? "配置 Embedding 语义搜索、TTS 语音合成、ImageGen 图像生成。"
                : "Configure Embedding semantic search, TTS text-to-speech, and ImageGen image generation."}
            </div>
            <button
              onClick={() => setShowMultimodal(true)}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                border: "1px solid var(--border-primary)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                cursor: "pointer",
                fontSize: 13,
                width: "100%",
              }}
            >
              {lang === "zh" ? "🎨 多模态设置" : "🎨 Multimodal Settings"}
            </button>
          </div>

          {showMultimodal && (
            <MultimodalPanel onClose={() => setShowMultimodal(false)} />
          )}

          {/* F3.5: Custom Permission Rules UI */}
          <PermissionRulesSection />
        </div>

        <div className="settings-footer">
          {onSessionRecovery && (
            <button
              className="save-btn"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", marginRight: "auto" }}
              onClick={onSessionRecovery}
            >
              {S.settings.sessionRecovery[lang]}
            </button>
          )}
          {onUsageStats && (
            <button
              className="save-btn"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", marginRight: "8px" }}
              onClick={onUsageStats}
            >
              {S.settings.usageStats[lang]}
            </button>
          )}
          {saved && <span className="save-success">{S.settings.saved[lang]}</span>}
          <button className="save-btn" onClick={handleSave}>{S.settings.saveSettings[lang]}</button>
        </div>
      </div>
    </div>
  );
}

// ========== F3.5: Permission Rules Section ==========

function PermissionRulesSection() {
  const lang = useLang();
  const zh = lang === "zh";
  const [customRules, setCustomRules] = useState<PermissionRule[]>([]);
  const [newRule, setNewRule] = useState<PermissionRule>({
    tool: "*",
    action: "ask",
    resource: "",
  });

  const refresh = () => {
    const evaluator = getPermissionManager().getEvaluator();
    setCustomRules([...evaluator.getCustomRules()]);
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleAdd = () => {
    if (!newRule.tool.trim()) return;
    const evaluator = getPermissionManager().getEvaluator();
    evaluator.addCustomRule({
      tool: newRule.tool.trim(),
      action: newRule.action,
      resource: newRule.resource?.trim() || undefined,
    });
    refresh();
    setNewRule({ tool: "*", action: "ask", resource: "" });
  };

  const handleRemove = (index: number) => {
    const evaluator = getPermissionManager().getEvaluator();
    // Custom rules start after default rules
    const defaultCount = 16;
    evaluator.removeCustomRule(defaultCount + index);
    refresh();
  };

  const actionLabels: Record<PermissionAction, string> = {
    allow: zh ? "✅ 允许" : "✅ Allow",
    deny: zh ? "🚫 禁止" : "🚫 Deny",
    ask: zh ? "❓ 询问" : "❓ Ask",
  };

  const actionColors: Record<PermissionAction, string> = {
    allow: "var(--success)",
    deny: "var(--error)",
    ask: "var(--text-secondary)",
  };

  return (
    <div className="setting-group">
      <div className="settings-section-title">
        {zh ? "🔐 权限规则" : "🔐 Permission Rules"}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        {zh
          ? "自定义工具权限规则。规则按顺序匹配，最后匹配的规则生效。内置规则（受保护路径、危险命令）始终生效。"
          : "Custom tool permission rules. Rules are matched in order, last match wins. Built-in rules (protected paths, dangerous commands) always apply."}
      </div>

      {/* Existing custom rules */}
      {customRules.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {customRules.map((rule, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                background: "var(--bg-secondary)",
                borderRadius: 6,
                border: "1px solid var(--border-primary)",
                fontSize: 12,
              }}
            >
              <span style={{ fontFamily: "monospace", flex: "0 0 auto", color: "var(--text-primary)" }}>
                {rule.tool}
              </span>
              {rule.resource && (
                <>
                  <span style={{ color: "var(--text-muted)" }}>→</span>
                  <span style={{ fontFamily: "monospace", flex: "0 0 auto", color: "var(--text-secondary)" }}>
                    {rule.resource}
                  </span>
                </>
              )}
              <span style={{ color: actionColors[rule.action], fontWeight: 600, marginLeft: "auto" }}>
                {actionLabels[rule.action]}
              </span>
              <button
                onClick={() => handleRemove(i)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "0 4px",
                }}
                title={zh ? "删除" : "Delete"}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {customRules.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, fontStyle: "italic" }}>
          {zh ? "暂无自定义规则" : "No custom rules"}
        </div>
      )}

      {/* Add new rule */}
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "flex-end",
          padding: 10,
          background: "var(--bg-secondary)",
          borderRadius: 6,
          border: "1px solid var(--border-primary)",
        }}
      >
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            {zh ? "工具名 (支持 * 通配)" : "Tool (supports * wildcard)"}
          </label>
          <input
            type="text"
            value={newRule.tool}
            onChange={(e) => setNewRule({ ...newRule, tool: e.target.value })}
            placeholder="bash / write / *"
            style={{ width: "100%", fontSize: 12, fontFamily: "monospace" }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            {zh ? "资源匹配 (可选)" : "Resource (optional)"}
          </label>
          <input
            type="text"
            value={newRule.resource || ""}
            onChange={(e) => setNewRule({ ...newRule, resource: e.target.value })}
            placeholder="rm -rf* / **/.env"
            style={{ width: "100%", fontSize: 12, fontFamily: "monospace" }}
          />
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            {zh ? "动作" : "Action"}
          </label>
          <select
            value={newRule.action}
            onChange={(e) => setNewRule({ ...newRule, action: e.target.value as PermissionAction })}
            style={{ fontSize: 12 }}
          >
            <option value="ask">{zh ? "询问" : "Ask"}</option>
            <option value="allow">{zh ? "允许" : "Allow"}</option>
            <option value="deny">{zh ? "禁止" : "Deny"}</option>
          </select>
        </div>
        <button
          onClick={handleAdd}
          style={{
            padding: "6px 14px",
background: "var(--accent)",
color: "var(--text-on-accent)",
border: "none",
borderRadius: 4,
fontSize: 12,
cursor: "pointer",
whiteSpace: "nowrap",
flex: "0 0 auto",
          }}
        >
          {zh ? "添加" : "Add"}
        </button>
      </div>

      {/* Quick templates */}
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{zh ? "快速添加: " : "Quick add: "}</span>
        {[
          { label: zh ? "禁止 bash sudo" : "Deny sudo", tool: "bash", action: "deny" as PermissionAction, resource: "sudo*" },
          { label: zh ? "允许 read *" : "Allow read", tool: "read", action: "allow" as PermissionAction, resource: "" },
          { label: zh ? "禁止 write *.lock" : "Deny *.lock", tool: "write", action: "deny" as PermissionAction, resource: "**/*.lock" },
          { label: zh ? "询问 bash npm*" : "Ask npm", tool: "bash", action: "ask" as PermissionAction, resource: "npm*" },
        ].map((tpl) => (
          <button
            key={tpl.label}
            onClick={() => {
              const evaluator = getPermissionManager().getEvaluator();
              evaluator.addCustomRule({
                tool: tpl.tool,
                action: tpl.action,
                resource: tpl.resource || undefined,
              });
              refresh();
            }}
            style={{
              padding: "3px 8px",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
              borderRadius: 3,
              fontSize: 11,
              cursor: "pointer",
              color: "var(--text-secondary)",
            }}
          >
            {tpl.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ========== Security Mode Selector Component ==========

export function SecurityModeSelector({
  currentMode,
  onModeChange,
  lang,
  compact,
}: {
  currentMode: SecurityMode;
  onModeChange: (mode: SecurityMode) => void;
  lang: "zh" | "en";
  compact?: boolean;
}) {
  const zh = lang === "zh";
  return (
    <div style={{ display: "flex", gap: compact ? 4 : 8, flexWrap: "wrap" }}>
      {SECURITY_MODES.map((m) => (
        <button
          key={m.mode}
          onClick={() => onModeChange(m.mode)}
          style={{
            flex: compact ? undefined : 1,
            padding: compact ? "4px 8px" : "8px 12px",
            borderRadius: 6,
            border: `1px solid ${currentMode === m.mode ? "var(--accent)" : "var(--border-primary)"}`,
            background: currentMode === m.mode ? "var(--accent)" : "var(--bg-secondary)",
            color: currentMode === m.mode ? "#fff" : "var(--text-primary)",
            cursor: "pointer",
            fontSize: compact ? 11 : 13,
            fontWeight: currentMode === m.mode ? 600 : 400,
            transition: "all 0.15s ease",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
          }}
          title={zh ? m.desc_zh : m.desc_en}
        >
          <span style={{ fontSize: compact ? 12 : 16 }}>{m.icon}</span>
          <span>{zh ? m.label_zh : m.label_en}</span>
          {!compact && (
            <span style={{ fontSize: 10, opacity: 0.8, textAlign: "center", marginTop: 2 }}>
              {zh ? m.desc_zh : m.desc_en}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
