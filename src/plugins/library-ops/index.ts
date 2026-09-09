/**
 * @codem/ui-library-ops —— 图书馆运营监控（Library Ops Monitor）
 *
 * 完全独立的大插件：
 * - 团队角色 / 子智能体 → 各自生成不同的动画角色，在 ClawLibrary 风格的
 *   图书馆里各自的岗位上工作（10 个岗位按职责自动分配）；
 * - 视图**不是独立面板**：作为 `task-center.library` slot 的贡献者，渲染在宿主
 *   「任务管理」面板的「图书馆」页签里（场景 + 花名册 + 用量/会话/工具/成本/
 *   错误/时间线/设置子视图）；与任务管理重复的「总览 / 团队」页签已移除。
 * - 启停互不影响：插件禁用 → provider 不装配 → 页签不出现，宿主功能与数据零变化
 *   （插件全程只读宿主数据）。
 *
 * 公共导出（供宿主或其它插件复用）：
 * - `LibraryOpsTaskView` 任务管理内的图书馆视图（provider 注册到 `task-center.library`）
 * - `useLibraryOps` 插件状态 store
 * - `collectSnapshot` / `collectSnapshotSync` 数据适配层
 * - `advanceScene` / `createSceneState` 场景引擎（纯函数，可单测）
 * - 地图 / 角色外观数据
 */

export { LibraryOpsTaskView } from "./components/LibraryOpsTaskView";
export { LibraryScene } from "./components/library/LibraryScene";
export { CharacterActor } from "./components/library/CharacterActor";
export { SceneFurniture } from "./components/library/SceneFurniture";

export {
  useLibraryOps,
  loadSettings,
  sortedActors,
  SERIES_CAP,
} from "./store";
export type { SeriesBundle } from "./store";

export {
  collectSnapshot,
  collectSnapshotSync,
  loadDefaultDeps,
  computeHealth,
  toolToActivity,
} from "./core/telemetry-adapter";
export type {
  AdapterDeps,
  AppStateLike,
  ProjectStateLike,
  AgentTeamLike,
  SubagentTaskLike,
  CostStatsLike,
} from "./core/telemetry-adapter";

export {
  advanceScene,
  createSceneState,
  orderedActors,
  stepActorMovement,
  sceneStats,
  bubbleVisible,
  actorPixel,
  WALK_TILES_PER_SEC,
} from "./core/scene-engine";

export { buildWalkGrid, findPath, nearestWalkable, isWalkable, tileToPixel, tileDepth } from "./core/pathfinder";

export {
  TILE_W,
  TILE_H,
  CANVAS_W,
  CANVAS_H,
  WALL_H,
  OFFSET_X,
  OFFSET_Y,
  tilePoint,
  tileCenter,
  blockPoints,
  floorPoints,
  gridLines,
  wallPoints,
  wallWindow,
  isoBox,
  FURNITURE_SIZE,
} from "./components/library/iso";

export {
  LIBRARY_MAP,
  LIBRARY_ZONES,
  LIBRARY_DECOR,
  GRID_COLS,
  GRID_ROWS,
  TILE_WIDTH,
  TILE_HEIGHT,
  ENTRANCE,
  DEFAULT_ZONE_ID,
  tileToScreen,
  screenToTile,
  mapBounds,
  getZone,
  zoneAt,
  isTileInZone,
  stationSlot,
  resolveZoneId,
  planPath,
} from "./data/library-map";

export { CHARACTER_PALETTES, generateLook, paletteOf, characterStyleVars, hashString } from "./data/characters";

export { formatCost, formatTokens, formatAge, formatPercent, formatClock, shortId } from "./core/format";

export * from "./types";
