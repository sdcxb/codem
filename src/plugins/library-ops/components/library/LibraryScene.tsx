/**
 * LibraryScene —— 图书馆主场景（等距 2.5D）。
 *
 * 视觉母题来自 ClawLibrary（一间图书馆，角色在各自岗位工作），本实现把
 * 「一只小龙虾」扩展为「一支团队」：每个团队角色 / 子智能体由 `CharacterActor`
 * 生成独立外观，站在自己岗位的工位上，按真实工作状态播放动画。
 *
 * ## 渲染策略
 * - 固定像素画布（等距包围盒）+ SVG 地板/墙/区域/家具 + DOM 角色层，
 *   两者共用 `iso.ts` 的同一套坐标，外层用 view 变换（平移 + 缩放）适配容器；
 * - 角色位置/朝向/动画态/气泡可见性在 rAF 里**直接写 DOM**（不触发 React 重渲染），
 *   仅在「角色集合 / 外观」变化时重建 React 子树；
 * - 支持滚轮缩放（以指针为锚点）、拖拽平移、双击复位、HUD 缩放按钮。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryActor, LibrarySnapshot, SceneState } from "../../types";
import { ACTIVITY_META } from "../../types";
import { LIBRARY_MAP } from "../../data/library-map";
import { advanceScene, bubbleVisible, createSceneState, sceneStats, stepActorMovement } from "../../core/scene-engine";
import { CharacterActor } from "./CharacterActor";
import { SceneFurniture } from "./SceneFurniture";
import {
  CANVAS_H,
  CANVAS_W,
  blockPoints,
  floorPoints,
  gridLines,
  tileCenter,
  wallPoints,
  wallWindow,
} from "./iso";
import { useLibraryOps } from "../../store";

const GRID = gridLines();
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

interface ActorNode {
  id: string;
  actor: LibraryActor;
  signature: string;
}

export interface LibrarySceneProps {
  snapshot: LibrarySnapshot | null;
  /**
   * 初始场景态。用于两个场景：
   * 1. 面板切走再切回时恢复上次的馆内状态（角色不必重新从入口走一遍）；
   * 2. 视觉预览 / 测试注入「已到岗」的确定性状态。
   */
  initialScene?: SceneState;
  showZoneLabels?: boolean;
  showNameplates?: boolean;
  showBubbles?: boolean;
  /** 动画速度倍率 */
  speed?: number;
  /** 最大角色数（超出折叠） */
  maxActors?: number;
  onSelectActor?: (id: string) => void;
  onSelectZone?: (id: string) => void;
  onSceneTick?: (state: SceneState) => void;
}

export function LibraryScene({
  snapshot,
  initialScene,
  showZoneLabels = true,
  showNameplates = true,
  showBubbles = true,
  speed = 1,
  maxActors = 24,
  onSelectActor,
  onSelectZone,
  onSceneTick,
}: LibrarySceneProps) {
  const selectedActorId = useLibraryOps((s) => s.selectedActorId);
  const selectedZoneId = useLibraryOps((s) => s.selectedZoneId);
  const setScene = useLibraryOps((s) => s.setIsoScene);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState>(initialScene ?? createSceneState());
  const lastSnapshotAt = useRef(0);
  const lastFrameAt = useRef(0);
  const speedRef = useRef(speed);
  const actorEls = useRef(new Map<string, HTMLDivElement>());
  const [view, setView] = useState<View>({ scale: 0.5, tx: 0, ty: 0 });
  const [signature, setSignature] = useState("");
  const [stats, setStats] = useState(() => sceneStats(createSceneState()));
  const viewRef = useRef(view);
  const viewAnim = useRef<number | null>(null);
  viewRef.current = view;

  /** 平滑过渡到目标视图（选中角色时居中用） */
  const animateTo = useCallback((target: View, duration = 340) => {
    if (viewAnim.current !== null) cancelAnimationFrame(viewAnim.current);
    const from = viewRef.current;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      setView({
        scale: from.scale + (target.scale - from.scale) * e,
        tx: from.tx + (target.tx - from.tx) * e,
        ty: from.ty + (target.ty - from.ty) * e,
      });
      viewAnim.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    viewAnim.current = requestAnimationFrame(step);
  }, []);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number; active: boolean } | null>(null);

  speedRef.current = speed;

  // 参与渲染的角色（按上限截断，优先活跃/异常）
  const nodes = useMemo<ActorNode[]>(() => {
    if (!snapshot) return [];
    const weight: Record<string, number> = { bad: 0, wait: 1, active: 2, ok: 3, off: 4 };
    const sorted = [...snapshot.actors].sort((a, b) => {
      const sa = ACTIVITY_META[a.activity].severity;
      const sb = ACTIVITY_META[b.activity].severity;
      if (weight[sa] !== weight[sb]) return weight[sa] - weight[sb];
      return (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0);
    });
    return sorted.slice(0, maxActors).map((actor) => ({
      id: actor.id,
      actor,
      signature: [
        actor.id,
        actor.look.paletteId,
        actor.look.body,
        actor.look.hair,
        actor.look.hat,
        actor.look.prop,
        actor.look.face,
        actor.name,
        actor.kind,
      ].join("|"),
    }));
  }, [snapshot, maxActors]);

  /** 缩放到适应容器并居中 */
  const fitView = useCallback(() => {
    if (viewAnim.current !== null) {
      cancelAnimationFrame(viewAnim.current);
      viewAnim.current = null;
    }
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(w / CANVAS_W, h / CANVAS_H) * 0.98));
    setView({ scale, tx: (w - CANVAS_W * scale) / 2, ty: (h - CANVAS_H * scale) / 2 });
  }, []);

  // 容器尺寸变化：首次自适应，之后保持用户的缩放/平移（只把中心点固定住）
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let last = { w: el.clientWidth, h: el.clientHeight };
    fitView();

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h || (w === last.w && h === last.h)) return;
      const prevW = last.w;
      const prevH = last.h;
      last = { w, h };
      setView((v) => {
        // 保持画布中心点不变，避免「窗口一变就重置缩放」
        const canvasCx = (prevW / 2 - v.tx) / v.scale;
        const canvasCy = (prevH / 2 - v.ty) / v.scale;
        return { scale: v.scale, tx: w / 2 - canvasCx * v.scale, ty: h / 2 - canvasCy * v.scale };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView]);

  // 滚轮缩放（以指针为锚点）—— 原生监听以便 preventDefault
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
        const k = scale / v.scale;
        return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 拖拽平移
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest(".lo-actor-wrap") || target.closest(".lo-scene__hud")) return;
      panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, active: true };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [view.tx, view.ty],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p?.active) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    setView((v) => ({ ...v, tx: p.tx + dx, ty: p.ty + dy }));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current) panRef.current.active = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // 快照 → 场景推进
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.at === lastSnapshotAt.current) return;
    const dt = lastSnapshotAt.current ? snapshot.at - lastSnapshotAt.current : 0;
    lastSnapshotAt.current = snapshot.at;
    const next = advanceScene(sceneRef.current, snapshot, dt);
    sceneRef.current = next;
    setScene(next);
    onSceneTick?.(next);
    const sig = nodes.map((n) => n.signature).join("~");
    setSignature(sig);
  }, [snapshot, nodes, setScene, onSceneTick]);

  // rAF：平滑行走 + 位置/朝向/动画态/气泡同步（只写 DOM）
  useEffect(() => {
    let raf = 0;
    let lastStatsAt = 0;
    const loop = (time: number) => {
      const prev = lastFrameAt.current || time;
      const dt = Math.min(64, Math.max(0, time - prev)) * Math.max(0.05, speedRef.current);
      lastFrameAt.current = time;

      const state = sceneRef.current;
      for (const a of Object.values(state.actors)) {
        stepActorMovement(a, dt);
        const el = actorEls.current.get(a.id);
        if (!el) continue;
        const p = tileCenter(a.col, a.row);
        el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
        el.style.zIndex = String(Math.round((a.col + a.row) * 10) + 100);
        el.style.opacity = String(Math.max(0, Math.min(1, a.appear)));
        el.style.setProperty("--lo-facing", String(a.facing));
        el.dataset.bubble = bubbleVisible(a, time) ? "1" : "0";
        el.dataset.zoneId = a.zoneId;
        const svg = el.querySelector("svg.lo-actor");
        if (svg) {
          svg.setAttribute("data-anim", a.anim);
          svg.setAttribute("data-walking", a.walking ? "1" : "0");
        }
      }
      // HUD 统计节流刷新（每 400ms 一次，避免每帧 setState）
      if (time - lastStatsAt > 400) {
        lastStatsAt = time;
        const next = sceneStats(state);
        setStats((prevStats) =>
          prevStats.total === next.total &&
          prevStats.walking === next.walking &&
          prevStats.working === next.working &&
          prevStats.idle === next.idle
            ? prevStats
            : next,
        );
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const actorsById = useMemo(() => {
    const m = new Map<string, SceneState["actors"][string]>();
    for (const a of Object.values(sceneRef.current.actors)) m.set(a.id, a);
    return m;
  }, [signature]);

  const zoomBy = useCallback((factor: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    setView((v) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      const k = scale / v.scale;
      const cx = w / 2;
      const cy = h / 2;
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  }, []);

  // 选中角色 → 把镜头平滑移到它身上（「在场景中查看」）
  useEffect(() => {
    if (!selectedActorId) return;
    const el = wrapRef.current;
    const actor = sceneRef.current.actors[selectedActorId];
    if (!el || !actor) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const p = tileCenter(actor.col, actor.row);
    const scale = Math.max(viewRef.current.scale, 0.75);
    animateTo({ scale, tx: w / 2 - p.x * scale, ty: h / 2 - p.y * scale });
  }, [selectedActorId, animateTo]);

  return (
    <div
      className="lo-scene"
      ref={wrapRef}
      data-scene="iso"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={fitView}
    >
      <div
        className="lo-scene__canvas"
        style={{
          width: CANVAS_W,
          height: CANVAS_H,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
        }}
      >
        {/* ===== 地板 / 墙 / 区域 / 家具（SVG 层） ===== */}
        <svg className="lo-scene__svg" width={CANVAS_W} height={CANVAS_H} viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}>
          <defs>
            <linearGradient id="lo-floor-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="lo-floor-stop-a" />
              <stop offset="100%" className="lo-floor-stop-b" />
            </linearGradient>
          </defs>

          {/* 背墙 */}
          <polygon points={wallPoints("nw")} className="lo-wall" />
          <polygon points={wallPoints("ne")} className="lo-wall" />
          <polygon points={wallWindow("nw", 0.08, 0.14)} className="lo-wall-window" />
          <polygon points={wallWindow("nw", 0.42, 0.14)} className="lo-wall-window" />
          <polygon points={wallWindow("nw", 0.76, 0.14)} className="lo-wall-window" />
          <polygon points={wallWindow("ne", 0.22, 0.16)} className="lo-wall-window" />
          <polygon points={wallWindow("ne", 0.62, 0.16)} className="lo-wall-window" />

          {/* 地板 */}
          <polygon points={floorPoints()} fill="url(#lo-floor-grad)" />
          <g className="lo-grid">
            {GRID.map((l) => (
              <line key={l.key} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
            ))}
          </g>

          {/* 区域 */}
          {LIBRARY_MAP.zones.map((zone) => {
            const active = zone.id === selectedZoneId;
            const c = tileCenter(zone.rect.col + zone.rect.w / 2, zone.rect.row + zone.rect.h / 2);
            return (
              <g
                key={zone.id}
                className={`lo-zone${active ? " is-selected" : ""}`}
                style={{ ["--lo-zone-token" as string]: `var(${zone.token})` }}
                data-zone-id={zone.id}
                role="button"
                tabIndex={0}
                aria-label={`${zone.name} —— ${zone.duty}`}
                onClick={() => onSelectZone?.(zone.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectZone?.(zone.id);
                  }
                }}
              >
                <polygon points={blockPoints(zone.rect)} className="lo-zone__fill" />
                <polygon points={blockPoints(zone.rect)} className="lo-zone__edge" />
                {showZoneLabels && (
                  <text x={c.x} y={c.y} className="lo-zone__label" textAnchor="middle">
                    {zone.icon} {zone.name}
                  </text>
                )}
              </g>
            );
          })}

          {/* 家具 */}
          <g className="lo-furniture">
            {LIBRARY_MAP.decor.map((d, i) => (
              <SceneFurniture key={`${d.kind}-${i}`} decor={d} index={i} />
            ))}
          </g>

          {/* 入口 */}
          <g className="lo-entrance">
            {(() => {
              const c = tileCenter(LIBRARY_MAP.entrance.col, LIBRARY_MAP.entrance.row);
              return (
                <>
                  <ellipse cx={c.x} cy={c.y} rx={26} ry={13} className="lo-entrance__pad" />
                  <text x={c.x} y={c.y + 4} textAnchor="middle">
                    ⇥ 入口
                  </text>
                </>
              );
            })()}
          </g>
        </svg>

        {/* ===== 角色层（DOM，rAF 逐帧改 transform） ===== */}
        <div className="lo-scene__actors">
          {nodes.map(({ id, actor }) => {
            const s = actorsById.get(id);
            const start = s ? tileCenter(s.col, s.row) : tileCenter(LIBRARY_MAP.entrance.col, LIBRARY_MAP.entrance.row);
            const selected = id === selectedActorId;
            return (
              <div
                key={id}
                className={`lo-actor-wrap${selected ? " is-selected" : ""}`}
                ref={(el) => {
                  if (el) actorEls.current.set(id, el);
                  else actorEls.current.delete(id);
                }}
                style={{ transform: `translate3d(${start.x}px, ${start.y}px, 0)` }}
                data-actor-id={id}
                data-bubble="0"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectActor?.(id);
                }}
                title={`${actor.name} · ${actor.roleLabel}`}
              >
                {showBubbles && s?.bubble ? (
                  <div className="lo-actor-bubble">
                    <span className="lo-actor-bubble__text">{truncate(s.bubble, 28)}</span>
                  </div>
                ) : null}
                <CharacterActor
                  look={actor.look}
                  anim={s?.anim ?? actor.activity}
                  walking={s?.walking ?? false}
                  phase={hashPhase(id)}
                />
                {showNameplates && (
                  <div className="lo-actor-name">
                    <span className="lo-actor-name__dot" data-severity={ACTIVITY_META[actor.activity].severity} />
                    <span className="lo-actor-name__text">{truncate(actor.name, 12)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ===== HUD ===== */}
      <div className="lo-scene__hud">
        <span className="lo-scene__stats" title="在馆 / 行走 / 工作 / 待命">
          <span>🧑‍💼 {stats.total}</span>
          <span>🚶 {stats.walking}</span>
          <span>⚙️ {stats.working}</span>
          <span>☕ {stats.idle}</span>
        </span>
        <button className="lo-hud-btn" onClick={() => zoomBy(1.25)} title="放大" aria-label="放大">
          ＋
        </button>
        <button className="lo-hud-btn" onClick={() => zoomBy(0.8)} title="缩小" aria-label="缩小">
          －
        </button>
        <button className="lo-hud-btn" onClick={fitView} title="适应窗口（双击场景同效）" aria-label="适应窗口">
          ⤢
        </button>
        <span className="lo-scene__hint">滚轮缩放 · 拖拽平移 · 双击复位</span>
      </div>

      {nodes.length === 0 && <div className="lo-scene__empty">暂无智能体入场 —— 发起一次对话或让助手建队</div>}
    </div>
  );
}

function truncate(text: string, max: number): string {
  const t = String(text ?? "");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function hashPhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return h / 1000;
}
