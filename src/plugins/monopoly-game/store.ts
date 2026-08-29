/**
 * Game Store — 游戏状态管理
 * 使用简单的 useState 模式（非 zustand），因为游戏引擎自身管理状态
 * 此文件仅提供游戏开关状态
 */

import { useState, useCallback } from "react";

let _gameVisible = false;
const _listeners: Set<(v: boolean) => void> = new Set();

export function useGameVisible(): [boolean, () => void, () => void, () => void] {
  const [visible, setVisible] = useState(_gameVisible);

  useState(() => {
    _listeners.add(setVisible);
    return () => { _listeners.delete(setVisible); };
  });

  const show = useCallback(() => {
    _gameVisible = true;
    _listeners.forEach(fn => fn(true));
  }, []);

  const hide = useCallback(() => {
    _gameVisible = false;
    _listeners.forEach(fn => fn(false));
  }, []);

  const toggle = useCallback(() => {
    _gameVisible = !_gameVisible;
    _listeners.forEach(fn => fn(_gameVisible));
  }, []);

  return [visible, show, hide, toggle];
}
