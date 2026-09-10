/**
 * SceneImageCard —— 设置页的「场景图片」卡片。
 *
 * 能力：
 * 1. 在内置场景之间切换（ClawLibrary 像素画 / 内置 AI 场景图）
 * 2. 上传自己的场景图（点击选择 或 拖拽到虚线区），立即生效并持久化到 IndexedDB
 * 3. 画面微调（缩放 / 位移）+ 对位预览（把 12 个房间框叠在缩略图上）
 *
 * 图片只替换「画面」，角色站位与岗位坐标来自固定布局，换图不会让角色站错位置；
 * 若图片里的房间和内置布局有偏差，用微调把图挪到对齐即可。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { SCENE_IMAGE_ID_FALLBACK } from "../../types";
import { CLAW_SCENE, PIXEL_ROOMS, SCENE_PRESETS, getScenePreset } from "../../data/pixel-art";
import {
  SCENE_ADJUST_LIMITS,
  SCENE_IMAGE_ACCEPT,
  clampSceneAdjust,
  describeSceneImage,
  formatDimensions,
  rectToPercent,
  sceneImageAspectWarning,
} from "../../core/scene-image";
import { isSceneImageDbAvailable } from "../../core/scene-image-db";
import { useLibraryOps } from "../../store";
import { Card, Field, Pill, SectionTitle, Switch } from "./common";
import { LoIcon } from "../icons";

const CANVAS_W = CLAW_SCENE.displayWidth;
const CANVAS_H = CLAW_SCENE.displayHeight;

export function SceneImageCard({ zh }: { zh: boolean }) {
  const settings = useLibraryOps((s) => s.settings);
  const update = useLibraryOps((s) => s.updateSettings);
  const customScene = useLibraryOps((s) => s.customScene);
  const busy = useLibraryOps((s) => s.sceneImageBusy);
  const error = useLibraryOps((s) => s.sceneImageError);
  const notice = useLibraryOps((s) => s.sceneImageNotice);
  const setCustomSceneImage = useLibraryOps((s) => s.setCustomSceneImage);
  const clearCustomSceneImage = useLibraryOps((s) => s.clearCustomSceneImage);
  const loadCustomSceneImage = useLibraryOps((s) => s.loadCustomSceneImage);
  const setTab = useLibraryOps((s) => s.setTab);
  const setEditingLayout = useLibraryOps((s) => s.setEditingLayout);
  const resetLayout = useLibraryOps((s) => s.resetLayout);
  const layoutOverrides = useLibraryOps((s) => s.layoutOverrides);
  const autoAlign = useLibraryOps((s) => s.autoAlignScene);
  const aligning = useLibraryOps((s) => s.aligning);
  const alignScore = useLibraryOps((s) => s.alignScore);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    void loadCustomSceneImage();
  }, [loadCustomSceneImage]);

  const active = settings.sceneImageId;
  const preset = getScenePreset(active) ?? getScenePreset(SCENE_IMAGE_ID_FALLBACK);
  const adjust = settings.sceneImageAdjust;
  const persistAvailable = useMemo(() => isSceneImageDbAvailable(), []);

  const currentImage = active === "custom" && customScene ? customScene.url : (preset?.thumb ?? "");
  const currentLabel =
    active === "custom" && customScene
      ? customScene.name
      : (zh ? preset?.label : preset?.labelEn) ?? (zh ? "内置场景" : "Built-in");
  const currentMeta = active === "custom" && customScene ? describeSceneImage(customScene) : (preset?.credit ?? "");
  const aspectWarning = customScene ? sceneImageAspectWarning(customScene.width, customScene.height) : null;
  const override = layoutOverrides[active];
  const overriddenRooms = override ? Object.keys(override.rooms).length : 0;
  const overriddenNodes = override ? Object.keys(override.nodes).length : 0;

  const pick = () => inputRef.current?.click();

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    // 校验与提示统一走 store，保证拖拽 / 点击 / 场景拖放三条路径口径一致
    await setCustomSceneImage(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  const setAdjust = (patch: Partial<typeof adjust>) => {
    update({ sceneImageAdjust: clampSceneAdjust({ ...adjust, ...patch }) });
  };

  const showAdjust = active !== "claw";

  return (
    <Card title={zh ? "场景图片" : "Scene image"} icon="image">
      {/* 当前生效 */}
      <div className="lo-scene-current">
        <div className="lo-scene-current__thumb">
          {currentImage ? <img src={currentImage} alt="" /> : <span>＋</span>}
        </div>
        <div className="lo-scene-current__info">
          <div className="lo-scene-current__name">
            {currentLabel}
            {preset && !preset.commercial && active !== "custom" && (
              <Pill token="--warning">{zh ? "仅限非商业" : "non-commercial"}</Pill>
            )}
            {active === "custom" && <Pill token="--accent">{zh ? "我的上传" : "uploaded"}</Pill>}
          </div>
          <div className="lo-scene-current__meta">{currentMeta}</div>
        </div>
      </div>

      {/* 选择场景 */}
      <SectionTitle hint={zh ? "换图不会改变角色站位" : "positions stay fixed"}>
        {zh ? "选择画面" : "Choose image"}
      </SectionTitle>
      <div className="lo-scene-picker">
        {SCENE_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`lo-scene-option${active === p.id ? " is-active" : ""}`}
            onClick={() => update({ sceneImageId: p.id })}
            title={p.credit}
          >
            <img className="lo-scene-option__thumb" src={p.thumb} alt="" loading="lazy" />
            <span className="lo-scene-option__label">{zh ? p.label : p.labelEn}</span>
            {!p.commercial && <span className="lo-scene-option__tag">{zh ? "非商业" : "NC"}</span>}
          </button>
        ))}
        <button
          className={`lo-scene-option lo-scene-option--custom${active === "custom" ? " is-active" : ""}`}
          onClick={() => (customScene ? update({ sceneImageId: "custom" }) : pick())}
          title={customScene ? customScene.name : zh ? "上传自己的场景图" : "Upload your own image"}
        >
          {customScene ? (
            <img className="lo-scene-option__thumb" src={customScene.url} alt="" />
          ) : (
            <span className="lo-scene-option__thumb lo-scene-option__thumb--empty">＋</span>
          )}
          <span className="lo-scene-option__label">
            {customScene ? (zh ? "我的上传" : "My upload") : zh ? "上传图片" : "Upload"}
          </span>
        </button>
      </div>

      {/* 上传 */}
      <div
        className={`lo-scene-upload${dragOver ? " is-over" : ""}${busy ? " is-busy" : ""}`}
        role="button"
        tabIndex={0}
        onClick={pick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void onFiles(e.dataTransfer?.files ?? null);
        }}
      >
        <span className="lo-scene-upload__icon"><LoIcon name={busy ? "timer" : "image"} size={18} /></span>
        <span className="lo-scene-upload__main">
          {busy ? (zh ? "正在读取图片…" : "Reading image…") : zh ? "点击选择图片，或把图片拖到这里" : "Click to choose an image, or drop one here"}
        </span>
        <span className="lo-scene-upload__hint">
          {zh ? "PNG / JPG / WebP · 建议 16:9（2752×1536）· 最大 32MB" : "PNG / JPG / WebP · 16:9 recommended · max 32MB"}
        </span>
        <input
          ref={inputRef}
          className="lo-scene-upload__input"
          type="file"
          accept={SCENE_IMAGE_ACCEPT}
          onChange={(e) => void onFiles(e.target.files)}
        />
      </div>

      {(error || notice) && (
        <div className={`lo-scene-msg${error ? " is-error" : " is-ok"}`}>
          {error ? <><LoIcon name="triangle-alert" size={12} /> {error}</> : <><LoIcon name="check-circle" size={12} /> {notice}</>}
        </div>
      )}
      {!persistAvailable && (
        <p className="lo-note">
          {zh
            ? "当前环境不支持本地持久化（IndexedDB 不可用），上传的图片只在本次运行内有效。"
            : "IndexedDB unavailable — uploads last only for this session."}
        </p>
      )}
      {aspectWarning && (
          <p className="lo-note">
            <LoIcon name="triangle-alert" size={11} /> {aspectWarning}
          </p>
        )}

      {/* 微调 + 对位预览 */}
      {showAdjust && (
        <>
          <SectionTitle
            hint={
              alignScore === null
                ? zh
                  ? "自动对位会按画面结构拟合，之后可再手动微调"
                  : "Auto align fits by image structure; fine-tune after"
                : `${zh ? "上次自动对位置信度" : "last auto-align"} ${Math.round(alignScore * 100)}%`
            }
          >
            {zh ? "画面微调" : "Image adjustment"}
          </SectionTitle>
          <div className="lo-align">
            <div className="lo-align__preview" data-role="align-preview">
              {currentImage ? (
                <img
                  className="lo-align__image"
                  src={currentImage}
                  alt=""
                  style={{
                    transform: `translate(${((adjust.x / CANVAS_W) * 100).toFixed(3)}%, ${((adjust.y / CANVAS_H) * 100).toFixed(3)}%) scale(${adjust.scale})`,
                  }}
                />
              ) : null}
              {PIXEL_ROOMS.map((room) => (
                <span
                  key={room.id}
                  className="lo-align__room"
                  style={{ ...rectToPercent(room.bounds, CANVAS_W, CANVAS_H), ["--lo-zone-token" as string]: `var(${room.token})` }}
                  title={zh ? room.label : room.labelEn}
                />
              ))}
            </div>
            <div className="lo-align__controls">
              <Field label={zh ? "缩放" : "Scale"}>
                <input
                  className="lo-range"
                  type="range"
                  min={SCENE_ADJUST_LIMITS.scale.min}
                  max={SCENE_ADJUST_LIMITS.scale.max}
                  step={SCENE_ADJUST_LIMITS.scale.step}
                  value={adjust.scale}
                  onChange={(e) => setAdjust({ scale: Number(e.target.value) })}
                />
                <span className="lo-range__value">{adjust.scale.toFixed(2)}×</span>
              </Field>
              <Field label={zh ? "左右" : "X"}>
                <input
                  className="lo-range"
                  type="range"
                  min={SCENE_ADJUST_LIMITS.offset.min}
                  max={SCENE_ADJUST_LIMITS.offset.max}
                  step={SCENE_ADJUST_LIMITS.offset.step}
                  value={adjust.x}
                  onChange={(e) => setAdjust({ x: Number(e.target.value) })}
                />
                <span className="lo-range__value">{Math.round(adjust.x)}</span>
              </Field>
              <Field label={zh ? "上下" : "Y"}>
                <input
                  className="lo-range"
                  type="range"
                  min={SCENE_ADJUST_LIMITS.offset.min}
                  max={SCENE_ADJUST_LIMITS.offset.max}
                  step={SCENE_ADJUST_LIMITS.offset.step}
                  value={adjust.y}
                  onChange={(e) => setAdjust({ y: Number(e.target.value) })}
                />
                <span className="lo-range__value">{Math.round(adjust.y)}</span>
              </Field>
            </div>
          </div>
          <div className="lo-switch-list">
            <Switch
              checked={settings.showAlignGuides}
              onChange={(v) => update({ showAlignGuides: v })}
              label={zh ? "在场景里显示对位参考线" : "Show alignment guides in scene"}
            />
          </div>
          <div className="lo-settings__actions">
            <button
              className="lo-btn lo-btn--primary"
              onClick={() => void autoAlign()}
              disabled={aligning}
              title={zh ? "按画面结构自动缩放到与内置房间布局最贴合的位置（上传后也会自动跑一次）" : "Auto-fit the image to the built-in room layout (also runs on upload)"}
            >
              <LoIcon name="sparkles" size={12} />{" "}
              {aligning ? (zh ? "正在对位…" : "Aligning…") : zh ? "自动对位" : "Auto align"}
            </button>
            <button
              className="lo-btn"
              onClick={() => {
                setTab("scene");
                setEditingLayout(true);
              }}
              title={zh ? "跳到「场景」视图，直接在场景上拖动房间框 / 走道节点" : "Open the scene view and drag rooms/nodes on the scene"}
            >
              {zh ? "手动对位编辑器" : "Manual alignment"}
            </button>
            <button className="lo-btn" onClick={() => update({ sceneImageAdjust: { scale: 1, x: 0, y: 0 } })}>
              {zh ? "重置微调" : "Reset adjustment"}
            </button>
            {(overriddenRooms > 0 || overriddenNodes > 0) && (
              <button
                className="lo-btn"
                onClick={resetLayout}
                title={zh ? "清除当前场景图的房间/走道对位调整" : "Clear room/node alignment for this image"}
              >
                {zh ? `重置对位（${overriddenRooms} 房间 / ${overriddenNodes} 节点）` : `Reset alignment (${overriddenRooms}/${overriddenNodes})`}
              </button>
            )}
            {customScene && (
              <button
                className="lo-btn lo-btn--danger"
                onClick={() => void clearCustomSceneImage()}
                disabled={busy}
                title={zh ? "删除已上传的图片并回到内置场景" : "Delete the upload and go back to a built-in scene"}
              >
                {zh ? "删除我的上传" : "Delete upload"}
              </button>
            )}
          </div>
        </>
      )}

      <p className="lo-note">
        {zh
          ? `图片会铺满 ${formatDimensions(CANVAS_W, CANVAS_H)} 的场景画布，角色、岗位标签与点击热区保持内置布局不变；上传的图片保存在本机（IndexedDB），不会写入宿主数据。`
          : `The image fills the ${formatDimensions(CANVAS_W, CANVAS_H)} canvas; actor positions and zone hitboxes stay unchanged. Uploads are stored locally (IndexedDB).`}
      </p>
      <p className="lo-note">
        {zh
          ? "画面和布局对不上？点上面的「打开对位编辑器」，在场景里把房间框拖到图里的房间上、把圆点拖到走道上，角色就会按新位置走动（按场景图分别保存）。"
          : "Misaligned? Open the alignment editor and drag the room boxes / waypoint dots onto the image; positions are saved per scene image."}
      </p>
      <p className="lo-note">
        {zh ? "生成新场景图的提示词：" : "Prompt for new scene art: "}
        <code>docs/art-prompts/01-图书馆场景.md</code>
      </p>
    </Card>
  );
}
