import type { TrmnlStopData } from "./data";

export interface ScreenSize {
  width: number;
  height: number;
}

export const SCREEN_OG: ScreenSize = { width: 800, height: 480 };
export const SCREEN_X: ScreenSize = { width: 1872, height: 1404 };

const LARGE_SCREEN_MIN_WIDTH = 1500;

function colsForWidth(width: number): number {
  return width >= LARGE_SCREEN_MIN_WIDTH ? 3 : 2;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface BrutalistOptions {
  viewport: ScreenSize;
  cols: number;
  baseTileH?: number;
  baseHeaderH?: number;
  showHeadsign?: boolean;
}

function renderBrutalist(data: TrmnlStopData, opts: BrutalistOptions): string {
  const {
    viewport,
    cols,
    baseTileH = 86,
    baseHeaderH = 48,
    showHeadsign = true,
  } = opts;

  const colWidth = viewport.width / cols;
  const s = Math.min(colWidth / 400, 1.6);
  const px = (p: number) => Math.round(p * s);

  const headerH = px(baseHeaderH);
  const tileH = px(baseTileH);
  const rowGap = Math.max(4, px(6));
  const colGap = Math.max(4, px(8));
  const sidePad = px(12);
  const topPad = px(8);

  const availH = viewport.height - headerH - topPad * 2;
  const fitRows = Math.max(1, Math.floor((availH + rowGap) / (tileH + rowGap)));
  const total = cols * fitRows;
  const deps = data.departures.slice(0, total);
  const isEmpty = data.departures.length === 0;

  const timeFontPx = px(showHeadsign ? 26 : 24);
  const routeFontPx = px(showHeadsign ? 22 : 18);
  const delayFontPx = px(showHeadsign ? 10 : 8);
  const headsignFontPx = px(13);
  const stopFontPx = px(showHeadsign ? 22 : 14);
  const countFontPx = px(showHeadsign ? 11 : 9);
  const timeMinW = px(showHeadsign ? 108 : 110);

  const styleBlock = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  width: ${viewport.width}px;
  height: ${viewport.height}px;
  overflow: hidden;
  background: #fff;
  color: #000;
  font-family: "Helvetica Neue Condensed", "Arial Narrow", Impact, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  position: relative;
}
.bt-header {
  height: ${headerH}px;
  background: #000;
  color: #fff;
  padding: 0 ${px(16)}px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${px(12)}px;
}
.bt-stop {
  flex: 1;
  min-width: 0;
  font-weight: 900;
  font-size: ${stopFontPx}px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bt-count {
  flex-shrink: 0;
  font-size: ${countFontPx}px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
}
.bt-grid {
  display: grid;
  grid-template-columns: repeat(${cols}, minmax(0, 1fr));
  gap: ${rowGap}px ${colGap}px;
  padding: ${topPad}px ${sidePad}px;
}
.bt-tile {
  display: flex;
  border: ${px(4)}px solid #000;
  background: #fff;
  height: ${tileH}px;
  min-width: 0;
  overflow: hidden;
}
.bt-time {
  background: #000;
  color: #fff;
  padding: ${px(6)}px ${px(12)}px;
  min-width: ${timeMinW}px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
}
.bt-time-text {
  font-weight: 900;
  font-size: ${timeFontPx}px;
  line-height: 0.95;
  letter-spacing: -0.03em;
}
.bt-delay {
  font-size: ${delayFontPx}px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  opacity: 0.85;
  margin-top: ${px(2)}px;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bt-content {
  flex: 1;
  padding: ${px(6)}px ${px(12)}px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  border-left: ${px(4)}px solid #000;
}
.bt-route {
  font-weight: 900;
  font-size: ${routeFontPx}px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bt-headsign {
  font-size: ${headsignFontPx}px;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  margin-top: ${px(6)}px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bt-empty {
  border: ${px(4)}px dashed #ccc;
  height: ${tileH}px;
}
.bt-no-deps {
  position: absolute;
  top: ${headerH}px;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
  font-size: ${px(showHeadsign ? 28 : 18)}px;
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: #000;
  pointer-events: none;
}
`;

  const header = `<div class="bt-header"><div class="bt-stop">${esc(
    data.stopName,
  )}</div><div class="bt-count">// ${data.departureCount} OUT</div></div>`;

  const tiles = Array.from({ length: total }, (_, i) => {
    const d = deps[i];
    if (!d) return `<div class="bt-empty"></div>`;
    const delay =
      d.delayText && d.delayText !== "Sched."
        ? `<div class="bt-delay">${esc(d.delayText)}</div>`
        : "";
    const headsign = showHeadsign
      ? `<div class="bt-headsign">↦ ${esc(d.headsign)}</div>`
      : "";
    return `<div class="bt-tile"><div class="bt-time"><div class="bt-time-text">${esc(
      d.time,
    )}</div>${delay}</div><div class="bt-content"><div class="bt-route">${esc(
      d.routeName,
    )}</div>${headsign}</div></div>`;
  }).join("");

  const grid = `<div class="bt-grid">${tiles}</div>`;
  const emptyOverlay = isEmpty
    ? `<div class="bt-no-deps">No departures</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>${styleBlock}</style>
</head>
<body>${header}${grid}${emptyOverlay}</body>
</html>`;
}

export function renderFull(
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  return renderBrutalist(data, {
    viewport: { width: screen.width, height: screen.height },
    cols: colsForWidth(screen.width),
  });
}

export function renderHalfHorizontal(
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  return renderBrutalist(data, {
    viewport: {
      width: screen.width,
      height: Math.floor(screen.height / 2),
    },
    cols: colsForWidth(screen.width),
    baseTileH: 70,
    baseHeaderH: 32,
    showHeadsign: false,
  });
}

export function renderHalfVertical(
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  return renderBrutalist(data, {
    viewport: {
      width: Math.floor(screen.width / 2),
      height: screen.height,
    },
    cols: 1,
  });
}

export function renderQuadrant(
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  return renderBrutalist(data, {
    viewport: {
      width: Math.floor(screen.width / 2),
      height: Math.floor(screen.height / 2),
    },
    cols: 1,
    baseTileH: 60,
    baseHeaderH: 28,
    showHeadsign: false,
  });
}

export function renderLayout(
  layout: string,
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  switch (layout) {
    case "full":
      return renderFull(data, screen);
    case "half_horizontal":
      return renderHalfHorizontal(data, screen);
    case "half_vertical":
      return renderHalfVertical(data, screen);
    case "quadrant":
      return renderQuadrant(data, screen);
    default:
      return renderFull(data, screen);
  }
}
