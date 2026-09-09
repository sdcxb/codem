/**
 * SettingsPanel —— 插件设置（仅影响本插件，不写入宿主设置）。
 *
 * 设置持久化到 localStorage `codem-library-ops`；插件关闭时保留，
 * 重新启用后继续沿用。
 */

import type { LibraryOpsSettings, MonitorTab } from "../../types";
import { DEFAULT_SETTINGS } from "../../types";
import { useLibraryOps } from "../../store";
import { Card, Field, SectionTitle, Switch } from "./common";

const TABS: Array<{ id: MonitorTab; zh: string; en: string; icon: string }> = [
  { id: "overview", zh: "总览", en: "Overview", icon: "📊" },
  { id: "library", zh: "图书馆", en: "Library", icon: "📚" },
  { id: "teams", zh: "团队", en: "Teams", icon: "👥" },
  { id: "sessions", zh: "会话", en: "Sessions", icon: "💬" },
  { id: "tools", zh: "工具", en: "Tools", icon: "🔧" },
  { id: "cost", zh: "成本", en: "Cost", icon: "💰" },
  { id: "errors", zh: "错误", en: "Errors", icon: "⚠️" },
  { id: "timeline", zh: "时间线", en: "Timeline", icon: "🕒" },
  { id: "settings", zh: "设置", en: "Settings", icon: "⚙️" },
];

export function SettingsPanel({ zh }: { zh: boolean }) {
  const settings = useLibraryOps((s) => s.settings);
  const update = useLibraryOps((s) => s.updateSettings);
  const samples = useLibraryOps((s) => s.samples);

  return (
    <div className="lo-settings">
      <Card title={zh ? "采样" : "Sampling"} icon="⏱️">
        <div className="lo-fields">
          <Field label={zh ? "采样间隔" : "Refresh interval"}>
            <select
              className="lo-select"
              value={settings.refreshMs}
              onChange={(e) => update({ refreshMs: Number(e.target.value) })}
            >
              {[1000, 1500, 2000, 3000, 5000, 10000].map((v) => (
                <option key={v} value={v}>
                  {v / 1000}s
                </option>
              ))}
            </select>
          </Field>
          <Field label={zh ? "已采样" : "Samples"}>{samples}</Field>
        </div>
        <p className="lo-note">
          {zh
            ? "仅在监控面板打开时采样；关闭面板即停止读取宿主数据。"
            : "Sampling runs only while the panel is open."}
        </p>
      </Card>

      <Card title={zh ? "场景" : "Scene"} icon="📚">
        <div className="lo-fields">
          <Field label={zh ? "动画速度" : "Animation speed"}>
            <input
              className="lo-range"
              type="range"
              min={0.25}
              max={3}
              step={0.25}
              value={settings.speed}
              onChange={(e) => update({ speed: Number(e.target.value) })}
            />
            <span className="lo-range__value">{settings.speed.toFixed(2)}×</span>
          </Field>
          <Field label={zh ? "最多显示角色" : "Max actors"}>
            <input
              className="lo-range"
              type="range"
              min={4}
              max={48}
              step={2}
              value={settings.maxActors}
              onChange={(e) => update({ maxActors: Number(e.target.value) })}
            />
            <span className="lo-range__value">{settings.maxActors}</span>
          </Field>
        </div>
        <div className="lo-switch-list">
          <Switch checked={settings.showNameplates} onChange={(v) => update({ showNameplates: v })} label={zh ? "显示角色名牌" : "Nameplates"} />
          <Switch checked={settings.showBubbles} onChange={(v) => update({ showBubbles: v })} label={zh ? "显示工作气泡" : "Work bubbles"} />
          <Switch checked={settings.showZoneLabels} onChange={(v) => update({ showZoneLabels: v })} label={zh ? "显示岗位标签" : "Zone labels"} />
          <Switch checked={settings.showEventFeed} onChange={(v) => update({ showEventFeed: v })} label={zh ? "显示右侧事件流" : "Event feed"} />
        </div>
      </Card>

      <Card title={zh ? "面板" : "Panel"} icon="🪟">
        <SectionTitle>{zh ? "默认页签" : "Default tab"}</SectionTitle>
        <div className="lo-chip-row">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`lo-chip${settings.defaultTab === t.id ? " is-active" : ""}`}
              onClick={() => update({ defaultTab: t.id })}
            >
              {t.icon} {zh ? t.zh : t.en}
            </button>
          ))}
        </div>
        <div className="lo-switch-list">
          <Switch
            checked={settings.autoOpen}
            onChange={(v) => update({ autoOpen: v })}
            label={zh ? "启动时自动打开监控" : "Auto-open on startup"}
          />
        </div>
        <div className="lo-settings__actions">
          <button className="lo-btn" onClick={() => update({ ...DEFAULT_SETTINGS })}>
            {zh ? "恢复默认设置" : "Reset to defaults"}
          </button>
        </div>
      </Card>

      <Card title={zh ? "关于" : "About"} icon="ℹ️">
        <p className="lo-note">
          {zh
            ? "图书馆运营监控（@codem/ui-library-ops）是完全独立的可启停插件：角色来自团队角色与子智能体，岗位按职责自动分配；监控口径与宿主用量统计一致。关闭插件后，宿主功能与数据完全不受影响。"
            : "Library Ops is a fully independent, toggleable plugin. Closing it leaves host behavior and data untouched."}
        </p>
        <div className="lo-fields">
          <Field label={zh ? "插件 ID" : "Plugin ID"}>@codem/ui-library-ops</Field>
          <Field label={zh ? "场景区域" : "Zones"}>10</Field>
          <Field label={zh ? "角色外观组合" : "Look combinations"}>34,560</Field>
        </div>
      </Card>
    </div>
  );
}
