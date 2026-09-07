/**
 * ComputerUseSettings — 电脑操作设置卡（对标 EAC computer-user 设置）
 *
 * - 模式：禁用 / 只读 / 手动批准（默认）/ 自动
 * - AI 可修改模式开关
 * - 截图目录 / 默认缩放 / 输入间隔 / 滚动刻度
 * - 用法说明（/computer 会话批准）
 */
import { useState, useEffect, useCallback } from "react";
import { useLang } from "../core/i18n/lang";
import { getComputerSettings, setComputerMode, type ComputerMode } from "../core/computer-use/computer-use";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";

const MODE_OPTIONS: Array<{ id: ComputerMode; zh: string; en: string; descZh: string }> = [
  { id: "disabled", zh: "禁用", en: "Disabled", descZh: "拒绝所有 computer_* 调用" },
  { id: "readonly", zh: "只读", en: "Read-only", descZh: "仅截图/读光标/等待，不可键鼠操作" },
  { id: "manual", zh: "手动批准", en: "Manual", descZh: "键鼠操作需会话批准（对助手说「批准电脑操作」或输入 /computer）" },
  { id: "auto", zh: "自动", en: "Auto", descZh: "LLM 可自由调用键鼠工具（高危）" },
];

export function ComputerUseSettings() {
  const lang = useLang();
  const zh = lang === "zh";
  const [mode, setMode] = useState<ComputerMode>(() => getComputerSettings().mode);
  const [aiCanChange, setAiCanChange] = useState<boolean>(() => getComputerSettings().ai_can_change_mode);
  const [screenshotDir, setScreenshotDir] = useState<string>(() => getComputerSettings().screenshot_dir);
  const [scale, setScale] = useState<number>(() => getComputerSettings().default_scale);

  const persist = useCallback((partial: Record<string, unknown>) => {
    const cur = getComputerSettings();
    setSettingJSON("codem-computer-user", { ...cur, ...partial });
  }, []);

  const handleMode = (m: ComputerMode) => {
    setMode(m);
    setComputerMode(m);
    persist({ mode: m });
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>
        {zh ? "电脑操作" : "Computer Use"}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.7 }}>
        {zh
          ? "让助手读屏并操作鼠标键盘（Codex-style computer use）。截图后经视觉模型理解，可点击/输入/滚轮/拖拽。工具默认「手动批准」——执行键鼠前需本会话批准（说「批准电脑操作」或输入 /computer）。"
          : "Let the assistant read the screen and control mouse/keyboard (Codex-style). Screenshots are understood via the vision model; the assistant can click/type/scroll/drag. Tools default to manual approval — say \"approve computer use\" or type /computer."}
      </div>

      {/* 模式 */}
      <div className="setting-group">
        <label>{zh ? "运行模式" : "Mode"}</label>
        <div style={{ display: "grid", gap: 6 }}>
          {MODE_OPTIONS.map((opt) => (
            <label
              key={opt.id}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                borderRadius: 8, cursor: "pointer",
                background: mode === opt.id ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-secondary)",
                border: mode === opt.id ? "1px solid var(--accent)" : "1px solid var(--border-primary)",
              }}
            >
              <input
                type="radio"
                checked={mode === opt.id}
                onChange={() => handleMode(opt.id)}
                style={{ accentColor: "var(--accent)" }}
              />
              <span style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{zh ? opt.zh : opt.en}</span>
              <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>{opt.descZh}</span>
            </label>
          ))}
        </div>
      </div>

      {/* AI 可改模式 */}
      <div className="setting-group">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={aiCanChange}
            onChange={(e) => { const v = e.target.checked; setAiCanChange(v); persist({ ai_can_change_mode: v }); }}
            style={{ accentColor: "var(--accent)" }}
          />
          {zh ? "AI 可自行修改运行模式（computer_set_mode 工具）" : "AI may change mode itself (computer_set_mode)"}
        </label>
        <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", marginTop: 4 }}>
          {zh ? "默认关闭——AI 不可自行降级安全模式。开启后 AI 可在被要求时切换模式。" : "Off by default — AI cannot lower the security mode itself."}
        </div>
      </div>

      {/* 高级 */}
      <div className="setting-group">
        <label>{zh ? "截图输出目录（空 = 系统临时目录）" : "Screenshot dir (empty = system temp)"}</label>
        <input
          value={screenshotDir}
          onChange={(e) => { setScreenshotDir(e.target.value); persist({ screenshot_dir: e.target.value }); }}
          placeholder={zh ? "如 D:/codem-shots" : "e.g. D:/codem-shots"}
          style={{ width: "100%", padding: "6px 8px", background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: 6, fontSize: 'var(--fs-sm)', boxSizing: "border-box" }}
        />
      </div>
      <div className="setting-group">
        <label>{zh ? "截图默认缩放" : "Default screenshot scale"}</label>
        <input
          type="range" min={0.1} max={1} step={0.1}
          value={scale}
          onChange={(e) => { const v = parseFloat(e.target.value); setScale(v); persist({ default_scale: v }); }}
          style={{ flex: 1 }}
        />
        <span>{scale.toFixed(1)}</span>
      </div>

      <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", lineHeight: 1.7, borderTop: "1px solid var(--border-primary)", paddingTop: 8 }}>
        {zh
          ? "会话批准：对助手说「批准电脑操作」或输入 /computer（再输一次撤销，重启失效）。插件管理器禁用 @codem/computer-use 可整体关闭。仅 Windows 可用。"
          : "Session approval: tell the assistant \"approve computer use\" or type /computer (toggle off again to revoke; resets on restart). Disable @codem/computer-use in Plugin Manager to turn off entirely. Windows only."}
      </div>
    </div>
  );
}
