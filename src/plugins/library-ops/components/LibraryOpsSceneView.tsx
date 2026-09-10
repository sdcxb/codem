/**
 * LibraryOpsSceneView —— 「子智能体」页签的接管视图（渲染在 `task-center.subagents` slot 里）。
 *
 * 为什么放在这里（v1.15.0）：场景里站着的就是**队长 / 团队成员 / 子智能体**——
 * 它本来就是「子智能体（以及带队的团队）现在在做什么」的可视化表达，
 * 放在「子智能体」页签下语义正确；而「设置」里调的全是场景显示
 * （场景图 / 名牌 / 气泡 / 动画速度 / 采样间隔），自然跟着场景走。
 *
 * 视图：`场景 | 设置`（宿主「子智能体」页签的列表在插件禁用时作为回退保留）。
 */

import { useEffect } from "react";
import type { MonitorTab, SceneView } from "../types";
import { SCENE_VIEWS } from "../types";
import { useLibraryOps } from "../store";
import { useLang } from "../../../core/i18n/lang";
import { LibraryOpsViewShell, type ShellView } from "./LibraryOpsViewShell";
import { LibraryPanel } from "./monitor/LibraryPanel";
import { SettingsPanel } from "./monitor/SettingsPanel";
import { LoIcon } from "./icons";

const VIEWS: ShellView[] = [
  { id: "scene", zh: "场景", en: "Scene", icon: "users" },
  { id: "settings", zh: "设置", en: "Settings", icon: "settings" },
];

export function LibraryOpsSceneView() {
  const zh = useLang() === "zh";
  const sceneTab = useLibraryOps((s) => s.sceneTab);
  const setSceneTab = useLibraryOps((s) => s.setSceneTab);
  const snapshot = useLibraryOps((s) => s.snapshot);

  // 深链（如「用量 → 打开场景」）：命中场景组视图就切过去
  useEffect(() => {
    const handler = (e: Event) => {
      const view = (e as CustomEvent).detail?.view;
      if (typeof view === "string" && (SCENE_VIEWS as string[]).includes(view)) {
        setSceneTab(view as SceneView);
      }
    };
    window.addEventListener("codem:open-task-center", handler as EventListener);
    return () => window.removeEventListener("codem:open-task-center", handler as EventListener);
  }, [setSceneTab]);

  const active: SceneView = (SCENE_VIEWS as string[]).includes(sceneTab) ? sceneTab : "scene";
  const subagents = snapshot?.actors.filter((a) => a.kind === "subagent").length ?? 0;
  const members = snapshot?.actors.filter((a) => a.kind === "member").length ?? 0;

  return (
    <LibraryOpsViewShell
      dataView="task-center-subagents"
      views={VIEWS}
      active={active}
      onSelect={(v: MonitorTab) => setSceneTab(v as SceneView)}
      showFeed={false}
      extraMeta={
        <>
          <span title={zh ? "子智能体" : "Sub-agents"}>
            <LoIcon name="bot" size={12} /> {subagents}
          </span>
          <span title={zh ? "团队成员" : "Team members"}>
            <LoIcon name="user" size={12} /> {members}
          </span>
        </>
      }
    >
      {active === "scene" && <LibraryPanel snapshot={snapshot} zh={zh} />}
      {active === "settings" && <SettingsPanel zh={zh} />}
    </LibraryOpsViewShell>
  );
}

export default LibraryOpsSceneView;
