/**
 * BoardScene — 棋盘场景
 * 使用 Kenney CC0 素材渲染地图节点、玩家棋子、建筑、设施图标
 * Phase 8 改进：角色精灵替换、所有者边框条、地块高亮、行走音效、连锁店招牌
 * Phase 8 批次2：道路视觉、地图背景城市感、可购买提示、骑乘状态、粒子系统、昼夜色调
 * Phase 8 批次3：地块信息弹窗、建筑等级分层、状态表情、行走动画、事件弹窗、买卖确认弹窗、地图缩略图
 */

import Phaser from "phaser";
import type { GameBoardMap, MapNode } from "../types";
import type { GameEngine } from "../engine/GameEngine";

interface TileVisual {
  container: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.Image;
  ownerBorder?: Phaser.GameObjects.Rectangle;
  highlightTween?: Phaser.Tweens.Tween;
  buyHint?: Phaser.GameObjects.Image;  // T4: 可购买提示金币
  icon?: Phaser.GameObjects.Image;
  building?: Phaser.GameObjects.Image;
  levelBadge?: Phaser.GameObjects.Text; // B4: 等级标识
  chainIcon?: Phaser.GameObjects.Image;
  nameLabel: Phaser.GameObjects.Text;
  priceLabel: Phaser.GameObjects.Text;
}

// 设施类型 → Kenney 图标 texture key（修正映射，使图标与设施含义匹配）
const FACILITY_ICON_MAP: Record<string, string> = {
  bank: "icon_star",           // 星标=金/财富 → 银行
  hospital: "icon_cross",      // 十字=医院 ✓
  prison: "icon_locked",       // 锁=监狱 ✓
  shop: "icon_basket",         // 篮子=商店 ✓
  park: "icon_trophy",         // 奖杯=休闲 → 公园
  magic_house: "icon_question", // 问号=神秘 → 魔法屋
  hotel: "icon_home",          // 房屋=住宿 → 酒店
  gas_station: "icon_power",   // 电源=能源 → 加油站
  news: "icon_warning",       // 警告=突发 → 新闻
  fortune: "icon_question",   // 问号=未知 → 命运
  auction_house: "icon_trophy", // 奖杯=竞价 → 拍卖
  airport: "icon_power",      // 电源=能源 → 机场
};

export class BoardScene extends Phaser.Scene {
  private map!: GameBoardMap;
  private engine!: GameEngine;
  private tileVisuals: Map<number, TileVisual> = new Map();
  private pawnSprites: Map<number, Phaser.GameObjects.Container> = new Map();
  private pawnShadowSprites: Map<number, Phaser.GameObjects.Image> = new Map();
  private pawnImages: Map<number, Phaser.GameObjects.Image> = new Map();
  private pawnRideIcons: Map<number, Phaser.GameObjects.Image> = new Map(); // P5: 骑乘状态图标
  private pawnStatusIcons: Map<number, Phaser.GameObjects.Image> = new Map(); // P4: 状态表情图标
  private currentHighlightNodeId: number = -1;
  private dayNightOverlay?: Phaser.GameObjects.Rectangle; // O3: 昼夜色调叠加层
  private infoPopup?: Phaser.GameObjects.Container; // T1: 地块信息弹窗
  private eventPopup?: Phaser.GameObjects.Container; // R2: 事件弹窗
  private confirmPopup?: Phaser.GameObjects.Container; // R3: 买卖确认弹窗
  private branchPopup?: Phaser.GameObjects.Container; // G2: 路口方向选择弹窗
  private miniMap?: Phaser.GameObjects.Graphics; // O2: 地图缩略图
  private miniMapContainer?: Phaser.GameObjects.Container; // O2: 缩略图容器
  private miniMapIndicator?: Phaser.GameObjects.Arc; // O2: 缩略图视角指示器
  private isMoving: boolean = false; // P2: 行走动画状态

  constructor() {
    super({ key: "BoardScene" });
  }

  init(data: { map: GameBoardMap; engine: GameEngine }): void {
    this.map = data.map;
    this.engine = data.engine;
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#1a1a2e");

    this.drawBackground();
    this.drawPaths();
    this.drawTiles();
    this.createPawns();

    // O3: 昼夜色调叠加层
    this.dayNightOverlay = this.add.rectangle(
      -1920, -1080, 1920 * 3, 1080 * 3, 0x000000, 0
    ).setDepth(-5);

    this.cameras.main.setZoom(0.85);
    this.cameras.main.centerOn(480, 340);
    this.setupCameraDrag();

    // O3: 初始更新昼夜色调
    this.updateDayNight();

    // T4: 初始显示可购买提示
    this.updateBuyHints();

    // O2: 创建地图缩略图
    this.createMiniMap();

    this.engine.on((event) => {
      if (event.type === "player_moved") {
        this.updatePawnPosition(event.data.playerId, event.data.nodeId);
        // A1: 行走音效
        this.playStepSound();
        // P2: 行走动画 — 标记移动状态
        this.isMoving = true;
      } else if (event.type === "game_start") {
        for (const player of this.engine.getPlayers()) {
          this.updatePawnPosition(player.id, player.positionNodeId);
        }
        // P4: 初始更新状态表情
        this.updateStatusIcons();
      } else if (event.type === "player_arrived") {
        // T3: 地块高亮 — 玩家到达时闪烁
        this.highlightTile(event.data.nodeId);
        // P2: 行走动画结束
        this.isMoving = false;
      } else if (event.type === "land_bought") {
        // A2: 买地音效
        this.playEventSound("chips");
        this.refreshTileVisuals();
        this.updateBuyHints();
      } else if (event.type === "land_upgraded") {
        // A2: 升级音效
        this.playEventSound("confirm");
        // O1: 升级金色粒子
        const upgradedLand = this.map.lands[event.data.landIndex];
        if (upgradedLand) this.emitParticles(upgradedLand.id, 0xf1c40f);
        this.refreshTileVisuals();
      } else if (event.type === "land_liquidated") {
        this.refreshTileVisuals();
      } else if (event.type === "player_bankrupted") {
        // A2: 破产音效
        this.playEventSound("fail");
        // O1: 破产黑色粒子
        const bankruptedPlayer = this.engine.getPlayers().find(p => p.id === event.data.playerId);
        if (bankruptedPlayer) {
          const node = this.map.nodes[bankruptedPlayer.positionNodeId];
          if (node) this.emitParticles(node.id, 0x1a1a2e);
        }
        // P4: 更新状态表情
        this.updateStatusIcons();
      } else if (event.type === "pay_toll") {
        // T2: 过路费飞字
        this.showFloatText(event.data.to, `+¥${event.data.amount}`, 0x27ae60);
        this.showFloatText(event.data.from, `-¥${event.data.amount}`, 0xe74c3c);
      } else if (event.type === "trigger_fortune" || event.type === "trigger_news") {
        this.playEventSound("card");
        // R2: 事件弹窗
        this.showEventPopup(event);
      } else if (event.type === "enter_magic_house") {
        this.playEventSound("switch");
      } else if (event.type === "card_used") {
        // G16: 卡牌翻牌动画
        this.playEventSound("card");
        this.showCardFlipAnimation(event.data);
      } else if (event.type === "prompt_buy_land") {
        // R3: 买卖确认弹窗
        this.showConfirmPopup("buy_land", event.data);
      } else if (event.type === "prompt_upgrade_land") {
        // R3: 升级确认弹窗
        this.showConfirmPopup("upgrade_land", event.data);
      } else if (event.type === "prompt_branch") {
        // G2: 路口方向选择
        this.showBranchPopup(event.data);
      } else if (event.type === "turn_start") {
        // O3: 每回合更新昼夜色调
        this.updateDayNight();
        // T4: 每回合更新可购买提示
        this.updateBuyHints();
        // P5: 更新骑乘状态显示
        this.updateRideIcons();
        // P4: 更新状态表情
        this.updateStatusIcons();
        // O2: 更新缩略图
        this.updateMiniMap();
      }
    });
  }

  // ===== G13+G15: 主题背景 + 大量装饰物 =====
  private drawBackground(): void {
    const theme = this.map.meta.backgroundTheme || "city";
    const bg = this.add.graphics();
    const w = 1920, h = 1080;

    // 1) 底色铺满
    const themeColors: Record<string, number> = {
      city: 0x16213e,
      wood: 0x2a1810,
      ocean: 0x0a2640,
      space: 0x050518,
    };
    bg.fillStyle(themeColors[theme] ?? 0x16213e, 1);
    bg.fillRect(-w, -h, w * 3, h * 3);

    // 2) 按主题调用对应绘制方法
    switch (theme) {
      case "space":
        this.drawSpaceTheme(bg);
        break;
      case "ocean":
        this.drawOceanTheme(bg);
        break;
      case "wood":
        this.drawWoodTheme(bg);
        break;
      default:
        this.drawCityTheme(bg);
        break;
    }

    // 3) 通用光晕
    for (let i = 0; i < 5; i++) {
      bg.fillStyle(0x2c3e50, 0.04);
      bg.fillCircle(480, 340, 200 + i * 60);
    }
    bg.setDepth(-10);
  }

  // ===== 太空站主题 =====
  private drawSpaceTheme(g: Phaser.GameObjects.Graphics): void {
    // 星空 — 大量大小不一的星点
    for (let i = 0; i < 300; i++) {
      const sx = -200 + Math.random() * 2200;
      const sy = -200 + Math.random() * 1400;
      const sr = 0.5 + Math.random() * 2.5;
      const alpha = 0.2 + Math.random() * 0.6;
      g.fillStyle(0xffffff, alpha);
      g.fillCircle(sx, sy, sr);
    }
    // 大星 — 带十字光芒
    for (let i = 0; i < 12; i++) {
      const sx = -100 + Math.random() * 1900;
      const sy = -100 + Math.random() * 1200;
      g.fillStyle(0xffffff, 0.6);
      g.fillCircle(sx, sy, 3);
      g.lineStyle(1, 0xffffff, 0.3);
      g.beginPath();
      g.moveTo(sx - 10, sy); g.lineTo(sx + 10, sy);
      g.moveTo(sx, sy - 10); g.lineTo(sx, sy + 10);
      g.strokePath();
    }
    // 星云团（紫色/蓝色雾气）
    const nebulae = [
      { x: 300, y: 200, r: 180, color: 0x6c3483 },
      { x: 900, y: 600, r: 220, color: 0x1a5276 },
      { x: 1400, y: 300, r: 160, color: 0x9b59b6 },
      { x: 600, y: 800, r: 140, color: 0x2471a3 },
    ];
    for (const n of nebulae) {
      g.fillStyle(n.color, 0.08);
      g.fillCircle(n.x, n.y, n.r);
      g.fillStyle(n.color, 0.05);
      g.fillCircle(n.x, n.y, n.r * 1.4);
      g.fillStyle(n.color, 0.03);
      g.fillCircle(n.x, n.y, n.r * 1.8);
    }
    // 太空站主体 — 中央圆环结构
    const stX = 480, stY = 340;
    g.lineStyle(3, 0x5dade2, 0.4);
    g.strokeCircle(stX, stY, 90);
    g.lineStyle(2, 0x85c1e9, 0.3);
    g.strokeCircle(stX, stY, 70);
    // 太空舱 — 四个方向伸出的小圆柱
    const pods = [
      { x: stX, y: stY - 90, w: 24, h: 36 },
      { x: stX + 90, y: stY, w: 36, h: 24 },
      { x: stX, y: stY + 90, w: 24, h: 36 },
      { x: stX - 90, y: stY, w: 36, h: 24 },
    ];
    for (const p of pods) {
      g.fillStyle(0x2c3e50, 0.6);
      g.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
      g.lineStyle(1.5, 0x5dade2, 0.4);
      g.strokeRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
      // 舷窗
      g.fillStyle(0xf1c40f, 0.2);
      g.fillCircle(p.x, p.y, 4);
    }
    // 太阳能板 — 左右两片大面积蓝色矩形
    const panelW = 120, panelH = 50;
    g.fillStyle(0x1a5276, 0.25);
    g.fillRect(stX - 90 - panelW, stY - panelH / 2, panelW, panelH);
    g.fillRect(stX + 90, stY - panelH / 2, panelW, panelH);
    // 太阳能板网格线
    g.lineStyle(0.5, 0x5dade2, 0.2);
    for (let gx = 0; gx < panelW; gx += 15) {
      g.beginPath();
      g.moveTo(stX - 90 - panelW + gx, stY - panelH / 2);
      g.lineTo(stX - 90 - panelW + gx, stY + panelH / 2);
      g.moveTo(stX + 90 + gx, stY - panelH / 2);
      g.lineTo(stX + 90 + gx, stY + panelH / 2);
      g.strokePath();
    }
    // 卫星 — 几个小卫星点缀
    for (let i = 0; i < 5; i++) {
      const satX = 100 + Math.random() * 1600;
      const satY = 50 + Math.random() * 900;
      g.fillStyle(0xbdc3c7, 0.3);
      g.fillRect(satX - 3, satY - 1, 6, 2);
      g.fillStyle(0x5dade2, 0.2);
      g.fillRect(satX - 10, satY - 4, 7, 8);
      g.fillRect(satX + 3, satY - 4, 7, 8);
    }
    // 外星飞碟 — 几个UFO
    const ufos = [
      { x: 200, y: 150 },
      { x: 800, y: 700 },
      { x: 1300, y: 200 },
    ];
    for (const u of ufos) {
      // 飞碟底盘（椭圆）
      g.fillStyle(0x7f8c8d, 0.3);
      g.fillEllipse(u.x, u.y, 30, 12);
      // 圆顶（绿色玻璃罩）
      g.fillStyle(0x2ecc71, 0.2);
      g.fillCircle(u.x, u.y - 4, 8);
      // 底部光束
      g.fillStyle(0xf1c40f, 0.06);
      g.beginPath();
      g.moveTo(u.x - 10, u.y + 4);
      g.lineTo(u.x + 10, u.y + 4);
      g.lineTo(u.x + 16, u.y + 30);
      g.lineTo(u.x - 16, u.y + 30);
      g.closePath();
      g.fillPath();
    }
    // 外星人标志 — 简笔外星人头像
    const aliens = [
      { x: 500, y: 550 },
      { x: 1000, y: 400 },
      { x: 300, y: 700 },
    ];
    for (const a of aliens) {
      // 头（绿色椭圆）
      g.fillStyle(0x27ae60, 0.2);
      g.fillEllipse(a.x, a.y, 16, 20);
      // 大眼睛
      g.fillStyle(0x000000, 0.4);
      g.fillCircle(a.x - 4, a.y - 2, 3);
      g.fillCircle(a.x + 4, a.y - 2, 3);
      // 眼白高光
      g.fillStyle(0xffffff, 0.3);
      g.fillCircle(a.x - 4, a.y - 3, 1);
      g.fillCircle(a.x + 4, a.y - 3, 1);
    }
    // 行星 — 远处的大星球
    const planets = [
      { x: 1500, y: 600, r: 50, color: 0xb9770e },
      { x: 100, y: 800, r: 35, color: 0x922b21 },
    ];
    for (const p of planets) {
      g.fillStyle(p.color, 0.12);
      g.fillCircle(p.x, p.y, p.r);
      // 环
      g.lineStyle(1.5, p.color, 0.08);
      g.strokeEllipse(p.x, p.y, p.r * 2.2, p.r * 0.6);
      // 表面纹理
      g.fillStyle(p.color, 0.06);
      g.fillCircle(p.x - p.r * 0.3, p.y - p.r * 0.2, p.r * 0.3);
      g.fillCircle(p.x + p.r * 0.2, p.y + p.r * 0.3, p.r * 0.2);
    }
  }

  // ===== 海岛主题 =====
  private drawOceanTheme(g: Phaser.GameObjects.Graphics): void {
    // 深海渐变 — 多层蓝色叠加
    const oceanLayers = [
      { y: 0, color: 0x0a2640, alpha: 0.5 },
      { y: 200, color: 0x0e3a5c, alpha: 0.3 },
      { y: 500, color: 0x127a8a, alpha: 0.15 },
    ];
    for (const layer of oceanLayers) {
      g.fillStyle(layer.color, layer.alpha);
      g.fillRect(-200, layer.y, 2200, 1400);
    }
    // 海浪波纹 — 大量随机短弧线
    for (let i = 0; i < 80; i++) {
      const wx = -100 + Math.random() * 2000;
      const wy = 50 + Math.random() * 1000;
      g.lineStyle(1, 0x5dade2, 0.08 + Math.random() * 0.1);
      g.beginPath();
      g.moveTo(wx, wy);
      g.lineTo(wx + 30, wy);
      g.strokePath();
    }
    // 椰子树 — 在地图边缘散布
    const palms = [
      { x: 150, y: 120 }, { x: 850, y: 80 }, { x: 1200, y: 150 },
      { x: 200, y: 700 }, { x: 900, y: 750 }, { x: 1400, y: 680 },
      { x: 50, y: 400 }, { x: 1700, y: 450 },
    ];
    for (const p of palms) {
      // 树干（棕色弯曲矩形）
      g.fillStyle(0x6e2c00, 0.3);
      g.fillRect(p.x - 3, p.y - 25, 6, 25);
      // 椰子叶（绿色椭圆扇形）
      const leafColors = [0x27ae60, 0x229954, 0x1e8449];
      for (let li = 0; li < 5; li++) {
        const angle = (li / 5) * Math.PI * 2;
        const lx = p.x + Math.cos(angle) * 10;
        const ly = p.y - 25 + Math.sin(angle) * 5;
        g.fillStyle(leafColors[li % 3], 0.25);
        g.fillEllipse(lx, ly, 16, 6);
        // 叶子旋转
        g.beginPath();
        g.moveTo(lx, ly);
        g.lineTo(lx + Math.cos(angle) * 18, ly + Math.sin(angle) * 8);
        g.strokePath();
      }
      // 椰子（小棕色圆）
      g.fillStyle(0x6e2c00, 0.3);
      g.fillCircle(p.x - 3, p.y - 22, 2);
      g.fillCircle(p.x + 3, p.y - 22, 2);
    }
    // 珊瑚礁 — 海面下浅色块
    const reefs = [
      { x: 400, y: 300 }, { x: 700, y: 500 }, { x: 1100, y: 350 },
      { x: 300, y: 600 }, { x: 1300, y: 550 },
    ];
    for (const r of reefs) {
      g.fillStyle(0xff6b6b, 0.08);
      g.fillCircle(r.x, r.y, 25);
      g.fillStyle(0xffa07a, 0.06);
      g.fillCircle(r.x - 8, r.y + 5, 15);
      g.fillStyle(0xdeb887, 0.06);
      g.fillCircle(r.x + 10, r.y - 3, 12);
    }
    // 帆船 — 小三角帆
    const boats = [
      { x: 600, y: 200 }, { x: 1200, y: 600 }, { x: 300, y: 500 },
    ];
    for (const b of boats) {
      // 船体
      g.fillStyle(0x8b4513, 0.25);
      g.fillEllipse(b.x, b.y + 6, 20, 6);
      // 桅杆
      g.lineStyle(1, 0x8b4513, 0.25);
      g.beginPath();
      g.moveTo(b.x, b.y + 6); g.lineTo(b.x, b.y - 10);
      g.strokePath();
      // 帆
      g.fillStyle(0xecf0f1, 0.15);
      g.beginPath();
      g.moveTo(b.x, b.y - 10); g.lineTo(b.x + 12, b.y + 4); g.lineTo(b.x, b.y + 4);
      g.closePath();
      g.fillPath();
    }
    // 海鸟 — V形小线条
    for (let i = 0; i < 15; i++) {
      const bx = Math.random() * 1800;
      const by = 30 + Math.random() * 200;
      g.lineStyle(1, 0xffffff, 0.15);
      g.beginPath();
      g.moveTo(bx, by); g.lineTo(bx + 4, by - 3); g.lineTo(bx + 8, by);
      g.strokePath();
    }
    // 沙滩 — 地图边缘浅色条
    g.fillStyle(0xf4e4bc, 0.08);
    g.fillRect(-200, -50, 2200, 60);
    g.fillStyle(0xf4e4bc, 0.05);
    g.fillRect(-200, 950, 2200, 60);
  }

  // ===== 古镇主题 =====
  private drawWoodTheme(g: Phaser.GameObjects.Graphics): void {
    // 大地底色 — 深棕渐变
    g.fillStyle(0x3e2723, 0.3);
    g.fillRect(-200, 0, 2200, 1100);
    g.fillStyle(0x4e342e, 0.15);
    g.fillRect(-200, 300, 2200, 800);
    // 青石板路 — 不规则灰色石块
    for (let i = 0; i < 40; i++) {
      const sx = -100 + Math.random() * 1800;
      const sy = 50 + Math.random() * 950;
      g.fillStyle(0x757575, 0.06 + Math.random() * 0.05);
      g.fillRoundedRect(sx, sy, 20 + Math.random() * 20, 15 + Math.random() * 15, 3);
    }
    // 大量树木 — 不同种类和大小
    for (let i = 0; i < 35; i++) {
      const tx = -50 + Math.random() * 1700;
      const ty = 50 + Math.random() * 950;
      const ts = 0.6 + Math.random() * 0.8;
      // 树干
      g.fillStyle(0x5d4037, 0.2);
      g.fillRect(tx - 2 * ts, ty, 4 * ts, 12 * ts);
      // 树冠 — 多层圆
      const crownColors = [0x2e7d32, 0x388e3c, 0x43a047, 0x66bb6a];
      for (let ci = 0; ci < 3; ci++) {
        g.fillStyle(crownColors[ci % 4], 0.12 - ci * 0.03);
        g.fillCircle(tx, ty - 8 * ts + ci * 4, (10 - ci * 2) * ts);
      }
    }
    // 灯笼 — 红色圆灯笼挂在路边
    const lanterns = [
      { x: 250, y: 180 }, { x: 600, y: 350 }, { x: 950, y: 200 },
      { x: 400, y: 550 }, { x: 1100, y: 500 }, { x: 800, y: 700 },
    ];
    for (const l of lanterns) {
      // 挂线
      g.lineStyle(0.5, 0x5d4037, 0.15);
      g.beginPath();
      g.moveTo(l.x, l.y - 15); g.lineTo(l.x, l.y);
      g.strokePath();
      // 灯笼体
      g.fillStyle(0xc62828, 0.2);
      g.fillEllipse(l.x, l.y + 5, 14, 18);
      // 灯光
      g.fillStyle(0xffeb3b, 0.12);
      g.fillCircle(l.x, l.y + 5, 4);
    }
    // 亭子 — 中国风小凉亭
    const pavilions = [
      { x: 500, y: 300 }, { x: 1000, y: 600 },
    ];
    for (const p of pavilions) {
      // 飞檐屋顶（三角形）
      g.fillStyle(0x8b4513, 0.15);
      g.beginPath();
      g.moveTo(p.x - 25, p.y - 5); g.lineTo(p.x, p.y - 25); g.lineTo(p.x + 25, p.y - 5);
      g.closePath();
      g.fillPath();
      // 屋檐翘角
      g.lineStyle(1.5, 0x8b4513, 0.2);
      g.beginPath();
      g.moveTo(p.x - 28, p.y - 3); g.lineTo(p.x - 25, p.y - 5);
      g.moveTo(p.x + 25, p.y - 5); g.lineTo(p.x + 28, p.y - 3);
      g.strokePath();
      // 柱子
      g.fillStyle(0x6d4c41, 0.12);
      g.fillRect(p.x - 18, p.y - 5, 4, 20);
      g.fillRect(p.x + 14, p.y - 5, 4, 20);
      // 地台
      g.fillStyle(0x795548, 0.1);
      g.fillRect(p.x - 22, p.y + 12, 44, 4);
    }
    // 池塘 — 荷花池
    const ponds = [
      { x: 300, y: 650, r: 50 },
      { x: 1200, y: 350, r: 40 },
    ];
    for (const p of ponds) {
      g.fillStyle(0x1565c0, 0.1);
      g.fillEllipse(p.x, p.y, p.r * 2, p.r);
      // 荷叶
      g.fillStyle(0x388e3c, 0.15);
      for (let li = 0; li < 4; li++) {
        const la = (li / 4) * Math.PI * 2;
        g.fillCircle(p.x + Math.cos(la) * p.r * 0.5, p.y + Math.sin(la) * p.r * 0.3, 8);
      }
      // 荷花粉点
      g.fillStyle(0xe91e63, 0.1);
      g.fillCircle(p.x, p.y, 3);
    }
    // 石桥 — 小拱桥
    g.fillStyle(0x9e9e9e, 0.1);
    g.beginPath();
    g.moveTo(600, 700); g.lineTo(600, 680);
    g.lineTo(680, 660); g.lineTo(760, 680); g.lineTo(760, 700);
    g.closePath();
    g.fillPath();
  }

  // ===== 繁华都市主题 =====
  private drawCityTheme(g: Phaser.GameObjects.Graphics): void {
    // 河流（蓝色曲线带）
    g.fillStyle(0x1a4a6e, 0.15);
    g.beginPath();
    g.moveTo(-100, 300); g.lineTo(200, 250); g.lineTo(500, 350);
    g.lineTo(800, 280); g.lineTo(1100, 320); g.lineTo(1300, 250);
    g.lineTo(1700, 300); g.lineTo(1700, 340); g.lineTo(1300, 290);
    g.lineTo(1100, 360); g.lineTo(800, 320); g.lineTo(500, 390);
    g.lineTo(200, 290); g.lineTo(-100, 340);
    g.closePath();
    g.fillPath();
    // 公园斑块
    const parks = [
      { x: 200, y: 150, r: 80 },
      { x: 700, y: 500, r: 100 },
      { x: 350, y: 600, r: 60 },
    ];
    for (const p of parks) {
      g.fillStyle(0x1a5e2e, 0.2);
      g.fillCircle(p.x, p.y, p.r);
      g.fillStyle(0x229954, 0.12);
      g.fillCircle(p.x, p.y, p.r * 0.7);
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        g.fillStyle(0x27ae60, 0.25);
        g.fillCircle(p.x + Math.cos(angle) * p.r * 0.5, p.y + Math.sin(angle) * p.r * 0.5, 6);
      }
    }
    // 摩天楼 — 高大建筑剪影
    const buildings = [
      { x: 100, y: 500, w: 40, h: 120 }, { x: 160, y: 520, w: 30, h: 100 },
      { x: 250, y: 480, w: 50, h: 140 }, { x: 850, y: 550, w: 45, h: 110 },
      { x: 920, y: 530, w: 35, h: 130 }, { x: 1000, y: 560, w: 40, h: 100 },
      { x: 1300, y: 500, w: 45, h: 130 }, { x: 1370, y: 520, w: 30, h: 110 },
      { x: 1450, y: 490, w: 50, h: 150 },
    ];
    for (const b of buildings) {
      g.fillStyle(0x2c3e50, 0.15);
      g.fillRect(b.x, b.y - b.h, b.w, b.h);
      // 窗户灯光
      g.fillStyle(0xf1c40f, 0.05);
      for (let wy = 0; wy < b.h - 8; wy += 10) {
        for (let wx = 0; wx < b.w - 6; wx += 8) {
          if (Math.random() > 0.4) {
            g.fillRect(b.x + wx + 2, b.y - b.h + wy + 2, 2, 3);
          }
        }
      }
    }
    // 街灯 — 路灯
    const lamps = [
      { x: 300, y: 300 }, { x: 600, y: 400 }, { x: 900, y: 300 },
      { x: 1200, y: 450 }, { x: 1500, y: 350 },
    ];
    for (const l of lamps) {
      g.lineStyle(1, 0x7f8c8d, 0.15);
      g.beginPath();
      g.moveTo(l.x, l.y); g.lineTo(l.x, l.y - 20);
      g.strokePath();
      g.fillStyle(0xf1c40f, 0.12);
      g.fillCircle(l.x, l.y - 22, 4);
      // 灯光晕
      g.fillStyle(0xf1c40f, 0.04);
      g.fillCircle(l.x, l.y - 22, 10);
    }
    // 行道树
    for (let i = 0; i < 15; i++) {
      const tx = 50 + i * 110 + Math.random() * 30;
      const ty = 700 + Math.random() * 200;
      g.fillStyle(0x5d4037, 0.12);
      g.fillRect(tx - 2, ty, 4, 10);
      g.fillStyle(0x27ae60, 0.12);
      g.fillCircle(tx, ty, 8);
    }
  }

  // ===== M3: 道路视觉 — 路缘石 + 马路 + 黄色虚线中线 =====
  private drawPaths(): void {
    const g = this.add.graphics();
    const drawn = new Set<string>();

    // 辅助函数：绘制一条道路（3 层）
    const drawRoad = (x1: number, y1: number, x2: number, y2: number) => {
      // 第 1 层：路缘石（深灰，8px 宽）
      g.lineStyle(8, 0x3a3a3a, 0.4);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.strokePath();

      // 第 2 层：马路面（中灰，5px 宽）
      g.lineStyle(5, 0x555555, 0.5);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.strokePath();

      // 第 3 层：黄色虚线中线（通过短线段模拟虚线）
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dashLen = 6;
      const gapLen = 4;
      const totalLen = dashLen + gapLen;
      const numDashes = Math.floor(dist / totalLen);
      g.lineStyle(1.5, 0xf1c40f, 0.5);
      for (let i = 0; i < numDashes; i++) {
        const t1 = (i * totalLen) / dist;
        const t2 = (i * totalLen + dashLen) / dist;
        g.beginPath();
        g.moveTo(x1 + dx * t1, y1 + dy * t1);
        g.lineTo(x1 + dx * t2, y1 + dy * t2);
        g.strokePath();
      }
    };

    for (const node of this.map.nodes) {
      for (const adjId of node.adjacent) {
        const key = `${Math.min(node.id, adjId)}-${Math.max(node.id, adjId)}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const adj = this.map.nodes[adjId];
        if (!adj) continue;
        drawRoad(node.x, node.y, adj.x, adj.y);
      }
    }
  }

  // ===== 地块渲染 =====
  private drawTiles(): void {
    for (const node of this.map.nodes) {
      const tileType = this.getNodeTileType(node);
      const texKey = `tile_${tileType}`;
      const bg = this.add.image(node.x, node.y, texKey);

      // M2: 地块沿路径朝向 — 根据第一个邻接方向旋转地块
      if (node.adjacent.length > 0) {
        const firstAdj = this.map.nodes[node.adjacent[0]];
        if (firstAdj) {
          const angle = Math.atan2(firstAdj.y - node.y, firstAdj.x - node.x);
          bg.setRotation(angle - Math.PI / 2);
        }
      }

      // 地块名称
      const name = this.getNodeName(node);
      const nameLabel = this.add.text(node.x, node.y - 16, name, {
        fontSize: "10px",
        color: "#ffffff",
        fontFamily: "sans-serif",
        fontStyle: "bold",
      }).setOrigin(0.5, 0.5);
      nameLabel.setWordWrapWidth(66, true);

      // 价格标签
      let priceText = "";
      const land = this.map.lands.find(l => l.id === node.id);
      const facility = this.map.facilities.find(f => f.id === node.id);
      const commercial = this.map.commercials.find(c => c.id === node.id);
      if (land) priceText = `¥${land.landPrice}`;
      else if (facility) priceText = facility.name;
      else if (commercial) priceText = `¥${commercial.tollFee}`;

      const priceLabel = this.add.text(node.x, node.y + 20, priceText, {
        fontSize: "8px",
        color: "#f1c40f",
        fontFamily: "monospace",
      }).setOrigin(0.5, 0.5);

      // 设施图标 — 使用 Kenney gameicons
      let icon: Phaser.GameObjects.Image | undefined;
      if (facility) {
        const iconKey = FACILITY_ICON_MAP[facility.type] || "icon_question";
        if (this.textures.exists(iconKey)) {
          icon = this.add.image(node.x, node.y, iconKey).setScale(0.45).setTint(0xffffff);
        }
      }

      // B4: 建筑精灵 — 根据等级分层选择不同建筑纹理
      let building: Phaser.GameObjects.Image | undefined;
      let levelBadge: Phaser.GameObjects.Text | undefined;
      if (land && land.level && land.level > 0) {
        const buildIdx = this.getBuildingIndex(land.level, land.maxLevel);
        const buildKey = `building_${buildIdx}`;
        if (this.textures.exists(buildKey)) {
          building = this.add.image(node.x, node.y - 4, buildKey).setDepth(5).setScale(0.6);
        }
        // B4: 等级数字标识 — 建筑右上角显示等级数字
        levelBadge = this.add.text(node.x + 22, node.y - 22, `Lv.${land.level}`, {
          fontSize: "8px",
          color: "#f1c40f",
          fontFamily: "sans-serif",
          fontStyle: "bold",
          backgroundColor: "#2c3e50",
          padding: { x: 2, y: 1 },
        }).setOrigin(0.5, 0.5).setDepth(7);
      }

      // 连锁店标记 — B3: 改为程序化绘制连锁店小招牌（三角旗）
      let chainIcon: Phaser.GameObjects.Image | undefined;
      if (land && land.isChainStore) {
        chainIcon = this.add.image(node.x + 22, node.y - 22, "chain_flag").setDepth(6);
      }

      const container = this.add.container(node.x, node.y, [bg, nameLabel, priceLabel]);
      this.tileVisuals.set(node.id, {
        container,
        bg,
        icon,
        building,
        levelBadge,
        chainIcon,
        nameLabel,
        priceLabel,
      });

      // T4: 可购买提示 — 空地地块上方浮动金币图标
      if (land && (land.owner === undefined || land.owner < 0) && land.level === 0) {
        const buyHint = this.add.image(node.x, node.y - 36, "icon_coin").setDepth(7).setScale(0.8);
        this.tweens.add({
          targets: buyHint,
          y: node.y - 44,
          duration: 600,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
        // 存入 tileVisuals
        const tv = this.tileVisuals.get(node.id);
        if (tv) tv.buyHint = buyHint;
      }

      bg.setInteractive();
      bg.on("pointerdown", () => this.onTileClick(node));
      bg.on("pointerover", () => {
        this.tweens.add({
          targets: bg,
          scaleX: 1.1,
          scaleY: 1.1,
          duration: 100,
          ease: "Power2",
        });
      });
      bg.on("pointerout", () => {
        this.tweens.add({
          targets: bg,
          scaleX: 1,
          scaleY: 1,
          duration: 100,
          ease: "Power2",
        });
      });
    }
  }

  private getNodeTileType(node: MapNode): string {
    if (node.id === this.map.startNodeId) return "start";
    const land = this.map.lands.find(l => l.id === node.id);
    if (land) {
      if (land.tmpState === "sealed") return "sealed";
      if (land.tmpState === "price_up") return "priceup";
      return "land";
    }
    if (this.map.facilities.find(f => f.id === node.id)) return "facility";
    if (this.map.commercials.find(c => c.id === node.id)) return "commercial";
    if (this.map.landmarks.find(lm => lm.id === node.id)) return "landmark";
    return "empty";
  }

  private getNodeName(node: MapNode): string {
    const land = this.map.lands.find(l => l.id === node.id);
    if (land) return land.name;
    const facility = this.map.facilities.find(f => f.id === node.id);
    if (facility) return facility.name;
    const commercial = this.map.commercials.find(c => c.id === node.id);
    if (commercial) return commercial.name;
    const landmark = this.map.landmarks.find(lm => lm.id === node.id);
    if (landmark) return landmark.name;
    if (node.id === this.map.startNodeId) return "起点";
    return "";
  }

  // ===== P1: 棋子 — 使用 Kenney characters 替代 pawns =====
  private createPawns(): void {
    const pawnColors = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c"];

    for (const player of this.engine.getPlayers()) {
      const node = this.map.nodes[player.positionNodeId];
      const px = node?.x || 0;
      const py = node?.y || 0;
      const pawnIdx = player.id % 6;

      // P1: 尝试使用 character 纹理，回退到 pawn
      const charKey = `character_${pawnIdx}`;
      const pawnKey = `pawn_${pawnIdx}`;
      const useKey = this.textures.exists(charKey) ? charKey : pawnKey;

      // 阴影
      const shadow = this.add.image(px, py + 10, pawnKey);
      shadow.setTint(0x000000);
      shadow.setAlpha(0.3);
      shadow.setScale(1, 0.5);
      shadow.setDepth(9);

      // P1: 使用角色精灵
      const pawn = this.add.image(px, py, useKey);
      // character 纹理通常更大，缩放到棋盘比例
      const scale = useKey.startsWith("character") ? 0.3 : 0.5;
      pawn.setScale(scale);
      pawn.setDepth(10);
      this.pawnImages.set(player.id, pawn);

      // P5: 骑乘状态显示 — 交通方式>步行时显示车辆图标
      if (player.trafficMethod > 0) {
        const rideKey = player.trafficMethod === 1 ? "ride_motorcycle" : "ride_car";
        if (this.textures.exists(rideKey)) {
          const rideIcon = this.add.image(px + 14, py + 6, rideKey).setDepth(10).setScale(0.5);
          this.pawnRideIcons.set(player.id, rideIcon);
        }
      }

      // 玩家名字标签
      const nameTag = this.add.text(px, py - 20, player.name, {
        fontSize: "9px",
        color: pawnColors[pawnIdx],
        fontFamily: "sans-serif",
        fontStyle: "bold",
        backgroundColor: "#00000088",
        padding: { x: 3, y: 1 },
      }).setOrigin(0.5, 0.5).setDepth(11);

      const container = this.add.container(px, py, [pawn, nameTag]);
      container.setDepth(10);
      this.pawnSprites.set(player.id, container);
      this.pawnShadowSprites.set(player.id, shadow);
    }
  }

  private updatePawnPosition(playerId: number, nodeId: number): void {
    const container = this.pawnSprites.get(playerId);
    const shadow = this.pawnShadowSprites.get(playerId);
    const pawnImg = this.pawnImages.get(playerId);
    const node = this.map.nodes[nodeId];
    if (!container || !node) return;

    const playerIdx = this.engine.getPlayers().findIndex(p => p.id === playerId);
    const offsetX = (playerIdx % 2) * 14 - 7;
    const offsetY = Math.floor(playerIdx / 2) * 14 - 7;
    const tx = node.x + offsetX;
    const ty = node.y + offsetY;

    // P3: 方向朝向 — 根据移动方向翻转
    if (pawnImg) {
      const prevX = container.x;
      if (tx < prevX) {
        pawnImg.setFlipX(true);
      } else if (tx > prevX) {
        pawnImg.setFlipX(false);
      }
    }

    if (shadow) {
      this.tweens.add({
        targets: shadow,
        x: tx,
        y: ty + 10,
        duration: 350,
        ease: "Power2",
      });
    }

    // P5: 骑乘状态图标同步移动
    const rideIcon = this.pawnRideIcons.get(playerId);
    if (rideIcon) {
      this.tweens.add({
        targets: rideIcon,
        x: tx + 14,
        y: ty + 6,
        duration: 350,
        ease: "Power2",
      });
    }

    this.tweens.add({
      targets: container,
      x: tx,
      y: ty,
      duration: 350,
      ease: "Back.out(1.5)",
      onUpdate: (tween) => {
        const progress = tween.progress;
        // P2: 行走动画 — 多次小弹跳模拟步伐
        const bounce = Math.abs(Math.sin(progress * Math.PI * 3)) * 8;
        container.y = ty - bounce;
      },
      onComplete: () => {
        container.y = ty;
      },
    });
  }

  // ===== B1: 所有者边框条 + T3: 地块高亮 =====
  private refreshTileVisuals(): void {
    for (const [nodeId, visual] of this.tileVisuals) {
      const land = this.map.lands.find(l => l.id === nodeId);
      if (!land) continue;

      // B4: 建筑更新 — 根据等级分层
      if (land.level && land.level > 0) {
        const buildIdx = this.getBuildingIndex(land.level, land.maxLevel);
        const buildKey = `building_${buildIdx}`;
        if (visual.building) {
          if (visual.building.texture.key !== buildKey && this.textures.exists(buildKey)) {
            // B2: 升级动画 — 从 scaleY=0 弹起
            visual.building.setTexture(buildKey);
            visual.building.setScale(0.6, 0);
            this.tweens.add({
              targets: visual.building,
              scaleY: 0.6,
              duration: 400,
              ease: "Back.out(1.5)",
            });
          }
        } else if (this.textures.exists(buildKey)) {
          visual.building = this.add.image(visual.container.x, visual.container.y - 4, buildKey).setDepth(5).setScale(0.6);
          // B2: 新建筑也加弹起动画
          visual.building.setScale(0.6, 0);
          this.tweens.add({
            targets: visual.building,
            scaleY: 0.6,
            duration: 400,
            ease: "Back.out(1.5)",
          });
        }
        // B4: 更新等级标识
        if (visual.levelBadge) {
          visual.levelBadge.setText(`Lv.${land.level}`);
        } else {
          visual.levelBadge = this.add.text(visual.container.x + 22, visual.container.y - 22, `Lv.${land.level}`, {
            fontSize: "8px",
            color: "#f1c40f",
            fontFamily: "sans-serif",
            fontStyle: "bold",
            backgroundColor: "#2c3e50",
            padding: { x: 2, y: 1 },
          }).setOrigin(0.5, 0.5).setDepth(7);
        }
      } else {
        visual.building?.destroy();
        visual.building = undefined;
        visual.levelBadge?.destroy();
        visual.levelBadge = undefined;
      }

      // B1: 所有者标识 — 边框条而非 setTint
      if (land.owner !== undefined && land.owner >= 0) {
        const owner = this.engine.getPlayers()[land.owner];
        if (owner) {
          // 移除旧边框
          if (visual.ownerBorder) {
            visual.ownerBorder.destroy();
          }
          // 创建新的所有者颜色边框条（底部 4px 高色条）
          const borderColor = this.parseColor(owner.color);
          visual.ownerBorder = this.add.rectangle(
            visual.container.x,
            visual.container.y + 34,
            70, 4,
            borderColor
          ).setDepth(4).setAlpha(0.9);
          // 不再 setTint 整个地块
          visual.bg.clearTint();
        }
      } else {
        visual.bg.clearTint();
        if (visual.ownerBorder) {
          visual.ownerBorder.destroy();
          visual.ownerBorder = undefined;
        }
      }

      // B3: 连锁店标志 — 使用 chain_flag 纹理
      if (land.isChainStore && !visual.chainIcon) {
        visual.chainIcon = this.add.image(visual.container.x + 22, visual.container.y - 22, "chain_flag").setDepth(6);
      } else if (!land.isChainStore && visual.chainIcon) {
        visual.chainIcon.destroy();
        visual.chainIcon = undefined;
      }
    }
  }

  // ===== T3: 地块高亮 — 脉冲 alpha =====
  private highlightTile(nodeId: number): void {
    // 清除上一个高亮
    if (this.currentHighlightNodeId >= 0) {
      const prev = this.tileVisuals.get(this.currentHighlightNodeId);
      if (prev && prev.highlightTween) {
        prev.highlightTween.stop();
        prev.bg.setAlpha(1);
      }
    }

    const visual = this.tileVisuals.get(nodeId);
    if (!visual) return;

    visual.highlightTween = this.tweens.add({
      targets: visual.bg,
      alpha: { from: 0.7, to: 1.0 },
      duration: 500,
      yoyo: true,
      repeat: 2,
      ease: "Sine.inOut",
    });
    this.currentHighlightNodeId = nodeId;
  }

  // ===== T2: 过路费飞字 =====
  private showFloatText(playerId: number, text: string, color: number): void {
    const container = this.pawnSprites.get(playerId);
    if (!container) return;
    const x = container.x;
    const y = container.y - 20;

    const floatText = this.add.text(x, y, text, {
      fontSize: "14px",
      color: `#${color.toString(16).padStart(6, "0")}`,
      fontFamily: "sans-serif",
      fontStyle: "bold",
      stroke: "#000000",
      strokeThickness: 3,
    }).setOrigin(0.5, 0.5).setDepth(50);

    this.tweens.add({
      targets: floatText,
      y: y - 30,
      alpha: 0,
      duration: 1200,
      ease: "Quad.out",
      onComplete: () => floatText.destroy(),
    });
  }

  // ===== A1: 行走音效 =====
  private playStepSound(): void {
    // 通过 UIScene 播放脚步声
    const uiScene = this.scene.get("UIScene") as any;
    if (uiScene && uiScene.playSfx) {
      uiScene.playSfx("sfx_click", 0.3);
    }
  }

  // ===== A2: 事件音效 =====
  private playEventSound(type: "chips" | "confirm" | "fail" | "card" | "switch"): void {
    const uiScene = this.scene.get("UIScene") as any;
    if (!uiScene || !uiScene.playSfx) return;
    const map: Record<string, string> = {
      chips: "sfx_chips",
      confirm: "sfx_confirm",
      fail: "sfx_fail",
      card: "sfx_card",
      switch: "sfx_switch",
    };
    uiScene.playSfx(map[type]);
  }

  private parseColor(hex: string): number {
    const h = hex.replace("#", "0x");
    return parseInt(h, 16);
  }

  // ===== T4: 更新可购买提示 =====
  private updateBuyHints(): void {
    for (const [nodeId, visual] of this.tileVisuals) {
      const land = this.map.lands.find(l => l.id === nodeId);
      if (!land) continue;
      const canBuy = (land.owner === undefined || land.owner < 0) && land.level === 0;

      if (canBuy && !visual.buyHint) {
        // 添加浮动金币
        visual.buyHint = this.add.image(visual.container.x, visual.container.y - 36, "icon_coin").setDepth(7).setScale(0.8);
        this.tweens.add({
          targets: visual.buyHint,
          y: visual.container.y - 44,
          duration: 600,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
      } else if (!canBuy && visual.buyHint) {
        // 移除金币
        visual.buyHint.destroy();
        visual.buyHint = undefined;
      }
    }
  }

  // ===== P5: 更新骑乘状态显示 =====
  private updateRideIcons(): void {
    for (const player of this.engine.getPlayers()) {
      const existing = this.pawnRideIcons.get(player.id);
      const shouldShow = player.trafficMethod > 0;
      const rideKey = player.trafficMethod === 1 ? "ride_motorcycle" : "ride_car";

      if (shouldShow) {
        if (existing) {
          // 已存在，更新纹理
          if (existing.texture.key !== rideKey && this.textures.exists(rideKey)) {
            existing.setTexture(rideKey);
          }
        } else if (this.textures.exists(rideKey)) {
          // 新增
          const container = this.pawnSprites.get(player.id);
          if (container) {
            const rideIcon = this.add.image(container.x + 14, container.y + 6, rideKey).setDepth(10).setScale(0.5);
            this.pawnRideIcons.set(player.id, rideIcon);
          }
        }
      } else if (existing) {
        // 步行状态，移除骑乘图标
        existing.destroy();
        this.pawnRideIcons.delete(player.id);
      }
    }
  }

  // ===== O1: 粒子系统 =====
  private emitParticles(nodeId: number, color: number): void {
    const visual = this.tileVisuals.get(nodeId);
    if (!visual) return;
    const x = visual.container.x;
    const y = visual.container.y - 4;

    // 程序化生成粒子纹理（小圆点）
    const particleKey = `particle_${color.toString(16)}`;
    if (!this.textures.exists(particleKey)) {
      const g = this.add.graphics();
      g.fillStyle(color, 1);
      g.fillCircle(3, 3, 3);
      g.fillStyle(0xffffff, 0.4);
      g.fillCircle(2, 2, 1.5);
      g.generateTexture(particleKey, 6, 6);
      g.destroy();
    }

    // 发射 8 颗粒子
    for (let i = 0; i < 8; i++) {
      const particle = this.add.image(x, y, particleKey).setDepth(20);
      const angle = (i / 8) * Math.PI * 2 + Math.random() * 0.3;
      const dist = 20 + Math.random() * 20;
      this.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist - 15,
        alpha: 0,
        scaleX: 0.3,
        scaleY: 0.3,
        duration: 600 + Math.random() * 200,
        ease: "Quad.out",
        onComplete: () => particle.destroy(),
      });
    }
  }

  // ===== O3: 昼夜色调 =====
  private updateDayNight(): void {
    if (!this.dayNightOverlay) return;
    const hud = this.engine.getHUDState();
    const progress = hud.totalRounds > 0 ? hud.round / hud.totalRounds : 0;

    // 0-25%: 白天（透明）
    // 25-50%: 黄昏（橙色调）
    // 50-75%: 夜晚（深蓝色调）
    // 75-100%: 黎明（紫色调）
    let color = 0x000000;
    let alpha = 0;

    if (progress < 0.25) {
      // 白天
      color = 0x000000;
      alpha = 0;
    } else if (progress < 0.5) {
      // 黄昏
      color = 0xe67e22;
      alpha = 0.08;
    } else if (progress < 0.75) {
      // 夜晚
      color = 0x0a0a3a;
      alpha = 0.15;
    } else {
      // 黎明
      color = 0x6c3483;
      alpha = 0.06;
    }

    this.dayNightOverlay.setFillStyle(color, alpha);
  }

  // ===== 相机拖拽 + 缩放 =====
  private setupCameraDrag(): void {
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) {
        isDragging = true;
        lastX = pointer.x;
        lastY = pointer.y;
      }
    });

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (isDragging) {
        const dx = pointer.x - lastX;
        const dy = pointer.y - lastY;
        this.cameras.main.scrollX -= dx / this.cameras.main.zoom;
        this.cameras.main.scrollY -= dy / this.cameras.main.zoom;
        lastX = pointer.x;
        lastY = pointer.y;
      }
    });

    this.input.on("pointerup", () => {
      isDragging = false;
    });

    this.input.on("wheel", (_pointer: Phaser.Input.Pointer, _gameObjects: any[], _deltaX: number, deltaY: number) => {
      const zoom = this.cameras.main.zoom;
      this.cameras.main.setZoom(Phaser.Math.Clamp(zoom - deltaY * 0.001, 0.4, 1.8));
    });
  }

  private onTileClick(node: MapNode): void {
    const land = this.map.lands.find(l => l.id === node.id);
    const facility = this.map.facilities.find(f => f.id === node.id);
    const commercial = this.map.commercials.find(c => c.id === node.id);
    const landmark = this.map.landmarks.find(lm => lm.id === node.id);
    // T1: 地块信息弹窗
    this.showTileInfoPopup(node, land, facility, commercial, landmark);
    if (land) {
      this.events.emit("tile_selected", { node, land });
    } else if (facility) {
      this.events.emit("facility_selected", { node, facility });
    }
  }

  // ===== B4: 建筑等级分层映射 =====
  private getBuildingIndex(level: number, maxLevel: number): number {
    // 将等级映射到 0-12 的建筑纹理索引
    // 1级→0(小屋), 2级→1, 3级→2, ... maxLevel→12
    if (maxLevel <= 0) return 0;
    const ratio = (level - 1) / Math.max(1, maxLevel - 1);
    return Math.min(12, Math.floor(ratio * 12));
  }

  // ===== T1: 地块信息弹窗 =====
  private showTileInfoPopup(
    node: MapNode,
    land?: any,
    facility?: any,
    commercial?: any,
    landmark?: any,
  ): void {
    this.closeInfoPopup();

    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    const panelW = 200;
    const panelH = 140;
    const px = (camW - panelW) / 2;
    const py = (camH - panelH) / 2 - 50;

    const overlay = this.add.rectangle(0, 0, camW, camH, 0x000000, 0.3)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(300).setAlpha(0);
    overlay.setInteractive();

    const panel = this.add.rectangle(px, py, panelW, panelH, 0x2c3e50, 0.95)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(301);
    panel.setStrokeStyle(2, 0xf1c40f, 0.5);

    const lines: string[] = [];
    if (land) {
      lines.push(`【地块】${land.name}`);
      lines.push(`地价: ¥${land.landPrice}`);
      lines.push(`建造费: ¥${land.buildPrice}`);
      lines.push(`等级: ${land.level || 0} / ${land.maxLevel}`);
      if (land.owner !== undefined && land.owner >= 0) {
        const owner = this.engine.getPlayers()[land.owner];
        lines.push(`所有者: ${owner ? owner.name : "未知"}`);
      } else {
        lines.push(`所有者: 无主`);
      }
      if (land.isChainStore) lines.push(`★ 连锁店`);
      const toll = (land.tolls && land.level) ? land.tolls[land.level - 1] : (land.tolls?.[0] || 0);
      lines.push(`过路费: ¥${toll}`);
    } else if (facility) {
      lines.push(`【设施】${facility.name}`);
      lines.push(`类型: ${facility.type}`);
    } else if (commercial) {
      lines.push(`【商业】${commercial.name}`);
      lines.push(`类型: ${commercial.type}`);
      lines.push(`过路费: ¥${commercial.tollFee}`);
    } else if (landmark) {
      lines.push(`【地标】${landmark.name}`);
    } else if (node.id === this.map.startNodeId) {
      lines.push(`【起点】`);
      lines.push(`经过即领工资`);
    } else {
      lines.push(`【空地】`);
    }

    const infoText = this.add.text(px + 10, py + 10, lines.join("\n"), {
      fontSize: "11px",
      color: "#ecf0f1",
      fontFamily: "sans-serif",
      lineSpacing: 4,
    }).setScrollFactor(0).setDepth(302);

    const closeBtn = this.add.text(px + panelW - 20, py + 5, "×", {
      fontSize: "16px",
      color: "#e74c3c",
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setScrollFactor(0).setDepth(302).setInteractive();
    closeBtn.on("pointerdown", () => this.closeInfoPopup());

    this.infoPopup = this.add.container(0, 0, [overlay, panel, infoText, closeBtn]).setScrollFactor(0).setDepth(300);
    overlay.on("pointerdown", () => this.closeInfoPopup());

    this.tweens.add({ targets: overlay, alpha: 0.3, duration: 200, ease: "Quad.out" });
    this.tweens.add({
      targets: [panel, infoText, closeBtn],
      scale: { from: 0.8, to: 1 },
      alpha: { from: 0, to: 1 },
      duration: 200,
      ease: "Back.out(1.5)",
    });
  }

  private closeInfoPopup(): void {
    if (this.infoPopup) {
      this.infoPopup.destroy(true);
      this.infoPopup = undefined;
    }
  }

  // ===== G16: 卡牌翻牌动画 =====
  private showCardFlipAnimation(data: { playerId: number; cardId: number; cardName: string }): void {
    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    const cx = camW / 2;
    const cy = camH / 2;

    // 卡牌背面（紫色矩形）
    const cardBack = this.add.rectangle(cx, cy, 80, 110, 0x9b59b6, 1)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(320);
    // 卡牌背面花纹
    const cardStar = this.add.text(cx, cy, "★", {
      fontSize: "32px",
      color: "#f1c40f",
    }).setOrigin(0.5).setScrollFactor(0).setDepth(321);

    // 卡牌正面（翻转后显示）
    const cardFront = this.add.rectangle(cx, cy, 80, 110, 0xf39c12, 0)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(320);
    const cardName = this.add.text(cx, cy, data.cardName, {
      fontSize: "14px",
      color: "#fff",
      align: "center",
      wordWrap: { width: 70 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(321).setAlpha(0);

    // 翻牌动画：先缩小 scaleX → 0，然后切换为正面放大
    this.tweens.add({
      targets: [cardBack, cardStar],
      scaleX: 0,
      duration: 300,
      ease: "Power2",
      onComplete: () => {
        cardBack.setVisible(false);
        cardStar.setVisible(false);
        cardFront.setFillStyle(0xf39c12, 1);
        this.tweens.add({
          targets: cardFront,
          scaleX: 1,
          duration: 300,
          ease: "Power2",
        });
        this.tweens.add({
          targets: cardName,
          alpha: 1,
          duration: 300,
        });
        // 飞出消失
        this.time.delayedCall(1200, () => {
          this.tweens.add({
            targets: [cardFront, cardName],
              y: cy - 100,
              alpha: 0,
              duration: 500,
              ease: "Power2",
              onComplete: () => {
                cardFront.destroy();
                cardName.destroy();
                cardBack.destroy();
                cardStar.destroy();
              },
          });
        });
      },
    });
  }

  // ===== R2: 事件弹窗（命运/新闻） =====
  private showEventPopup(event: any): void {
    this.closeEventPopup();

    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    const panelW = 280;
    const panelH = 160;
    const px = (camW - panelW) / 2;
    const py = (camH - panelH) / 2;

    const isFortune = event.type === "trigger_fortune";
    const title = isFortune ? "命运" : "新闻";
    const accentColor = isFortune ? 0x9b59b6 : 0xe67e22;

    const overlay = this.add.rectangle(0, 0, camW, camH, 0x000000, 0.4)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(310).setAlpha(0);
    overlay.setInteractive();

    const panel = this.add.rectangle(px, py, panelW, panelH, 0x2c3e50, 0.97)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(311);
    panel.setStrokeStyle(3, accentColor, 0.7);

    const titleText = this.add.text(px + panelW / 2, py + 15, title, {
      fontSize: "16px",
      color: `#${accentColor.toString(16).padStart(6, "0")}`,
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(312);

    const descText = this.add.text(px + 15, py + 40, event.data?.description || "发生了一件事...", {
      fontSize: "12px",
      color: "#ecf0f1",
      fontFamily: "sans-serif",
      wordWrap: { width: panelW - 30 },
      lineSpacing: 4,
    }).setScrollFactor(0).setDepth(312);

    const okBtn = this.add.text(px + panelW / 2, py + panelH - 20, "[ 确认 ]", {
      fontSize: "12px",
      color: "#f1c40f",
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(312).setInteractive();
    okBtn.on("pointerdown", () => this.closeEventPopup());
    okBtn.on("pointerover", () => okBtn.setColor("#ffffff"));
    okBtn.on("pointerout", () => okBtn.setColor("#f1c40f"));

    this.eventPopup = this.add.container(0, 0, [overlay, panel, titleText, descText, okBtn]).setScrollFactor(0).setDepth(310);

    this.tweens.add({ targets: overlay, alpha: 0.4, duration: 200, ease: "Quad.out" });
    this.tweens.add({
      targets: [panel, titleText, descText, okBtn],
      scale: { from: 0.7, to: 1 },
      alpha: { from: 0, to: 1 },
      duration: 300,
      ease: "Back.out(1.5)",
    });

    this.time.delayedCall(5000, () => this.closeEventPopup());
  }

  private closeEventPopup(): void {
    if (this.eventPopup) {
      this.eventPopup.destroy(true);
      this.eventPopup = undefined;
    }
  }

  // ===== R3: 买卖确认弹窗 =====
  private showConfirmPopup(type: "buy_land" | "upgrade_land", data: any): void {
    this.closeConfirmPopup();

    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    const panelW = 240;
    const panelH = 130;
    const px = (camW - panelW) / 2;
    const py = (camH - panelH) / 2;

    const overlay = this.add.rectangle(0, 0, camW, camH, 0x000000, 0.35)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(320).setAlpha(0);
    overlay.setInteractive();

    const panel = this.add.rectangle(px, py, panelW, panelH, 0x2c3e50, 0.97)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(321);
    panel.setStrokeStyle(2, 0x27ae60, 0.6);

    let title = "";
    let desc = "";
    let actionLabel = "";
    if (type === "buy_land") {
      title = "购买地块?";
      desc = `价格: ¥${data.landPrice}\n购买后可建造建筑、收取过路费`;
      actionLabel = "购买";
    } else {
      title = "升级建筑?";
      desc = `当前等级: Lv.${data.level}\n最高等级: Lv.${data.maxLevel}\n升级后过路费增加`;
      actionLabel = "升级";
    }

    const titleText = this.add.text(px + panelW / 2, py + 15, title, {
      fontSize: "14px",
      color: "#f1c40f",
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(322);

    const descText = this.add.text(px + 15, py + 35, desc, {
      fontSize: "11px",
      color: "#ecf0f1",
      fontFamily: "sans-serif",
      lineSpacing: 3,
    }).setScrollFactor(0).setDepth(322);

    const confirmBtn = this.add.text(px + panelW * 0.3, py + panelH - 18, `[ ${actionLabel} ]`, {
      fontSize: "12px",
      color: "#27ae60",
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(322).setInteractive();
    confirmBtn.on("pointerdown", () => {
      if (type === "buy_land") {
        this.engine.buyLand(data.landIndex);
      } else {
        this.engine.upgradeLand(data.landIndex);
      }
      this.closeConfirmPopup();
    });
    confirmBtn.on("pointerover", () => confirmBtn.setColor("#2ecc71"));
    confirmBtn.on("pointerout", () => confirmBtn.setColor("#27ae60"));

    const cancelBtn = this.add.text(px + panelW * 0.7, py + panelH - 18, "[ 取消 ]", {
      fontSize: "12px",
      color: "#e74c3c",
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(322).setInteractive();
    cancelBtn.on("pointerdown", () => {
      this.engine.skipAction();
      this.closeConfirmPopup();
    });
    cancelBtn.on("pointerover", () => cancelBtn.setColor("#ff6b6b"));
    cancelBtn.on("pointerout", () => cancelBtn.setColor("#e74c3c"));

    this.confirmPopup = this.add.container(0, 0, [overlay, panel, titleText, descText, confirmBtn, cancelBtn])
      .setScrollFactor(0).setDepth(320);

    this.tweens.add({ targets: overlay, alpha: 0.35, duration: 200, ease: "Quad.out" });
    this.tweens.add({
      targets: [panel, titleText, descText, confirmBtn, cancelBtn],
      scale: { from: 0.8, to: 1 },
      alpha: { from: 0, to: 1 },
      duration: 250,
      ease: "Back.out(1.5)",
    });
  }

  private closeConfirmPopup(): void {
    if (this.confirmPopup) {
      this.confirmPopup.destroy(true);
      this.confirmPopup = undefined;
    }
  }

  // ===== P4: 状态表情 =====
  private updateStatusIcons(): void {
    for (const player of this.engine.getPlayers()) {
      const existing = this.pawnStatusIcons.get(player.id);
      let statusKey = "";

      if (player.status === "bankrupted") {
        statusKey = "status_bankrupt";
      } else if (player.daysSleeping > 0 || player.daysSleepWalking > 0) {
        statusKey = "status_sleep";
      } else if (player.daysTortoiseWalking > 0) {
        statusKey = "status_tortoise";
      } else if (player.daysStopping > 0) {
        statusKey = "status_stop";
      } else if (player.godInfo === 1 || player.godInfo === 2) {
        statusKey = "status_god_lucky";
      } else if (player.godInfo === 5 || player.godInfo === 6) {
        statusKey = "status_god_unlucky";
      }

      if (statusKey) {
        if (this.textures.exists(statusKey)) {
          if (existing) {
            if (existing.texture.key !== statusKey) {
              existing.setTexture(statusKey);
            }
          } else {
            const container = this.pawnSprites.get(player.id);
            if (container) {
              const icon = this.add.image(container.x + 14, container.y - 14, statusKey)
                .setDepth(11).setScale(0.6);
              this.pawnStatusIcons.set(player.id, icon);
            }
          }
        }
      } else if (existing) {
        existing.destroy();
        this.pawnStatusIcons.delete(player.id);
      }
    }
  }

  // ===== O2: 地图缩略图 =====
  private createMiniMap(): void {
    const miniMapSize = 120;
    const padding = 10;
    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;

    // 计算地图边界
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of this.map.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    const mapW = maxX - minX + 80;
    const mapH = maxY - minY + 80;
    const scale = Math.min(miniMapSize / mapW, miniMapSize / mapH);

    const g = this.add.graphics();
    // 背景
    g.fillStyle(0x000000, 0.5);
    g.fillRect(0, 0, miniMapSize + 4, miniMapSize + 4);
    g.fillStyle(0x1a1a2e, 0.8);
    g.fillRect(2, 2, miniMapSize, miniMapSize);

    // 绘制节点
    for (const node of this.map.nodes) {
      const mx = 2 + (node.x - minX + 40) * scale;
      const my = 2 + (node.y - minY + 40) * scale;

      const tileType = this.getNodeTileType(node);
      let color = 0x7f8c8d;
      if (tileType === "land") color = 0x2980b9;
      else if (tileType === "facility") color = 0xd4ac0d;
      else if (tileType === "commercial") color = 0x7d3c98;
      else if (tileType === "start") color = 0x229954;

      g.fillStyle(color, 0.8);
      g.fillCircle(mx, my, 2);
    }

    // 绘制路径
    const drawn = new Set<string>();
    g.lineStyle(1, 0xecf0f1, 0.2);
    for (const node of this.map.nodes) {
      for (const adjId of node.adjacent) {
        const key = `${Math.min(node.id, adjId)}-${Math.max(node.id, adjId)}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const adj = this.map.nodes[adjId];
        if (!adj) continue;
        const mx1 = 2 + (node.x - minX + 40) * scale;
        const my1 = 2 + (node.y - minY + 40) * scale;
        const mx2 = 2 + (adj.x - minX + 40) * scale;
        const my2 = 2 + (adj.y - minY + 40) * scale;
        g.beginPath();
        g.moveTo(mx1, my1);
        g.lineTo(mx2, my2);
        g.strokePath();
      }
    }

    // 棋子位置
    for (const player of this.engine.getPlayers()) {
      const node = this.map.nodes[player.positionNodeId];
      if (!node) continue;
      const mx = 2 + (node.x - minX + 40) * scale;
      const my = 2 + (node.y - minY + 40) * scale;
      const color = this.parseColor(player.color);
      g.fillStyle(color, 1);
      g.fillCircle(mx, my, 1.5);
    }

    // 视角指示器
    const indicator = this.add.arc(
      2 + (this.cameras.main.scrollX + camW / 2 / this.cameras.main.zoom - minX + 40) * scale,
      2 + (this.cameras.main.scrollY + camH / 2 / this.cameras.main.zoom - minY + 40) * scale,
      3,
      0x00ffff, 0.8
    ).setScrollFactor(0).setDepth(1);

    this.miniMap = g;
    this.miniMapIndicator = indicator;

    // 放入容器
    this.miniMapContainer = this.add.container(
      camW - miniMapSize - padding - 4,
      camH - miniMapSize - padding - 4,
      [g, indicator]
    ).setScrollFactor(0).setDepth(250);

    // 缩略图可点击拖动
    this.miniMapContainer.setSize(miniMapSize + 4, miniMapSize + 4);
    this.miniMapContainer.setInteractive();
    this.miniMapContainer.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const localX = pointer.x - this.miniMapContainer!.x;
      const localY = pointer.y - this.miniMapContainer!.y;
      const targetX = (localX - 2) / scale + minX - 40;
      const targetY = (localY - 2) / scale + minY - 40;
      this.cameras.main.centerOn(targetX, targetY);
    });
  }

  private updateMiniMap(): void {
    if (!this.miniMap || !this.miniMapIndicator || !this.miniMapContainer) return;

    // 重绘棋子位置和视角指示器
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of this.map.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    const mapW = maxX - minX + 80;
    const mapH = maxY - minY + 80;
    const miniMapSize = 120;
    const scale = Math.min(miniMapSize / mapW, miniMapSize / mapH);

    // 更新视角指示器位置
    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    this.miniMapIndicator.setPosition(
      (this.cameras.main.scrollX + camW / 2 / this.cameras.main.zoom - minX + 40) * scale,
      (this.cameras.main.scrollY + camH / 2 / this.cameras.main.zoom - minY + 40) * scale
    );
  }

  // ===== G2: 路口方向选择弹窗 =====
  private showBranchPopup(data: { playerId: number; choices: { nodeId: number; name: string; x: number; y: number }[]; remainingSteps: number }): void {
    this.closeBranchPopup();

    // 仅人类玩家显示弹窗，AI 自动选择
    const player = this.engine.getPlayers().find(p => p.id === data.playerId);
    if (player?.isAI) return;

    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    const choices = data.choices;
    const panelW = 200;
    const panelH = 50 + choices.length * 40;
    const px = (camW - panelW) / 2;
    const py = (camH - panelH) / 2;

    const overlay = this.add.rectangle(0, 0, camW, camH, 0x000000, 0.4)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(330).setAlpha(0);
    overlay.setInteractive();

    const panel = this.add.rectangle(px, py, panelW, panelH, 0x1a1a2e, 0.97)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(331);
    panel.setStrokeStyle(2, 0x3498db, 0.7);

    const titleText = this.add.text(px + panelW / 2, py + 15, "选择方向", {
      fontSize: "14px",
      color: "#3498db",
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(332);

    const stepText = this.add.text(px + panelW / 2, py + 32, `剩余 ${data.remainingSteps} 步`, {
      fontSize: "10px",
      color: "#bdc3c7",
      fontFamily: "sans-serif",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(332);

    const elements: Phaser.GameObjects.GameObject[] = [overlay, panel, titleText, stepText];

    choices.forEach((choice, i) => {
      const btnY = py + 50 + i * 40;
      const btn = this.add.rectangle(px + 10, btnY, panelW - 20, 32, 0x2c3e50, 0.9)
        .setOrigin(0, 0).setScrollFactor(0).setDepth(332);
      btn.setStrokeStyle(1, 0x3498db, 0.4);
      btn.setInteractive();
      btn.on("pointerover", () => btn.setFillStyle(0x3498db, 0.7));
      btn.on("pointerout", () => btn.setFillStyle(0x2c3e50, 0.9));
      btn.on("pointerdown", () => {
        this.engine.chooseBranch(choice.nodeId);
        this.closeBranchPopup();
      });

      const btnText = this.add.text(px + panelW / 2, btnY + 16, choice.name, {
        fontSize: "12px",
        color: "#ecf0f1",
        fontFamily: "sans-serif",
        fontStyle: "bold",
      }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(333);

      elements.push(btn, btnText);
    });

    this.branchPopup = this.add.container(0, 0, elements).setScrollFactor(0).setDepth(330);

    this.tweens.add({ targets: overlay, alpha: 0.4, duration: 200, ease: "Quad.out" });
    this.tweens.add({
      targets: elements.slice(1),
      scale: { from: 0.8, to: 1 },
      alpha: { from: 0, to: 1 },
      duration: 250,
      ease: "Back.out(1.5)",
    });
  }

  private closeBranchPopup(): void {
    if (this.branchPopup) {
      this.branchPopup.destroy(true);
      this.branchPopup = undefined;
    }
  }

  update(): void {
    // 动画占位
  }
}
