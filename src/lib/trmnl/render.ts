import type { TrmnlDeparture, TrmnlStopData } from "./data";

const CSS = "https://usetrmnl.com/css/latest/plugins.css";
const JS = "https://usetrmnl.com/css/latest/plugins.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(
  viewClass: string,
  inner: string,
  stopName: string,
  count: number,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${CSS}"/>
  <script type="text/javascript" src="${JS}"></script>
  <style>
    .dep-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
      width: 100%;
    }
    @media (min-width: 700px) {
      .dep-grid--2col { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body class="environment trmnl">
  <div class="screen">
    <div class="view ${viewClass}">
      <div class="layout layout--col">
        ${inner}
      </div>
      <div class="title_bar">
        <img class="image" src="https://usetrmnl.com/images/plugins/trmnl--render.svg"/>
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

function departureItem(dep: TrmnlDeparture, emphasis: number = 1): string {
  const delayPart =
    dep.delayText !== "Sched."
      ? ` <span class="label label--small">${esc(dep.delayText)}</span>`
      : "";
  return `<div class="item item--emphasis-${emphasis}">
    <div class="meta"></div>
    <div class="content">
      <span class="title title--small">${esc(dep.routeName)} &mdash; ${esc(dep.time)}${delayPart}</span>
      <span class="label label--small label--underline">${esc(dep.headsign)}</span>
    </div>
  </div>`;
}

function departureItemCompact(
  dep: TrmnlDeparture,
  emphasis: number = 1,
): string {
  const delay = dep.delayText !== "Sched." ? ` (${dep.delayText})` : "";
  return `<div class="item item--emphasis-${emphasis}">
    <div class="meta"></div>
    <div class="content">
      <span class="title title--small">${esc(dep.routeName)} &mdash; ${esc(dep.time)}${esc(delay)}</span>
      <span class="label label--small">${esc(dep.headsign)}</span>
    </div>
  </div>`;
}

// ── Full (800x480 OG · 1872x1404 X) ─────────────────────────────────────────

export function renderFull(data: TrmnlStopData): string {
  const deps = data.departures.slice(0, 12);

  if (deps.length === 0) {
    return page(
      "view--full",
      noDepartures(),
      data.stopName,
      data.departureCount,
    );
  }

  const items = deps.map((d) => departureItem(d, 1)).join("\n    ");
  const inner = `<div class="dep-grid dep-grid--2col">
    ${items}
  </div>`;
  return page("view--full", inner, data.stopName, data.departureCount);
}

// ── Half Horizontal (800x240 OG · 1872x702 X) ───────────────────────────────

export function renderHalfHorizontal(data: TrmnlStopData): string {
  const deps = data.departures.slice(0, 8);

  if (deps.length === 0) {
    return page(
      "view--half_horizontal",
      noDepartures(),
      data.stopName,
      data.departureCount,
    );
  }

  const items = deps.map((d) => departureItemCompact(d, 1)).join("\n    ");
  const inner = `<div class="dep-grid dep-grid--2col">
    ${items}
  </div>`;
  return page(
    "view--half_horizontal",
    inner,
    data.stopName,
    data.departureCount,
  );
}

// ── Half Vertical (400x480 OG · 936x1404 X) ─────────────────────────────────

export function renderHalfVertical(data: TrmnlStopData): string {
  const deps = data.departures.slice(0, 10);

  if (deps.length === 0) {
    return page(
      "view--half_vertical",
      noDepartures(),
      data.stopName,
      data.departureCount,
    );
  }

  const items = deps.map((d) => departureItem(d, 1)).join("\n    ");
  const inner = `<div class="dep-grid">
    ${items}
  </div>`;
  return page("view--half_vertical", inner, data.stopName, data.departureCount);
}

// ── Quadrant (400x240 OG · 936x702 X) ───────────────────────────────────────

export function renderQuadrant(data: TrmnlStopData): string {
  const [next, ...rest] = data.departures;
  const remaining = rest.slice(0, 5);

  let inner: string;

  if (!next) {
    inner = noDepartures("No departures");
  } else {
    const nextItem = departureItem(next, 3);
    const restItems = remaining
      .map((d) => departureItemCompact(d, 1))
      .join("\n    ");

    inner = `<div class="dep-grid">
    ${nextItem}
    ${restItems}
  </div>`;
  }

  return page("view--quadrant", inner, data.stopName, data.departureCount);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export function renderLayout(layout: string, data: TrmnlStopData): string {
  switch (layout) {
    case "full":
      return renderFull(data);
    case "half_horizontal":
      return renderHalfHorizontal(data);
    case "half_vertical":
      return renderHalfVertical(data);
    case "quadrant":
      return renderQuadrant(data);
    default:
      return renderFull(data);
  }
}
