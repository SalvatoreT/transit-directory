import type { TrmnlDeparture, TrmnlStopData } from "./data";

const CSS = "https://trmnl.com/css/latest/plugins.css";
const JS = "https://trmnl.com/css/latest/plugins.js";

function delayLabelClass(delayText: string): string {
  if (delayText === "On Time") return " label--success";
  if (delayText.includes("late")) return " label--error";
  if (delayText.includes("early")) return " label--warning";
  return "";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface ScreenSize {
  width: number;
  height: number;
}

const SCREEN_OG: ScreenSize = { width: 800, height: 480 };
const SCREEN_X: ScreenSize = { width: 1872, height: 1404 };

function page(
  viewClass: string,
  inner: string,
  stopName: string,
  count: number,
  screen: ScreenSize = SCREEN_OG,
): string {
  const s = (px: number) => Math.round(px * (screen.width / SCREEN_OG.width));
  const sizeOverride =
    screen === SCREEN_OG
      ? ""
      : `\n  <style>:root {
    --screen-w: ${screen.width}px;
    --screen-h: ${screen.height}px;
    --gap-xsmall: ${s(5)}px;
    --gap-small: ${s(7)}px;
    --gap: ${s(10)}px;
    --gap-medium: ${s(16)}px;
    --gap-large: ${s(20)}px;
    --gap-xlarge: ${s(30)}px;
    --gap-xxlarge: ${s(40)}px;
    --title-font-size: ${s(26)}px;
    --title-small-font-size: ${s(16)}px;
    --title-large-font-size: ${s(30)}px;
    --title-xlarge-font-size: ${s(35)}px;
    --title-xxlarge-font-size: ${s(40)}px;
    --label-font-size: ${s(16)}px;
    --label-small-font-size: ${s(16)}px;
    --label-large-font-size: ${s(21)}px;
    --label-xlarge-font-size: ${s(26)}px;
    --label-xxlarge-font-size: ${s(30)}px;
    --description-font-size: ${s(16)}px;
    --description-large-font-size: ${s(16)}px;
    --description-xlarge-font-size: ${s(21)}px;
    --item-meta-width: ${s(10)}px;
    --item-index-font-size: ${s(16)}px;
    --title-bar-font-size: ${s(16)}px;
    --list-gap-small: ${s(8)}px;
    --list-gap-large: ${s(16)}px;
  }</style>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${CSS}"/>
  <script type="text/javascript" src="${JS}"></script>${sizeOverride}
</head>
<body class="environment trmnl">
  <div class="screen">
    <div class="view ${viewClass}">
      <div class="layout layout--col">
        ${inner}
      </div>
      <div class="title_bar">
        <img class="image" src="https://trmnl.com/images/plugins/trmnl--render.svg"/>
        <span class="title">${esc(stopName)}</span>
        <span class="instance">${count} departures</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function noDepartures(msg = "No upcoming departures"): string {
  return `<div class="layout layout--col layout--center">
    <span class="title">${msg}</span>
  </div>`;
}

function delayLabel(dep: TrmnlDeparture): string {
  if (dep.delayText === "Sched.") return "";
  return `<span class="label${delayLabelClass(dep.delayText)}" style="white-space: nowrap; display: inline-block; font-size: calc(var(--title-font-size) * 0.55);">${esc(dep.delayText)}</span>`;
}

function departureItem(dep: TrmnlDeparture, emphasis: number = 3): string {
  return `<div class="item item--emphasis-${emphasis}">
    <div class="meta" style="min-width: 5em; width: auto; background: transparent; text-align: center; flex-direction: column;"><span class="title" style="font-family: monospace; display: block;">${esc(dep.time)}</span>${delayLabel(dep)}</div>
    <div class="content">
      <span class="title">${esc(dep.routeName)}</span>
      <span class="label label--underline">${esc(dep.headsign)}</span>
    </div>
  </div>`;
}

function departureItemCompact(
  dep: TrmnlDeparture,
  emphasis: number = 2,
): string {
  return `<div class="item item--emphasis-${emphasis}">
    <div class="meta" style="min-width: 5em; width: auto; background: transparent; text-align: center; flex-direction: column;"><span class="title" style="font-family: monospace; display: block;">${esc(dep.time)}</span>${delayLabel(dep)}</div>
    <div class="content">
      <span class="title">${esc(dep.routeName)}</span>
      <span class="label">${esc(dep.headsign)}</span>
    </div>
  </div>`;
}

// ── Full (800x480 OG · 1872x1404 X) ─────────────────────────────────────────

export function renderFull(
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  const deps = data.departures.slice(0, 8);

  if (deps.length === 0) {
    return page(
      "view--full",
      noDepartures(),
      data.stopName,
      data.departureCount,
      screen,
    );
  }

  const items = deps.map((d) => departureItem(d)).join("\n    ");
  const rows = Math.ceil(deps.length / 2);
  const inner = `<div class="grid grid--cols-2 gap--small" style="grid-auto-flow: column; grid-template-rows: repeat(${rows}, auto);">
    ${items}
  </div>`;
  return page("view--full", inner, data.stopName, data.departureCount, screen);
}

// ── Half Horizontal (800x240 OG · 1872x702 X) ───────────────────────────────

export function renderHalfHorizontal(
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  const deps = data.departures.slice(0, 3);

  if (deps.length === 0) {
    return page(
      "view--half_horizontal",
      noDepartures(),
      data.stopName,
      data.departureCount,
      screen,
    );
  }

  const items = deps.map((d) => departureItemCompact(d)).join("\n    ");
  const rows = Math.ceil(deps.length / 2);
  const inner = `<div class="grid grid--cols-2 gap--small" style="grid-auto-flow: column; grid-template-rows: repeat(${rows}, auto);">
    ${items}
  </div>`;
  return page(
    "view--half_horizontal",
    inner,
    data.stopName,
    data.departureCount,
    screen,
  );
}

// ── Half Vertical (400x480 OG · 936x1404 X) ─────────────────────────────────

export function renderHalfVertical(
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  const deps = data.departures.slice(0, 5);

  if (deps.length === 0) {
    return page(
      "view--half_vertical",
      noDepartures(),
      data.stopName,
      data.departureCount,
      screen,
    );
  }

  const items = deps.map((d) => departureItem(d)).join("\n    ");
  const inner = `<div class="grid grid--cols-1 gap--small">
    ${items}
  </div>`;
  return page(
    "view--half_vertical",
    inner,
    data.stopName,
    data.departureCount,
    screen,
  );
}

// ── Quadrant (400x240 OG · 936x702 X) ───────────────────────────────────────

export function renderQuadrant(
  data: TrmnlStopData,
  screen: ScreenSize = SCREEN_OG,
): string {
  const [next, ...rest] = data.departures;
  const remaining = rest.slice(0, 2);

  let inner: string;

  if (!next) {
    inner = noDepartures("No departures");
  } else {
    const nextItem = departureItem(next);
    const restItems = remaining
      .map((d) => departureItemCompact(d))
      .join("\n    ");

    inner = `<div class="grid grid--cols-1 gap--small">
    ${nextItem}
    ${restItems}
  </div>`;
  }

  return page(
    "view--quadrant",
    inner,
    data.stopName,
    data.departureCount,
    screen,
  );
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export { SCREEN_OG, SCREEN_X };

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
