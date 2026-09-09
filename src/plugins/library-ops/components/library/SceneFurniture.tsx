/**
 * SceneFurniture —— 图书馆家具（等距矢量绘制）。
 *
 * 参考 ClawLibrary 的 `mid_props` / `fg_occluder` 分层与 lobster-pet 迷你办公室
 * 的像素家具：这里用等距立方体（`iso.ts` 的 `isoBox`）+ 细节件把书架、长桌、
 * 终端、柜台、绿植、台灯、地毯、台阶画成有体积的矢量家具，替代早期的文字字形
 * 占位（▤ ▭ ❦）。
 *
 * 颜色：每个家具只声明一个语义令牌（`--lo-fx`），三个面由 `color-mix` 派生明暗，
 * 因此四套皮肤下都有正确的体积感，且全文件零硬编码色值。
 */

import { memo } from "react";
import type { LibraryDecor } from "../../types";
import { FURNITURE_SIZE, isoBox, tileCenter, type IsoBox } from "./iso";

function faces(box: IsoBox) {
  return (
    <>
      <polygon points={box.south} className="lo-fx-face lo-fx-face--south" />
      <polygon points={box.east} className="lo-fx-face lo-fx-face--east" />
      <polygon points={box.top} className="lo-fx-face lo-fx-face--top" />
    </>
  );
}

function Bookshelf({ box, tile }: { box: IsoBox; tile: { col: number; row: number } }) {
  // 书脊：沿东侧面铺 6 格
  const spines = Array.from({ length: 6 }, (_, i) => {
    const p = tileCenter(tile.col + 1.5, tile.row + 0.5);
    const x = p.x - 34 + i * 12;
    const y = p.y + 4 - i * 6;
    return { x, y, h: 16 + ((i * 7) % 10), key: i };
  });
  return (
    <>
      {faces(box)}
      <g className="lo-fx-detail">
        {spines.map((s) => (
          <rect key={s.key} x={s.x} y={s.y - s.h} width={8} height={s.h} rx={1} className="lo-fx-book" />
        ))}
      </g>
    </>
  );
}

function Table({ box }: { box: IsoBox }) {
  return (
    <>
      {faces(box)}
      <polygon points={box.top} className="lo-fx-face lo-fx-face--slab" />
    </>
  );
}

function Terminal({ box }: { box: IsoBox }) {
  const c = box.topCenter;
  const monH = 20;
  const monW = 22;
  return (
    <>
      {faces(box)}
      {/* 显示器：立在桌面上的竖直面板 */}
      <polygon
        points={`${c.x - monW / 2},${c.y - monH} ${c.x + monW / 2},${c.y - monH} ${c.x + monW / 2},${c.y} ${c.x - monW / 2},${c.y}`}
        className="lo-fx-screen"
      />
      {/* 键盘 */}
      <polygon
        points={`${c.x - 11},${c.y + 5} ${c.x + 11},${c.y + 5} ${c.x + 14},${c.y + 11} ${c.x - 14},${c.y + 11}`}
        className="lo-fx-keyboard"
      />
    </>
  );
}

function Counter({ box }: { box: IsoBox }) {
  return (
    <>
      {faces(box)}
      <polygon points={box.top} className="lo-fx-face lo-fx-face--slab" />
    </>
  );
}

function Plant({ box, tile }: { box: IsoBox; tile: { col: number; row: number } }) {
  const c = tileCenter(tile.col + 0.5, tile.row + 0.5);
  const leaves = [
    { dx: 0, dy: -26, r: 12 },
    { dx: -9, dy: -16, r: 9 },
    { dx: 9, dy: -18, r: 10 },
    { dx: -4, dy: -34, r: 8 },
    { dx: 6, dy: -32, r: 7 },
  ];
  return (
    <>
      {faces(box)}
      <g className="lo-fx-leaf">
        {leaves.map((l, i) => (
          <circle key={i} cx={c.x + l.dx} cy={c.y - 18 + l.dy} r={l.r} />
        ))}
      </g>
    </>
  );
}

function Lamp({ tile }: { tile: { col: number; row: number } }) {
  const c = tileCenter(tile.col + 0.5, tile.row + 0.5);
  return (
    <>
      <ellipse cx={c.x} cy={c.y} rx={26} ry={13} className="lo-fx-lamp-glow" />
      <rect x={c.x - 1.5} y={c.y - 40} width={3} height={40} className="lo-fx-lamp-pole" />
      <ellipse cx={c.x} cy={c.y - 42} rx={9} ry={5} className="lo-fx-lamp-head" />
    </>
  );
}

function Carpet({ tile, span = 3 }: { tile: { col: number; row: number }; span?: number }) {
  const a = isoBox(tile.col, tile.row, span, span, 0);
  return <polygon points={a.top} className="lo-fx-carpet" />;
}

function Stairs({ box }: { box: IsoBox }) {
  const x1 = box.baseCenter.x;
  const y1 = box.baseCenter.y;
  const steps = [0, 1, 2].map((i) => ({
    x: x1 - 20 + i * 6,
    y: y1 - 4 - i * 8,
    w: 40 - i * 12,
    h: 10,
    key: i,
  }));
  return (
    <>
      {faces(box)}
      <g className="lo-fx-stairs">
        {steps.map((s) => (
          <rect key={s.key} x={s.x} y={s.y} width={s.w} height={s.h} rx={1} />
        ))}
      </g>
    </>
  );
}

export interface SceneFurnitureProps {
  decor: LibraryDecor;
  index: number;
}

export const SceneFurniture = memo(function SceneFurniture({ decor, index }: SceneFurnitureProps) {
  const size = FURNITURE_SIZE[decor.kind];
  const w = decor.span && decor.kind !== "carpet" ? decor.span : size.w;
  const box = isoBox(decor.tile.col, decor.tile.row, w, size.d, size.h);
  const token = decor.token ?? size.token;

  let body: React.ReactNode;
  switch (decor.kind) {
    case "bookshelf":
      body = <Bookshelf box={box} tile={decor.tile} />;
      break;
    case "table":
      body = <Table box={box} />;
      break;
    case "terminal":
      body = <Terminal box={box} />;
      break;
    case "counter":
      body = <Counter box={box} />;
      break;
    case "plant":
      body = <Plant box={box} tile={decor.tile} />;
      break;
    case "lamp":
      body = <Lamp tile={decor.tile} />;
      break;
    case "carpet":
      body = <Carpet tile={decor.tile} span={decor.span ?? 3} />;
      break;
    case "stairs":
      body = <Stairs box={box} />;
      break;
    default:
      body = <Table box={box} />;
  }

  return (
    <g
      className={`lo-fx lo-fx--${decor.kind}`}
      style={{ ["--lo-fx" as string]: `var(${token})` }}
      data-fx-index={index}
      pointerEvents="none"
    >
      {body}
    </g>
  );
});
