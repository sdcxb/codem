/**
 * 皮肤系统 React Hook
 * 订阅 ThemeManager 的皮肤切换，皮肤变化时自动重新渲染
 */

import { useState, useEffect } from "react";
import { ThemeManager } from "./theme-manager";
import type { SkinId, DreamSkinConfig } from "./types";

/**
 * 获取当前皮肤状态，皮肤变化时自动重新渲染
 */
export function useSkin(): { skin: SkinId; dreamConfig: DreamSkinConfig | null } {
  const [skin, setSkin] = useState<SkinId>(ThemeManager.getSkin());
  const [dreamConfig, setDreamConfig] = useState<DreamSkinConfig | null>(ThemeManager.getDreamConfig());

  useEffect(() => {
    const unsubscribe = ThemeManager.onChange((newSkin) => {
      setSkin(newSkin);
      setDreamConfig(ThemeManager.getDreamConfig());
    });
    return unsubscribe;
  }, []);

  return { skin, dreamConfig };
}
