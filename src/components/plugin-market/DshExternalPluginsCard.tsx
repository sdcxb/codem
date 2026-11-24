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

/**
 * 异常 → 一句可读原因。
 *
 * 本轮修的是一整类缺陷：异步处理器只有 `try/finally`（或者没有 `try`），promise 一旦 reject，
 * 忙碌标记在 `finally` 里复位了，但**用户一个字都看不到**；`load` 那种更糟 ——
 * 读失败反而让整张卡片 `return null`，与「一个都没装」完全不可区分。
 */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
    try {
      const list = await readDshInstalledPlugins();
      setPlugins(list.map((p) => ({ ...p, enabled: isExternalPluginEnabled(p.name) })));
      const firstError = list.find((p) => p.error)?.error;
      setError(firstError ?? null);
    } catch (e) {
      /*
       * 改前没有 try：读失败 ⇒ `plugins` 仍是 `[]`、`error` 仍是 `null`
       * ⇒ 下面那句 `if (plugins.length === 0 && !error) return null` 把**整张卡片吞掉**。
       * 于是「读失败」与「一个都没装」在界面上完全一样，用户连"这是出错了"都不知道。
       * 现在：失败写进 error —— 卡片照常渲染，并把原因显示出来。
       */
      setPlugins([]);
      setError(`读取 DSH 已安装插件失败：${reasonOf(e)}`);
    }
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
    } catch (e) {
      /*
       * 改前只有 `finally`、没有 catch：转圈停了，但用户**看不到任何原因**
       * （「检查更新」看起来像"什么都没发生"）。现在原因同时进卡片错误行与 toast。
       */
      const message = `检查更新失败：${reasonOf(e)}`;
      setError(message);
      notify?.(message, "error");
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
    } catch (e) {
      // 改前只有 `finally`：升级 reject 后按钮恢复了，但用户不知道升级失败了
      const message = `升级「${p.name}」失败：${reasonOf(e)}`;
      setError(message);
      notify?.(message, "error");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (p: DshInstalledPlugin, enabled: boolean) => {
    setExternalPluginEnabled(p.name, enabled);
    setPlugins((prev) => prev.map((x) => (x.name === p.name ? { ...x, enabled } : x)));
    notify?.(zh ? `${p.name} 已${enabled ? "启用" : "停用"}` : `${p.name} ${enabled ? "enabled" : "disabled"}`, "info");
  };

  /*
   * ⚠️ `!error` 这一半是**契约的一半**，不是顺手写的：只有「一个都没装而且没出错」才允许把卡片藏掉。
   * 读失败必须让卡片留下来显示原因 —— 否则「读失败」会伪装成「没装任何插件」。
   */
  if (plugins.length === 0 && !error) return null;

  return (
    /*
     * 这一段是**列表上方的一块元信息**，不再套 `market-skill-card`：
     * 大卡片里再嵌卡片会让「已安装插件」看起来有两个层级。
     * 行本身仍走 `dsh-ext-row`（版本 / 升级 / 停用三个行为原样保留）。
     */
    <section className="dsh-ext-card" data-testid="dsh-external-plugins">
      {/* 复用 dsh-ext-row 的 flex/发丝线，块本身不再是一张卡片 */}
      <div className="dsh-ext-row">
        <CommonIcons.package size={16} strokeWidth={1.5} aria-hidden="true" />
        <strong>DSH Ops · {zh ? "已安装插件" : "Installed plugins"}</strong>
        <span className="dsh-ext-meta">{zh ? "外部运行时" : "External runtime"}</span>
        <div className="dsh-ext-actions">
          <button className="dsh-ext-btn dsh-ext-btn--secondary" onClick={() => void check()} disabled={checking}>
            {checking ? <StatusIcons.loading className="spin" /> : <ActionIcons.refresh />}
            {zh ? " 检查更新" : " Check updates"}
          </button>
        </div>
      </div>
      <p className="dsh-ext-note">
        {zh
          ? "这些是 DSH profile 里 npm 安装的独立插件。Codem 只管理版本与停用状态，不把它们的代码注入 Codem 运行时。"
          : "These are npm plugins installed in the DSH profile. Codem manages version/disabled state only; their code is not injected into the Codem runtime."}
      </p>
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
    </section>
  );
}
