/**
 * PixelLibraryScene —— 像素美术图书馆场景（默认场景）。
 *
 * 场景美术直接使用上游 ClawLibrary 的 `scene-floor` + `scene-objects`
 * （一张完整的图书馆像素画），角色使用其 `capy-claw` / `cat-claw` 精灵表，
 * 行走路线使用其 `walkGraph`（20 节点）。
 *
 * ⚠️ 美术资源**仅限非商业用途**（CC BY-NC-SA 4.0 / Star-Office-UI 非商业）。
 * 出处与义务见 `docs/ASSET-LICENSES.md`；商用请改用设置里的「等距矢量」场景。
 *
 * 渲染策略与等距场景一致：固定尺寸画布 + view 变换（平移/缩放），
 * 角色位置/帧/气泡在 rAF 里直接写 DOM（不触发 React 重渲染）。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryActor, LibrarySnapshot } from "../../types";
import { ACTIVITY_META } from "../../types";
import {
  ACTOR_DISPLAY,
  ASSET_BASE,
  CLAW_SCENE,
  PIXEL_ROOMS,
  SCENE_CREDITS,
  ZONE_TO_ROOM,
  roomOfZone,
} from "../../data/pixel-art";
import {
  advancePixelScene,
  createPixelSceneState,
  frameAt,
  frameOffset,
  logicToDisplay,
  pixelBubbleVisible,
  pixelSceneStats,
  sheetOf,
  stepPixelMovement,
  type PixelSceneState,
} from "../../core/pixel-scene";
import { useLibraryOps } from "../../store";

const MIN_SCALE = 0.3;
const MAX_SCALE = 3.2;
/** 显示画布尺寸（= 上游 displaySize） */
const CANVAS_W = CLAW_SCENE.displayWidth;
const CANVAS_H = CLAW_SCENE.displayHeight;
/** 精灵显示尺寸 */
const SPRITE_W = ACTOR_DISPLAY.width;
const SPRITE_H = ACTOR_DISPLAY.height;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

export interface PixelLibrarySceneProps {
  snapshot: LibrarySnapshot | null;
  initialScene?: PixelSceneState;
  showZoneLabels?: boolean;
  showNameplates?: boolean;
  showBubbles?: boolean;
  speed?: number;
  maxActors?: number;
  onSelectActor?: (id: string) => void;
  onSelectZone?: (id: string) => void;
  /** 资源加载失败（提示用户切到等距风格） */
  onAssetError?: () => void;
}

interface ActorNode {
  id: string;
  actor: LibraryActor;
  signature: string;
}

export function PixelLibraryScene({
  snapshot,
  initialScene,
  showZoneLabels = true,
  showNameplates = true,
  showBubbles = true,
  speed = 1,
  maxActors = 24,
  onSelectActor,
  onSelectZone,
  onAssetError,
}: PixelLibrarySceneProps) {
  const selectedActorId = useLibraryOps((s) => s.selectedActorId);
  const selectedZoneId = useLibraryOps((s) => s.selectedZoneId);
  const setScene = useLibraryOps((s) => s.setPixelScene);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PixelSceneState>(initialScene ?? createPixelSceneState());
  const lastSnapshotAt = useRef(0);
  const lastFrameAt = useRef(0);
  const speedRef = useRef(speed);
  const actorEls = useRef(new Map<string, HTMLDivElement>());
  const viewRef = useRef<View>({ scale: 0.5, tx: 0, ty: 0 });
  const viewAnim = useRef<number | null>(null);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number; active: boolean } | null>(null);

  const [view, setView] = useState<View>({ scale: 0.5, tx: 0, ty: 0 });
  const [signature, setSignature] = useState("");
  const [stats, setStats] = useState(() => pixelSceneStats(createPixelSceneState()));
  const [assetError, setAssetError] = useState(false);

  speedRef.current = speed;
  viewRef.current = view;

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
      signature: [actor.id, actor.name, actor.kind, actor.roleLabel, actor.activity].join("|"),
    }));
  }, [snapshot, maxActors]);

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
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(w / CANVAS_W, h / CANVAS_H) * 0.99));
    setView({ scale, tx: (w - CANVAS_W * scale) / 2, ty: (h - CANVAS_H * scale) / 2 });
  }, []);

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

  // 首次自适应 + 尺寸变化时保持中心点
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
        const cx = (prevW / 2 - v.tx) / v.scale;
        const cy = (prevH / 2 - v.ty) / v.scale;
        return { scale: v.scale, tx: w / 2 - cx * v.scale, ty: h / 2 - cy * v.scale };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView]);

  // 滚轮缩放（指针为锚点）
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
    const next = advancePixelScene(sceneRef.current, snapshot, dt);
    sceneRef.current = next;
    setScene(next);
    setSignature(nodes.map((n) => n.signature).join("~"));
  }, [snapshot, nodes, setScene]);

  // rAF：位置 / 帧 / 朝向 / 气泡
  useEffect(() => {
    let raf = 0;
    let lastStatsAt = 0;
    const loop = (time: number) => {
      const prev = lastFrameAt.current || time;
      const dt = Math.min(64, Math.max(0, time - prev)) * Math.max(0.05, speedRef.current);
      lastFrameAt.current = time;

      const state = sceneRef.current;
      for (const a of Object.values(state.actors)) {
        stepPixelMovement(a, dt);
        const el = actorEls.current.get(a.id);
        if (!el) continue;
        const p = logicToDisplay({ x: a.x, y: a.y });
        el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
        el.style.zIndex = String(Math.round(a.y) + 10);
        el.style.opacity = String(Math.max(0, Math.min(1, a.appear)));
        el.style.setProperty("--lo-facing", String(a.facing));
        el.dataset.bubble = pixelBubbleVisible(a, time) ? "1" : "0";
        el.dataset.zoneId = a.zoneId;
        el.dataset.action = a.action;

        const sprite = el.querySelector<HTMLElement>(".lo-sprite");
        if (sprite) {
          const sheet = sheetOf(a);
          const frame = frameAt(a, time);
          const off = frameOffset(sheet, frame);
          const scale = SPRITE_W / sheet.frameWidth;
          sprite.style.backgroundPosition = `${-off.x * scale}px ${-off.y * scale}px`;
        }
      }
      if (time - lastStatsAt > 400) {
        lastStatsAt = time;
        const next = pixelSceneStats(state);
        setStats((s) =>
          s.total === next.total && s.walking === next.walking && s.working === next.working && s.idle === next.idle
            ? s
            : next,
        );
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 选中角色 → 镜头居中
  useEffect(() => {
    if (!selectedActorId) return;
    const el = wrapRef.current;
    const actor = sceneRef.current.actors[selectedActorId];
    if (!el || !actor) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const p = logicToDisplay({ x: actor.x, y: actor.y });
    const scale = Math.max(viewRef.current.scale, 1.1);
    animateTo({ scale, tx: w / 2 - p.x * scale, ty: h / 2 - p.y * scale });
  }, [selectedActorId, animateTo]);

  const zoomBy = useCallback((factor: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    setView((v) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      const k = scale / v.scale;
      return { scale, tx: w / 2 - (w / 2 - v.tx) * k, ty: h / 2 - (h / 2 - v.ty) * k };
    });
  }, []);

  const actorsById = useMemo(() => sceneRef.current.actors, [signature]);

  const markAssetError = useCallback(() => {
    setAssetError(true);
    onAssetError?.();
  }, [onAssetError]);

  if (assetError) {
    return (
      <div className="lo-scene lo-scene--asset-error">
        <div className="lo-scene__empty">
          像素美术资源未找到（{ASSET_BASE}）—— 请在设置里切换到「等距矢量」场景风格，或重新运行资源同步脚本。
        </div>
      </div>
    );
  }

  return (
    <div
      className="lo-scene"
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={fitView}
      data-scene="pixel"
    >
      <div
        className="lo-scene__canvas"
        style={{ width: CANVAS_W, height: CANVAS_H, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        {/* 地板 + 家具（上游 scene-floor / scene-objects） */}
        <img className="lo-pixel-layer" src={CLAW_SCENE.floor} alt="" draggable={false} onError={markAssetError} />
        <img className="lo-pixel-layer" src={CLAW_SCENE.objects} alt="" draggable={false} onError={markAssetError} />

        {/* 岗位高亮 + 标签 */}
        {PIXEL_ROOMS.map((room) => {
          const active = selectedZoneId ? roomOfZone(selectedZoneId) === room.id : false;
          const [bx, by, bw, bh] = room.bounds;
          const p = logicToDisplay({ x: bx, y: by });
          const size = logicToDisplay({ x: bw, y: bh });
          const anchor = logicToDisplay(room.labelAnchor);
          return (
            <div
              key={room.id}
              className={`lo-pixel-room${active ? " is-selected" : ""}`}
              style={{
                left: p.x,
                top: p.y,
                width: size.x,
                height: size.y,
                ["--lo-zone-token" as string]: `var(${room.token})`,
              }}
              role="button"
              tabIndex={0}
              aria-label={`${room.label} —— ${room.labelEn}`}
              title={`${room.label}（上游分区 ${room.id}）`}
              onClick={() => onSelectZone?.(zoneOfRoom(room.id))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectZone?.(zoneOfRoom(room.id));
                }
              }}
            >
              {showZoneLabels && (
                <span className="lo-pixel-room__label" style={{ left: anchor.x - p.x, top: anchor.y - p.y }}>
                  {room.label}
                </span>
              )}
            </div>
          );
        })}

        {/* 角色层 */}
        <div className="lo-pixel-actors">
          {nodes.map(({ id, actor }) => {
            const a = actorsById[id];
            const start = a ? logicToDisplay({ x: a.x, y: a.y }) : logicToDisplay({ x: 860, y: 610 });
            const sheet = a ? sheetOf(a) : null;
            const scale = sheet ? SPRITE_W / sheet.frameWidth : 1;
            const bgW = sheet ? sheet.columns * sheet.frameWidth * scale : SPRITE_W;
            const bgH = sheet ? sheet.rows * sheet.frameHeight * scale : SPRITE_H;
            const url = sheet ? `${ASSET_BASE}/claw-library/${sheet.path}` : "";
            const selected = id === selectedActorId;
            return (
              <div
                key={id}
                className={`lo-actor-wrap lo-pixel-actor${selected ? " is-selected" : ""}`}
                ref={(el) => {
                  if (el) actorEls.current.set(id, el);
                  else actorEls.current.delete(id);
                }}
                style={{ transform: `translate3d(${start.x}px, ${start.y}px, 0)` }}
                data-actor-id={id}
                data-bubble="0"
                title={`${actor.name} · ${actor.roleLabel}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectActor?.(id);
                }}
              >
                {showBubbles && a?.bubble ? (
                  <div className="lo-actor-bubble">
                    <span className="lo-actor-bubble__text">{truncate(a.bubble, 28)}</span>
                  </div>
                ) : null}
                <div
                  className="lo-sprite"
                  style={{
                    width: SPRITE_W,
                    height: SPRITE_H,
                    backgroundImage: url ? `url(${url})` : undefined,
                    backgroundSize: `${bgW}px ${bgH}px`,
                    backgroundRepeat: "no-repeat",
                  }}
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

      {/* HUD */}
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
        <span className="lo-scene__hint" title={`${SCENE_CREDITS[0].project} · ${SCENE_CREDITS[0].license}`}>
          滚轮缩放 · 拖拽平移 · 双击复位
        </span>
      </div>

      {nodes.length === 0 && <div className="lo-scene__empty">暂无智能体入场 —— 发起一次对话或让助手建队</div>}
    </div>
  );
}

/** 房间 id → 本插件岗位 id（反向映射，多个岗位同房间时取第一个） */
function zoneOfRoom(roomId: string): string {
  const hit = Object.entries(ZONE_TO_ROOM).find(([, r]) => r === roomId);
  return hit ? hit[0] : roomId;
}

function truncate(text: string, max: number): string {
  const t = String(text ?? "");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
