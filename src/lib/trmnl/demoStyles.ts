// Experimental, demo-only departure layouts. Each renderer returns a complete
// HTML body for a TRMNL screen size, ignoring the TRMNL plugin CSS. Once a
// direction is chosen, the chosen approach can be folded back into
// src/lib/trmnl/render.ts for production.

import type { TrmnlStopData } from "./data";

interface ScreenSize {
  width: number;
  height: number;
}

export const SCREEN_OG: ScreenSize = { width: 800, height: 480 };
export const SCREEN_X: ScreenSize = { width: 1872, height: 1404 };

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function frame(content: string, bodyStyle: string, screen: ScreenSize): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { width: ${screen.width}px; height: ${screen.height}px; overflow: hidden;
         font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
         -webkit-font-smoothing: antialiased; ${bodyStyle} }
</style></head>
<body>${content}</body></html>`;
}

// Brutalist: chunky outlined tiles, heavy condensed all-caps type. Each
// departure is a tile pairing a black time block with a white content block.
// Multi-column responsive: 2 columns on OG, 3 on the larger TRMNL X.
function renderBrutalist(
  data: TrmnlStopData,
  _nowHHMM: string,
  screen: ScreenSize = SCREEN_OG,
): string {
  const s = screen.width / SCREEN_OG.width;
  const px = (p: number) => Math.round(p * s);
  const cols = screen.width >= 1500 ? 3 : 2;

  const headerH = px(48);
  const sidePad = px(12);
  const rowGap = px(6);
  const tileH = px(86);
  const availH = screen.height - headerH - px(8);
  const rows = Math.max(1, Math.floor((availH + rowGap) / (tileH + rowGap)));
  const total = cols * rows;
  const deps = data.departures.slice(0, total);

  const tile = (
    time: string,
    routeName: string,
    headsign: string,
    delayText: string,
  ) => `
      <div style="display:flex; border:${px(4)}px solid #000; background:#fff; height:${tileH}px;">
        <div style="background:#000; color:#fff; padding:${px(6)}px ${px(12)}px; min-width:${px(140)}px; display:flex; flex-direction:column; justify-content:center; align-items:flex-start;">
          <div style="font-family:'Helvetica Neue Condensed','Impact','Arial Narrow',sans-serif; font-weight:900; font-size:${px(34)}px; line-height:0.95; letter-spacing:-0.03em;">${esc(time)}</div>
          <div style="font-size:${px(10)}px; letter-spacing:0.2em; text-transform:uppercase; opacity:0.85; margin-top:${px(2)}px;">${esc(delayText)}</div>
        </div>
        <div style="flex:1; padding:${px(6)}px ${px(12)}px; display:flex; flex-direction:column; justify-content:center; min-width:0; border-left:${px(4)}px solid #000;">
          <div style="font-family:'Helvetica Neue Condensed','Impact','Arial Narrow',sans-serif; font-weight:900; font-size:${px(26)}px; text-transform:uppercase; letter-spacing:0.02em; line-height:1;">${esc(routeName)}</div>
          <div style="font-size:${px(13)}px; text-transform:uppercase; letter-spacing:0.18em; margin-top:${px(6)}px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">↦ ${esc(headsign)}</div>
        </div>
      </div>`;

  const tiles = Array.from({ length: total }, (_, i) => {
    const d = deps[i];
    if (!d) {
      return `<div style="border:${px(4)}px dashed #ccc; height:${tileH}px;"></div>`;
    }
    return tile(d.time, d.routeName, d.headsign, d.delayText);
  }).join("");

  const header = `<div style="padding:${px(10)}px ${px(16)}px; background:#000; color:#fff; display:flex; align-items:center; justify-content:space-between; height:${headerH}px;">
    <div style="font-family:'Helvetica Neue Condensed','Impact',sans-serif; font-size:${px(22)}px; font-weight:900; letter-spacing:0.06em; text-transform:uppercase;">${esc(data.stopName)}</div>
    <div style="font-size:${px(11)}px; letter-spacing:0.25em; text-transform:uppercase;">// ${data.departureCount} Out</div>
  </div>`;

  const grid = `<div style="display:grid; grid-template-columns: repeat(${cols}, 1fr); gap:${rowGap}px ${px(8)}px; padding:${px(8)}px ${sidePad}px;">${tiles}</div>`;

  return frame(header + grid, "background:#fff; color:#000;", screen);
}

export interface DemoStyle {
  id: string;
  name: string;
  description: string;
  render: (data: TrmnlStopData, nowHHMM: string, screen?: ScreenSize) => string;
}

export const DEMO_STYLES: DemoStyle[] = [
  {
    id: "brutalist",
    name: "Brutalist",
    description:
      "Heavy condensed all-caps type, thick outlined tiles. Two columns on OG, three on TRMNL X.",
    render: renderBrutalist,
  },
];
