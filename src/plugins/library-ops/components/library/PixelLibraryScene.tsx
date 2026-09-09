/**
 * PixelLibraryScene —— 像素美术图书馆场景（默认场景）。
 *
 * 场景图片有三种来源（设置里的「场景图片」）：
 * 1. 内置像素画（ClawLibrary `scene-floor` + `scene-objects` 两层）
 * 2. 内置场景图（AI 生成的一整张 2752×1536 图书馆地图）
 * 3. 用户上传（拖到场景里 / 设置里选文件，存 IndexedDB）
 *
 * 三者共用同一套坐标：图片铺满 1920×1072 显示画布，角色、岗位标签、点击热区
 * 都不随图片变化 —— 所以换图不会让角色站错位置。若图片里的房间位置和内置布局
 * 有偏差，用设置里的「画面微调」把图挪一挪，并打开「对位参考线」对照。
 *
 * 角色始终使用 ClawLibrary 的 `capy-claw` / `cat-claw` 精灵表，
 * 行走路线使用其 `walkGraph`（20 节点）。
 *
 * ⚠️ 内置像素画**仅限非商业用途**（CC BY-NC-SA 4.0）；内置 AI 场景图与用户上传图
 * 属于自有素材。出处与义务见 `docs/ASSET-LICENSES.md`；商用请改用设置里的「等距矢量」场景。
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
  FALLBACK_SCENE_PRESET_ID,
  SCENE_CREDITS,
  ZONE_TO_ROOM,
  getScenePreset,
  pixelRooms,
  resolveSprite,
  roomOfZone,
  walkEdges,
  walkNodes,
  type PixelRoom,
  type WalkNode,
} from "../../data/pixel-art";
import { resizeRoom, translateRoom, type RoomOverride } from "../../data/layout-override";
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
import { isIdentityAdjust, sceneAdjustTransform } from "../../core/scene-image";
import { LoIcon } from "../icons";
import { useLibraryOps } from "../../store";

const MIN_SCALE = 0.3;
const MAX_SCALE = 3.2;
/** 显示画布尺寸（= 上游 displaySize） */
const CANVAS_W = CLAW_SCENE.displayWidth;
const CANVAS_H = CLAW_SCENE.displayHeight;
/** 精灵显示尺寸 */
const SPRITE_W = ACTOR_DISPLAY.width;
const SPRITE_H = ACTOR_DISPLAY.height;
/** 显示画布 → 逻辑坐标的比例（x 通常为 1，y 略小于 1） */
const DISPLAY_TO_LOGIC_X = CLAW_SCENE.logicWidth / CANVAS_W;
const DISPLAY_TO_LOGIC_Y = CLAW_SCENE.logicHeight / CANVAS_H;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

/** 对位拖拽中的本地预览（不写 store，松手才提交） */
interface LayoutPreview {
  rooms: Record<string, RoomOverride>;
  nodes: Record<string, { x: number; y: number }>;
}

const EMPTY_PREVIEW: LayoutPreview = { rooms: {}, nodes: {} };

/** 正在进行的对位拖拽 */
interface LayoutDrag {
  kind: "room" | "node";
  id: string;
  mode: "move" | "resize";
  base: PixelRoom | WalkNode;
  startX: number;
  startY: number;
}

/** 客户端像素位移 → 逻辑坐标位移（考虑画布缩放与显示/逻辑比例） */
function clientDeltaToLogic(dx: number, dy: number, viewScale: number): { x: number; y: number } {
  const s = viewScale || 1;
  return { x: (dx / s) * DISPLAY_TO_LOGIC_X, y: (dy / s) * DISPLAY_TO_LOGIC_Y };
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
  const sceneImageId = useLibraryOps((s) => s.settings.sceneImageId);
  const sceneImageAdjust = useLibraryOps((s) => s.settings.sceneImageAdjust);
  const showAlignGuides = useLibraryOps((s) => s.settings.showAlignGuides);
  const customScene = useLibraryOps((s) => s.customScene);
  const sceneImageBusy = useLibraryOps((s) => s.sceneImageBusy);
  const setCustomSceneImage = useLibraryOps((s) => s.setCustomSceneImage);
  const loadCustomSceneImage = useLibraryOps((s) => s.loadCustomSceneImage);
  const editingLayout = useLibraryOps((s) => s.editingLayout);
  const layoutOverrides = useLibraryOps((s) => s.layoutOverrides);
  const setEditingLayout = useLibraryOps((s) => s.setEditingLayout);
  const setRoomOverride = useLibraryOps((s) => s.setRoomOverride);
  const setNodeOverride = useLibraryOps((s) => s.setNodeOverride);
  const resetLayout = useLibraryOps((s) => s.resetLayout);

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
  const [fileDragging, setFileDragging] = useState(false);
  const [layoutDrag, setLayoutDrag] = useState<LayoutDrag | null>(null);
  const [preview, setPreview] = useState<LayoutPreview>(EMPTY_PREVIEW);

  const previewRef = useRef(preview);
  previewRef.current = preview;

  speedRef.current = speed;
  viewRef.current = view;

  // 首次挂载时把用户上传过的场景图片读回来（IndexedDB → objectURL）
  useEffect(() => {
    void loadCustomSceneImage();
  }, [loadCustomSceneImage]);

  /** 房间 / 路网（已应用对位覆盖） */
  const rooms = useMemo(() => pixelRooms(), [layoutOverrides, sceneImageId]);
  const guideNodes = useMemo(() => walkNodes(), [layoutOverrides, sceneImageId]);

  /** 当前生效的图片图层（内置预设可能多层，自定义只有一层） */
  const layers = useMemo<Array<{ src: string; pixelated: boolean }>>(() => {
    if (sceneImageId === "custom" && customScene) return [{ src: customScene.url, pixelated: false }];
    const preset = getScenePreset(sceneImageId) ?? getScenePreset(FALLBACK_SCENE_PRESET_ID);
    if (preset) return preset.layers.map((src) => ({ src, pixelated: preset.pixelated }));
    return [
      { src: CLAW_SCENE.floor, pixelated: true },
      { src: CLAW_SCENE.objects, pixelated: true },
    ];
  }, [sceneImageId, customScene]);

  const layerStyle = useMemo(
    () => (isIdentityAdjust(sceneImageAdjust) ? undefined : { transform: sceneAdjustTransform(sceneImageAdjust) }),
    [sceneImageAdjust],
  );

  // ===== 对位模式：拖动房间框 / 路网节点 =====
  // 拖拽过程只改本地预览（避免每帧写 localStorage），松手时提交到 store。
  useEffect(() => {
    if (!layoutDrag) return;
    const onMove = (e: PointerEvent) => {
      const scale = viewRef.current.scale || 1;
      const d = clientDeltaToLogic(e.clientX - layoutDrag.startX, e.clientY - layoutDrag.startY, scale);
      if (layoutDrag.kind === "node") {
        const base = layoutDrag.base as WalkNode;
        setPreview({ rooms: {}, nodes: { [layoutDrag.id]: { x: Math.round(base.x + d.x), y: Math.round(base.y + d.y) } } });
      } else {
        const base = layoutDrag.base as PixelRoom;
        const patch =
          layoutDrag.mode === "resize"
            ? resizeRoom(base, base.bounds[2] + d.x, base.bounds[3] + d.y)
            : translateRoom(base, d.x, d.y);
        setPreview({ rooms: { [layoutDrag.id]: patch }, nodes: {} });
      }
    };
    const onUp = () => {
      const p = previewRef.current;
      const node = p.nodes[layoutDrag.id];
      const room = p.rooms[layoutDrag.id];
      if (layoutDrag.kind === "node" && node) setNodeOverride(layoutDrag.id, node);
      if (layoutDrag.kind === "room" && room) setRoomOverride(layoutDrag.id, room);
      setPreview(EMPTY_PREVIEW);
      setLayoutDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [layoutDrag, setNodeOverride, setRoomOverride]);

  // Esc 退出对位模式
  useEffect(() => {
    if (!editingLayout) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditingLayout(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingLayout, setEditingLayout]);

  const startRoomDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, room: PixelRoom, mode: "move" | "resize") => {
      if (!editingLayout) return;
      e.preventDefault();
      e.stopPropagation();
      setLayoutDrag({ kind: "room", id: room.id, mode, base: room, startX: e.clientX, startY: e.clientY });
    },
    [editingLayout],
  );

  const startNodeDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, node: WalkNode) => {
      if (!editingLayout) return;
      e.preventDefault();
      e.stopPropagation();
      setLayoutDrag({ kind: "node", id: node.id, mode: "move", base: node, startX: e.clientX, startY: e.clientY });
    },
    [editingLayout],
  );

  // 把图片直接拖到场景上即可替换（比进设置里点按钮更快）
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const types = e.dataTransfer?.types;
    if (!types || (!types.includes("Files") && !types.includes("application/x-moz-file"))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setFileDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // 只有真正离开场景容器才收起提示（避免掠过子元素时闪烁）
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setFileDragging(false);
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setFileDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) await setCustomSceneImage(file);
    },
    [setCustomSceneImage],
  );

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
          const resolved = resolveSprite(a.variant, a.action);
          const frame = frameAt(a, time);
          const off = frameOffset(resolved.sheet, frame);
          const scale = SPRITE_W / resolved.sheet.frameWidth;
          sprite.style.backgroundPosition = `${-off.x * scale}px ${-off.y * scale}px`;
          // 该动作没有专属精灵表（回退到了站立帧）时，用 CSS 程序化补一个动效，
          // 让「只画了一张站立图」的自制素材也能活起来
          const fallback = resolved.action !== a.action ? a.action : "";
          if ((sprite.dataset.fallback ?? "") !== fallback) {
            if (fallback) sprite.dataset.fallback = fallback;
            else delete sprite.dataset.fallback;
          }
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
      className={`lo-scene${fileDragging ? " is-dropping" : ""}${editingLayout ? " is-editing-layout" : ""}`}
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={fitView}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-scene="pixel"
      data-scene-image={sceneImageId}
    >
      <div
        className="lo-scene__canvas"
        style={{ width: CANVAS_W, height: CANVAS_H, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        {/* 场景图片（内置像素画 / 内置场景图 / 用户上传） */}
        {layers.map((layer, i) => (
          <img
            key={`${layer.src}#${i}`}
            className={`lo-pixel-layer${layer.pixelated ? " lo-pixel-layer--pixelated" : ""}${
              layerStyle ? " lo-pixel-layer--adjusted" : ""
            }`}
            src={layer.src}
            alt=""
            draggable={false}
            style={layerStyle}
            data-layer={i}
            onError={markAssetError}
          />
        ))}

        {/* 对位参考线：路网（房间框在下面渲染，可拖动） */}
        {(showAlignGuides || editingLayout) && (
          <svg className="lo-scene__guides" viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} aria-hidden="true">
            {walkEdges().map(([a, b]) => {
              const na = guideNodes.find((n) => n.id === a);
              const nb = guideNodes.find((n) => n.id === b);
              if (!na || !nb) return null;
              const pa = logicToDisplay(preview.nodes[a] ?? na);
              const pb = logicToDisplay(preview.nodes[b] ?? nb);
              return <line key={`${a}-${b}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} />;
            })}
            {!editingLayout &&
              guideNodes.map((n) => {
                const p = logicToDisplay(n);
                return <circle key={n.id} cx={p.x} cy={p.y} r={4} />;
              })}
          </svg>
        )}

        {/* 岗位高亮 + 标签（对位模式下可拖动 / 缩放） */}
        {rooms.map((room) => {
          const pv = preview.rooms[room.id];
          const eff: PixelRoom = pv
            ? {
                ...room,
                bounds: pv.bounds ?? room.bounds,
                labelAnchor: pv.labelAnchor ?? room.labelAnchor,
                work: pv.work ?? room.work,
              }
            : room;
          const active = selectedZoneId ? roomOfZone(room.id) === room.id : false;
          const [bx, by, bw, bh] = eff.bounds;
          const p = logicToDisplay({ x: bx, y: by });
          const size = logicToDisplay({ x: bw, y: bh });
          const anchor = logicToDisplay(eff.labelAnchor);
          const draggingThis = layoutDrag?.kind === "room" && layoutDrag.id === room.id;
          return (
            <div
              key={room.id}
              className={`lo-pixel-room${active ? " is-selected" : ""}${editingLayout ? " is-editing" : ""}${
                draggingThis ? " is-dragging" : ""
              }`}
              style={{
                left: p.x,
                top: p.y,
                width: size.x,
                height: size.y,
                ["--lo-zone-token" as string]: `var(${room.token})`,
              }}
              role={editingLayout ? "presentation" : "button"}
              tabIndex={editingLayout ? -1 : 0}
              aria-label={`${room.label} —— ${room.labelEn}`}
              title={editingLayout ? `${room.label}：拖动移动，右下角小方块改大小` : `${room.label}（上游分区 ${room.id}）`}
              data-room-id={room.id}
              onClick={editingLayout ? undefined : () => onSelectZone?.(zoneOfRoom(room.id))}
              onPointerDown={editingLayout ? (e) => startRoomDrag(e, eff, "move") : undefined}
              onKeyDown={(e) => {
                if (editingLayout) return;
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
              {editingLayout && (
                <span
                  className="lo-pixel-room__handle"
                  title="拖动改变房间大小"
                  onPointerDown={(e) => startRoomDrag(e, eff, "resize")}
                />
              )}
            </div>
          );
        })}

        {/* 对位模式：路网节点可拖动 */}
        {editingLayout &&
          guideNodes.map((n) => {
            const pos = preview.nodes[n.id] ?? n;
            const p = logicToDisplay(pos);
            const draggingThis = layoutDrag?.kind === "node" && layoutDrag.id === n.id;
            return (
              <div
                key={n.id}
                className={`lo-edit-node${draggingThis ? " is-dragging" : ""}`}
                style={{ left: p.x, top: p.y }}
                data-node-id={n.id}
                title={`${n.id}（${n.roomId}）—— 拖动改走道位置`}
                onPointerDown={(e) => startNodeDrag(e, n)}
              />
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
                <div className="lo-sprite-wrap">
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
                </div>
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
          <span>
            <LoIcon name="users" size={12} /> {stats.total}
          </span>
          <span>
            <LoIcon name="footprints" size={12} /> {stats.walking}
          </span>
          <span>
            <LoIcon name="cog" size={12} /> {stats.working}
          </span>
          <span>
            <LoIcon name="coffee" size={12} /> {stats.idle}
          </span>
        </span>
        <button className="lo-hud-btn" onClick={() => zoomBy(1.25)} title="放大" aria-label="放大">
          <LoIcon name="plus" size={13} />
        </button>
        <button className="lo-hud-btn" onClick={() => zoomBy(0.8)} title="缩小" aria-label="缩小">
          <LoIcon name="minus" size={13} />
        </button>
        <button className="lo-hud-btn" onClick={fitView} title="适应窗口（双击场景同效）" aria-label="适应窗口">
          <LoIcon name="maximize-2" size={13} />
        </button>
        <button
          className={`lo-hud-btn${editingLayout ? " is-active" : ""}`}
          onClick={() => setEditingLayout(!editingLayout)}
          title={editingLayout ? "退出对位模式（Esc）" : "对位模式：拖动房间框 / 走道节点，让它们对齐当前场景图"}
          aria-label="对位模式"
          aria-pressed={editingLayout}
        >
          <LoIcon name="move" size={13} />
        </button>
        {editingLayout && (
          <button
            className="lo-hud-btn"
            onClick={resetLayout}
            title="清除当前场景图的全部对位调整（回到内置布局）"
            aria-label="重置对位"
          >
            <LoIcon name="rotate-ccw" size={13} />
          </button>
        )}
        <span className="lo-scene__hint" title={`${SCENE_CREDITS[0].project} · ${SCENE_CREDITS[0].license}`}>
          {editingLayout ? "拖动房间框对齐画面 · Esc 退出" : "滚轮缩放 · 拖拽平移 · 双击复位"}
        </span>
      </div>

      {editingLayout && (
        <div className="lo-scene__edit-hint">
          <LoIcon name="move" size={12} /> 对位模式：拖动<b>房间框</b>移动、右下角小方块改大小，拖动<b>圆点</b>改走道；角色会按新位置走动。
        </div>
      )}

      {nodes.length === 0 && <div className="lo-scene__empty">暂无智能体入场 —— 发起一次对话或让助手建队</div>}

      {fileDragging && (
        <div className="lo-scene__drop">
          <div className="lo-scene__drop-card">
            <LoIcon name="image" size={26} className="lo-scene__drop-icon" />
            <span>松手即可用这张图替换场景</span>
            <span className="lo-scene__drop-hint">PNG / JPG / WebP · 建议 16:9</span>
          </div>
        </div>
      )}

      {sceneImageBusy && <div className="lo-scene__busy">正在读取场景图片…</div>}
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
