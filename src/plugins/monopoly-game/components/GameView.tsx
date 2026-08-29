/**
 * GameView — 大富翁游戏主视图组件
 * 管理 Phaser 游戏实例和 React UI 覆盖层
 */

import { useEffect, useRef, useState, useCallback } from "react";
import Phaser from "phaser";
import { GameEngine } from "../engine/GameEngine";
import { AIPlayer } from "../engine/AIPlayer";
import type { GameBoardMap, GameConfig, HUDState, PlayerState } from "../types";
import { PlayerCards } from "./PlayerCards";
import { GameLog } from "./GameLog";
import { ActionBar } from "./ActionBar";
import { CardPanel } from "./CardPanel";
import { ToolPanel } from "./ToolPanel";
import { ShopPanel } from "./ShopPanel";
import { BankPanel } from "./BankPanel";
import { AuctionPanel } from "./AuctionPanel";
import { SaveLoadPanel } from "./SaveLoadPanel";
import { CharacterSelect } from "./CharacterSelect";
import { AssetsPanel } from "./AssetsPanel";
import { HelpPanel } from "./HelpPanel";
import charactersData from "../data/characters.json";
import "../styles/game.css";

import cityMap from "../maps/city.json";
import ancientMap from "../maps/ancient.json";
import islandMap from "../maps/island.json";
import spaceMap from "../maps/space.json";
import gameConfigData from "../data/game-config.json";
import stocksData from "../data/stocks.json";

const MAP_OPTIONS = [
  { id: "city", name: "繁华都市", map: cityMap },
  { id: "ancient", name: "古镇风情", map: ancientMap },
  { id: "island", name: "海岛假期", map: islandMap },
  { id: "space", name: "太空站", map: spaceMap },
];

export function GameView() {
  const phaserRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [hud, setHud] = useState<HUDState | null>(null);
  const [started, setStarted] = useState(false);
  const [selectedMapId, setSelectedMapId] = useState("city");
  const [showStockPanel, setShowStockPanel] = useState(false);
  const [showCardPanel, setShowCardPanel] = useState(false);
  const [showToolPanel, setShowToolPanel] = useState(false);
  const [showShopPanel, setShowShopPanel] = useState(false);
  const [showBankPanel, setShowBankPanel] = useState(false);
  const [showAuctionPanel, setShowAuctionPanel] = useState(false);
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [showLoadPanel, setShowLoadPanel] = useState(false);
  const [screen, setScreen] = useState<'map_select' | 'char_select'>('map_select');
  const [humanCharId, setHumanCharId] = useState(0);
  const [aiDifficulty, setAiDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal');
  // G20-G23: 开局设置
  const [gameDaysIdx, setGameDaysIdx] = useState(1); // 默认30天
  const [initialFundsIdx, setInitialFundsIdx] = useState(1); // 默认15000
  const [winConditionIdx, setWinConditionIdx] = useState(0); // 默认2倍
  const [numHumanPlayers, setNumHumanPlayers] = useState(1); // G29: 热座模式
  const [numAITotal, setNumAITotal] = useState(3);
  const [useWinCondition, setUseWinCondition] = useState(false);
  // G35-G36: 音量/速度
  const [volume, setVolume] = useState(0.5);
  const [gameSpeed, setGameSpeed] = useState(1);
  // 面板开关
  const [showAssetsPanel, setShowAssetsPanel] = useState(false);
  const [showHelpPanel, setShowHelpPanel] = useState(false);
  const [showSellPanel, setShowSellPanel] = useState(false);
  const [showAirportPanel, setShowAirportPanel] = useState(false);
  const [showGameOver, setShowGameOver] = useState(false);
  const [gameOverData, setGameOverData] = useState<{rankings: any[]} | null>(null);
  const [airportFee, setAirportFee] = useState(0);

  // 当前选中的地图对象（组件级，非 initGame 局部）
  const selectedMap = MAP_OPTIONS.find(m => m.id === selectedMapId) || MAP_OPTIONS[0];

  const initGame = useCallback((mapId?: string, charId?: number) => {
    if (!phaserRef.current || gameRef.current) return;

    const selMap = MAP_OPTIONS.find(m => m.id === (mapId || selectedMapId)) || MAP_OPTIONS[0];
    const map = selMap.map as unknown as GameBoardMap;
    // G20-G23: 使用玩家选择的开局设置
    const totalPlayers = numHumanPlayers + numAITotal;
    const config: GameConfig = {
      ...gameConfigData,
      numPlayers: totalPlayers,
      numAI: numAITotal,
    } as GameConfig;

    const engine = new GameEngine(map, config, stocksData as any, charId ?? humanCharId);
    engineRef.current = engine;

    // G23: 设置胜利条件
    if (useWinCondition) {
      engine.setWinningMultiplier(gameConfigData.winningConditions[winConditionIdx]);
    }
    // G20: 设置游戏天数
    engine.setTotalRounds(gameConfigData.gameDays[gameDaysIdx]);
    // G22: 设置初始资金 — 并重新分配玩家现金
    const chosenInitCash = gameConfigData.initialFunds[initialFundsIdx];
    engine.setInitCash(chosenInitCash);
    // 重新应用初始资金到所有玩家（构造函数使用了 config 中的默认值）
    const characters = (charactersData as any[]) || [];
    for (const p of engine.getPlayers()) {
      const charDef = characters[p.characterId] || characters[0];
      p.cash = Math.floor(chosenInitCash * (charDef?.initCashRatio || 1.0));
    }

    // 监听引擎事件更新 HUD
    engine.on((event) => {
      setHud(engine.getHUDState());
      // G34: 监听游戏结束事件
      if (event.type === "game_end" && event.data?.rankings) {
        setGameOverData({ rankings: event.data.rankings });
        setShowGameOver(true);
      }
      // G24: 监听机场传送提示
      if (event.type === "prompt_airport") {
        setAirportFee(event.data.fee);
        setShowAirportPanel(true);
      }
    });

    const phaserGame = new Phaser.Game({
      type: Phaser.AUTO,
      parent: phaserRef.current,
      width: 960,
      height: 680,
      backgroundColor: "#2c3e50",
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: [
        ( PhaserSceneBoot as any),
        ( PhaserSceneBoard as any),
        ( PhaserSceneUI as any),
      ],
    });

    // 传递数据给场景
    phaserGame.scene.add("BootScene", PhaserSceneBoot, false);
    phaserGame.scene.add("BoardScene", PhaserSceneBoard, false);
    phaserGame.scene.add("UIScene", PhaserSceneUI, false);

    // 先移除自动添加的，再手动启动
    phaserGame.scene.remove("BootScene");
    phaserGame.scene.remove("BoardScene");
    phaserGame.scene.remove("UIScene");

    // 启动 BootScene，传入引擎和地图
    const bootData = { map, engine };
    phaserGame.scene.add("BootScene", PhaserSceneBootClass, true, bootData);

    gameRef.current = phaserGame;
    engine.start();
    setStarted(true);
    setHud(engine.getHUDState());
  }, [numHumanPlayers, numAITotal, useWinCondition, winConditionIdx, gameDaysIdx, initialFundsIdx]);

  useEffect(() => {
    return () => {
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, []);

  // G2/G4: AI 回合自动执行
  const aiRef = useRef<AIPlayer | null>(null);
  useEffect(() => {
    if (!started || !engineRef.current) return;
    if (!aiRef.current) {
      aiRef.current = new AIPlayer();
      // G18: 设置 AI 难度
      aiRef.current.setDifficulty(aiDifficulty);
    }
    const engine = engineRef.current;
    const ai = aiRef.current;

    const checkInterval = setInterval(() => {
      const phase = engine.getPhase();
      const player = engine.getCurrentPlayer();

      // 游戏结束时停止 AI 循环
      if (phase === "ended") return;

      if (player.isAI && phase === "rolling") {
        // AI 掷骰子
        const decision = ai.takeTurn(engine, player);
        ai.executeDecision(engine, player, decision);
      } else if (player.isAI && phase === "moving") {
        // AI 自动移动
        engine.moveStep();
      } else if (player.isAI && phase === "idle") {
        // AI 到达地块后决策
        const decision = ai.takeTurn(engine, player);
        ai.executeDecision(engine, player, decision);
      } else if (player.isAI && (phase === "shop" || phase === "bank" || phase === "magic" || phase === "fortune" || phase === "auction")) {
        const decision = ai.takeTurn(engine, player);
        ai.executeDecision(engine, player, decision);
      }
    }, 300);

    return () => clearInterval(checkInterval);
  }, [started]);

  const handleRollDice = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.rollDice();

    // 如果掷骰后阶段不是 moving（如住院跳过），不需要自动移动
    if (engine.getPhase() !== "moving") return;

    // G2: 自动移动 — 支持 branch 阶段暂停后自动继续
    const moveInterval = setInterval(() => {
      const phase = engine.getPhase();
      if (phase === "moving") {
        engine.moveStep();
      } else if (phase === "branch") {
        // 人类玩家分岔选择 — 等待弹窗点击后 chooseBranch 会设回 moving
        // 不清除 interval，继续等待
      } else {
        clearInterval(moveInterval);
      }
    }, 250);
  }, []);

  const handleEndTurn = useCallback(() => {
    engineRef.current?.endTurn();
  }, []);

  const handleBuyLand = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const player = engine.getCurrentPlayer();
    const node = engine.getMap().nodes[player.positionNodeId];
    const landIndex = engine.getMap().lands.findIndex(l => l.id === node?.id);
    if (landIndex >= 0) {
      engine.buyLand(landIndex);
    }
  }, []);

  const handleUpgradeLand = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const player = engine.getCurrentPlayer();
    const node = engine.getMap().nodes[player.positionNodeId];
    const landIndex = engine.getMap().lands.findIndex(l => l.id === node?.id);
    if (landIndex >= 0) {
      engine.upgradeLand(landIndex);
    }
  }, []);

  const handleSkip = useCallback(() => {
    engineRef.current?.skipAction();
  }, []);

  // G26: 主动卖地
  const handleSellLand = useCallback((landIndex: number) => {
    engineRef.current?.sellLand(landIndex);
    setShowSellPanel(false);
  }, []);

  // G34: 投降
  const handleSurrender = useCallback(() => {
    if (window.confirm('确定要投降吗？投降后所有地产将被没收。')) {
      engineRef.current?.surrender();
    }
  }, []);

  // G24: 机场传送
  const handleAirportTeleport = useCallback((targetNodeId: number) => {
    engineRef.current?.airportTeleport(targetNodeId, airportFee);
    setShowAirportPanel(false);
  }, [airportFee]);

  // G25: 购买商业地块
  const handleBuyCommercial = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const player = engine.getCurrentPlayer();
    const node = engine.getMap().nodes[player.positionNodeId];
    const commercial = engine.getMap().commercials.find(c => c.id === node?.id);
    if (commercial && commercial.type === 'construction') {
      engine.buyCommercial(node.id);
    } else if (commercial && commercial.type === 'insurance') {
      engine.buyInsurance(node.id);
    }
  }, []);

  if (!started) {
    if (screen === 'char_select') {
      return (
        <CharacterSelect
          onSelect={(charId) => {
            setHumanCharId(charId);
            setScreen('map_select');
            // 延迟一帧让组件渲染 phaserRef
            setTimeout(() => initGame(selectedMapId, charId), 50);
          }}
          onBack={() => setScreen('map_select')}
        />
      );
    }
    return (
      <div className="monopoly-game-wrapper">
        <div className="game-start-screen">
          <h1>大富翁</h1>
          <p>完整经济系统 · 卡牌道具 · 股票拍卖</p>
          {/* G30: 帮助按钮 */}
          <button className="action-btn secondary" style={{ position: 'absolute', top: 16, right: 16 }} onClick={() => setShowHelpPanel(true)}>
            游戏规则
          </button>
          <div className="map-select">
            <h3>选择地图</h3>
            <div className="map-options">
              {MAP_OPTIONS.map(m => (
                <button
                  key={m.id}
                  className={`map-option ${selectedMapId === m.id ? "selected" : ""}`}
                  onClick={() => setSelectedMapId(m.id)}
                >
                  {m.name}
                </button>
              ))}
            </div>
          </div>
          {/* G20: 游戏天数选择 */}
          <div className="map-select">
            <h3>游戏天数</h3>
            <div className="map-options">
              {gameConfigData.gameDays.map((days: number, idx: number) => (
                <button
                  key={idx}
                  className={`map-option ${gameDaysIdx === idx ? "selected" : ""}`}
                  onClick={() => setGameDaysIdx(idx)}
                >
                  {days}天
                </button>
              ))}
            </div>
          </div>
          {/* G29: 热座模式 — 玩家人数选择 */}
          <div className="map-select">
            <h3>人类玩家（热座模式）</h3>
            <div className="map-options">
              {([1, 2, 3, 4] as const).map(n => (
                <button
                  key={n}
                  className={`map-option ${numHumanPlayers === n ? "selected" : ""}`}
                  onClick={() => { setNumHumanPlayers(n); setNumAITotal(Math.max(1, 4 - n)); }}
                >
                  {n}人
                </button>
              ))}
            </div>
          </div>
          {/* G21: AI 数量 */}
          <div className="map-select">
            <h3>AI 数量</h3>
            <div className="map-options">
              {([1, 2, 3] as const).map(n => (
                <button
                  key={n}
                  className={`map-option ${numAITotal === n ? "selected" : ""}`}
                  onClick={() => setNumAITotal(n)}
                >
                  {n}个
                </button>
              ))}
            </div>
          </div>
          {/* G22: 初始资金选择 */}
          <div className="map-select">
            <h3>初始资金</h3>
            <div className="map-options">
              {gameConfigData.initialFunds.map((funds: number, idx: number) => (
                <button
                  key={idx}
                  className={`map-option ${initialFundsIdx === idx ? "selected" : ""}`}
                  onClick={() => setInitialFundsIdx(idx)}
                >
                  ¥{funds.toLocaleString()}
                </button>
              ))}
            </div>
          </div>
          {/* G23: 胜利条件 */}
          <div className="map-select">
            <h3>胜利条件</h3>
            <div className="map-options">
              <button
                className={`map-option ${!useWinCondition ? "selected" : ""}`}
                onClick={() => setUseWinCondition(false)}
              >
                仅比天数
              </button>
              {gameConfigData.winningConditions.map((mult: number, idx: number) => (
                <button
                  key={idx}
                  className={`map-option ${useWinCondition && winConditionIdx === idx ? "selected" : ""}`}
                  onClick={() => { setUseWinCondition(true); setWinConditionIdx(idx); }}
                >
                  {mult}倍资金
                </button>
              ))}
            </div>
          </div>
          {/* G18: AI 难度选择 */}
          <div className="map-select">
            <h3>AI 难度</h3>
            <div className="map-options">
              {([['easy', '简单'], ['normal', '普通'], ['hard', '困难']] as const).map(([id, label]) => (
                <button
                  key={id}
                  className={`map-option ${aiDifficulty === id ? "selected" : ""}`}
                  onClick={() => setAiDifficulty(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button className="game-start-btn" onClick={() => setScreen('char_select')}>
            选择角色
          </button>
          {/* 存档读档入口 */}
          <button className="action-btn secondary" style={{ marginTop: 8 }} onClick={() => setShowLoadPanel(true)}>
            读取存档
          </button>
        </div>
        {/* G30: 帮助面板 */}
        {showHelpPanel && (
          <HelpPanel onClose={() => setShowHelpPanel(false)} />
        )}
        {/* 存档读档入口（开始画面） */}
        {showLoadPanel && selectedMap && (
          <SaveLoadPanel
            engine={engineRef.current || new GameEngine(
              selectedMap.map as unknown as GameBoardMap,
              { ...gameConfigData, numPlayers: 4, numAI: 3 } as GameConfig,
              stocksData as any,
              humanCharId
            )}
            map={selectedMap.map as unknown as GameBoardMap}
            config={{ ...gameConfigData, numPlayers: 4, numAI: 3 } as GameConfig}
            stocks={stocksData as any}
            mode="load"
            onClose={() => setShowLoadPanel(false)}
            onLoaded={() => {
              if (!engineRef.current) {
                const engine = new GameEngine(
                  selectedMap.map as unknown as GameBoardMap,
                  { ...gameConfigData, numPlayers: 4, numAI: 3 } as GameConfig,
                  stocksData as any,
                  humanCharId
                );
                engineRef.current = engine;
                engine.on((event) => {
                  setHud(engine.getHUDState());
                  if (event.type === "game_end" && event.data?.rankings) {
                    setGameOverData({ rankings: event.data.rankings });
                    setShowGameOver(true);
                  }
                  if (event.type === "prompt_airport") {
                    setAirportFee(event.data.fee);
                    setShowAirportPanel(true);
                  }
                });
                const phaserGame = new Phaser.Game({
                  type: Phaser.AUTO,
                  parent: phaserRef.current!,
                  width: 960, height: 680,
                  backgroundColor: "#2c3e50",
                  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
                  scene: [],
                });
                gameRef.current = phaserGame;
                const bootData = { map: selectedMap.map, engine };
                phaserGame.scene.add("BootScene", PhaserSceneBootClass, true, bootData);
                setStarted(true);
                setHud(engine.getHUDState());
              } else {
                setHud(engineRef.current.getHUDState());
              }
            }}
          />
        )}
      </div>
    );
  }

  const currentPlayer = hud?.players[hud.currentPlayer];
  const phase = hud?.phase || "idle";

  return (
    <div className="monopoly-game-wrapper">
      <div className="game-layout">
        {/* 左侧：玩家信息 */}
        <div className="game-sidebar-left">
          <PlayerCards players={hud?.players || []} currentPlayerIdx={hud?.currentPlayer ?? 0} />
        </div>

        {/* 中间：Phaser 游戏画布 */}
        <div className="game-center">
          <div ref={phaserRef} className="phaser-container" />
          {/* G33: 日志颜色消息条 */}
          {hud?.message && (
            <div className="game-message-bar" style={{
              color: hud.logColors?.length ? hud.logColors[hud.logColors.length - 1] : "#f1c40f"
            }}>
              {hud.message}
            </div>
          )}
          <ActionBar
            phase={phase}
            currentPlayer={currentPlayer}
            onRollDice={handleRollDice}
            onEndTurn={handleEndTurn}
            onBuyLand={handleBuyLand}
            onUpgradeLand={handleUpgradeLand}
            onSkip={handleSkip}
            onShowStock={() => setShowStockPanel(!showStockPanel)}
            onShowCards={() => setShowCardPanel(!showCardPanel)}
            onShowTools={() => setShowToolPanel(!showToolPanel)}
            onShowShop={() => setShowShopPanel(true)}
            onShowBank={() => setShowBankPanel(true)}
            onShowAuction={() => setShowAuctionPanel(true)}
            onShowSave={() => setShowSavePanel(true)}
            onShowLoad={() => setShowLoadPanel(true)}
            onShowAssets={() => setShowAssetsPanel(true)}
            onShowSellLand={() => setShowSellPanel(true)}
            onBuyCommercial={handleBuyCommercial}
            onSurrender={handleSurrender}
            onShowHelp={() => setShowHelpPanel(true)}
            volume={volume}
            onVolumeChange={setVolume}
            gameSpeed={gameSpeed}
            onSpeedChange={setGameSpeed}
          />
          {/* G35: 音量/速度控制条 */}
          <div className="settings-bar">
            <label className="setting-item">
              <span>音量</span>
              <input type="range" min="0" max="1" step="0.1" value={volume} onChange={e => setVolume(parseFloat(e.target.value))} />
            </label>
            <label className="setting-item">
              <span>速度</span>
              <select value={gameSpeed} onChange={e => setGameSpeed(parseInt(e.target.value))}>
                <option value={1}>1x</option>
                <option value={2}>2x</option>
                <option value={4}>4x</option>
              </select>
            </label>
          </div>
        </div>

        {/* 右侧：游戏日志 */}
        <div className="game-sidebar-right">
          <GameLog log={hud?.log || []} logColors={hud?.logColors || []} round={hud?.round ?? 0} totalRounds={hud?.totalRounds ?? 0} winningMultiplier={hud?.winningMultiplier ?? 0} priceIndex={hud?.priceIndex ?? 1000} />
        </div>
      </div>

      {/* 浮动面板 */}
      {showStockPanel && (
        <StockPanel
          stocks={engineRef.current?.getStockPrices() || []}
          playerStocks={engineRef.current?.getPlayerStocks(currentPlayer?.id ?? 0) || []}
          onBuy={(id, amount) => engineRef.current?.buyStock(id, amount)}
          onSell={(id, amount) => engineRef.current?.sellStock(id, amount)}
          onClose={() => setShowStockPanel(false)}
        />
      )}
      {showCardPanel && engineRef.current && (
        <CardPanel
          engine={engineRef.current}
          currentPlayerId={currentPlayer?.id ?? 0}
          onClose={() => setShowCardPanel(false)}
        />
      )}
      {showToolPanel && engineRef.current && (
        <ToolPanel
          engine={engineRef.current}
          currentPlayerId={currentPlayer?.id ?? 0}
          onClose={() => setShowToolPanel(false)}
        />
      )}
      {showShopPanel && engineRef.current && (
        <ShopPanel
          engine={engineRef.current}
          onClose={() => setShowShopPanel(false)}
        />
      )}
      {showBankPanel && engineRef.current && (
        <BankPanel
          engine={engineRef.current}
          onClose={() => setShowBankPanel(false)}
        />
      )}
      {showAuctionPanel && engineRef.current && (
        <AuctionPanel
          engine={engineRef.current}
          onClose={() => setShowAuctionPanel(false)}
        />
      )}
      {/* G31: 资产面板 */}
      {showAssetsPanel && engineRef.current && (
        <AssetsPanel
          engine={engineRef.current}
          playerId={currentPlayer?.id ?? 0}
          onClose={() => setShowAssetsPanel(false)}
        />
      )}
      {/* G26: 卖地面板 */}
      {showSellPanel && engineRef.current && (
        <SellLandPanel
          engine={engineRef.current}
          playerId={currentPlayer?.id ?? 0}
          onSell={handleSellLand}
          onClose={() => setShowSellPanel(false)}
        />
      )}
      {/* G24: 机场传送面板 */}
      {showAirportPanel && engineRef.current && (
        <AirportPanel
          engine={engineRef.current}
          fee={airportFee}
          onTeleport={handleAirportTeleport}
          onClose={() => setShowAirportPanel(false)}
        />
      )}
      {/* G30: 帮助/规则面板 */}
      {showHelpPanel && (
        <HelpPanel onClose={() => setShowHelpPanel(false)} />
      )}
      {/* G34: 游戏结束面板 */}
      {showGameOver && gameOverData && (
        <GameOverPanel rankings={gameOverData.rankings} onClose={() => { setShowGameOver(false); window.location.reload(); }} />
      )}
      {showSavePanel && engineRef.current && selectedMap && (
        <SaveLoadPanel
          engine={engineRef.current}
          map={selectedMap.map as unknown as GameBoardMap}
          config={{ ...gameConfigData, numPlayers: 4, numAI: 3 } as GameConfig}
          stocks={stocksData as any}
          mode="save"
          onClose={() => setShowSavePanel(false)}
        />
      )}
      {showLoadPanel && selectedMap && (
        <SaveLoadPanel
          engine={engineRef.current || new GameEngine(
            selectedMap.map as unknown as GameBoardMap,
            { ...gameConfigData, numPlayers: 4, numAI: 3 } as GameConfig,
            stocksData as any,
            humanCharId
          )}
          map={selectedMap.map as unknown as GameBoardMap}
          config={{ ...gameConfigData, numPlayers: 4, numAI: 3 } as GameConfig}
          stocks={stocksData as any}
          mode="load"
          onClose={() => setShowLoadPanel(false)}
          onLoaded={() => {
            if (engineRef.current) {
              setHud(engineRef.current.getHUDState());
            }
          }}
        />
      )}
    </div>
  );
}

// R4: 股票趋势迷你折线图
function StockSparkline({ prices }: { prices: number[] }) {
  if (!prices || prices.length < 2) return null;
  const w = 60, h = 20;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * w;
    const y = h - ((p - min) / range) * h;
    return `${x},${y}`;
  }).join(" ");
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? "#27ae60" : "#e74c3c";
  return (
    <svg width={w} height={h} style={{ verticalAlign: "middle" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx={w} cy={h - ((prices[prices.length - 1] - min) / range) * h} r="2" fill={color} />
    </svg>
  );
}

// 浮动面板组件 — 临时内联
import { UI_ICONS } from "../utils/asset-maps";
function StockPanel({ stocks, playerStocks, onBuy, onSell, onClose }: {
  stocks: { id: number; price: number }[];
  playerStocks: { stockId: number; amount: number; avgCost: number }[];
  onBuy: (id: number, amount: number) => void;
  onSell: (id: number, amount: number) => void;
  onClose: () => void;
}) {
  const stockNames = ["科技股份", "地产集团", "银行财团", "能源公司", "消费品牌", "医药集团", "基建工程", "娱乐传媒"];
  // R4: 维护历史价格序列
  const priceHistoryRef = useRef<{ [id: number]: number[] }>({});
  const [priceHistory, setPriceHistory] = useState<{ [id: number]: number[] }>({});

  useEffect(() => {
    const newHistory = { ...priceHistoryRef.current };
    for (const s of stocks) {
      if (!newHistory[s.id]) newHistory[s.id] = [];
      newHistory[s.id] = [...newHistory[s.id], s.price].slice(-20);
    }
    priceHistoryRef.current = newHistory;
    setPriceHistory({ ...newHistory });
  }, [stocks]);

  return (
    <div className="stock-panel-overlay">
      <div className="stock-panel">
        <div className="stock-panel-header">
          <h3>
            <img src={UI_ICONS.stock} alt="stock" className="panel-header-icon" />
            股票交易
          </h3>
          <button onClick={onClose} className="panel-close">×</button>
        </div>
        <div className="stock-list">
          {stocks.map((s) => {
            const held = playerStocks.find(p => p.stockId === s.id);
            const history = priceHistory[s.id] || [s.price];
            return (
              <div key={s.id} className="stock-row">
                <span className="stock-name">{stockNames[s.id] || "股票" + s.id}</span>
                <span className="stock-price">¥{s.price}</span>
                <StockSparkline prices={history} />
                <span className="stock-held">{held ? held.amount + "股" : "无"}</span>
                <button onClick={() => onBuy(s.id, 10)} className="stock-btn buy">买10</button>
                <button onClick={() => onSell(s.id, 10)} className="stock-btn sell">卖10</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// G26: 卖地面板
function SellLandPanel({ engine, playerId, onSell, onClose }: {
  engine: GameEngine;
  playerId: number;
  onSell: (landIndex: number) => void;
  onClose: () => void;
}) {
  const player = engine.getPlayers().find(p => p.id === playerId);
  if (!player) return null;
  const lands = player.properties.map(idx => {
    const land = engine.getProperty().getLand(idx);
    return { idx, name: land?.name || `地块${idx}`, level: land?.level || 0, price: land?.landPrice || 0, buildPrice: land?.buildPrice || 0 };
  });
  return (
    <div className="card-panel-overlay">
      <div className="card-panel" style={{ width: 420 }}>
        <div className="panel-header">
          <h3>出售地产</h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>
        {lands.length === 0 ? (
          <div className="empty-state">暂无可出售的地产</div>
        ) : (
          <div className="card-list">
            {lands.map(l => {
              const sellPrice = Math.floor(l.price + l.buildPrice * l.level * 0.5);
              return (
                <div key={l.idx} className="card-item" onClick={() => onSell(l.idx)}>
                  <div className="card-icon-row">
                    <span className="card-name">{l.name}</span>
                    <span className="card-desc">Lv.{l.level}</span>
                  </div>
                  <div className="card-desc">出售价: ¥{sellPrice.toLocaleString()}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// G24: 机场传送面板
function AirportPanel({ engine, fee, onTeleport, onClose }: {
  engine: GameEngine;
  fee: number;
  onTeleport: (nodeId: number) => void;
  onClose: () => void;
}) {
  const map = engine.getMap();
  // 列出所有地块节点供选择
  const targetNodes = map.nodes.filter(n => n.tileType === "land" || n.tileType === "facility" || n.tileType === "commercial");
  return (
    <div className="card-panel-overlay">
      <div className="card-panel" style={{ width: 480, maxHeight: "70vh", overflowY: "auto" }}>
        <div className="panel-header">
          <h3>机场传送（费用 ¥{fee.toLocaleString()}）</h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
          {targetNodes.map(n => {
            const name = (() => {
              const land = map.lands.find(l => l.id === n.id);
              if (land) return land.name;
              const fac = map.facilities.find(f => f.id === n.id);
              if (fac) return fac.name;
              const com = map.commercials.find(c => c.id === n.id);
              if (com) return com.name;
              if (n.id === map.startNodeId) return "起点";
              return `地块${n.id}`;
            })();
            return (
              <button
                key={n.id}
                className="action-btn secondary"
                style={{ fontSize: 11, padding: "4px 8px" }}
                onClick={() => onTeleport(n.id)}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// G34: 游戏结束面板
function GameOverPanel({ rankings, onClose }: {
  rankings: { playerId: number; name: string; wealth: number }[];
  onClose: () => void;
}) {
  return (
    <div className="card-panel-overlay">
      <div className="card-panel" style={{ width: 420, textAlign: "center" }}>
        <div className="panel-header">
          <h3>游戏结束</h3>
        </div>
        <div style={{ fontSize: 48, margin: "16px 0" }}>
          {rankings[0] ? "🏆" : ""}
        </div>
        <h2 style={{ color: "#f1c40f" }}>{rankings[0]?.name || "无人"} 获胜！</h2>
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {rankings.map((r, i) => (
            <div key={r.playerId} style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "8px 12px",
              background: i === 0 ? "rgba(241, 196, 15, 0.15)" : "rgba(44, 62, 80, 0.4)",
              borderRadius: 6,
            }}>
              <span style={{ color: i === 0 ? "#f1c40f" : "#ecf0f1" }}>
                {i + 1}. {r.name}
              </span>
              <span style={{ color: "#f1c40f" }}>
                ¥{r.wealth.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
        <button className="game-start-btn" style={{ marginTop: 20 }} onClick={onClose}>
          返回主菜单
        </button>
      </div>
    </div>
  );
}

// 动态导入 Phaser 场景类（避免顶层 import 循环依赖）
// 实际使用 Phaser 的 Scene 子类
import { BootScene as PhaserSceneBoot } from "../scenes/BootScene";
import { BoardScene as PhaserSceneBoard } from "../scenes/BoardScene";
import { UIScene as PhaserSceneUI } from "../scenes/UIScene";

// 包装类用于传递 init 数据
class PhaserSceneBootClass extends PhaserSceneBoot {
  init(data: any) {
    this.scene.add("BoardScene", PhaserSceneBoard, false, data);
    this.scene.add("UIScene", PhaserSceneUI, false, data);
  }
}
