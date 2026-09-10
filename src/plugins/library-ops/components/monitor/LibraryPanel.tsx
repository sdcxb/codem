/**
 * LibraryPanel —— 图书馆场景页（本插件的核心视图）。
 *
 * 左侧：完整等距图书馆场景（角色在岗位上工作）
 * 右侧：馆内花名册 + 选中角色详情 + 岗位分布
 *
 * 这就是「把我们的图书馆作为 lobster-pet 监控界面内的场景」的落地：
 * 场景是监控界面的一个页签/卡片，与其它监控卡共享同一份快照。
 */

import { useMemo } from "react";
import type { LibrarySnapshot, SceneState } from "../../types";
import { ACTIVITY_META, KIND_META } from "../../types";
import { LIBRARY_MAP } from "../../data/library-map";
import { paletteOf } from "../../data/characters";
import { formatAge } from "../../core/format";
import { useLibraryOps, sortedActors } from "../../store";
import { Card, Empty, Field, Pill } from "./common";
import { LibraryScene } from "../library/LibraryScene";
import { PixelLibraryScene } from "../library/PixelLibraryScene";
import type { PixelSceneState } from "../../core/pixel-scene";
import { LoIcon } from "../icons";

export interface LibraryPanelProps {
  snapshot: LibrarySnapshot | null;
  zh: boolean;
}

export function LibraryPanel({ snapshot, zh }: LibraryPanelProps) {
  const settings = useLibraryOps((s) => s.settings);
  const selectedActorId = useLibraryOps((s) => s.selectedActorId);
  const selectActor = useLibraryOps((s) => s.selectActor);
  const selectedZoneId = useLibraryOps((s) => s.selectedZoneId);
  const selectZone = useLibraryOps((s) => s.selectZone);

  const actors = sortedActors(snapshot);
  const selected = actors.find((a) => a.id === selectedActorId) ?? null;
  const selectedZone = selectedZoneId ? LIBRARY_MAP.zones.find((z) => z.id === selectedZoneId) ?? null : null;
  const zoneOccupants = selectedZone ? actors.filter((a) => a.preferredZoneId === selectedZone.id) : [];

  // 切走再切回时恢复上次的馆内状态（读取一次，不订阅：避免每次采样都重渲染场景）
  const initialPixelScene = useMemo(() => useLibraryOps.getState().pixelScene, []);
  const initialIsoScene = useMemo(() => useLibraryOps.getState().isoScene, []);
  const sceneStyle = settings.sceneStyle;

  const zoneCounts = new Map<string, number>();
  for (const a of actors) zoneCounts.set(a.preferredZoneId, (zoneCounts.get(a.preferredZoneId) ?? 0) + 1);

  return (
    <div className="lo-library">
      <div className="lo-library__scene">
        {sceneStyle === "pixel" ? (
          <PixelLibraryScene
            snapshot={snapshot}
            initialScene={(initialPixelScene as PixelSceneState | null) ?? undefined}
            showZoneLabels={settings.showZoneLabels}
            showNameplates={settings.showNameplates}
            showBubbles={settings.showBubbles}
            speed={settings.speed}
            maxActors={settings.maxActors}
            onSelectActor={selectActor}
          />
        ) : (
          <LibraryScene
            snapshot={snapshot}
            initialScene={(initialIsoScene as SceneState | null) ?? undefined}
            showZoneLabels={settings.showZoneLabels}
            showNameplates={settings.showNameplates}
            showBubbles={settings.showBubbles}
            speed={settings.speed}
            maxActors={settings.maxActors}
            onSelectActor={selectActor}
          />
        )}
      </div>

      <aside className="lo-library__side">
        <Card
          title={zh ? `馆内花名册 (${actors.length})` : `Roster (${actors.length})`}
          icon="users"
          scroll
          className="lo-card--roster"
        >
          {/* 去重说明：场景与「子智能体」「团队」页签是同一份数据的两种表达，
              这里只做可视化，不再重复提供明细列表。 */}
          <p className="lo-note" style={{ margin: "0 0 8px" }}>
            <LoIcon name="users" size={12} />{" "}
            {zh
              ? "场景 = 子智能体 / 团队的可视化视图（同一份数据）；明细列表见「子智能体」「团队」页签。"
              : "Scene = a visual view of the same Sub-agents / Teams data; see those tabs for detail lists."}
          </p>
          {actors.length === 0 ? (
            <Empty text={zh ? "暂无角色" : "No actors"} />
          ) : (
            <ul className="lo-roster">
              {actors.map((a) => {
                const meta = ACTIVITY_META[a.activity];
                const palette = paletteOf(a.look);
                return (
                  <li
                    key={a.id}
                    className={`lo-roster__item${a.id === selectedActorId ? " is-selected" : ""}`}
                    onClick={() => selectActor(a.id === selectedActorId ? null : a.id)}
                  >
                    <span className="lo-roster__swatch" style={{ background: palette.uniform }} />
                    <span className="lo-roster__main">
                      <span className="lo-roster__name" title={a.name}>
                        <LoIcon name={KIND_META[a.kind].icon} size={12} /> {a.name}
                      </span>
                      <span className="lo-roster__role" title={a.roleLabel}>
                        {a.roleLabel}
                      </span>
                    </span>
                    <span className="lo-roster__status" style={{ color: `var(${meta.token})` }}>
                      <LoIcon name={meta.icon} size={12} /> {zh ? meta.zh : meta.en}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title={zh ? "角色详情" : "Actor detail"} icon="scan-search" className="lo-card--detail">
          {selectedZone ? (
            <div className="lo-fields">
              <Field label={zh ? "岗位" : "Zone"}>
                <LoIcon name={selectedZone.icon} size={12} /> {zh ? selectedZone.name : selectedZone.nameEn}
              </Field>
              <Field label={zh ? "职责" : "Duty"}>{selectedZone.duty}</Field>
              <Field label={zh ? "在岗" : "On duty"}>
                <span style={{ color: zoneOccupants.length > selectedZone.capacity ? "var(--warning)" : undefined }}>
                  {zoneOccupants.length}/{selectedZone.capacity}
                  {zoneOccupants.length > selectedZone.capacity && (zh ? "（超容量）" : " (over capacity)")}
                </span>
              </Field>
              <Field label={zh ? "默认动作" : "Default action"}>
                <LoIcon name={ACTIVITY_META[selectedZone.activity].icon} size={12} />{" "}
                {zh ? ACTIVITY_META[selectedZone.activity].zh : ACTIVITY_META[selectedZone.activity].en}
              </Field>
              <div className="lo-zone-occupants">
                {zoneOccupants.length === 0 ? (
                  <span className="lo-empty">{zh ? "该岗位暂无角色" : "Nobody here"}</span>
                ) : (
                  zoneOccupants.map((a) => (
                    <button key={a.id} className="lo-zone-occupants__item" onClick={() => selectActor(a.id)}>
                      <span className="lo-roster__swatch" style={{ background: paletteOf(a.look).uniform }} />
                      <span className="lo-roster__name">{a.name}</span>
                      <span style={{ color: `var(${ACTIVITY_META[a.activity].token})` }}>
                        <LoIcon name={ACTIVITY_META[a.activity].icon} size={12} />
                      </span>
                    </button>
                  ))
                )}
              </div>
              <button className="lo-link-btn" onClick={() => selectZone(null)}>
                {zh ? "取消选中岗位" : "Clear zone"}
              </button>
            </div>
          ) : !selected ? (
            <Empty text={zh ? "点击场景中的角色或岗位查看详情" : "Click an actor or a zone in the scene"} />
          ) : (
            <div className="lo-fields">
              <Field label={zh ? "名称" : "Name"}>{selected.name}</Field>
              <Field label={zh ? "类型" : "Kind"}>
                <Pill token="--accent">
                  <LoIcon name={KIND_META[selected.kind].icon} size={12} /> {zh ? KIND_META[selected.kind].zh : KIND_META[selected.kind].en}
                </Pill>
              </Field>
              <Field label={zh ? "岗位" : "Zone"}>{selected.roleLabel}</Field>
              <Field label={zh ? "状态" : "Status"}>
                <span style={{ color: `var(${ACTIVITY_META[selected.activity].token})` }}>
                  <LoIcon name={ACTIVITY_META[selected.activity].icon} size={12} /> {zh ? ACTIVITY_META[selected.activity].zh : ACTIVITY_META[selected.activity].en}
                </span>
              </Field>
              {selected.focus && <Field label={zh ? "正在做" : "Focus"}>{selected.focus}</Field>}
              {selected.teamName && <Field label={zh ? "团队" : "Team"}>{selected.teamName}</Field>}
              {selected.model && <Field label={zh ? "模型" : "Model"}>{selected.model}</Field>}
              <Field label={zh ? "任务" : "Tasks"}>
                {selected.metrics.done}/{selected.metrics.tasks}
              </Field>
              <Field label={zh ? "工具调用" : "Tools"}>{selected.metrics.tools}</Field>
              <Field label={zh ? "最近活动" : "Last event"}>{formatAge(selected.lastEventAt)}</Field>
              {selected.kind === "subagent" && selected.parentId && (
                <button
                  className="lo-link-btn"
                  // 场景接管了「子智能体」页签后，宿主列表的下钻入口不可达 →
                  // 这里补一个「打开父会话」，由宿主监听 codem:open-session 处理
                  onClick={() => {
                    try {
                      window.dispatchEvent(
                        new CustomEvent("codem:open-session", { detail: { sessionId: selected.parentId } }),
                      );
                    } catch {
                      /* 忽略：非浏览器环境 */
                    }
                  }}
                >
                  {zh ? "打开父会话 →" : "Open parent session →"}
                </button>
              )}
              <Field label={zh ? "外观" : "Look"}>
                {paletteOf(selected.look).zh} · #{selected.look.body}-{selected.look.hair}-{selected.look.hat}-{selected.look.prop}
              </Field>
            </div>
          )}
        </Card>

        <Card title={zh ? "岗位分布" : "Zone distribution"} icon="map" scroll>
          <ul className="lo-zones">
            {LIBRARY_MAP.zones.map((zone) => {
              const count = zoneCounts.get(zone.id) ?? 0;
              const over = count > zone.capacity;
              return (
                <li
                  key={zone.id}
                  className={`lo-zones__item${zone.id === selectedZoneId ? " is-selected" : ""}${over ? " is-over" : ""}`}
                  title={zone.duty}
                  onClick={() => selectZone(zone.id === selectedZoneId ? null : zone.id)}
                >
                  <span className="lo-zones__icon"><LoIcon name={zone.icon} size={14} /></span>
                  <span className="lo-zones__name">{zh ? zone.name : zone.nameEn}</span>
                  <span className="lo-zones__count" style={{ color: over ? "var(--warning)" : `var(${zone.token})` }}>
                    {count}/{zone.capacity}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      </aside>
    </div>
  );
}
