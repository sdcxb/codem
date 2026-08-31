/**
 * UIScene — UI 覆盖层场景
 * 使用 Kenney 骰子 PNG + UI 面板 + 音效
 * Phase 8 改进：骰子居中翻滚 + 点数飞字 + 行走/事件音效 + BGM
 */

import Phaser from "phaser";
import type { GameEngine } from "../engine/GameEngine";

export class UIScene extends Phaser.Scene {
  private engine!: GameEngine;
  private messageText?: Phaser.GameObjects.Text;
  private diceContainer?: Phaser.GameObjects.Container;
  private roundText?: Phaser.GameObjects.Text;
  private sfx: Map<string, Phaser.Sound.BaseSound> = new Map();
  private bgm?: Phaser.Sound.BaseSound;
  private diceRollTimer?: Phaser.Time.TimerEvent;

  constructor() {
    super({ key: "UIScene" });
  }

  init(data: { engine: GameEngine }): void {
    this.engine = data.engine;
  }

  create(): void {
    // 音效
    const sfxKeys = ["sfx_dice", "sfx_card", "sfx_chips", "sfx_click", "sfx_error", "sfx_confirm", "sfx_switch", "sfx_success", "sfx_fail"];
    for (const key of sfxKeys) {
      if (this.sound && this.cache.audio.exists(key)) {
        this.sfx.set(key, this.sound.add(key));
      }
    }

    // A3: BGM — 循环播放 Kenney jingle 作为简易 BGM
    if (this.sound && this.cache.audio.exists("sfx_success")) {
      this.bgm = this.sound.add("sfx_success", { loop: true, volume: 0.15 });
      // BGM 需要用户交互后才能播放（浏览器策略），延迟启动
      this.input.once("pointerdown", () => {
        if (this.bgm && !this.bgm.isPlaying) {
          this.bgm.play();
        }
      });
    }

    // 消息栏 — 使用半透明背景，提升可读性
    this.messageText = this.add.text(10, 10, "", {
      fontSize: "var(--fs-md)",
      color: "#ecf0f1",
      fontFamily: "sans-serif",
      backgroundColor: "#2c3e50cc",
      padding: { x: 10, y: 6 },
    }).setScrollFactor(0).setDepth(100);

    // 回合信息
    this.roundText = this.add.text(this.cameras.main.width - 140, 10, "", {
      fontSize: "var(--fs-md)",
      color: "#f1c40f",
      fontFamily: "sans-serif",
      backgroundColor: "#2c3e50cc",
      padding: { x: 10, y: 6 },
    }).setScrollFactor(0).setDepth(100);

    // D1: 骰子显示容器 — 移至屏幕中央
    this.diceContainer = this.add.container(
      this.cameras.main.width / 2,
      this.cameras.main.height / 2
    ).setScrollFactor(0).setDepth(200);

    // 监听引擎事件
    this.engine.on((event) => {
      switch (event.type) {
        case "dice_rolled":
          this.playSfx("sfx_dice");
          this.showDice(event.data.values);
          break;
        case "game_start":
        case "turn_start":
          this.updateHUD();
          // R1: 回合切换遮罩
          if (event.type === "turn_start") {
            this.showTurnTransition(event.data);
          }
          break;
        case "game_end":
          this.showGameEnd(event.data);
          break;
      }
    });

    this.updateHUD();

    this.scale.on("resize", (gameSize: Phaser.Structs.Size) => {
      if (this.roundText) {
        this.roundText.setPosition(gameSize.width - 140, 10);
      }
      if (this.diceContainer) {
        this.diceContainer.setPosition(gameSize.width / 2, gameSize.height / 2);
      }
    });
  }

  // 暴露给 BoardScene 调用
  playSfx(key: string, volume: number = 1): void {
    try {
      const s = this.sfx.get(key);
      if (s) {
        if (s instanceof Phaser.Sound.WebAudioSound || s instanceof Phaser.Sound.HTML5AudioSound) {
          (s as any).setVolume(volume);
        }
        s.play();
      }
    } catch (e) {
      // 音频播放失败不崩溃
      console.warn(`[Monopoly] SFX play failed (non-fatal): ${key}`, e);
    }
  }

  // D1 + D2: 骰子居中翻滚 + 随机切换纹理
  private showDice(values: number[]): void {
    if (!this.diceContainer) return;
    this.diceContainer.removeAll(true);

    // D2: 滚动期间快速随机切换 dice_1-6 纹理（每 80ms）
    const diceSprites: Phaser.GameObjects.Image[] = [];
    values.forEach((_, i) => {
      const sprite = this.add.image(i * 50 - (values.length - 1) * 25, 0, `dice_${1 + Math.floor(Math.random() * 6)}`);
      sprite.setScale(0.8);
      this.diceContainer!.add(sprite);
      diceSprites.push(sprite);
    });

    // 随机切换纹理动画
    this.diceRollTimer = this.time.addEvent({
      delay: 80,
      callback: () => {
        diceSprites.forEach((sprite) => {
          const randVal = 1 + Math.floor(Math.random() * 6);
          sprite.setTexture(`dice_${randVal}`);
        });
      },
      repeat: 7, // 80ms × 8 = 640ms
    });

    // 640ms 后显示真实结果
    this.time.delayedCall(640, () => {
      if (!this.diceContainer) return;
      this.diceContainer.removeAll(true);
      values.forEach((val, i) => {
        const sprite = this.add.image(i * 50 - (values.length - 1) * 25, 0, `dice_${val}`);
        sprite.setScale(0.8);
        this.diceContainer!.add(sprite);
        // 弹入动画
        this.tweens.add({
          targets: sprite,
          scaleX: 0.85,
          scaleY: 0.85,
          duration: 200,
          ease: "Back.out(2)",
          delay: i * 100,
        });
      });
      this.playSfx("sfx_click");

      // D3: 点数飞字 — 在骰子上方弹出大号数字
      const sum = values.reduce((a, b) => a + b, 0);
      const sumText = this.add.text(
        this.cameras.main.width / 2,
        this.cameras.main.height / 2 - 50,
        String(sum),
        {
          fontSize: "32px",
          color: "#f1c40f",
          fontFamily: "sans-serif",
          fontStyle: "bold",
          stroke: "#000000",
          strokeThickness: 4,
        }
      ).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(201).setScale(0);

      this.tweens.add({
        targets: sumText,
        scale: 1.2,
        duration: 300,
        ease: "Back.out(2)",
        onComplete: () => {
          this.tweens.add({
            targets: sumText,
            scale: 0,
            alpha: 0,
            duration: 500,
            delay: 800,
            ease: "Quad.in",
            onComplete: () => sumText.destroy(),
          });
        },
      });

      // 1.5s 后清除骰子
      this.time.delayedCall(1500, () => {
        if (this.diceContainer) {
          this.diceContainer.removeAll(true);
        }
      });
    });
  }

  // R1: 回合切换遮罩
  private showTurnTransition(data: { currentPlayer?: number }): void {
    const hud = this.engine.getHUDState();
    const playerIdx = hud.currentPlayer;
    const player = hud.players[playerIdx];
    if (!player) return;

    const cx = this.cameras.main.width / 2;
    const cy = this.cameras.main.height / 2;

    // 全屏遮罩
    const overlay = this.add.rectangle(0, 0, this.cameras.main.width, this.cameras.main.height, 0x000000, 0.5)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(150).setAlpha(0);

    // 回合文字
    const turnText = this.add.text(cx, cy, `${player.name} 的回合`, {
      fontSize: "28px",
      color: player.color,
      fontFamily: "sans-serif",
      fontStyle: "bold",
      stroke: "#000000",
      strokeThickness: 4,
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(151).setAlpha(0);

    // 淡入
    this.tweens.add({
      targets: [overlay, turnText],
      alpha: { from: 0, to: 1 },
      duration: 300,
      ease: "Quad.out",
      onComplete: () => {
        // 1.5s 后淡出
        this.tweens.add({
          targets: [overlay, turnText],
          alpha: 0,
          duration: 300,
          delay: 1200,
          ease: "Quad.in",
          onComplete: () => {
            overlay.destroy();
            turnText.destroy();
          },
        });
      },
    });
  }

  private updateHUD(): void {
    if (this.messageText) {
      this.messageText.setText(this.engine.getMessage());
    }
    if (this.roundText) {
      const hud = this.engine.getHUDState();
      this.roundText.setText(`第${hud.round}回合 / ${hud.totalRounds}\n物价: ${hud.priceIndex}`);
    }
  }

  private showGameEnd(data: { rankings: { playerId: number; name: string; wealth: number }[] }): void {
    this.playSfx("sfx_success");
    const lines = data.rankings.map((r, i) =>
      `${i + 1}. ${r.name} - ${r.wealth}`
    );
    this.add.text(
      this.cameras.main.width / 2,
      this.cameras.main.height / 2,
      `游戏结束!\n${lines.join("\n")}`,
      {
        fontSize: "var(--fs-3xl)",
        color: "#f1c40f",
        fontFamily: "sans-serif",
        backgroundColor: "#2c3e50",
        padding: { x: 20, y: 10 },
        align: "center",
      }
    ).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(200);
  }

  update(): void {
    if (this.messageText) {
      this.messageText.setText(this.engine.getMessage());
    }
    if (this.roundText) {
      const hud = this.engine.getHUDState();
      this.roundText.setText(`第${hud.round}回合 / ${hud.totalRounds}\n物价: ${hud.priceIndex}`);
    }
  }
}
