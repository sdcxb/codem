/**
 * SaveLoadPanel — 存档/读档面板
 * 比照《大富翁4》：3个存档槽位，显示存档详情，支持保存/读取/删除
 */

import { useState, useEffect } from "react";
import { SaveLoadSystem, type SaveSlotInfo } from "../engine/SaveLoadSystem";
import type { GameEngine } from "../engine/GameEngine";
import type { GameBoardMap, GameConfig, StockDef } from "../types";

interface Props {
  engine: GameEngine;
  map: GameBoardMap;
  config: GameConfig;
  stocks: StockDef[];
  mode: "save" | "load";
  onClose: () => void;
  onLoaded?: () => void;
}

export function SaveLoadPanel({ engine, map, config, stocks, mode, onClose, onLoaded }: Props) {
  const [slots, setSlots] = useState<SaveSlotInfo[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    refreshSlots();
  }, []);

  const refreshSlots = () => {
    setSlots(SaveLoadSystem.getSlotInfos());
  };

  const handleSave = (slot: number) => {
    const player = engine.getCurrentPlayer();
    const saveName = `${player.name}_第${engine.getRound()}回合_${new Date().toLocaleDateString("zh-CN")}`;
    const ok = engine.saveToSlot(slot, saveName);
    if (ok) {
      setMessage(`存档成功：槽位 ${slot + 1}`);
      refreshSlots();
    } else {
      setMessage("存档失败！");
    }
  };

  const handleLoad = (slot: number) => {
    const ok = engine.loadFromSlot(slot, map, config, stocks);
    if (ok) {
      setMessage("读档成功！");
      onLoaded?.();
      onClose();
    } else {
      setMessage("读档失败：存档不存在或损坏");
    }
  };

  const handleDelete = (slot: number) => {
    SaveLoadSystem.deleteSave(slot);
    setMessage(`已删除槽位 ${slot + 1}`);
    refreshSlots();
  };

  const formatDate = (ts: number): string => {
    if (!ts) return "";
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="card-panel-overlay" onClick={onClose}>
      <div className="shop-panel" onClick={e => e.stopPropagation()} style={{ width: 520 }}>
        <div className="panel-header">
          <h3>{mode === "save" ? "保存游戏" : "读取存档"}</h3>
          <button className="panel-close" onClick={onClose}>×</button>
        </div>

        <div className="save-slot-list">
          {slots.map((slot) => (
            <div
              key={slot.slot}
              className={`save-slot ${slot.isEmpty ? "empty" : "occupied"}`}
              onClick={() => !slot.isEmpty && mode === "load" && handleLoad(slot.slot)}
            >
              <div className="save-slot-info">
                <div className="save-slot-name">
                  {slot.isEmpty
                    ? `槽位 ${slot.slot + 1}：空`
                    : `槽位 ${slot.slot + 1}：${slot.saveName}`}
                </div>
                {!slot.isEmpty && (
                  <div className="save-slot-detail">
                    <span>地图: {slot.mapName}</span>
                    <span>回合: {slot.round}</span>
                    <span>玩家: {slot.playerCount}</span>
                    <span>{formatDate(slot.timestamp)}</span>
                  </div>
                )}
              </div>
              <div className="save-slot-actions">
                {mode === "save" && (
                  <button
                    className="shop-btn"
                    onClick={(e) => { e.stopPropagation(); handleSave(slot.slot); }}
                  >
                    {slot.isEmpty ? "保存" : "覆盖"}
                  </button>
                )}
                {!slot.isEmpty && mode === "load" && (
                  <button
                    className="shop-btn"
                    onClick={(e) => { e.stopPropagation(); handleLoad(slot.slot); }}
                  >
                    读取
                  </button>
                )}
                {!slot.isEmpty && (
                  <button
                    className="shop-btn sell"
                    onClick={(e) => { e.stopPropagation(); handleDelete(slot.slot); }}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {message && <div className="action-message">{message}</div>}

        <div style={{ marginTop: 8, fontSize: 11, color: "#7f8c8d", textAlign: "center" }}>
          存档数据保存在浏览器本地，清除浏览器缓存将丢失存档
        </div>
      </div>
    </div>
  );
}
