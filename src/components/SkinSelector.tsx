/**
 * 皮肤选择器组件
 * 在设置面板中显示，允许用户切换三套皮肤
 *
 * 设计原则：
 * - 只有默认皮肤才显示明暗模式选择（由 Sidebar codem-theme 系统管理）
 * - Hub/Dream 皮肤各自有固定的配色，不需要明暗切换
 */

import { useState, useEffect } from "react";
import { ThemeManager } from "../core/theme";
import type { SkinId } from "../core/theme";
import { getSetting, setSetting } from "../core/storage/settings";
import { useLang, S } from "../core/i18n/lang";

export function SkinSelector() {
  const [skin, setSkin] = useState<SkinId>(ThemeManager.getSkin());
  // 明暗模式读取 codem-theme（与 Sidebar 一致），而非 ThemeManager
  const [themeMode, setThemeMode] = useState<"dark" | "light">(
    () => (getSetting("codem-theme") as "dark" | "light") || "dark"
  );
  const lang = useLang();

  useEffect(() => {
    const unsubscribe = ThemeManager.onChange((newSkin) => {
      setSkin(newSkin);
    });
    return unsubscribe;
  }, []);

  const handleSkinChange = (newSkin: SkinId) => {
    setSkin(newSkin);
    ThemeManager.setSkin(newSkin);
  };

  const handleThemeModeChange = (mode: "dark" | "light") => {
    setThemeMode(mode);
    // 与 Sidebar 使用同一套 codem-theme 系统
    setSetting("codem-theme", mode);
    document.documentElement.setAttribute("data-theme", mode);
  };

  const skins = ThemeManager.getAvailableSkins();

  return (
    <div className="setting-group">
      <label>{lang === "zh" ? "皮肤" : "Skin"}</label>
      <div className="skin-selector-grid">
        {skins.map((s) => (
          <div
            key={s.id}
            className={`skin-card ${skin === s.id ? "active" : ""}`}
            onClick={() => handleSkinChange(s.id)}
          >
            <div className={`skin-preview skin-preview-${s.id}`} />
            <div className="skin-card-name">{s.name}</div>
            <div className="skin-card-desc">{s.description}</div>
          </div>
        ))}
      </div>

      {/* 只有默认皮肤才显示明暗模式选择 */}
      {skin === "default" && (
        <div className="setting-group" style={{ marginTop: "12px" }}>
          <label>{S.settings.theme[lang]}</label>
          <select
            value={themeMode}
            onChange={(e) => handleThemeModeChange(e.target.value as "dark" | "light")}
          >
            <option value="dark">{S.settings.dark[lang]}</option>
            <option value="light">{S.settings.light[lang]}</option>
          </select>
        </div>
      )}

      {skin === "dream" && <DreamConfigPanel />}
    </div>
  );
}

/**
 * 梦幻皮肤配置面板
 */
function DreamConfigPanel() {
  const [dreamConfig, setDreamConfig] = useState(ThemeManager.getDreamConfig());
  const [uploading, setUploading] = useState(false);
  const lang = useLang();

  const updateConfig = (config: Partial<typeof dreamConfig>) => {
    const newConfig = { ...dreamConfig, ...config };
    setDreamConfig(newConfig);
    ThemeManager.updateDreamConfig(config);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { ThemeExtractor } = await import("../core/theme");
      const dataUrl = await ThemeExtractor.fileToDataURL(file);
      await ThemeManager.setDreamBackground(dataUrl, true);
      setDreamConfig(ThemeManager.getDreamConfig());
    } catch (err) {
      console.error("背景图上传失败:", err);
    } finally {
      setUploading(false);
    }
  };

  const handleClearBackground = () => {
    ThemeManager.setDreamBackground(null);
    setDreamConfig(ThemeManager.getDreamConfig());
  };

  return (
    <div className="dream-config-panel" style={{ marginTop: "12px" }}>
      <label>{lang === "zh" ? "背景图片" : "Background Image"}</label>
      <div className="dream-bg-upload">
        {dreamConfig.backgroundImage ? (
          <div className="dream-bg-preview">
            <img src={dreamConfig.backgroundImage} alt="背景预览" />
            <button className="btn-clear-bg" onClick={handleClearBackground}>
              {lang === "zh" ? "清除" : "Clear"}
            </button>
          </div>
        ) : (
          <label className="dream-bg-upload-area">
            <input
              type="file"
              accept="image/*"
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
            <span>{uploading ? "⏳..." : lang === "zh" ? "📷 点击上传背景图" : "📷 Click to upload"}</span>
          </label>
        )}
      </div>

      {dreamConfig.extractedPalette && (
        <div className="dream-palette-info">
          <label>{lang === "zh" ? "提取的主题色" : "Extracted Palette"}</label>
          <div className="palette-swatches">
            {dreamConfig.extractedPalette.palette.map((color, i) => (
              <div
                key={i}
                className="palette-swatch"
                style={{ background: color }}
                title={color}
              />
            ))}
          </div>
          <div className="palette-details">
            <span>{lang === "zh" ? "主色调" : "Dominant"}: {dreamConfig.extractedPalette.dominant}</span>
            <span>{lang === "zh" ? "强调色" : "Accent"}: {dreamConfig.extractedPalette.accent}</span>
          </div>
        </div>
      )}

      <div className="setting-group" style={{ marginTop: "12px" }}>
        <label>{lang === "zh" ? "毛玻璃模糊度" : "Blur Radius"}: {dreamConfig.blurRadius}px</label>
        <input
          type="range"
          min="0"
          max="30"
          value={dreamConfig.blurRadius}
          onChange={(e) => updateConfig({ blurRadius: Number(e.target.value) })}
        />
      </div>

      <div className="setting-group">
        <label>{lang === "zh" ? "卡片透明度" : "Card Opacity"}: {Math.round(dreamConfig.cardOpacity * 100)}%</label>
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.05"
          value={dreamConfig.cardOpacity}
          onChange={(e) => updateConfig({ cardOpacity: Number(e.target.value) })}
        />
      </div>

      <div className="setting-group dream-toggles">
        <label>
          <input
            type="checkbox"
            checked={dreamConfig.decorations}
            onChange={(e) => updateConfig({ decorations: e.target.checked })}
          />
          {lang === "zh" ? "显示装饰元素" : "Show decorations"}
        </label>
        <label>
          <input
            type="checkbox"
            checked={dreamConfig.polaroid}
            onChange={(e) => updateConfig({ polaroid: e.target.checked })}
          />
          {lang === "zh" ? "显示拍立得" : "Show polaroid"}
        </label>
        <label>
          <input
            type="checkbox"
            checked={dreamConfig.scriptFont}
            onChange={(e) => updateConfig({ scriptFont: e.target.checked })}
          />
          {lang === "zh" ? "手写标题字体" : "Script font title"}
        </label>
      </div>

      <div className="setting-group">
        <label>{lang === "zh" ? "安全区" : "Safe Area"}</label>
        <select
          value={dreamConfig.safeArea}
          onChange={(e) => updateConfig({ safeArea: e.target.value as typeof dreamConfig.safeArea })}
        >
          <option value="auto">{lang === "zh" ? "自动" : "Auto"}</option>
          <option value="left">{lang === "zh" ? "左侧" : "Left"}</option>
          <option value="right">{lang === "zh" ? "右侧" : "Right"}</option>
          <option value="center">{lang === "zh" ? "居中" : "Center"}</option>
          <option value="none">{lang === "zh" ? "无" : "None"}</option>
        </select>
      </div>
    </div>
  );
}
