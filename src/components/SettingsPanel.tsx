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
import { getNotebookConfig } from "../core/knowledge";
import { SkinSelector } from "./SkinSelector";
import { GitConfigSection, EnvironmentConfigSection } from "./GitEnvSettings";
import { getWorktreeSettings, setWorktreeSettings, type WorktreeInfo } from "../core/environment";
import { useProjectStore } from "../core/store";
import { getAutomationConfig, setAutomationConfig, refreshAutomationEngines, stopAutomationEngines, type AutomationTrigger, type TriggerType } from "../core/automation/automation-manager";

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
  /** Open a specific tab on mount (e.g. "automation") */
  initialTab?: string;
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

export function SettingsPanel({ onClose, onSessionRecovery, onUsageStats, initialTab }: SettingsPanelProps) {
  const lang = useLang();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [identity, setIdentity] = useState<IdentityConfig>(defaultIdentity);
  const [userConfig, setUserConfig] = useState<UserConfig>(defaultUser);
  const [saved, setSaved] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [mimoAccount, setMimoAccount] = useState<{ email: string; uid: string } | null>(null);
  const [loginStatus, setLoginStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [fontFamily, setFontFamily] = useState<string>(getSetting("codem-font-family") || "AlimamaFangYuanTi");
  const [fontWeight, setFontWeight] = useState<string>(getSetting("codem-font-weight") || "400");

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

    // Trigger engine reconfigure (mode/provider/apiKey may have changed)
    window.dispatchEvent(new Event("codem-settings-changed"));

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
const [activeTab, setActiveTab] = useState<"general" | "appearance" | "security" | "git" | "environment" | "worktree" | "knowledge" | "automation" | "multimodal">((initialTab as any) || "general");
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
          <div className="settings-sidebar">
            <button className={`settings-sidebar-item ${activeTab === "general" ? "active" : ""}`} onClick={() => setActiveTab("general")}>
              <span className="sidebar-icon">⚙️</span>{lang === "zh" ? "通用" : "General"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "appearance" ? "active" : ""}`} onClick={() => setActiveTab("appearance")}>
              <span className="sidebar-icon">🎨</span>{lang === "zh" ? "外观" : "Appearance"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "security" ? "active" : ""}`} onClick={() => setActiveTab("security")}>
              <span className="sidebar-icon">🔒</span>{lang === "zh" ? "安全" : "Security"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "git" ? "active" : ""}`} onClick={() => setActiveTab("git")}>
              <span className="sidebar-icon">🔀</span>{lang === "zh" ? "Git" : "Git"}
            </button>
<button className={`settings-sidebar-item ${activeTab === "environment" ? "active" : ""}`} onClick={() => setActiveTab("environment")}>
<span className="sidebar-icon">🏗️</span>{lang === "zh" ? "环境" : "Environment"}
</button>
<button className={`settings-sidebar-item ${activeTab === "worktree" ? "active" : ""}`} onClick={() => setActiveTab("worktree")}>
<span className="sidebar-icon">🌲</span>{lang === "zh" ? "工作树" : "Worktree"}
</button>
<button className={`settings-sidebar-item ${activeTab === "knowledge" ? "active" : ""}`} onClick={() => setActiveTab("knowledge")}>
<span className="sidebar-icon">📓</span>{lang === "zh" ? "知识" : "Knowledge"}
</button>
<button className={`settings-sidebar-item ${activeTab === "automation" ? "active" : ""}`} onClick={() => setActiveTab("automation")}>
<span className="sidebar-icon">🤖</span>{lang === "zh" ? "自动化" : "Automation"}
</button>
            <button className={`settings-sidebar-item ${activeTab === "multimodal" ? "active" : ""}`} onClick={() => setActiveTab("multimodal")}>
              <span className="sidebar-icon">🤖</span>{lang === "zh" ? "多模态" : "Multimodal"}
            </button>
          </div>

          <div className="settings-content">
          {activeTab === "general" && (
          <>
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

</>
          )}
          {activeTab === "appearance" && (
          <>
          <SkinSelector />

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

          <div className="setting-group">
            <label>{lang === "zh" ? "字体粗细 (wght)" : "Font Weight (wght)"}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="range"
                min={100}
                max={900}
                step={50}
                value={fontWeight}
                onChange={(e) => {
                  const w = e.target.value;
                  setFontWeight(w);
                  setSetting("codem-font-weight", w);
                  document.documentElement.style.setProperty("--font-weight", w);
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 36, textAlign: "right", fontFamily: "var(--font-family)", fontWeight: Number(fontWeight) }}>
                {fontWeight}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {lang === "zh" ? "100=极细 · 400=常规 · 700=粗体 · 900=极粗" : "100=Thin · 400=Regular · 700=Bold · 900=Black"}
            </div>
          </div>

</>
          )}
          {activeTab === "security" && (
          <>
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

          <div className="setting-group">
            <label>{lang === "zh" ? "全局字体" : "Font Family"}</label>
            <select
              value={fontFamily}
              onChange={(e) => {
                setFontFamily(e.target.value);
                setSetting("codem-font-family", e.target.value);
                document.documentElement.style.setProperty("--font-family", e.target.value);
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
              style={{ fontSize: 13, fontFamily: "inherit" }}
            >
              <option value="AlimamaFangYuanTi">Alimama 方圆体 (默认)</option>
              <option value="Inter, sans-serif">Inter</option>
              <option value="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">System Default</option>
              <option value="'Courier New', monospace">Courier New</option>
              <option value="Georgia, serif">Georgia</option>
            </select>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {lang === "zh" ? "选择应用全局使用的字体（外观选项卡可调粗细）" : "Select the global font (adjust weight in Appearance tab)"}
            </div>
          </div>

</>
          )}
          {activeTab === "general" && (
          <>
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

</>
          )}
          {activeTab === "multimodal" && (
          <>
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

          </>
          )}
{activeTab === "knowledge" && (
<>
{/* F8: Notebook Knowledge Settings */}
<NotebookSettingsSection />
</>
)}
{activeTab === "automation" && (
<>
{/* Automation triggers */}
<AutomationSettingsSection lang={lang} />
</>
)}
          {activeTab === "security" && (
          <>
          {/* F3.5: Custom Permission Rules UI */}
          <PermissionRulesSection />
          </>
          )}
          {activeTab === "git" && (
          <>
          {/* G series: Git Preferences */}
          <GitConfigSection />
          </>
          )}
{activeTab === "environment" && (
<>
{/* ENV series: Environment Scripts */}
<EnvironmentConfigSection />
</>
)}
{activeTab === "worktree" && (
<>
{/* Worktree Settings */}
<WorktreeSettingsSection lang={lang} />
</>
)}
          </div>
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

// ========== Worktree Settings Section ==========

function WorktreeSettingsSection({ lang }: { lang: ReturnType<typeof useLang> }) {
  const zh = lang === "zh";
  const [settings, setSettings] = useState(() => getWorktreeSettings());
  const [scanResults, setScanResults] = useState<WorktreeInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const { currentProject } = useProjectStore();
  const [scanError, setScanError] = useState<string | null>(null);

  // Load settings
  useEffect(() => {
    setSettings(getWorktreeSettings());
    const handler = () => setSettings(getWorktreeSettings());
    window.addEventListener("codem-worktree-settings-changed", handler);
    return () => window.removeEventListener("codem-worktree-settings-changed", handler);
  }, []);

  // Scan worktrees for current project
  const handleScan = async () => {
    if (!currentProject?.path) {
      setScanError(zh ? "请先选择项目" : "Select a project first");
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      const { getWorktreeRoot, scanWorktrees } = await import("../core/environment");
      const root = getWorktreeRoot(currentProject.path);
      const results = await scanWorktrees(root);
      setScanResults(results);
    } catch (e: any) {
      setScanError(e?.message || String(e));
    } finally {
      setScanning(false);
    }
  };

  // Delete a worktree
  const handleDelete = async (wt: WorktreeInfo) => {
    if (!currentProject?.path) return;
    if (wt.hasUncommitted) {
      if (!confirm(zh ? `工作树 ${wt.sessionId} 有未提交修改，确认删除？` : `Worktree ${wt.sessionId} has uncommitted changes. Delete anyway?`)) {
        return;
      }
    }
    try {
      const { removeWorktree } = await import("../core/environment");
      await removeWorktree(currentProject.path, wt.path);
      handleScan(); // Refresh
    } catch (e: any) {
      setScanError(e?.message || String(e));
    }
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4,
    display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "6px 10px", borderRadius: 4,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)", color: "var(--text-primary)",
    fontSize: 13, width: 80,
  };

  return (
    <div className="setting-group">
      <label style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "block" }}>
        🌲 {zh ? "Git 工作树管理" : "Git Worktree Management"}
      </label>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        {zh
          ? "管理 Git Worktree 的创建、清理和数量限制。工作树模式为每个任务创建独立的文件系统目录，实现真正的并行隔离。"
          : "Manage Git Worktree creation, cleanup, and limits. Worktree mode creates isolated filesystem directories per task for true parallel isolation."}
      </div>

      {/* Max worktrees */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>{zh ? "最大工作树数量" : "Max Worktrees"}</label>
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={settings.maxWorktrees}
          onChange={(e) => {
            const val = parseInt(e.target.value) || 15;
            setWorktreeSettings({ maxWorktrees: val });
            setSettings(getWorktreeSettings());
          }}
          style={inputStyle}
        />
        <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>
          {zh ? "超过此数量自动清理最旧的（默认 15）" : "Auto-clean oldest when exceeded (default 15)"}
        </span>
        {scanResults.length > 0 && (
          <span style={{ fontSize: 11, marginLeft: 12, color: scanResults.length >= settings.maxWorktrees ? "#e74c3c" : "#22c55e" }}>
            {zh ? `当前: ${scanResults.length}/${settings.maxWorktrees}` : `Current: ${scanResults.length}/${settings.maxWorktrees}`}
          </span>
        )}
      </div>

      {/* Auto clean oldest */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={settings.autoCleanOldest}
            onChange={(e) => {
              setWorktreeSettings({ autoCleanOldest: e.target.checked });
              setSettings(getWorktreeSettings());
            }}
            style={{ width: 16, height: 16 }}
          />
          <span>{zh ? "自动清理最旧工作树" : "Auto-clean oldest worktrees"}</span>
        </label>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, marginLeft: 24 }}>
          {zh ? "新建工作树时，如果超过上限，自动删除最旧的非活跃工作树。" : "When creating a new worktree, auto-remove the oldest inactive one if limit exceeded."}
        </div>
      </div>

      {/* Warn on dirty */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={settings.warnOnDirty}
            onChange={(e) => {
              setWorktreeSettings({ warnOnDirty: e.target.checked });
              setSettings(getWorktreeSettings());
            }}
            style={{ width: 16, height: 16 }}
          />
          <span>{zh ? "归档前检查未提交修改" : "Warn on uncommitted changes before archive"}</span>
        </label>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, marginLeft: 24 }}>
          {zh ? "删除工作树前检查是否有未提交的代码，有则提示确认。" : "Check for uncommitted changes before deleting a worktree; prompt for confirmation."}
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border-primary)", margin: "16px 0", paddingTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>
            {zh ? "已有工作树" : "Existing Worktrees"}
          </label>
          <button
            onClick={handleScan}
            disabled={scanning || !currentProject?.path}
            style={{
              padding: "4px 12px", borderRadius: 4, fontSize: 11,
              border: "1px solid var(--border-primary)",
              background: "var(--bg-tertiary)", color: "var(--text-primary)",
              cursor: scanning ? "wait" : "pointer",
            }}
          >
            {scanning ? "⏳" : "🔄"} {zh ? "扫描" : "Scan"}
          </button>
        </div>
        {!currentProject?.path && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {zh ? "请先选择项目" : "Select a project first"}
          </div>
        )}
        {scanError && (
          <div style={{ fontSize: 11, color: "#e74c3c", marginBottom: 8 }}>{scanError}</div>
        )}
        {scanResults.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {scanResults.map(wt => (
              <div key={wt.sessionId} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 8px", borderRadius: 4,
                border: "1px solid var(--border-primary)",
                background: "var(--bg-tertiary)", fontSize: 12,
              }}>
                <span style={{ fontSize: 14 }}>{wt.hasUncommitted ? "⚠️" : "🌲"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{wt.sessionId}</div>
                  <div style={{ fontSize: 10, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis" }}>{wt.path}</div>
                </div>
                <span style={{ fontSize: 10, opacity: 0.7 }}>🌿 {wt.branch}</span>
                {wt.hasUncommitted && (
                  <span style={{ fontSize: 10, color: "#e67e22" }}>
                    {zh ? "未提交" : "dirty"}
                  </span>
                )}
                <button
                  onClick={() => handleDelete(wt)}
                  style={{
                    padding: "2px 8px", borderRadius: 4, fontSize: 11,
                    border: "1px solid #e74c3c", background: "transparent",
                    color: "#e74c3c", cursor: "pointer",
                  }}
                >
                  {zh ? "删除" : "Delete"}
                </button>
              </div>
            ))}
          </div>
        )}
        {scanResults.length === 0 && currentProject?.path && !scanning && !scanError && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {zh ? "无工作树（扫描后显示）" : "No worktrees (scan to see)"}
          </div>
        )}
      </div>
    </div>
  );
}

function NotebookSettingsSection() {
  const lang = useLang();
  const zh = lang === "zh";
  const [config, setConfig] = useState(() => {
    try {
      return getNotebookConfig();
    } catch {
      return { maxChunkSize: 2000, overlapSize: 200, topK: 5, similarityThreshold: 0.3 };
    }
  });

  const updateConfig = (key: string, value: number) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    setSettingJSON('codem-notebook-config', newConfig);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--border-primary)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: 13,
    outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginBottom: 4,
    display: 'block',
  };

  return (
    <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--border-primary)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
      <div className="settings-section-title" style={{ marginBottom: 12 }}>
        {zh ? '📓 知识笔记本设置' : '📓 Notebook Knowledge Settings'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>
            {zh ? '最大分块大小（字符）' : 'Max Chunk Size (chars)'}
          </label>
          <input
            type="number"
            min={500}
            max={8000}
            step={100}
            value={config.maxChunkSize}
            onChange={(e) => updateConfig('maxChunkSize', parseInt(e.target.value) || 2000)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>
            {zh ? '重叠大小（字符）' : 'Overlap Size (chars)'}
          </label>
          <input
            type="number"
            min={0}
            max={1000}
            step={50}
            value={config.overlapSize}
            onChange={(e) => updateConfig('overlapSize', parseInt(e.target.value) || 200)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>
            {zh ? '检索结果数量 (Top-K)' : 'Retrieval Top-K'}
          </label>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={config.topK}
            onChange={(e) => updateConfig('topK', parseInt(e.target.value) || 5)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>
            {zh ? '相似度阈值' : 'Similarity Threshold'}
          </label>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={config.similarityThreshold}
            onChange={(e) => updateConfig('similarityThreshold', parseFloat(e.target.value) || 0.3)}
            style={inputStyle}
          />
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
        {zh
          ? '调整知识笔记本的文本分块和检索参数。较小的分块提供更精确的检索但可能丢失上下文；较大的分块保留更多上下文但可能引入噪声。'
          : 'Adjust text chunking and retrieval parameters for knowledge notebooks. Smaller chunks provide more precise retrieval but may lose context; larger chunks retain more context but may introduce noise.'}
      </p>
    </div>
  );
}

// ========== Automation Settings Section ==========

function AutomationSettingsSection({ lang }: { lang: ReturnType<typeof useLang> }) {
  const zh = lang === "zh";
  const [triggers, setTriggers] = useState<AutomationTrigger[]>([]);
  const [editing, setEditing] = useState<Partial<AutomationTrigger> | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [enginesStopped, setEnginesStopped] = useState(false);

  useEffect(() => {
    const config = getAutomationConfig();
    setTriggers(config.triggers);
    setHistory(config.history || []);
    const handler = () => {
      const c = getAutomationConfig();
      setTriggers(c.triggers);
      setHistory(c.history || []);
    };
    window.addEventListener("codem-automation-config-changed", handler);
    return () => window.removeEventListener("codem-automation-config-changed", handler);
  }, []);

  const handleAdd = () => {
    setEditing({
      id: `trigger-${Date.now()}`,
      name: "",
      type: "timer",
      enabled: true,
      message: "",
      intervalMs: 3600000,
      cooldownMs: 30000,
    });
  };

  const handleSave = () => {
    if (!editing || !editing.name || !editing.message) return;
    const config = getAutomationConfig();
    const existing = config.triggers.findIndex(t => t.id === editing.id);
    if (existing >= 0) {
      config.triggers[existing] = editing as AutomationTrigger;
    } else {
      config.triggers.push(editing as AutomationTrigger);
    }
    setAutomationConfig(config);
    setTriggers(config.triggers);
    setEditing(null);
    // Refresh engines so changes take effect immediately
    refreshAutomationEngines();
  };

  const handleToggle = (id: string) => {
    const t = triggers.find(t => t.id === id);
    if (!t) return;
    const config = getAutomationConfig();
    config.triggers = config.triggers.map(t => t.id === id ? { ...t, enabled: !t.enabled } : t);
    setAutomationConfig(config);
    setTriggers(config.triggers);
    refreshAutomationEngines();
  };

  const handleDelete = (id: string) => {
    const config = getAutomationConfig();
    config.triggers = config.triggers.filter(t => t.id !== id);
    setAutomationConfig(config);
    setTriggers(config.triggers);
    refreshAutomationEngines();
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4, display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 13, width: "100%",
  };

  return (
    <div className="setting-group">
      <label style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, display: "block" }}>
        🤖 {zh ? "自动化任务" : "Automation Triggers"}
      </label>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        {zh
          ? "配置文件监听和定时器触发器，自动创建会话并发送预设消息。支持工作树模式并行隔离。"
          : "Configure file-watch and timer triggers to automatically create sessions and send preset messages. Supports worktree mode for parallel isolation."}
      </div>

      {triggers.map(t => (
        <div key={t.id} style={{
          display: "flex", alignItems: "center", gap: 8, padding: "8px",
          borderRadius: 4, border: "1px solid var(--border-primary)",
          background: "var(--bg-tertiary)", marginBottom: 8, fontSize: 12,
        }}>
          <input type="checkbox" checked={t.enabled} onChange={() => handleToggle(t.id)} style={{ width: 16, height: 16 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{t.name}</div>
            <div style={{ fontSize: 10, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis" }}>
              {t.type === "file_watch" ? "📁" : "⏰"} {t.message}
            </div>
          </div>
          <button onClick={() => setEditing(t)} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "none", color: "var(--text-primary)", cursor: "pointer" }}>
            {zh ? "编辑" : "Edit"}
          </button>
          <button onClick={() => handleDelete(t.id)} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid #e74c3c", background: "none", color: "#e74c3c", cursor: "pointer" }}>
            {zh ? "删除" : "Del"}
          </button>
        </div>
      ))}

      {triggers.length === 0 && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
          {zh ? "无触发器。点击下方按钮添加。" : "No triggers. Click below to add one."}
        </div>
      )}

      <button onClick={handleAdd} style={{
        padding: "8px 16px", borderRadius: 6, fontSize: 13,
        border: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)", color: "var(--text-primary)", cursor: "pointer",
      }}>
        + {zh ? "添加触发器" : "Add Trigger"}
      </button>

      {/* Stop all engines button */}
      {triggers.length > 0 && (
        <button
          onClick={() => {
            stopAutomationEngines();
            setEnginesStopped(true);
            setTimeout(() => setEnginesStopped(false), 3000);
          }}
          style={{
            marginLeft: 8, padding: "8px 16px", borderRadius: 6, fontSize: 13,
            border: "1px solid #e74c3c", background: "none", color: "#e74c3c", cursor: "pointer",
          }}
        >
          {enginesStopped ? "✅ " + (zh ? "已停止" : "Stopped") : (zh ? "停止所有" : "Stop All")}
        </button>
      )}

      {/* Trigger history */}
      {history.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
            📜 {zh ? "触发历史" : "Trigger History"} ({history.length})
          </div>
          <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {history.slice(0, 20).map((h, i) => (
              <div key={i} style={{ fontSize: 10, padding: "4px 6px", borderRadius: 4, background: "var(--bg-tertiary)" }}>
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>{new Date(h.timestamp).toLocaleString()}</span>
                <span style={{ marginLeft: 6 }}>{h.triggerName}</span>
                <span style={{ marginLeft: 6, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", maxWidth: 200 }}>
                  {h.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <div style={{
          marginTop: 16, padding: 12, borderRadius: 8,
          border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
        }}>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>{zh ? "名称" : "Name"}</label>
            <input value={editing.name || ""} onChange={e => setEditing({ ...editing, name: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>{zh ? "类型" : "Type"}</label>
            <select value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value as TriggerType })} style={inputStyle}>
              <option value="timer">{zh ? "定时器" : "Timer"}</option>
              <option value="file_watch">{zh ? "文件监听" : "File Watch"}</option>
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>{zh ? "触发消息" : "Trigger Message"}</label>
            <textarea value={editing.message || ""} onChange={e => setEditing({ ...editing, message: e.target.value })} style={{ ...inputStyle, minHeight: 60 }} />
          </div>
          {editing.type === "file_watch" && (
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>{zh ? "监听文件路径" : "Watch Path"}</label>
              <input value={editing.watchPath || ""} onChange={e => setEditing({ ...editing, watchPath: e.target.value })} style={inputStyle} placeholder={zh ? "C:\\path\\to\\file" : "/path/to/file"} />
            </div>
          )}
          {editing.type === "timer" && (
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>{zh ? "间隔（毫秒）" : "Interval (ms)"}</label>
              <input type="number" value={editing.intervalMs || 3600000} onChange={e => setEditing({ ...editing, intervalMs: parseInt(e.target.value) || 3600000 })} style={{ ...inputStyle, width: 120 }} />
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleSave} disabled={!editing.name || !editing.message} style={{
              padding: "6px 16px", borderRadius: 4, fontSize: 12,
              border: "1px solid var(--accent)", background: "var(--accent)",
              color: "#fff", cursor: "pointer", opacity: (!editing.name || !editing.message) ? 0.5 : 1,
            }}>{zh ? "保存" : "Save"}</button>
            <button onClick={() => setEditing(null)} style={{
              padding: "6px 16px", borderRadius: 4, fontSize: 12,
              border: "1px solid var(--border-primary)", background: "none",
              color: "var(--text-primary)", cursor: "pointer",
            }}>{zh ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
