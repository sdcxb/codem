/**
 * 卡牌和道具的图标映射
 * 全部使用 Kenney CC0 PNG 素材，零 emoji
 */

// Vite 静态资源基路径
const ICON_BASE = new URL("../assets/sprites/icons/", import.meta.url).href;

// ===== 卡牌图标映射 =====
export interface CardIconInfo {
  icon: string;  // PNG 图片路径
  category: "fortune" | "cash" | "points" | "control" | "teleport" | "swap" | "attack" | "steal" | "downgrade" | "defense" | "immunity" | "status" | "god";
  color: string;
}

export const CARD_ICONS: Record<number, CardIconInfo> = {
  0:  { icon: "cards/card_0.png",  category: "points",     color: "#e67e22" },  // 福神卡 → star
  1:  { icon: "cards/card_1.png",  category: "cash",       color: "#27ae60" },  // 财神卡 → cash
  2:  { icon: "cards/card_2.png",  category: "control",    color: "#3498db" },  // 送神卡 → return
  3:  { icon: "cards/card_3.png",  category: "swap",         color: "#1abc9c" },  // 交换卡 → share
  4:  { icon: "cards/card_4.png",  category: "steal",         color: "#c0392b" },  // 抢夺卡 → trashcan
  5:  { icon: "cards/card_5.png",  category: "attack",       color: "#8e44ad" },  // 怪物卡 → exclamation
  6:  { icon: "cards/card_6.png",  category: "defense",      color: "#f1c40f" },  // 天使卡 → checkmark
  7:  { icon: "cards/card_7.png",  category: "downgrade",    color: "#922b21" },  // 恶魔卡 → faceAngry
  8:  { icon: "cards/card_8.png",  category: "control",      color: "#3498db" },  // 转移卡 → export
  9:  { icon: "cards/card_9.png",  category: "fortune",      color: "#f1c40f" },  // 购地卡 → home
  10: { icon: "cards/card_10.png", category: "fortune",      color: "#2ecc71" },  // 升级卡 → arrowUp
  11: { icon: "cards/card_11.png", category: "attack",       color: "#e74c3c" },  // 拍卖卡 → trophy
  12: { icon: "cards/card_12.png", category: "defense",      color: "#2ecc71" },  // 同盟卡 → heart
  13: { icon: "cards/card_13.png", category: "status",       color: "#e74c3c" },  // 离婚卡 → heartBroken
  14: { icon: "cards/card_14.png", category: "immunity",     color: "#16a085" },  // 保险卡 → unlocked
  15: { icon: "cards/card_15.png", category: "immunity",     color: "#3498db" },  // 免罪卡 → locked
  16: { icon: "cards/card_16.png", category: "status",       color: "#1abc9c" },  // 乌龟卡 → backward
  17: { icon: "cards/card_17.png", category: "status",       color: "#9b59b6" },  // 梦游卡 → dots2
  18: { icon: "cards/card_18.png", category: "status",       color: "#e74c3c" },  // 停留卡 → pause
  19: { icon: "cards/card_19.png", category: "status",       color: "#3498db" },  // 催眠卡 → sleep
  20: { icon: "cards/card_20.png", category: "control",      color: "#9b59b6" },  // 转向卡 → return
  21: { icon: "cards/card_21.png", category: "control",      color: "#1abc9c" },  // 重新掷骰卡 → rewind
  22: { icon: "cards/card_22.png", category: "control",      color: "#e67e22" },  // 遥控骰子卡 → target
  23: { icon: "cards/card_23.png", category: "points",       color: "#e67e22" },  // 点卷卡 → cash
  24: { icon: "cards/card_24.png", category: "god",            color: "#f1c40f" },  // 小财神卡 → faceHappy
  25: { icon: "cards/card_25.png", category: "god",            color: "#f39c12" },  // 大财神卡 → stars
  26: { icon: "cards/card_26.png", category: "god",            color: "#7f8c8d" },  // 小穷神卡 → faceSad
  27: { icon: "cards/card_27.png", category: "god",            color: "#566573" },  // 大穷神卡 → drops
  28: { icon: "cards/card_28.png", category: "downgrade",    color: "#8e44ad" },  // 归零卡 → backward
  29: { icon: "cards/card_29.png", category: "attack",       color: "#c0392b" },  // 查封卡 → locked
};

export function getCardIcon(cardId: number): CardIconInfo {
  return CARD_ICONS[cardId] || { icon: "facilities/fortune.png", category: "fortune", color: "#95a5a6" };
}

export function getCardIconUrl(cardId: number): string {
  const info = getCardIcon(cardId);
  return ICON_BASE + info.icon;
}

// ===== 道具图标映射 =====
export interface ToolIconInfo {
  icon: string;
  category: "vehicle" | "roadblock" | "landmine" | "bomb" | "teleport" | "time" | "build" | "missile" | "seal" | "markup" | "dice" | "alliance" | "stop" | "sleep" | "reverse" | "tortoise" | "immunity" | "assurance" | "research";
  color: string;
}

export const TOOL_ICONS: Record<number, ToolIconInfo> = {
  0:  { icon: "tools/tool_0.png",  category: "vehicle",     color: "#3498db" },  // 机车卡 → cycle
  1:  { icon: "tools/tool_1.png",  category: "vehicle",     color: "#2980b9" },  // 汽车卡 → sedan
  2:  { icon: "tools/tool_2.png",  category: "roadblock",   color: "#e74c3c" },  // 路障 → alert
  3:  { icon: "tools/tool_3.png",  category: "landmine",     color: "#2c3e50" },  // 地雷 → grenade
  4:  { icon: "tools/tool_4.png",  category: "bomb",          color: "#7f8c8d" },  // 定时炸弹 → grenadeVintage
  5:  { icon: "tools/tool_5.png",  category: "teleport",     color: "#9b59b6" },  // 传送机 → swirl
  6:  { icon: "tools/tool_6.png",  category: "time",          color: "#e67e22" },  // 时光机 → rewind
  7:  { icon: "tools/tool_7.png",  category: "build",         color: "#27ae60" },  // 工程车 → home
  8:  { icon: "tools/tool_8.png",  category: "vehicle",      color: "#3498db" },  // 机车 → cycle_low
  9:  { icon: "tools/tool_9.png",  category: "build",         color: "#27ae60" },  // 机器工人 → gear
  10: { icon: "tools/tool_10.png", category: "build",         color: "#1abc9c" },  // 机器娃娃 → target
  11: { icon: "tools/tool_11.png", category: "missile",      color: "#c0392b" },  // 导弹 → rocket
  12: { icon: "tools/tool_12.png", category: "seal",          color: "#8e44ad" },  // 查封令 → locked
  13: { icon: "tools/tool_13.png", category: "markup",        color: "#f39c12" },  // 涨价令 → arrowUp
  14: { icon: "tools/tool_14.png", category: "dice",          color: "#1abc9c" },  // 遥控骰子 → target
  15: { icon: "tools/tool_15.png", category: "alliance",     color: "#2ecc71" },  // 同盟令 → heart
  16: { icon: "tools/tool_16.png", category: "stop",          color: "#e74c3c" },  // 停留令 → pause
  17: { icon: "tools/tool_17.png", category: "sleep",          color: "#3498db" },  // 催眠器 → sleep
  18: { icon: "tools/tool_18.png", category: "reverse",       color: "#9b59b6" },  // 转向器 → return
  19: { icon: "tools/tool_19.png", category: "tortoise",     color: "#1abc9c" },  // 乌龟令 → backward
  20: { icon: "tools/tool_20.png", category: "immunity",      color: "#16a085" },  // 免罪符 → unlocked
  21: { icon: "tools/tool_21.png", category: "assurance",     color: "#27ae60" },  // 保险证 → unlocked
  22: { icon: "tools/tool_22.png", category: "research",      color: "#f1c40f" },  // 研究图纸 → idea
};

export function getToolIcon(toolId: number): ToolIconInfo {
  return TOOL_ICONS[toolId] || { icon: "tools/tool_22.png", category: "research", color: "#95a5a6" };
}

export function getToolIconUrl(toolId: number): string {
  const info = getToolIcon(toolId);
  return ICON_BASE + info.icon;
}

// ===== 设施图标映射 =====
export const FACILITY_ICONS: Record<string, { icon: string; color: string }> = {
  bank:          { icon: "facilities/bank.png",          color: "#f1c40f" },
  hospital:      { icon: "facilities/hospital.png",      color: "#e74c3c" },
  prison:        { icon: "facilities/prison.png",        color: "#566573" },
  shop:          { icon: "facilities/shop.png",           color: "#3498db" },
  park:          { icon: "facilities/park.png",           color: "#27ae60" },
  magic_house:   { icon: "facilities/magic_house.png",    color: "#9b59b6" },
  hotel:         { icon: "facilities/hotel.png",          color: "#e74c3c" },
  gas_station:   { icon: "facilities/gas_station.png",     color: "#e67e22" },
  news:          { icon: "facilities/news.png",           color: "#ecf0f1" },
  fortune:       { icon: "facilities/fortune.png",         color: "#9b59b6" },
  auction_house: { icon: "facilities/auction_house.png",  color: "#f1c40f" },
  landmark:      { icon: "facilities/landmark.png",        color: "#f1c40f" },
};

export function getFacilityIcon(type: string): { icon: string; color: string } {
  return FACILITY_ICONS[type] || { icon: "facilities/fortune.png", color: "#95a5a6" };
}

export function getFacilityIconUrl(type: string): string {
  const info = getFacilityIcon(type);
  return ICON_BASE + info.icon;
}

// ===== UI 图标（面板标题用） =====
export const UI_ICONS = {
  bank: ICON_BASE + "ui/bank.png",
  shop: ICON_BASE + "ui/shop.png",
  stock: ICON_BASE + "ui/stock.png",
  auction: ICON_BASE + "ui/auction.png",
  cards: ICON_BASE + "ui/cards.png",
  tools: ICON_BASE + "ui/tools.png",
  cash: ICON_BASE + "ui/cash.png",
  alliance: ICON_BASE + "ui/alliance.png",
};
