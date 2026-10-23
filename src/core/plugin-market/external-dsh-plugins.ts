/**
 * 外部 DSH 插件（当前以 dsh-ops 为真实用例）的「已安装 / 检查更新 / 升级」。
 *
 * 这里管理的是 **DSH profile 里 npm 安装的插件**，不是 Codem 自己的 Cordis 内置插件：
 * - 安装位置：`<home>/.dsh/profiles/desktop`
 * - 已安装版本：读 `node_modules/<name>/package.json`
 * - 最新版本：`npm view <name> version`
 * - 升级：`npm install <name>@<version> --no-audit --no-fund`
 *
 * 纪律：
 * 1. 读不到 profile / npm 失败时返回 `error`，不把「没查成」伪装成「已是最新」；
 * 2. 升级后必须**回读** package.json 才算成功；
 * 3. 本模块不执行插件代码，也不把插件注入 Codem 运行时；停用只改 Codem 的管理状态。
 */
import { executeCommand, readFile } from "../file-api";
import { getAppDataDir } from "../file-api";
import { getSettingJSON, setSettingJSON } from "../storage/settings";

export interface DshInstalledPlugin {
  name: string;
  installedVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** package.json 所在目录；读不到时为 null */
  path: string | null;
  enabled: boolean;
  error?: string;
}

const DISABLED_KEY = "codem-external-dsh-disabled";

/** `<appData>` → 用户 home。Windows 是 `AppData/Roaming`，Linux 是 `~/.config`。 */
export function homeFromAppData(appData: string): string {
  const normalized = appData.replace(/[\\/]+$/, "");
  // getAppDataDir() 返回的是 **app 专属目录**：`%APPDATA%\com.codem.app`，不是 Roaming 本身。
  const win = normalized.match(/^(.*?)[\\/]AppData[\\/]Roaming(?:[\\/].*)?$/i);
  if (win?.[1]) return win[1];
  const linux = normalized.match(/^(.*?)[\\/]\.config(?:[\\/].*)?$/i);
  if (linux?.[1]) return linux[1];
  return normalized;
}

export function dshProfilePath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.dsh/profiles/desktop`;
}

/** 简单的 semver 比较；只处理数字段 + 可选 prerelease（够 npm 插件用）。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split("-")[0].split(".").map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, "").split("-")[0].split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  const preA = a.includes("-");
  const preB = b.includes("-");
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

function disabledSet(): Set<string> {
  try {
    const raw = getSettingJSON<string[] | null>(DISABLED_KEY, null);
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function isExternalPluginEnabled(name: string): boolean {
  return !disabledSet().has(name);
}

export function setExternalPluginEnabled(name: string, enabled: boolean): void {
  const set = disabledSet();
  if (enabled) set.delete(name);
  else set.add(name);
  setSettingJSON(DISABLED_KEY, [...set]);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

interface DshProfilePackage {
  dependencies?: Record<string, string>;
}

async function profileDependencies(profile: string): Promise<Record<string, string>> {
  const raw = await readText(`${profile}/package.json`);
  if (!raw) return {};
  try {
    const json = JSON.parse(raw) as DshProfilePackage;
    return json.dependencies && typeof json.dependencies === "object" ? json.dependencies : {};
  } catch {
    return {};
  }
}

async function readInstalledVersion(profile: string, name: string): Promise<string | null> {
  const raw = await readText(`${profile}/node_modules/${name}/package.json`);
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as { version?: unknown };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

/** 读取 DSH profile 中已安装的插件（只看 dependencies，不把传递依赖当插件）。 */
export async function readDshInstalledPlugins(): Promise<DshInstalledPlugin[]> {
  try {
    const appData = await getAppDataDir();
    const profile = dshProfilePath(homeFromAppData(appData));
    const deps = await profileDependencies(profile);
    const names = Object.keys(deps).filter((n) => !n.startsWith("@deepseek-ai/") && n !== "dsh-profile-desktop");
    const out: DshInstalledPlugin[] = [];
    for (const name of names) {
      const installedVersion = await readInstalledVersion(profile, name);
      if (!installedVersion) continue;
      out.push({
        name,
        installedVersion,
        latestVersion: null,
        updateAvailable: false,
        path: `${profile}/node_modules/${name}`,
        enabled: isExternalPluginEnabled(name),
      });
    }
    return out;
  } catch (e) {
    return [
      {
        name: "dsh-ops",
        installedVersion: "",
        latestVersion: null,
        updateAvailable: false,
        path: null,
        enabled: isExternalPluginEnabled("dsh-ops"),
        error: e instanceof Error ? e.message : String(e),
      },
    ];
  }
}

async function npmViewLatest(profile: string, name: string): Promise<string | null> {
  const r = await executeCommand(`npm view ${name} version --json`, profile, 30_000);
  if (r.exitCode !== 0) return null;
  const value = (r.stdout || "").trim().replace(/^"|"$/g, "");
  return /^\d+\.\d+\.\d+/.test(value) ? value : null;
}

/** 检查所有已安装 DSH 插件的最新版本；npm 失败的插件保留 installedVersion + error。 */
export async function checkDshPluginUpdates(): Promise<DshInstalledPlugin[]> {
  const plugins = await readDshInstalledPlugins();
  const appData = await getAppDataDir();
  const profile = dshProfilePath(homeFromAppData(appData));
  for (const p of plugins) {
    if (!p.installedVersion) continue;
    try {
      const latest = await npmViewLatest(profile, p.name);
      p.latestVersion = latest;
      p.updateAvailable = !!latest && compareVersions(latest, p.installedVersion) > 0;
      p.error = latest ? undefined : "npm view 失败或未返回版本";
    } catch (e) {
      p.error = e instanceof Error ? e.message : String(e);
    }
  }
  return plugins;
}

/** 升级一个已安装插件到 latest，并回读版本确认。 */
export async function upgradeDshPlugin(
  name: string,
  latestVersion?: string | null,
): Promise<{ ok: boolean; from: string; to: string; error?: string }> {
  const plugins = await readDshInstalledPlugins();
  const before = plugins.find((p) => p.name === name)?.installedVersion ?? "";
  const appData = await getAppDataDir();
  const profile = dshProfilePath(homeFromAppData(appData));
  const spec = latestVersion ? `${name}@${latestVersion}` : `${name}@latest`;
  try {
    const r = await executeCommand(`npm install ${spec} --no-audit --no-fund`, profile, 180_000);
    if (r.exitCode !== 0) {
      return {
        ok: false,
        from: before,
        to: before,
        error: (r.stderr || r.stdout || "npm install 失败").trim().slice(-800),
      };
    }
    const after = (await readInstalledVersion(profile, name)) ?? "";
    return { ok: !!after && after !== before, from: before, to: after };
  } catch (e) {
    return { ok: false, from: before, to: before, error: e instanceof Error ? e.message : String(e) };
  }
}
