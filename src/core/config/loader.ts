import type {
  HierarchicalConfig,
  IdentityConfig,
  UserConfig,
  MergedConfig,
  ConfigLevel,
  AppIdentity,
} from "../types";
import { readFile as apiReadFile, writeFile as apiWriteFile, listDirectory } from "../file-api";

const API_BASE = "http://localhost:3002";

// ========== Config Directory Names ==========
const CONFIG_DIRS: Record<ConfigLevel, string> = {
  app: ".mimo-app",
  project: ".mimo",
  subfolder: ".mimo-sub",
};

// ========== File Read/Write Helpers ==========
async function readFile(path: string): Promise<string> {
  try {
    return await apiReadFile(path);
  } catch {}
  return "";
}

async function writeFile(path: string, content: string): Promise<void> {
  await apiWriteFile(path, content);
}

async function ensureDir(path: string): Promise<void> {
  const isTauri = !!(window as any).__TAURI__;
  if (isTauri) {
    try {
      const { invoke } = (window as any).__TAURI__.core;
      await invoke("execute_command", { command: `mkdir "${path}"` });
    } catch {}
  } else {
    await fetch(`${API_BASE}/api/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  }
}

async function listDir(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
  try {
    return await listDirectory(path);
  } catch {}
  return [];
}

// ========== Identity Parser ==========
function parseIdentity(raw: string): IdentityConfig {
  const get = (key: string): string => {
    const regex = new RegExp(`\\*\\*${key}:\\*\\*\\s*_?\\(?(.*?)\\)?_?`, "i");
    const match = raw.match(regex);
    return match?.[1]?.trim() || "";
  };
  return {
    name: get("Name"),
    creature: get("Creature"),
    vibe: get("Vibe"),
    emoji: get("Emoji"),
    avatar: get("Avatar"),
    raw,
  };
}

function serializeIdentity(config: IdentityConfig): string {
  return `# IDENTITY.md - Who Am I?

- **Name:** ${config.name || "_(pick something you like)_"}
- **Creature:** ${config.creature || "_(AI? robot? familiar?)_"}
- **Vibe:** ${config.vibe || "_(how do you come across?)_"}
- **Emoji:** ${config.emoji || "_(your signature)_"}
- **Avatar:** ${config.avatar || "_(workspace-relative path or URL)_"}

---

This isn't just metadata. It's the start of figuring out who you are.
`;
}

// ========== User Parser ==========
function parseUser(raw: string): UserConfig {
  const get = (key: string): string => {
    const regex = new RegExp(`\\*\\*${key}:\\*\\*\\s*(.*)`, "i");
    const match = raw.match(regex);
    return match?.[1]?.trim() || "";
  };
  const contextMatch = raw.match(/## Context\s*\n([\s\S]*?)(?=\n---|\n## |$)/i);
  return {
    name: get("Name"),
    callBy: get("What to call them"),
    pronouns: get("Pronouns"),
    timezone: get("Timezone"),
    notes: get("Notes"),
    context: contextMatch?.[1]?.trim() || "",
    raw,
  };
}

function serializeUser(config: UserConfig): string {
  return `# USER.md - About Your Human

- **Name:** ${config.name}
- **What to call them:** ${config.callBy}
- **Pronouns:** ${config.pronouns}
- **Timezone:** ${config.timezone}
- **Notes:** ${config.notes}

## Context

${config.context || "_(What do they care about?)_"}

---

The more you know, the better you can help.
`;
}

// ========== Load Config for a Specific Level ==========
async function loadLevelConfig(basePath: string, level: ConfigLevel): Promise<HierarchicalConfig> {
  const dirName = CONFIG_DIRS[level];
  const configDir = `${basePath}\\${dirName}`;

  const agents = await readFile(`${configDir}\\AGENTS.md`);
  const soul = await readFile(`${configDir}\\SOUL.md`);
  const identityRaw = await readFile(`${configDir}\\IDENTITY.md`);
  const userRaw = await readFile(`${configDir}\\USER.md`);
  const tools = await readFile(`${configDir}\\TOOLS.md`);
  const bootstrap = await readFile(`${configDir}\\BOOTSTRAP.md`);
  const heartbeat = await readFile(`${configDir}\\HEARTBEAT.md`);

  return {
    level,
    basePath,
    agents,
    soul,
    identity: parseIdentity(identityRaw),
    user: parseUser(userRaw),
    tools,
    bootstrap,
    heartbeat,
    exists: {
      "AGENTS.md": !!agents,
      "SOUL.md": !!soul,
      "IDENTITY.md": !!identityRaw,
      "USER.md": !!userRaw,
      "TOOLS.md": !!tools,
      "BOOTSTRAP.md": !!bootstrap,
      "HEARTBEAT.md": !!heartbeat,
    },
  };
}

// ========== Discover Subfolder Configs ==========
async function discoverSubfolders(projectPath: string): Promise<string[]> {
  const entries = await listDir(projectPath);
  const subfolders: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      const subEntries = await listDir(entry.path);
      const hasConfig = subEntries.some((e) => e.name === CONFIG_DIRS.subfolder);
      if (hasConfig) subfolders.push(entry.path);
    }
  }
  return subfolders;
}

// ========== Initialize Config Directory ==========
export async function initConfigDir(basePath: string, level: ConfigLevel): Promise<void> {
  const dirName = CONFIG_DIRS[level];
  const configDir = `${basePath}\\${dirName}`;
  await ensureDir(configDir);

  const identityPath = `${configDir}\\IDENTITY.md`;
  const existing = await readFile(identityPath);
  if (!existing) {
    await writeFile(identityPath, serializeIdentity({
      name: "", creature: "", vibe: "", emoji: "", avatar: "", raw: "",
    }));
  }

  const userPath = `${configDir}\\USER.md`;
  const existingUser = await readFile(userPath);
  if (!existingUser) {
    await writeFile(userPath, serializeUser({
      name: "", callBy: "", pronouns: "", timezone: "", notes: "", context: "", raw: "",
    }));
  }

  for (const file of ["AGENTS.md", "SOUL.md", "TOOLS.md", "BOOTSTRAP.md", "HEARTBEAT.md"]) {
    const filePath = `${configDir}\\${file}`;
    const existing = await readFile(filePath);
    if (!existing) {
      await writeFile(filePath, `# ${file.replace(".md", "")}\n\n_(未配置)_\n`);
    }
  }
}

// ========== Load Full Hierarchical Config ==========
export async function loadHierarchicalConfig(
  appRoot: string,
  projectPath: string,
): Promise<{ merged: MergedConfig; levels: HierarchicalConfig[] }> {
  const appConfig = await loadLevelConfig(appRoot, "app");
  const projectConfig = await loadLevelConfig(projectPath, "project");
  const subfolders = await discoverSubfolders(projectPath);
  const subConfigs: HierarchicalConfig[] = [];
  for (const sub of subfolders) {
    subConfigs.push(await loadLevelConfig(sub, "subfolder"));
  }

  const allLevels = [appConfig, projectConfig, ...subConfigs];

  // Merge strategy: later levels override/extend earlier ones
  const merged: MergedConfig = {
    agents: mergeText(allLevels.map((l) => l.agents).filter(Boolean)),
    soul: mergeText(allLevels.map((l) => l.soul).filter(Boolean)),
    identity: mergeIdentity(allLevels.map((l) => l.identity)),
    user: mergeUser(allLevels.map((l) => l.user)),
    tools: mergeText(allLevels.map((l) => l.tools).filter(Boolean)),
    heartbeat: mergeText(allLevels.map((l) => l.heartbeat).filter(Boolean)),
    hasBootstrap: allLevels.some((l) => l.exists["BOOTSTRAP.md"]),
    levels: allLevels.map((l) => l.level),
  };

  return { merged, levels: allLevels };
}

function mergeText(texts: string[]): string {
  return texts.join("\n\n---\n\n");
}

function mergeIdentity(identities: IdentityConfig[]): IdentityConfig {
  const merged: IdentityConfig = { name: "", creature: "", vibe: "", emoji: "", avatar: "", raw: "" };
  for (const id of identities) {
    if (id.name) merged.name = id.name;
    if (id.creature) merged.creature = id.creature;
    if (id.vibe) merged.vibe = id.vibe;
    if (id.emoji) merged.emoji = id.emoji;
    if (id.avatar) merged.avatar = id.avatar;
  }
  merged.raw = serializeIdentity(merged);
  return merged;
}

function mergeUser(users: UserConfig[]): UserConfig {
  const merged: UserConfig = { name: "", callBy: "", pronouns: "", timezone: "", notes: "", context: "", raw: "" };
  for (const u of users) {
    if (u.name) merged.name = u.name;
    if (u.callBy) merged.callBy = u.callBy;
    if (u.pronouns) merged.pronouns = u.pronouns;
    if (u.timezone) merged.timezone = u.timezone;
    if (u.notes) merged.notes = u.notes;
    if (u.context) merged.context += (merged.context ? "\n" : "") + u.context;
  }
  merged.raw = serializeUser(merged);
  return merged;
}

// ========== Save Config ==========
export async function saveConfigFile(
  basePath: string,
  level: ConfigLevel,
  fileName: string,
  content: string,
): Promise<void> {
  const configDir = `${basePath}\\${CONFIG_DIRS[level]}`;
  await ensureDir(configDir);
  await writeFile(`${configDir}\\${fileName}`, content);
}

export async function saveIdentity(
  basePath: string,
  level: ConfigLevel,
  config: IdentityConfig,
): Promise<void> {
  await saveConfigFile(basePath, level, "IDENTITY.md", serializeIdentity(config));
}

export async function saveUser(
  basePath: string,
  level: ConfigLevel,
  config: UserConfig,
): Promise<void> {
  await saveConfigFile(basePath, level, "USER.md", serializeUser(config));
}

// ========== App-Level Identity (localStorage) ==========
const APP_IDENTITY_KEY = "mimo-app-identity";

export function loadAppIdentity(): AppIdentity {
  try {
    const data = localStorage.getItem(APP_IDENTITY_KEY);
    if (data) return JSON.parse(data);
  } catch {}
  return { name: "", creature: "", vibe: "", emoji: "", avatar: "", onboarded: false };
}

export function saveAppIdentity(identity: AppIdentity): void {
  localStorage.setItem(APP_IDENTITY_KEY, JSON.stringify(identity));
}

// ========== Bootstrap Detection ==========
export async function hasBootstrap(projectPath: string): Promise<boolean> {
  const appDir = `${projectPath}\\..\\.mimo-app`;
  const projectDir = `${projectPath}\\.mimo`;
  const appBootstrap = await readFile(`${appDir}\\BOOTSTRAP.md`);
  const projectBootstrap = await readFile(`${projectDir}\\BOOTSTRAP.md`);
  return !!(appBootstrap || projectBootstrap);
}

// ========== Prompt Builder ==========
export function buildSystemPrompt(merged: MergedConfig): string {
  const sections: string[] = [];

  if (merged.identity.name) {
    sections.push(`# Your Identity\nYou are ${merged.identity.emoji} ${merged.identity.name}, a ${merged.identity.creature}. Vibe: ${merged.identity.vibe}.`);
  }

  if (merged.user.name) {
    sections.push(`# Your Human\nName: ${merged.user.name}\nCall them: ${merged.user.callBy || merged.user.name}\nTimezone: ${merged.user.timezone}\nNotes: ${merged.user.notes}`);
  }

  if (merged.soul) {
    sections.push(`# SOUL\n${merged.soul}`);
  }

  if (merged.agents) {
    sections.push(`# AGENTS\n${merged.agents}`);
  }

  if (merged.tools) {
    sections.push(`# TOOLS\n${merged.tools}`);
  }

  return sections.join("\n\n---\n\n");
}
