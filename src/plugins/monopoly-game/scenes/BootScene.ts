/**
 * BootScene — 启动场景
 * 加载 Kenney CC0 PNG 素材（棋子/骰子/建筑/卡牌/图标/UI/角色/音效）
 * 补充程序化生成地块纹理（Kenney 无棋盘地块素材）
 */

import Phaser from "phaser";

// 使用 Vite 的 import.meta.url 获取 assets 路径
const ASSETS_BASE = new URL("../assets/sprites/", import.meta.url).href;

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: "BootScene" });
  }

  preload(): void {
    // ===== 加载 Kenney PNG 素材 =====

    // 骰子 (1-6)
    for (let i = 1; i <= 6; i++) {
      this.load.image(`dice_${i}`, `${ASSETS_BASE}dice/dice_${i}.png`);
    }

    // 棋子 (6 色)
    for (let i = 0; i < 6; i++) {
      this.load.image(`pawn_${i}`, `${ASSETS_BASE}pawns/pawn_${i}.png`);
    }

    // 筹码（金币）
    const chipColors = ["red", "blue", "green", "black", "white"];
    for (const c of chipColors) {
      this.load.image(`coin_${c}`, `${ASSETS_BASE}chips/coin_${c}.png`);
    }

    // 卡背
    this.load.image("cardback_red", `${ASSETS_BASE}cards/cardback_red_1.png`);
    this.load.image("cardback_blue", `${ASSETS_BASE}cards/cardback_blue_1.png`);
    this.load.image("cardback_green", `${ASSETS_BASE}cards/cardback_green_1.png`);
    this.load.image("card_joker", `${ASSETS_BASE}cards/card_joker.png`);

    // UI 按钮 & 面板
    this.load.image("btn_blue", `${ASSETS_BASE}ui/btn_blue.png`);
    this.load.image("btn_green", `${ASSETS_BASE}ui/btn_green.png`);
    this.load.image("btn_red", `${ASSETS_BASE}ui/btn_red.png`);
    this.load.image("btn_grey", `${ASSETS_BASE}ui/btn_grey.png`);
    this.load.image("panel_blue", `${ASSETS_BASE}ui/panel_blue.png`);
    this.load.image("panel_grey", `${ASSETS_BASE}ui/panel_grey.png`);
    this.load.image("panel_green", `${ASSETS_BASE}ui/panel_green.png`);
    this.load.image("panel_red", `${ASSETS_BASE}ui/panel_red.png`);

    // 设施图标
    this.load.image("icon_star", `${ASSETS_BASE}icons/star.png`);
    this.load.image("icon_home", `${ASSETS_BASE}icons/home.png`);
    this.load.image("icon_cross", `${ASSETS_BASE}icons/cross.png`);
    this.load.image("icon_locked", `${ASSETS_BASE}icons/locked.png`);
    this.load.image("icon_basket", `${ASSETS_BASE}icons/basket.png`);
    this.load.image("icon_door", `${ASSETS_BASE}icons/door.png`);
    this.load.image("icon_wrench", `${ASSETS_BASE}icons/wrench.png`);
    this.load.image("icon_warning", `${ASSETS_BASE}icons/warning.png`);
    this.load.image("icon_question", `${ASSETS_BASE}icons/question.png`);
    this.load.image("icon_trophy", `${ASSETS_BASE}icons/trophy.png`);
    this.load.image("icon_gear", `${ASSETS_BASE}icons/gear.png`);
    this.load.image("icon_power", `${ASSETS_BASE}icons/power.png`);

    // 卡通角色（用于棋盘上显示）
    for (let i = 0; i < 6; i++) {
      this.load.image(`character_${i}`, `${ASSETS_BASE}characters/char_${i}.png`);
    }

    // 建筑纹理（多个等距建筑）
    for (let i = 0; i < 13; i++) {
      this.load.image(`building_${i}`, `${ASSETS_BASE}buildings/building_${i}.png`);
    }

    // 音效
    this.load.audio("sfx_dice", `${ASSETS_BASE}audio/dice_throw.ogg`);
    this.load.audio("sfx_card", `${ASSETS_BASE}audio/card_slide.ogg`);
    this.load.audio("sfx_chips", `${ASSETS_BASE}audio/chips_collide.ogg`);
    this.load.audio("sfx_click", `${ASSETS_BASE}audio/click.ogg`);
    this.load.audio("sfx_error", `${ASSETS_BASE}audio/error.ogg`);
    this.load.audio("sfx_confirm", `${ASSETS_BASE}audio/confirm.ogg`);
    this.load.audio("sfx_switch", `${ASSETS_BASE}audio/switch.ogg`);
    this.load.audio("sfx_success", `${ASSETS_BASE}audio/jingle_success.ogg`);
    this.load.audio("sfx_fail", `${ASSETS_BASE}audio/jingle_fail.ogg`);

    // 加载完成后生成补充纹理
    this.load.on("complete", () => {
      this.generateSupplementalTextures();
    });
  }

  create(): void {
    this.scene.start("BoardScene");
    this.scene.launch("UIScene");
  }

  // ===== 程序化生成补充纹理（Kenney 没有的部分） =====

  private generateSupplementalTextures(): void {
    this.generateTileTextures();
    this.generateEffectTextures();
    this.generateCardTypeIcons();
    this.generateToolTypeIcons();
  }

  // ----- 地块纹理（渐变背景 + 边框） -----

  private generateTileTextures(): void {
    const size = 72;

    this.makeTileTexture("tile_land", size, 0x2980b9, 0x1a5276, 0x5dade2);
    this.makeTileTexture("tile_facility", size, 0xd4ac0d, 0xb7950b, 0xf1c40f);
    this.makeTileTexture("tile_commercial", size, 0x7d3c98, 0x5b2c6f, 0xa569bd);
    this.makeTileTexture("tile_landmark", size, 0xc0392b, 0x922b21, 0xe74c3c);
    this.makeTileTexture("tile_start", size, 0x229954, 0x196f3d, 0x2ecc71);
    this.makeTileTexture("tile_empty", size, 0x566573, 0x424949, 0x7f8c8d);
    this.makeTileTexture("tile_sealed", size, 0x641e16, 0x4d0f08, 0x922b21);
    this.makeTileTexture("tile_priceup", size, 0xca6f1e, 0xaf601a, 0xf39c12);
  }

  // M1: 地块纹理改为等距菱形
  private makeTileTexture(key: string, size: number, colorMain: number, colorDark: number, colorLight: number): void {
    if (this.textures.exists(key)) return;
    const g = this.add.graphics();
    const cx = size / 2;
    const cy = size / 2;
    // 菱形四点：上、右、下、左
    const diamond = [
      { x: cx, y: 2 },          // 上
      { x: size - 2, y: cy },   // 右
      { x: cx, y: size - 2 },   // 下
      { x: 2, y: cy },          // 左
    ];

    // 阴影
    g.fillStyle(0x000000, 0.3);
    g.fillPoints(
      diamond.map(p => ({ x: p.x + 2, y: p.y + 3 })),
      true
    );

    // 深色菱形底
    g.fillStyle(colorDark, 1);
    g.fillPoints(diamond, true);

    // 主色菱形（略小）
    const inner = diamond.map(p => ({
      x: cx + (p.x - cx) * 0.9,
      y: cy + (p.y - cy) * 0.85,
    }));
    g.fillStyle(colorMain, 0.9);
    g.fillPoints(inner, true);

    // 高光上半
    const top = [
      { x: cx, y: 4 },
      { x: cx + size * 0.35, y: cy - 2 },
      { x: cx, y: cy },
      { x: cx - size * 0.35, y: cy - 2 },
    ];
    g.fillStyle(colorLight, 0.3);
    g.fillPoints(top, true);

    // 边框
    g.lineStyle(1.5, colorLight, 0.5);
    g.strokePoints(inner, true);
    g.lineStyle(2, 0xffffff, 0.2);
    g.strokePoints(diamond, true);

    g.generateTexture(key, size, size);
    g.destroy();
  }

  // ----- 效果纹理（路障/地雷/炸弹/方向箭头等） -----

  private generateEffectTextures(): void {
    // 路障
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillEllipse(10, 18, 14, 4);
      g.fillStyle(0xe74c3c, 1);
      g.fillRect(4, 4, 12, 3);
      g.fillStyle(0xffffff, 1);
      g.fillRect(7, 4, 2, 3);
      g.fillStyle(0x2c3e50, 1);
      g.fillRect(9, 4, 2, 14);
      g.generateTexture("effect_roadblock", 20, 20);
      g.destroy();
    }

    // 地雷
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillEllipse(10, 18, 14, 4);
      g.fillStyle(0x2c3e50, 1);
      g.fillCircle(10, 10, 7);
      g.fillStyle(0xe74c3c, 1);
      g.fillCircle(10, 10, 4);
      g.fillStyle(0xf1c40f, 1);
      g.fillCircle(10, 10, 2);
      g.generateTexture("effect_landmine", 20, 20);
      g.destroy();
    }

    // 定时炸弹
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillEllipse(10, 18, 14, 4);
      g.fillStyle(0x2c3e50, 1);
      g.fillCircle(10, 11, 7);
      g.fillStyle(0x7f8c8d, 1);
      g.fillRect(8, 3, 4, 4);
      g.fillStyle(0xf1c40f, 1);
      g.fillCircle(10, 11, 3);
      g.generateTexture("effect_bomb", 20, 20);
      g.destroy();
    }

    // 金币（价格标记）
    {
      const g = this.add.graphics();
      g.fillStyle(0xf1c40f, 1);
      g.fillCircle(8, 8, 7);
      g.fillStyle(0xb7950b, 1);
      g.fillCircle(8, 8, 5);
      g.fillStyle(0xf1c40f, 1);
      g.fillRect(6, 4, 4, 1);
      g.fillRect(6, 11, 4, 1);
      g.fillRect(5, 5, 1, 6);
      g.fillRect(9, 5, 1, 6);
      g.generateTexture("icon_coin", 16, 16);
      g.destroy();
    }

    // 玩家方向箭头
    {
      const g = this.add.graphics();
      g.fillStyle(0xffffff, 0.8);
      g.fillTriangle(5, 0, 10, 8, 0, 8);
      g.generateTexture("direction_arrow", 10, 8);
      g.destroy();
    }

    // 连锁店标记 — B3: 改为彩色三角旗
    {
      const g = this.add.graphics();
      // 旗杆
      g.fillStyle(0x566573, 1);
      g.fillRect(1, 0, 2, 16);
      // 旗帜（三角）
      g.fillStyle(0xe74c3c, 0.9);
      g.fillTriangle(3, 1, 15, 5, 3, 9);
      // 旗帜高光
      g.fillStyle(0xffffff, 0.3);
      g.fillTriangle(3, 1, 9, 3, 3, 5);
      g.generateTexture("chain_flag", 16, 16);
      g.destroy();
    }

    // 骰子滚动动画帧（模糊效果）
    for (let i = 0; i < 4; i++) {
      if (this.textures.exists(`dice_roll_${i}`)) continue;
      const size = 64;
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillRoundedRect(4, 5, size - 4, size - 4, 10);
      g.fillStyle(0xecf0f1, 1);
      g.fillRoundedRect(0, 0, size - 4, size - 4, 10);
      g.fillStyle(0x2c3e50, 0.4);
      for (let j = 0; j < 4 + i; j++) {
        g.fillCircle(
          10 + Math.random() * (size - 25),
          10 + Math.random() * (size - 25),
          3
        );
      }
      g.lineStyle(2, 0x2c3e50, 0.3);
      g.strokeRoundedRect(0, 0, size - 4, size - 4, 10);
      g.generateTexture(`dice_roll_${i}`, size, size);
      g.destroy();
    }

    // P5: 骑乘状态图标 — 机车（简化版）
    {
      const g = this.add.graphics();
      // 车轮
      g.fillStyle(0x2c3e50, 1);
      g.fillCircle(4, 12, 3);
      g.fillCircle(12, 12, 3);
      // 车身
      g.fillStyle(0x3498db, 1);
      g.fillRoundedRect(1, 5, 14, 5, 2);
      // 车把
      g.fillStyle(0x566573, 1);
      g.fillRect(11, 2, 2, 4);
      g.generateTexture("ride_motorcycle", 16, 16);
      g.destroy();
    }

    // P5: 骑乘状态图标 — 汽车（简化版）
    {
      const g = this.add.graphics();
      // 车轮
      g.fillStyle(0x2c3e50, 1);
      g.fillCircle(4, 13, 2.5);
      g.fillCircle(12, 13, 2.5);
      // 车身
      g.fillStyle(0xe74c3c, 1);
      g.fillRoundedRect(0, 4, 16, 8, 3);
      // 车窗
      g.fillStyle(0x85c1e9, 0.8);
      g.fillRoundedRect(3, 5, 10, 4, 2);
      // 车灯
      g.fillStyle(0xf1c40f, 0.8);
      g.fillCircle(1, 8, 1);
      g.fillCircle(15, 8, 1);
      g.generateTexture("ride_car", 16, 16);
      g.destroy();
    }

    // P4: 状态表情图标 — 破产（红色 X）
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillCircle(10, 10, 8);
      g.fillStyle(0xe74c3c, 1);
      g.fillCircle(8, 8, 7);
      g.lineStyle(2, 0xffffff, 1);
      g.beginPath();
      g.moveTo(5, 5);
      g.lineTo(11, 11);
      g.moveTo(11, 5);
      g.lineTo(5, 11);
      g.strokePath();
      g.generateTexture("status_bankrupt", 16, 16);
      g.destroy();
    }

    // P4: 状态表情图标 — 睡眠（蓝色 Z）
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillCircle(10, 10, 8);
      g.fillStyle(0x3498db, 1);
      g.fillCircle(8, 8, 7);
      g.fillStyle(0xffffff, 1);
      g.fillRect(5, 4, 6, 1);
      g.fillRect(4, 6, 4, 1);
      g.fillRect(6, 8, 3, 1);
      g.generateTexture("status_sleep", 16, 16);
      g.destroy();
    }

    // P4: 状态表情图标 — 龟壳（绿色龟壳）
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillCircle(10, 10, 8);
      g.fillStyle(0x27ae60, 1);
      g.fillCircle(8, 8, 7);
      g.fillStyle(0x1d8348, 1);
      g.fillCircle(8, 8, 5);
      g.fillStyle(0x2ecc71, 0.6);
      g.fillCircle(8, 8, 3);
      g.generateTexture("status_tortoise", 16, 16);
      g.destroy();
    }

    // P4: 状态表情图标 — 停步（红色停止符）
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillCircle(10, 10, 8);
      g.fillStyle(0xe74c3c, 1);
      g.fillCircle(8, 8, 7);
      g.fillStyle(0xffffff, 1);
      g.fillRect(4, 7, 8, 2);
      g.generateTexture("status_stop", 16, 16);
      g.destroy();
    }

    // P4: 状态表情图标 — 小财神（金色笑脸）
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillCircle(10, 10, 8);
      g.fillStyle(0xf1c40f, 1);
      g.fillCircle(8, 8, 7);
      g.fillStyle(0x000000, 1);
      g.fillCircle(5, 6, 1.5);
      g.fillCircle(11, 6, 1.5);
      g.lineStyle(1.5, 0x000000, 1);
      g.beginPath();
      g.arc(8, 9, 3, 0.2, Math.PI - 0.2);
      g.strokePath();
      g.generateTexture("status_god_lucky", 16, 16);
      g.destroy();
    }

    // P4: 状态表情图标 — 小穷神（灰色哭脸）
    {
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.3);
      g.fillCircle(10, 10, 8);
      g.fillStyle(0x7f8c8d, 1);
      g.fillCircle(8, 8, 7);
      g.fillStyle(0x000000, 1);
      g.fillCircle(5, 6, 1.5);
      g.fillCircle(11, 6, 1.5);
      g.lineStyle(1.5, 0x000000, 1);
      g.beginPath();
      g.arc(8, 12, 3, Math.PI + 0.2, -0.2);
      g.strokePath();
      g.generateTexture("status_god_unlucky", 16, 16);
      g.destroy();
    }
  }

  // ----- 卡牌类型图标（30 种卡牌各一个小图标纹理） -----

  private generateCardTypeIcons(): void {
    // 为每张卡牌生成一个 32x32 的纯色渐变图标纹理
    // 实际卡牌图标在 React 层用 Kenney PNG <img> 显示
    // Phaser 内场景仅用颜色区分
    const cardIcons: Record<string, { color: number; dark: number }> = {
      // 福运类 — 金色系
      fortune: { color: 0xf1c40f, dark: 0xb7950b },
      cash: { color: 0x27ae60, dark: 0x1d8348 },
      points: { color: 0xe67e22, dark: 0xaf601a },
      // 控制类 — 蓝色系
      control: { color: 0x3498db, dark: 0x1f618d },
      teleport: { color: 0x9b59b6, dark: 0x6c3483 },
      swap: { color: 0x1abc9c, dark: 0x117a65 },
      // 攻击类 — 红色系
      attack: { color: 0xe74c3c, dark: 0x922b21 },
      steal: { color: 0xc0392b, dark: 0x922b21 },
      downgrade: { color: 0x8e44ad, dark: 0x6c3483 },
      // 防御类 — 绿色系
      defense: { color: 0x2ecc71, dark: 0x1d8348 },
      immunity: { color: 0x16a085, dark: 0x117a65 },
      // 状态类 — 紫色系
      status: { color: 0x9b59b6, dark: 0x6c3483 },
      god: { color: 0xf39c12, dark: 0xb9770e },
    };

    for (const [type, def] of Object.entries(cardIcons)) {
      const key = `card_icon_${type}`;
      if (this.textures.exists(key)) continue;
      const g = this.add.graphics();
      const size = 32;

      // 阴影
      g.fillStyle(0x000000, 0.3);
      g.fillRoundedRect(1, 2, size, size, 6);
      // 深色背景
      g.fillStyle(def.dark, 1);
      g.fillRoundedRect(0, 0, size, size, 6);
      // 主色填充
      g.fillStyle(def.color, 0.9);
      g.fillRoundedRect(1, 1, size - 2, size - 4, 5);
      // 高光
      g.fillStyle(0xffffff, 0.2);
      g.fillRoundedRect(2, 2, size - 4, size / 3, 4);

      g.generateTexture(key, size, size);
      g.destroy();
    }
  }

  // ----- 道具类型图标（23 种道具各一个小图标纹理） -----

  private generateToolTypeIcons(): void {
    // 为每个道具类型生成纯色渐变图标纹理
    // 实际道具图标在 React 层用 Kenney PNG <img> 显示
    const toolIcons: Record<string, { color: number; dark: number }> = {
      vehicle: { color: 0x3498db, dark: 0x1f618d },
      roadblock: { color: 0xe74c3c, dark: 0x922b21 },
      landmine: { color: 0x2c3e50, dark: 0x1a1a2e },
      bomb: { color: 0x7f8c8d, dark: 0x566573 },
      teleport: { color: 0x9b59b6, dark: 0x6c3483 },
      time: { color: 0xe67e22, dark: 0xaf601a },
      build: { color: 0x27ae60, dark: 0x1d8348 },
      missile: { color: 0xc0392b, dark: 0x922b21 },
      seal: { color: 0x8e44ad, dark: 0x6c3483 },
      markup: { color: 0xf39c12, dark: 0xb9770e },
      dice: { color: 0x1abc9c, dark: 0x117a65 },
      alliance: { color: 0x2ecc71, dark: 0x1d8348 },
      stop: { color: 0xe74c3c, dark: 0x922b21 },
      sleep: { color: 0x3498db, dark: 0x1f618d },
      reverse: { color: 0x9b59b6, dark: 0x6c3483 },
      tortoise: { color: 0x1abc9c, dark: 0x117a65 },
      immunity: { color: 0x16a085, dark: 0x117a65 },
      assurance: { color: 0x27ae60, dark: 0x1d8348 },
      research: { color: 0xf1c40f, dark: 0xb7950b },
    };

    for (const [type, def] of Object.entries(toolIcons)) {
      const key = `tool_icon_${type}`;
      if (this.textures.exists(key)) continue;
      const g = this.add.graphics();
      const size = 32;

      // 阴影
      g.fillStyle(0x000000, 0.3);
      g.fillRoundedRect(1, 2, size, size, 6);
      // 深色背景
      g.fillStyle(def.dark, 1);
      g.fillRoundedRect(0, 0, size, size, 6);
      // 主色填充
      g.fillStyle(def.color, 0.9);
      g.fillRoundedRect(1, 1, size - 2, size - 4, 5);
      // 高光
      g.fillStyle(0xffffff, 0.2);
      g.fillRoundedRect(2, 2, size - 4, size / 3, 4);

      g.generateTexture(key, size, size);
      g.destroy();
    }
  }
}
