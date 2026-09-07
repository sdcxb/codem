/**
 * persona — 人设卡管理（B2：对标 EAC dsh-soul-md 的人设卡注入 + 管理 UI）
 *
 * 历史缺陷：persona-provider 只是内存 Map（default/developer/creative 三人设），
 * 无持久化、无管理 UI、buildPrompt() 结果从未被主 prompt 消费（孤儿代码）。
 *
 * 本模块：
 * 1. 人设卡持久化（codem-persona-cards JSON：内联文本或外部文件路径）
 * 2. 激活人设管理（codem-persona-active）
 * 3. getActivePersonaPrompt()：返回当前人设的注入文本（文件模式读取 + 热重载，
 *    文件变更后下次组装自动用新内容——与 EAC soul.md 热重载同语义）
 */
import { getSettingJSON, setSettingJSON, getSetting, setSetting } from "../storage/settings";

export interface PersonaCard {
  id: string;
  name: string;
  /** 人设内容（markdown）。与 path 二选一：优先内联文本 */
  content?: string;
  /** 外部文件路径（soul.md 风格）。设置后内容以文件为准（支持热重载） */
  path?: string;
  /** 提示词段落顺序（小 = 更靠前，默认 0 紧随人格段） */
  order?: number;
  /** 文件缺失/不可读时使用的内容；空 = 不注入 */
  fallback?: string;
  createdAt: number;
}

const CARDS_KEY = "codem-persona-cards";
const ACTIVE_KEY = "codem-persona-active";

function genId(): string {
  return `persona-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listPersonaCards(): PersonaCard[] {
  try {
    const cards = getSettingJSON<PersonaCard[]>(CARDS_KEY, []);
    return Array.isArray(cards) ? cards : [];
  } catch {
    return [];
  }
}

export function getPersonaCard(id: string): PersonaCard | null {
  return listPersonaCards().find((c) => c.id === id) || null;
}

export function savePersonaCard(input: { id?: string; name: string; content?: string; path?: string; fallback?: string; order?: number }): PersonaCard {
  const cards = listPersonaCards();
  const card: PersonaCard = {
    id: input.id || genId(),
    name: input.name || "未命名人设",
    content: input.content || "",
    path: input.path || undefined,
    fallback: input.fallback || "",
    order: input.order ?? 0,
    createdAt: input.id ? (getPersonaCard(input.id)?.createdAt ?? Date.now()) : Date.now(),
  };
  const idx = cards.findIndex((c) => c.id === card.id);
  if (idx >= 0) cards[idx] = card;
  else cards.push(card);
  setSettingJSON(CARDS_KEY, cards);
  return card;
}

export function deletePersonaCard(id: string): void {
  const cards = listPersonaCards().filter((c) => c.id !== id);
  setSettingJSON(CARDS_KEY, cards);
  if (getActivePersonaId() === id) setSetting(ACTIVE_KEY, "");
}

export function getActivePersonaId(): string {
  try {
    return getSetting(ACTIVE_KEY) || "";
  } catch {
    return "";
  }
}

export function setActivePersona(id: string): void {
  setSetting(ACTIVE_KEY, id);
}

/** 清除激活（不删除卡） */
export function clearActivePersona(): void {
  setSetting(ACTIVE_KEY, "");
}

/**
 * 读取激活人设的注入文本：
 * - 卡含 path → 读文件（UTF-8）；成功用文件内容（每次调用重读 = 热重载）；
 *   失败用 fallback（空 = 不注入）
 * - 否则用卡 content（空 = 不注入）
 */
export async function getActivePersonaPrompt(): Promise<string | null> {
  const id = getActivePersonaId();
  if (!id) return null;
  const card = getPersonaCard(id);
  if (!card) return null;

  if (card.path) {
    try {
      const { readFile } = await import("../file-api");
      const text = await readFile(card.path);
      if (text && text.trim()) return text;
    } catch {
      /* file unreadable — fall through to fallback */
    }
    return card.fallback?.trim() ? card.fallback : null;
  }
  return card.content?.trim() ? card.content : null;
}

/** 构建要注入系统提示的段落（# Persona），无激活人设返回空串 */
export async function buildPersonaPromptSection(): Promise<string> {
  const text = await getActivePersonaPrompt();
  if (!text) return "";
  return `# Persona

${text}

`;
}
