/**
 * BoardScene — 棋盘场景 v3.0
 * 真正的 2.5D 等距视角渲染，对标大富翁4核心视觉体验
 *
 * 核心改造:
 * 1. 等距投影: grid (gx, gy) → screen (sx, sy) = (gx - gy) * tileW/2, (gx + gy) * tileH/2
 * 2. 深度排序: 所有地块/建筑/角色按 isoDepth = gx + gy 排序
 * 3. 逐格行走: 监听 player_moved 事件，沿路径逐格 tween 角色位置
 * 4. 建筑分层: 按等级显示不同建筑精灵，正确的 z-order
 * 5. 所有者颜色条 + 连锁店招牌 + 购买提示
 */

import Phaser from "phaser";
import type { GameBoardMap, MapNode, LandTile, FacilityTile, CommercialTile, Landmark } from "../types";
import type { GameEngine } from "../engine/GameEngine";

// ===== 等距投影常量 =====
// 纹理 80×40，网格间距放大到 84×42 以留出地块间隙
const TILE_W = 84;   // 网格步进宽度
const TILE_H = 42;   // 网格步进高度
const TILE_HW = TILE_W / 2;
const TILE_HH = TILE_H / 2;

/** 网格坐标 → 等距屏幕坐标 */
function gridToIso(gx: number, gy: number): { x: number; y: number } {
  return {
    x: (gx - gy) * TILE_HW,
    y: (gx + gy) * TILE_HH,
  };
}

interface TileVisual {
  container: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.Image;
  ownerBar?: Phaser.GameObjects.Rectangle;
  highlightTween?: Phaser.Tweens.Tween;
  buyHint?: Phaser.GameObjects.Image;
  icon?: Phaser.GameObjects.Image;
  building?: Phaser.GameObjects.Image;
  levelBadge?: Phaser.GameObjects.Text;
  chainIcon?: Phaser.GameObjects.Image;
  nameLabel: Phaser.GameObjects.Text;
  priceLabel: Phaser.GameObjects.Text;
  node: MapNode;
  isoDepth: number;
}

// 设施类型 → 图标 texture key
const FACILITY_ICON_MAP: Record<string, string> = {
  bank: "icon_star",
  hospital: "icon_cross",
  prison: "icon_locked",
  shop: "icon_basket",
  park: "icon_trophy",
  magic_house: "icon_question",
  hotel: "icon_home",
  gas_station: "icon_power",
  news: "icon_warning",
  fortune: "icon_question",
  auction_house: "icon_trophy",
  airport: "icon_power",
};

export class BoardScene extends Phaser.Scene {
  private map!: GameBoardMap;
  private engine!: GameEngine;
  private tileVisuals: Map<number, TileVisual> = new Map();
  private pawnSprites: Map<number, Phaser.GameObjects.Container> = new Map();
  private pawnShadowSprites: Map<number, Phaser.GameObjects.Image> = new Map();
  private pawnImages: Map<number, Phaser.GameObjects.Image> = new Map();
  private pawnRideIcons: Map<number, Phaser.GameObjects.Image> = new Map();
  private pawnStatusIcons: Map<number, Phaser.GameObjects.Image> = new Map();
  private currentHighlightNodeId: number = -1;
  private dayNightOverlay?: Phaser.GameObjects.Rectangle;
  private infoPopup?: Phaser.GameObjects.Container;
  private eventPopup?: Phaser.GameObjects.Container;
  private confirmPopup?: Phaser.GameObjects.Container;
  private branchPopup?: Phaser.GameObjects.Container;
  private miniMap?: Phaser.GameObjects.Graphics;
  private miniMapContainer?: Phaser.GameObjects.Container;
  private miniMapIndicator?: Phaser.GameObjects.Arc;
  private isMoving: boolean = false;

  constructor() {
    super({ key: "BoardScene" });
  }

  init(data: { map: GameBoardMap; engine: GameEngine }): void {
    this.map = data.map;
    this.engine = data.engine;
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#0d1b2a");

    this.drawIslandBackground();
    this.drawPaths();
    this.drawTiles();
    this.sortDepths();
    this.createPawns();

    // 昼夜叠加层
    this.dayNightOverlay = this.add.rectangle(
      -1920, -1080, 1920 * 3, 1080 * 3, 0x000000, 0
    ).setDepth(1000);

    // 相机居中到地图中央
    const allNodes = this.map.nodes;
    let cx = 0, cy = 0;
    for (const n of allNodes) {
      const iso = gridToIso(n.x, n.y);
      cx += iso.x;
      cy += iso.y;
    }
    cx /= allNodes.length;
    cy /= allNodes.length;

    this.cameras.main.centerOn(cx, cy);
    this.cameras.main.setZoom(1.0);
    this.setupCameraDrag();

    this.updateDayNight();
    this.updateBuyHints();
    this.createMiniMap();

    this.engine.on((event) => {
      if (event.type === "player_moved") {
        this.updatePawnPosition(event.data.playerId, event.data.nodeId);
        this.playStepSound();
        this.isMoving = true;
      } else if (event.type === "game_start") {
        for (const player of this.engine.getPlayers()) {
          this.updatePawnPosition(player.id, player.positionNodeId);
        }
        this.updateStatusIcons();
      } else if (event.type === "player_arrived") {
        this.highlightTile(event.data.nodeId);
        this.isMoving = false;
      } else if (event.type === "land_bought") {
        this.playEventSound("chips");
        this.refreshTileVisuals();
        this.updateBuyHints();
        this.sortDepths();
      } else if (event.type === "land_upgraded") {
        this.playEventSound("confirm");
        const upgradedLand = this.map.lands[event.data.landIndex];
        if (upgradedLand) this.emitParticles(upgradedLand.id, 0xf1c40f);
        this.refreshTileVisuals();
        this.sortDepths();
      } else if (event.type === "land_liquidated") {
        this.refreshTileVisuals();
        this.sortDepths();
      } else if (event.type === "player_bankrupted") {
        this.playEventSound("fail");
        const bankruptedPlayer = this.engine.getPlayers().find(p => p.id === event.data.playerId);
        if (bankruptedPlayer) {
          const node = this.map.nodes[bankruptedPlayer.positionNodeId];
          if (node) this.emitParticles(node.id, 0x1a1a2e);
        }
        this.updateStatusIcons();
      } else if (event.type === "pay_toll") {
        this.showFloatText(event.data.to, `+¥${event.data.amount}`, 0x27ae60);
        this.showFloatText(event.data.from, `-¥${event.data.amount}`, 0xe74c3c);
      } else if (event.type === "trigger_fortune" || event.type === "trigger_news") {
        this.playEventSound("card");
        this.showEventPopup(event);
      } else if (event.type === "enter_magic_house") {
        this.playEventSound("switch");
      } else if (event.type === "card_used") {
        this.playEventSound("card");
        this.showCardFlipAnimation(event.data);
      } else if (event.type === "prompt_buy_land") {
        this.showConfirmPopup("buy_land", event.data);
      } else if (event.type === "prompt_upgrade_land") {
        this.showConfirmPopup("upgrade_land", event.data);
      } else if (event.type === "prompt_branch") {
        this.showBranchPopup(event.data);
      } else if (event.type === "turn_start") {
        this.updateDayNight();
        this.updateBuyHints();
        this.updateRideIcons();
        this.updateStatusIcons();
        this.updateMiniMap();
      }
    });
  }

  // ===== 等距深度排序 =====
  // 按 isoDepth = gx + gy 从小到大排列，depth 从 1 开始递增
  private sortDepths(): void {
    const sorted = [...this.tileVisuals.values()].sort((a, b) => a.isoDepth - b.isoDepth);
    let depth = 1;
    for (const tv of sorted) {
      tv.container.setDepth(depth);
      // 建筑在地块之上
      if (tv.building) tv.building.setDepth(depth + 0.5);
      if (tv.icon) tv.icon.setDepth(depth + 0.3);
      if (tv.chainIcon) tv.chainIcon.setDepth(depth + 0.7);
      if (tv.levelBadge) tv.levelBadge.setDepth(depth + 0.8);
      if (tv.ownerBar) tv.ownerBar.setDepth(depth + 0.2);
      if (tv.buyHint) tv.buyHint.setDepth(depth + 0.9);
      depth += 2;
    }

    // 角色深度根据其所在地块的 isoDepth
    for (const player of this.engine.getPlayers()) {
      const container = this.pawnSprites.get(player.id);
      const shadow = this.pawnShadowSprites.get(player.id);
      const node = this.map.nodes[player.positionNodeId];
      if (node && container) {
        const tv = this.tileVisuals.get(node.id);
        const baseDepth = tv ? tv.isoDepth * 2 + 1 : 100;
        container.setDepth(baseDepth + 100);
        if (shadow) shadow.setDepth(baseDepth + 99);
        const rideIcon = this.pawnRideIcons.get(player.id);
        if (rideIcon) rideIcon.setDepth(baseDepth + 101);
        const statusIcon = this.pawnStatusIcons.get(player.id);
        if (statusIcon) statusIcon.setDepth(baseDepth + 102);
      }
    }
  }

  // ===== 岛屿背景 — 环形地图中央的岛屿 =====
  private drawIslandBackground(): void {
    const g = this.add.graphics();

    // 计算地图边界（等距坐标）
    let minIsoX = Infinity, minIsoY = Infinity, maxIsoX = -Infinity, maxIsoY = -Infinity;
    for (const node of this.map.nodes) {
      const iso = gridToIso(node.x, node.y);
      minIsoX = Math.min(minIsoX, iso.x);
      minIsoY = Math.min(minIsoY, iso.y);
      maxIsoX = Math.max(maxIsoX, iso.x);
      maxIsoY = Math.max(maxIsoY, iso.y);
    }
    const islandCx = (minIsoX + maxIsoX) / 2;
    const islandCy = (minIsoY + maxIsoY) / 2;
    const islandRadius = Math.min(maxIsoX - minIsoX, maxIsoY - minIsoY) / 2 - 50;

    // 1) 深海底色
    g.fillStyle(0x0d1b2a, 1);
    g.fillRect(-1920, -1080, 1920 * 3, 1080 * 3);

    // 2) 海水渐变层
    const oceanLayers = [
      { color: 0x0a2640, alpha: 0.4 },
      { color: 0x0e3a5c, alpha: 0.25 },
      { color: 0x127a8a, alpha: 0.12 },
    ];
    for (const layer of oceanLayers) {
      g.fillStyle(layer.color, layer.alpha);
      g.fillRect(-1920, -1080, 1920 * 3, 1080 * 3);
    }

    // 4) 岛屿沙滩
    g.fillStyle(0xf4e4bc, 0.15);
    g.fillCircle(islandCx, islandCy, islandRadius + 40);
    g.fillStyle(0xf4e4bc, 0.1);
    g.fillCircle(islandCx, islandCy, islandRadius + 60);

    // 5) 岛屿草地
    g.fillStyle(0x2d5016, 0.35);
    g.fillCircle(islandCx, islandCy, islandRadius);
    g.fillStyle(0x3a6b1f, 0.3);
    g.fillCircle(islandCx, islandCy, islandRadius - 20);
    g.fillStyle(0x4a7c2a, 0.25);
    g.fillCircle(islandCx, islandCy, islandRadius - 40);

    // 6) 岛屿上的装饰物
    // 湖泊
    g.fillStyle(0x1a5276, 0.25);
    g.fillEllipse(islandCx - islandRadius * 0.3, islandCy + islandRadius * 0.2, 80, 50);
    g.fillStyle(0x2471a3, 0.15);
    g.fillEllipse(islandCx - islandRadius * 0.3, islandCy + islandRadius * 0.2, 60, 35);

    // 中心地标建筑
    g.fillStyle(0x2c3e50, 0.2);
    g.fillRect(islandCx - 15, islandCy - 25, 30, 50);
    g.fillStyle(0xf1c40f, 0.08);
    g.fillRect(islandCx - 12, islandCy - 20, 24, 45);
    // 灯光窗户
    for (let wy = 0; wy < 40; wy += 8) {
      for (let wx = 0; wx < 20; wx += 6) {
        if (Math.random() > 0.5) {
          g.fillStyle(0xf1c40f, 0.06);
          g.fillRect(islandCx - 12 + wx, islandCy - 20 + wy, 3, 4);
        }
      }
    }
    // 顶塔
    g.fillStyle(0x2c3e50, 0.15);
    g.beginPath();
    g.moveTo(islandCx - 18, islandCy - 25); g.lineTo(islandCx, islandCy - 40); g.lineTo(islandCx + 18, islandCy - 25);
    g.closePath();
    g.fillPath();

    // 树木
    for (let i = 0; i < 20; i++) {
      const angle = (i / 20) * Math.PI * 2 + Math.random() * 0.3;
      const dist = islandRadius * (0.3 + Math.random() * 0.4);
      const tx = islandCx + Math.cos(angle) * dist;
      const ty = islandCy + Math.sin(angle) * dist;
      const ts = 0.8 + Math.random() * 0.6;
      g.fillStyle(0x5d4037, 0.25);
      g.fillRect(tx - 2 * ts, ty, 4 * ts, 12 * ts);
      g.fillStyle(0x2e7d32, 0.3);
      g.fillCircle(tx, ty - 6 * ts, 10 * ts);
      g.fillStyle(0x388e3c, 0.25);
      g.fillCircle(tx, ty - 6 * ts, 7 * ts);
    }

    // 7) 海浪波纹
    for (let i = 0; i < 60; i++) {
      const wx = -200 + Math.random() * 2200;
      const wy = -100 + Math.random() * 1200;
      g.lineStyle(1, 0x5dade2, 0.06 + Math.random() * 0.08);
      g.beginPath();
      g.moveTo(wx, wy);
      g.lineTo(wx + 25 + Math.random() * 15, wy);
      g.strokePath();
    }

    // 8) 沙滩边海鸟
    for (let i = 0; i < 12; i++) {
      const bx = 100 + Math.random() * 1600;
      const by = 30 + Math.random() * 180;
      g.lineStyle(1, 0xffffff, 0.12);
      g.beginPath();
      g.moveTo(bx, by); g.lineTo(bx + 3, by - 2); g.lineTo(bx + 6, by);
      g.strokePath();
    }

    g.setDepth(-10);
  }

  // ===== 等距道路 — 在等距坐标间画道路 =====
  private drawPaths(): void {
    const g = this.add.graphics();
    const drawn = new Set<string>();

    const drawRoad = (x1: number, y1: number, x2: number, y2: number) => {
      // 路缘石
      g.lineStyle(10, 0x3a3a3a, 0.5);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.strokePath();

      // 马路面
      g.lineStyle(7, 0x4a4a4a, 0.55);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.strokePath();

      // 浅色路面中心
      g.lineStyle(5, 0x5a5a5a, 0.4);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.strokePath();

      // 黄色虚线中线
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
        // 等距坐标间画路
        const p1 = gridToIso(node.x, node.y);
        const p2 = gridToIso(adj.x, adj.y);
        drawRoad(p1.x, p1.y, p2.x, p2.y);
      }
    }
    g.setDepth(0);
  }

  // ===== 等距菱形地块渲染 =====
  private drawTiles(): void {
    for (const node of this.map.nodes) {
      const iso = gridToIso(node.x, node.y);
      const tileType = this.getNodeTileType(node);
      const texKey = `tile_${tileType}`;
      const bg = this.add.image(iso.x, iso.y, texKey).setDepth(1);

      // 地块名称
      const name = this.getNodeName(node);
      const nameLabel = this.add.text(iso.x, iso.y - 4, name, {
        fontSize: "var(--fs-xs)",
        color: "#ffffff",
        fontFamily: "sans-serif",
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 2,
      }).setOrigin(0.5, 0.5).setDepth(2);
      nameLabel.setWordWrapWidth(72, true);

      // 价格标签
      let priceText = "";
      const land = this.map.lands.find(l => l.id === node.id);
      const facility = this.map.facilities.find(f => f.id === node.id);
      const commercial = this.map.commercials.find(c => c.id === node.id);
      if (land) priceText = `¥${land.landPrice}`;
      else if (facility) priceText = facility.name;
      else if (commercial) priceText = `¥${commercial.tollFee}`;

      const priceLabel = this.add.text(iso.x, iso.y + 10, priceText, {
        fontSize: "9px",
        color: "#f1c40f",
        fontFamily: "monospace",
        stroke: "#000000",
        strokeThickness: 1,
      }).setOrigin(0.5, 0.5).setDepth(2);

      // 设施图标
      let icon: Phaser.GameObjects.Image | undefined;
      if (facility) {
        const iconKey = FACILITY_ICON_MAP[facility.type] || "icon_question";
        if (this.textures.exists(iconKey)) {
          icon = this.add.image(iso.x, iso.y, iconKey).setScale(0.45).setTint(0xffffff).setDepth(3);
        }
      }

      // 建筑精灵
      let building: Phaser.GameObjects.Image | undefined;
      let levelBadge: Phaser.GameObjects.Text | undefined;
      if (land && land.level && land.level > 0) {
        const buildIdx = this.getBuildingIndex(land.level, land.maxLevel);
        const buildKey = `building_${buildIdx}`;
        if (this.textures.exists(buildKey)) {
          // 建筑略偏上，模拟从地块中"竖立"
          building = this.add.image(iso.x, iso.y - 12, buildKey).setDepth(5).setScale(0.7);
        }
        levelBadge = this.add.text(iso.x + 24, iso.y - 18, `Lv.${land.level}`, {
          fontSize: "8px",
          color: "#f1c40f",
          fontFamily: "sans-serif",
          fontStyle: "bold",
          backgroundColor: "#2c3e50",
          padding: { x: 2, y: 1 },
        }).setOrigin(0.5, 0.5).setDepth(7);
      }

      // 连锁店标记
      let chainIcon: Phaser.GameObjects.Image | undefined;
      if (land && land.isChainStore) {
        chainIcon = this.add.image(iso.x + 24, iso.y - 18, "chain_flag").setDepth(6).setScale(1.2);
      }

      const container = this.add.container(iso.x, iso.y, [bg, nameLabel, priceLabel]);
      const isoDepth = node.x + node.y;
      this.tileVisuals.set(node.id, {
        container,
        bg,
        icon,
        building,
        levelBadge,
        chainIcon,
        nameLabel,
        priceLabel,
        node,
        isoDepth,
      });

      // 可购买提示
      if (land && (land.owner === undefined || land.owner < 0) && land.level === 0) {
        const buyHint = this.add.image(iso.x, iso.y - 28, "icon_coin").setDepth(7).setScale(1.0);
        this.tweens.add({
          targets: buyHint,
          y: iso.y - 38,
          duration: 600,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
        const tv = this.tileVisuals.get(node.id);
        if (tv) tv.buyHint = buyHint;
      }

      // 所有者颜色条
      if (land && land.owner !== undefined && land.owner >= 0) {
        const owner = this.engine.getPlayers()[land.owner];
        if (owner) {
          const borderColor = this.parseColor(owner.color);
          const ownerBar = this.add.rectangle(
            iso.x, iso.y + TILE_HH + 2,
            TILE_W * 0.7, 4,
            borderColor
          ).setDepth(4).setAlpha(0.9);
          const tv = this.tileVisuals.get(node.id);
          if (tv) tv.ownerBar = ownerBar;
        }
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

  // ===== 棋子 — 角色精灵 + 阴影 + 逐格行走弹跳 =====
  private createPawns(): void {
    const pawnColors = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c"];

    for (const player of this.engine.getPlayers()) {
      const node = this.map.nodes[player.positionNodeId];
      if (!node) continue;
      const iso = gridToIso(node.x, node.y);
      const px = iso.x;
      const py = iso.y;
      const pawnIdx = player.id % 6;

      const charKey = `character_${pawnIdx}`;
      const pawnKey = `pawn_${pawnIdx}`;
      const useKey = this.textures.exists(charKey) ? charKey : pawnKey;

      // 阴影
      const shadow = this.add.image(px, py + 8, pawnKey);
      shadow.setTint(0x000000);
      shadow.setAlpha(0.35);
      shadow.setScale(1, 0.5);
      shadow.setDepth(9);

      // 角色精灵
      const pawn = this.add.image(px, py, useKey);
      const scale = useKey.startsWith("character") ? 0.5 : 0.7;
      pawn.setScale(scale);
      pawn.setDepth(10);
      this.pawnImages.set(player.id, pawn);

      // 骑乘状态
      if (player.trafficMethod > 0) {
        const rideKey = player.trafficMethod === 1 ? "ride_motorcycle" : "ride_car";
        if (this.textures.exists(rideKey)) {
          const rideIcon = this.add.image(px + 14, py + 6, rideKey).setDepth(10).setScale(0.5);
          this.pawnRideIcons.set(player.id, rideIcon);
        }
      }

      // 名字标签
      const nameTag = this.add.text(px, py - 24, player.name, {
        fontSize: "var(--fs-xs)",
        color: pawnColors[pawnIdx],
        fontFamily: "sans-serif",
        fontStyle: "bold",
        backgroundColor: "#000000cc",
        padding: { x: 4, y: 2 },
      }).setOrigin(0.5, 0.5).setDepth(11);

      const container = this.add.container(px, py, [pawn, nameTag]);
      container.setDepth(10);
      this.pawnSprites.set(player.id, container);
      this.pawnShadowSprites.set(player.id, shadow);
    }
  }

  /** 逐格行走动画 — 角色沿路径平滑移动到下一个地块 */
  private updatePawnPosition(playerId: number, nodeId: number): void {
    const container = this.pawnSprites.get(playerId);
    const shadow = this.pawnShadowSprites.get(playerId);
    const pawnImg = this.pawnImages.get(playerId);
    const node = this.map.nodes[nodeId];
    if (!container || !node) return;

    const iso = gridToIso(node.x, node.y);

    // 多人同地块偏移
    const playerIdx = this.engine.getPlayers().findIndex(p => p.id === playerId);
    const offsetX = (playerIdx % 2) * 12 - 6;
    const offsetY = Math.floor(playerIdx / 2) * 12 - 6;
    const tx = iso.x + offsetX;
    const ty = iso.y + offsetY;

    // 方向翻转
    if (pawnImg) {
      const prevX = container.x;
      if (tx < prevX) pawnImg.setFlipX(true);
      else if (tx > prevX) pawnImg.setFlipX(false);
    }

    // 阴影跟随
    if (shadow) {
      this.tweens.add({
        targets: shadow,
        x: tx,
        y: ty + 8,
        duration: 280,
        ease: "Power2",
      });
    }

    // 骑乘图标跟随
    const rideIcon = this.pawnRideIcons.get(playerId);
    if (rideIcon) {
      this.tweens.add({
        targets: rideIcon,
        x: tx + 14,
        y: ty + 6,
        duration: 280,
        ease: "Power2",
      });
    }

    // 角色逐格行走 — 弹跳 + 移动
    this.tweens.add({
      targets: container,
      x: tx,
      y: ty,
      duration: 280,
      ease: "Quad.out",
      onUpdate: (tween) => {
        const progress = tween.progress;
        // 弹跳: 3次正弦波，模拟走路起伏
        const bounce = Math.abs(Math.sin(progress * Math.PI * 3)) * 7;
        container.y = ty - bounce;
      },
      onComplete: () => {
        container.y = ty;
        // 重新排序深度
        this.sortDepths();
      },
    });
  }

  // ===== 所有者边框 + 地块刷新 =====
  private refreshTileVisuals(): void {
    for (const [nodeId, visual] of this.tileVisuals) {
      const land = this.map.lands.find(l => l.id === nodeId);
      if (!land) continue;
      const iso = gridToIso(visual.node.x, visual.node.y);

      // 建筑更新
      if (land.level && land.level > 0) {
        const buildIdx = this.getBuildingIndex(land.level, land.maxLevel);
        const buildKey = `building_${buildIdx}`;
        if (visual.building) {
          if (visual.building.texture.key !== buildKey && this.textures.exists(buildKey)) {
            visual.building.setTexture(buildKey);
            visual.building.setScale(0.7, 0);
            this.tweens.add({
              targets: visual.building,
              scaleY: 0.7,
              duration: 400,
              ease: "Back.out(1.5)",
            });
          }
        } else if (this.textures.exists(buildKey)) {
          visual.building = this.add.image(iso.x, iso.y - 12, buildKey).setDepth(5).setScale(0.7);
          visual.building.setScale(0.7, 0);
          this.tweens.add({
            targets: visual.building,
            scaleY: 0.7,
            duration: 400,
            ease: "Back.out(1.5)",
          });
        }
        if (visual.levelBadge) {
          visual.levelBadge.setText(`Lv.${land.level}`);
        } else {
          visual.levelBadge = this.add.text(iso.x + 24, iso.y - 18, `Lv.${land.level}`, {
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

      // 所有者颜色条
      if (land.owner !== undefined && land.owner >= 0) {
        const owner = this.engine.getPlayers()[land.owner];
        if (owner) {
          if (visual.ownerBar) visual.ownerBar.destroy();
          const borderColor = this.parseColor(owner.color);
          visual.ownerBar = this.add.rectangle(
            iso.x, iso.y + TILE_HH + 2,
            TILE_W * 0.7, 4,
            borderColor
          ).setDepth(4).setAlpha(0.9);
          visual.bg.clearTint();
        }
      } else {
        visual.bg.clearTint();
        if (visual.ownerBar) {
          visual.ownerBar.destroy();
          visual.ownerBar = undefined;
        }
      }

      // 连锁店标记
      if (land.isChainStore && !visual.chainIcon) {
        visual.chainIcon = this.add.image(iso.x + 24, iso.y - 18, "chain_flag").setDepth(6).setScale(1.2);
      } else if (!land.isChainStore && visual.chainIcon) {
        visual.chainIcon.destroy();
        visual.chainIcon = undefined;
      }
    }
  }

  // ===== 地块高亮 =====
  private highlightTile(nodeId: number): void {
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

  // ===== 过路费飞字 =====
  private showFloatText(playerId: number, text: string, color: number): void {
    const container = this.pawnSprites.get(playerId);
    if (!container) return;
    const x = container.x;
    const y = container.y - 20;

    const floatText = this.add.text(x, y, text, {
      fontSize: "var(--fs-md)",
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

  // ===== 音效 =====
  private playStepSound(): void {
    const uiScene = this.scene.get("UIScene") as any;
    if (uiScene && uiScene.playSfx) {
      uiScene.playSfx("sfx_click", 0.3);
    }
  }

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

  // ===== 可购买提示 =====
  private updateBuyHints(): void {
    for (const [nodeId, visual] of this.tileVisuals) {
      const land = this.map.lands.find(l => l.id === nodeId);
      if (!land) continue;
      const iso = gridToIso(visual.node.x, visual.node.y);
      const canBuy = (land.owner === undefined || land.owner < 0) && land.level === 0;

      if (canBuy && !visual.buyHint) {
        visual.buyHint = this.add.image(iso.x, iso.y - 28, "icon_coin").setDepth(7).setScale(1.0);
        this.tweens.add({
          targets: visual.buyHint,
          y: iso.y - 38,
          duration: 600,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
      } else if (!canBuy && visual.buyHint) {
        visual.buyHint.destroy();
        visual.buyHint = undefined;
      }
    }
  }

  // ===== 骑乘状态 =====
  private updateRideIcons(): void {
    for (const player of this.engine.getPlayers()) {
      const existing = this.pawnRideIcons.get(player.id);
      const shouldShow = player.trafficMethod > 0;
      const rideKey = player.trafficMethod === 1 ? "ride_motorcycle" : "ride_car";

      if (shouldShow) {
        if (existing) {
          if (existing.texture.key !== rideKey && this.textures.exists(rideKey)) {
            existing.setTexture(rideKey);
          }
        } else if (this.textures.exists(rideKey)) {
          const container = this.pawnSprites.get(player.id);
          if (container) {
            const rideIcon = this.add.image(container.x + 14, container.y + 6, rideKey).setDepth(10).setScale(0.5);
            this.pawnRideIcons.set(player.id, rideIcon);
          }
        }
      } else if (existing) {
        existing.destroy();
        this.pawnRideIcons.delete(player.id);
      }
    }
  }

  // ===== 粒子系统 =====
  private emitParticles(nodeId: number, color: number): void {
    const visual = this.tileVisuals.get(nodeId);
    if (!visual) return;
    const iso = gridToIso(visual.node.x, visual.node.y);
    const x = iso.x;
    const y = iso.y - 6;

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

  // ===== 昼夜色调 =====
  private updateDayNight(): void {
    if (!this.dayNightOverlay) return;
    const hud = this.engine.getHUDState();
    const progress = hud.totalRounds > 0 ? hud.round / hud.totalRounds : 0;

    let color = 0x000000;
    let alpha = 0;

    if (progress < 0.25) {
      color = 0x000000; alpha = 0;
    } else if (progress < 0.5) {
      color = 0xe67e22; alpha = 0.08;
    } else if (progress < 0.75) {
      color = 0x0a0a3a; alpha = 0.15;
    } else {
      color = 0x6c3483; alpha = 0.06;
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
    this.showTileInfoPopup(node, land, facility, commercial, landmark);
    if (land) {
      this.events.emit("tile_selected", { node, land });
    } else if (facility) {
      this.events.emit("facility_selected", { node, facility });
    }
  }

  // ===== 建筑等级分层映射 =====
  private getBuildingIndex(level: number, maxLevel: number): number {
    if (maxLevel <= 0) return 0;
    const ratio = (level - 1) / Math.max(1, maxLevel - 1);
    return Math.min(12, Math.floor(ratio * 12));
  }

  // ===== 地块信息弹窗 =====
  private showTileInfoPopup(
    node: MapNode,
    land?: LandTile,
    facility?: FacilityTile,
    commercial?: CommercialTile,
    landmark?: Landmark,
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
      fontSize: "var(--fs-xs)",
      color: "#ecf0f1",
      fontFamily: "sans-serif",
      lineSpacing: 4,
    }).setScrollFactor(0).setDepth(302);

    const closeBtn = this.add.text(px + panelW - 20, py + 5, "×", {
      fontSize: "var(--fs-lg)",
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

  // ===== 卡牌翻牌动画 =====
  private showCardFlipAnimation(data: { playerId: number; cardId: number; cardName: string }): void {
    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    const cx = camW / 2;
    const cy = camH / 2;

    const cardBack = this.add.rectangle(cx, cy, 80, 110, 0x9b59b6, 1)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(320);
    const cardStar = this.add.text(cx, cy, "★", {
      fontSize: "32px",
      color: "#f1c40f",
    }).setOrigin(0.5).setScrollFactor(0).setDepth(321);

    const cardFront = this.add.rectangle(cx, cy, 80, 110, 0xf39c12, 0)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(320);
    const cardName = this.add.text(cx, cy, data.cardName, {
      fontSize: "var(--fs-md)",
      color: "#fff",
      align: "center",
      wordWrap: { width: 70 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(321).setAlpha(0);

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

  // ===== 事件弹窗（命运/新闻） =====
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
      fontSize: "var(--fs-lg)",
      color: `#${accentColor.toString(16).padStart(6, "0")}`,
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(312);

    const descText = this.add.text(px + 15, py + 40, event.data?.description || "发生了一件事...", {
      fontSize: "var(--fs-sm)",
      color: "#ecf0f1",
      fontFamily: "sans-serif",
      wordWrap: { width: panelW - 30 },
      lineSpacing: 4,
    }).setScrollFactor(0).setDepth(312);

    const okBtn = this.add.text(px + panelW / 2, py + panelH - 20, "[ 确认 ]", {
      fontSize: "var(--fs-sm)",
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

  // ===== 买卖确认弹窗 =====
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
      fontSize: "var(--fs-md)",
      color: "#f1c40f",
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(322);

    const descText = this.add.text(px + 15, py + 35, desc, {
      fontSize: "var(--fs-xs)",
      color: "#ecf0f1",
      fontFamily: "sans-serif",
      lineSpacing: 3,
    }).setScrollFactor(0).setDepth(322);

    const confirmBtn = this.add.text(px + panelW * 0.3, py + panelH - 18, `[ ${actionLabel} ]`, {
      fontSize: "var(--fs-sm)",
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
      fontSize: "var(--fs-sm)",
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

  // ===== 状态表情 =====
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

  // ===== 地图缩略图 =====
  private createMiniMap(): void {
    const miniMapSize = 120;
    const padding = 10;
    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;

    let minIsoX = Infinity, minIsoY = Infinity, maxIsoX = -Infinity, maxIsoY = -Infinity;
    for (const node of this.map.nodes) {
      const iso = gridToIso(node.x, node.y);
      minIsoX = Math.min(minIsoX, iso.x);
      minIsoY = Math.min(minIsoY, iso.y);
      maxIsoX = Math.max(maxIsoX, iso.x);
      maxIsoY = Math.max(maxIsoY, iso.y);
    }
    const mapW = maxIsoX - minIsoX + 80;
    const mapH = maxIsoY - minIsoY + 80;
    const scale = Math.min(miniMapSize / mapW, miniMapSize / mapH);

    const g = this.add.graphics();
    g.fillStyle(0x000000, 0.5);
    g.fillRect(0, 0, miniMapSize + 4, miniMapSize + 4);
    g.fillStyle(0x1a1a2e, 0.8);
    g.fillRect(2, 2, miniMapSize, miniMapSize);

    for (const node of this.map.nodes) {
      const iso = gridToIso(node.x, node.y);
      const mx = 2 + (iso.x - minIsoX + 40) * scale;
      const my = 2 + (iso.y - minIsoY + 40) * scale;

      const tileType = this.getNodeTileType(node);
      let color = 0x7f8c8d;
      if (tileType === "land") color = 0x2980b9;
      else if (tileType === "facility") color = 0xd4ac0d;
      else if (tileType === "commercial") color = 0x7d3c98;
      else if (tileType === "start") color = 0x229954;

      g.fillStyle(color, 0.8);
      g.fillCircle(mx, my, 2);
    }

    const drawn = new Set<string>();
    g.lineStyle(1, 0xecf0f1, 0.2);
    for (const node of this.map.nodes) {
      for (const adjId of node.adjacent) {
        const key = `${Math.min(node.id, adjId)}-${Math.max(node.id, adjId)}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const adj = this.map.nodes[adjId];
        if (!adj) continue;
        const p1 = gridToIso(node.x, node.y);
        const p2 = gridToIso(adj.x, adj.y);
        const mx1 = 2 + (p1.x - minIsoX + 40) * scale;
        const my1 = 2 + (p1.y - minIsoY + 40) * scale;
        const mx2 = 2 + (p2.x - minIsoX + 40) * scale;
        const my2 = 2 + (p2.y - minIsoY + 40) * scale;
        g.beginPath();
        g.moveTo(mx1, my1);
        g.lineTo(mx2, my2);
        g.strokePath();
      }
    }

    for (const player of this.engine.getPlayers()) {
      const node = this.map.nodes[player.positionNodeId];
      if (!node) continue;
      const iso = gridToIso(node.x, node.y);
      const mx = 2 + (iso.x - minIsoX + 40) * scale;
      const my = 2 + (iso.y - minIsoY + 40) * scale;
      const color = this.parseColor(player.color);
      g.fillStyle(color, 1);
      g.fillCircle(mx, my, 1.5);
    }

    const indicator = this.add.arc(
      2 + (this.cameras.main.scrollX + camW / 2 / this.cameras.main.zoom - minIsoX + 40) * scale,
      2 + (this.cameras.main.scrollY + camH / 2 / this.cameras.main.zoom - minIsoY + 40) * scale,
      3,
      0x00ffff, 0.8
    ).setScrollFactor(0).setDepth(1);

    this.miniMap = g;
    this.miniMapIndicator = indicator;

    this.miniMapContainer = this.add.container(
      camW - miniMapSize - padding - 4,
      camH - miniMapSize - padding - 4,
      [g, indicator]
    ).setScrollFactor(0).setDepth(250);

    this.miniMapContainer.setSize(miniMapSize + 4, miniMapSize + 4);
    this.miniMapContainer.setInteractive();
    this.miniMapContainer.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const localX = pointer.x - this.miniMapContainer!.x;
      const localY = pointer.y - this.miniMapContainer!.y;
      const targetX = (localX - 2) / scale + minIsoX - 40;
      const targetY = (localY - 2) / scale + minIsoY - 40;
      this.cameras.main.centerOn(targetX, targetY);
    });
  }

  private updateMiniMap(): void {
    if (!this.miniMap || !this.miniMapIndicator || !this.miniMapContainer) return;

    let minIsoX = Infinity, minIsoY = Infinity, maxIsoX = -Infinity, maxIsoY = -Infinity;
    for (const node of this.map.nodes) {
      const iso = gridToIso(node.x, node.y);
      minIsoX = Math.min(minIsoX, iso.x);
      minIsoY = Math.min(minIsoY, iso.y);
      maxIsoX = Math.max(maxIsoX, iso.x);
      maxIsoY = Math.max(maxIsoY, iso.y);
    }
    const mapW = maxIsoX - minIsoX + 80;
    const mapH = maxIsoY - minIsoY + 80;
    const miniMapSize = 120;
    const scale = Math.min(miniMapSize / mapW, miniMapSize / mapH);

    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    this.miniMapIndicator.setPosition(
      (this.cameras.main.scrollX + camW / 2 / this.cameras.main.zoom - minIsoX + 40) * scale,
      (this.cameras.main.scrollY + camH / 2 / this.cameras.main.zoom - minIsoY + 40) * scale
    );
  }

  // ===== 路口方向选择弹窗 =====
  private showBranchPopup(data: { playerId: number; choices: { nodeId: number; name: string; x: number; y: number }[]; remainingSteps: number }): void {
    this.closeBranchPopup();

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
      fontSize: "var(--fs-md)",
      color: "#3498db",
      fontFamily: "sans-serif",
      fontStyle: "bold",
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(332);

    const stepText = this.add.text(px + panelW / 2, py + 32, `剩余 ${data.remainingSteps} 步`, {
      fontSize: "var(--fs-xs)",
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
        fontSize: "var(--fs-sm)",
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