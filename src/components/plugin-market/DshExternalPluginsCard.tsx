/**
 * 外部 DSH 插件更新卡片（dsh-ops 真实用例）。
 *
 * 它与 `FreeModelPluginCard` 是同一类：不是 Cordis 内置插件，因而单独管理。
 * 本卡片只做「读版本 / 检查更新 / 升级 / 停用」，不执行插件代码。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { IncrementalList } from "../ui/IncrementalList";
import { Switch } from "../ui/switch";
import { ActionIcons, CommonIcons, StatusIcons } from "../../core/icons/icon-map";
import {
  checkDshPluginUpdates,
  isExternalPluginEnabled,
  readDshInstalledPlugins,
  setExternalPluginEnabled,
  upgradeDshPlugin,
  type DshInstalledPlugin,
} from "../../core/plugin-market/external-dsh-plugins";

function renderPluginRow(
  p: DshInstalledPlugin,
  zh: boolean,
  busy: string | null,
  upgrade: (p: DshInstalledPlugin) => Promise<void>,
  toggle: (p: DshInstalledPlugin, enabled: boolean) => void,
) {
  return (
    <div key={p.name} className="dsh-ext-row">
      <strong>{p.name}</strong>
      <Badge variant={p.updateAvailable ? "warning" : "muted"}>
        {p.installedVersion ? `v${p.installedVersion}` : "未安装"}
      </Badge>
      {p.latestVersion && (
        <span className="dsh-ext-meta">
          {p.updateAvailable ? `→ v${p.latestVersion}` : `最新 v${p.latestVersion}`}
        </span>
      )}
      {p.updateAvailable && (
        <button className="dsh-ext-btn dsh-ext-btn--primary" onClick={() => void upgrade(p)} disabled={busy === p.name}>
          {busy === p.name ? (zh ? "升级中…" : "Upgrading…") : zh ? "升级并安装" : "Upgrade"}
        </button>
      )}
      <span className="dsh-ext-toggle">
        <span className="dsh-ext-meta">{p.enabled ? (zh ? "已启用" : "Enabled") : zh ? "已停用" : "Disabled"}</span>
        <Switch checked={p.enabled} onCheckedChange={(v) => toggle(p, v)} />
      </span>
    </div>
  );
}

export function DshExternalPluginsCard({
  zh,
  notify,
}: {
  zh: boolean;
  notify?: (msg: string, type?: "info" | "success" | "error") => void;
}) {
  const [plugins, setPlugins] = useState<DshInstalledPlugin[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await readDshInstalledPlugins();
    setPlugins(list.map((p) => ({ ...p, enabled: isExternalPluginEnabled(p.name) })));
    const firstError = list.find((p) => p.error)?.error;
    setError(firstError ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const list = await checkDshPluginUpdates();
      setPlugins(list);
      const withUpdates = list.filter((p) => p.updateAvailable);
      const failures = list.filter((p) => p.error);
      if (withUpdates.length > 0) {
        notify?.(
          zh
            ? `发现 ${withUpdates.length} 个插件可更新：${withUpdates.map((p) => `${p.name} ${p.installedVersion} → ${p.latestVersion}`).join("、")}`
            : `${withUpdates.length} update(s): ${withUpdates.map((p) => `${p.name} ${p.installedVersion} → ${p.latestVersion}`).join(", ")}`,
          "info",
        );
      } else if (failures.length > 0) {
        notify?.(
          zh ? `检查未完成：${failures.map((p) => `${p.name}: ${p.error}`).join("；")}` : `Check failed: ${failures[0]?.error}`,
          "error",
        );
      } else {
        notify?.(zh ? "已是最新版本" : "Already up to date", "success");
      }
    } finally {
      setChecking(false);
    }
  };

  const upgrade = async (p: DshInstalledPlugin) => {
    setBusy(p.name);
    setError(null);
    try {
      const r = await upgradeDshPlugin(p.name, p.latestVersion);
      if (!r.ok) {
        setError(r.error ?? "upgrade failed");
        notify?.(zh ? `升级失败：${r.error ?? "未知错误"}` : `Upgrade failed: ${r.error ?? "unknown"}`, "error");
      } else {
        notify?.(zh ? `已升级 ${p.name} ${r.from} → ${r.to}` : `Upgraded ${p.name} ${r.from} → ${r.to}`, "success");
        await load();
      }
    } finally {
      setBusy(null);
    }
  };

  const toggle = (p: DshInstalledPlugin, enabled: boolean) => {
    setExternalPluginEnabled(p.name, enabled);
    setPlugins((prev) => prev.map((x) => (x.name === p.name ? { ...x, enabled } : x)));
    notify?.(zh ? `${p.name} 已${enabled ? "启用" : "停用"}` : `${p.name} ${enabled ? "enabled" : "disabled"}`, "info");
  };

  if (plugins.length === 0 && !error) return null;

  return (
    <div className="market-skill-card dsh-ext-card" data-testid="dsh-external-plugins">
      <div className="market-skill-card-header">
        <span className="market-skill-icon">{<CommonIcons.package />}</span>
        <div className="market-skill-card-title">
          <span className="market-skill-name">DSH Ops / DSH 已安装插件</span>
          <Badge variant="muted">外部运行时</Badge>
        </div>
        <div className="dsh-ext-actions">
          <button className="dsh-ext-btn dsh-ext-btn--secondary" onClick={() => void check()} disabled={checking}>
            {checking ? <StatusIcons.loading className="spin" /> : <ActionIcons.refresh />}
            {zh ? " 检查更新" : " Check updates"}
          </button>
        </div>
      </div>
      <div className="dsh-ext-note">
        {zh
          ? "这些是 DSH profile 里 npm 安装的独立插件。Codem 只管理版本与停用状态，不把它们的代码注入 Codem 运行时。"
          : "These are npm plugins installed in the DSH profile. Codem manages version/disabled state only; their code is not injected into the Codem runtime."}
      </div>
      {error && (
        <div className="dsh-ext-error">
          {error}
        </div>
      )}
      <IncrementalList
        className="dsh-ext-body"
        items={plugins}
        initial={20}
        step={20}
        resetKey={plugins.map((p) => `${p.name}@${p.installedVersion}:${p.enabled}`).join("|")}
        moreLabel={(rest, next) => (zh ? `再显示 ${next} 个（还有 ${rest} 个）` : `Show ${next} more (${rest} left)`)}
        renderItem={(p) => renderPluginRow(p, zh, busy, upgrade, toggle)}
      />
    </div>
  );
}
