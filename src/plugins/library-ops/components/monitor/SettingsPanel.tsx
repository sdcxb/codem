/**
 * SettingsPanel —— 插件设置（仅影响本插件，不写入宿主设置）。
 *
 * 设置持久化到 localStorage `codem-library-ops`；插件关闭时保留，
 * 重新启用后继续沿用。
 */

import type { LibraryOpsSettings, MonitorTab } from "../../types";
import { DEFAULT_SETTINGS } from "../../types";
import { SCENE_CREDITS } from "../../data/pixel-art";
import { useLibraryOps } from "../../store";
import { Card, Field, Pill, SectionTitle, Switch } from "./common";
import { SceneImageCard } from "./SceneImageCard";

const TABS: Array<{ id: MonitorTab; zh: string; en: string; icon: string }> = [
  { id: "library", zh: "场景", en: "Scene", icon: "📚" },
  { id: "usage", zh: "用量", en: "Usage", icon: "📊" },
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
        <SectionTitle hint={zh ? "像素美术资源仅限非商业使用" : "pixel art is non-commercial only"}>
          {zh ? "场景风格" : "Scene style"}
        </SectionTitle>
        <div className="lo-chip-row">
          {(
            [
              { id: "pixel", icon: "🖼️", zh: "像素图书馆", en: "Pixel library" },
              { id: "iso", icon: "📐", zh: "等距矢量", en: "Isometric vector" },
            ] as const
          ).map((s) => (
            <button
              key={s.id}
              className={`lo-chip${settings.sceneStyle === s.id ? " is-active" : ""}`}
              onClick={() => update({ sceneStyle: s.id })}
            >
              {s.icon} {zh ? s.zh : s.en}
            </button>
          ))}
        </div>
        <p className="lo-note">
          {settings.sceneStyle === "pixel"
            ? zh
              ? "像素图书馆的「画面」可以在下面换成内置场景图或你自己上传的图；角色与岗位布局不变。"
              : "In pixel mode you can swap the scene image below (built-in or your own upload)."
            : zh
              ? "等距矢量场景由本项目自绘，无第三方美术许可约束。"
              : "Isometric vector scene is drawn by this project; no third-party art license constraints."}
        </p>
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

      <SceneImageCard zh={zh} />

      <Card title={zh ? "美术资源许可" : "Art asset licenses"} icon="⚖️">
        <div className="lo-credits">
          {SCENE_CREDITS.map((c) => (
            <div key={c.project} className="lo-credits__item">
              <div className="lo-credits__head">
                <strong>{c.project}</strong>
                {!c.commercial && <Pill token="--warning">{zh ? "仅限非商业" : "non-commercial"}</Pill>}
              </div>
              <div className="lo-credits__meta">
                {zh ? "作者" : "By"} {c.author} ·{" "}
                <a className="lo-link-btn" href={c.repo} target="_blank" rel="noreferrer">
                  {zh ? "仓库" : "repo"}
                </a>{" "}
                ·{" "}
                <a className="lo-link-btn" href={c.licenseUrl} target="_blank" rel="noreferrer">
                  {c.license}
                </a>
              </div>
              <div className="lo-credits__changes">
                {zh ? "改动" : "Changes"}: {c.changes}
              </div>
            </div>
          ))}
        </div>
        <p className="lo-note">
          {zh
            ? "像素美术资源来自第三方项目，仅限学习 / 演示 / 交流等非商业用途；商业分发必须替换为自有资源（或改用「等距矢量」场景）。完整声明见仓库 THIRD_PARTY_NOTICES.md 与 docs/ASSET-LICENSES.md。"
            : "Third-party pixel art is non-commercial only. Full notices: THIRD_PARTY_NOTICES.md / docs/ASSET-LICENSES.md."}
        </p>
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
