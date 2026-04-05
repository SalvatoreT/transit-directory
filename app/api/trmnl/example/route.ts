import type { TrmnlStopData } from "../../../../src/lib/trmnl/data";
import {
  renderFull,
  renderHalfHorizontal,
  renderHalfVertical,
  renderQuadrant,
  SCREEN_X,
} from "../../../../src/lib/trmnl/render";

const SAMPLE_DATA: TrmnlStopData = {
  stopName: "Caltrain - San Francisco",
  stopId: "70012",
  agencyName: "Caltrain",
  departureCount: 12,
  lastUpdated: new Date().toISOString(),
  departures: [
    {
      routeName: "Local",
      headsign: "San Jose Diridon",
      time: "15:15",
      delayText: "On Time",
    },
    {
      routeName: "Limited",
      headsign: "Tamien",
      time: "15:32",
      delayText: "+4 min late",
    },
    {
      routeName: "Express",
      headsign: "San Jose Diridon",
      time: "15:50",
      delayText: "Sched.",
    },
    {
      routeName: "Local",
      headsign: "San Jose Diridon",
      time: "16:15",
      delayText: "On Time",
    },
    {
      routeName: "Limited",
      headsign: "Gilroy",
      time: "16:32",
      delayText: "-1 min early",
    },
    {
      routeName: "Local",
      headsign: "San Jose Diridon",
      time: "16:47",
      delayText: "Sched.",
    },
    {
      routeName: "Express",
      headsign: "San Jose Diridon",
      time: "17:05",
      delayText: "+2 min late",
    },
    {
      routeName: "Local",
      headsign: "Tamien",
      time: "17:15",
      delayText: "On Time",
    },
    {
      routeName: "Limited",
      headsign: "San Jose Diridon",
      time: "17:32",
      delayText: "Sched.",
    },
    {
      routeName: "Express",
      headsign: "Gilroy",
      time: "17:50",
      delayText: "On Time",
    },
    {
      routeName: "Local",
      headsign: "San Jose Diridon",
      time: "18:15",
      delayText: "+1 min late",
    },
    {
      routeName: "Limited",
      headsign: "Tamien",
      time: "18:32",
      delayText: "On Time",
    },
  ],
};

function layoutIframe(
  title: string,
  html: string,
  width: number,
  height: number,
  scale: number = 1,
): string {
  const encoded = html
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const displayW = Math.round(width * scale);
  const displayH = Math.round(height * scale);
  return `
    <div style="margin-bottom: 48px;">
      <h2 style="font-size: 1.1rem; margin-bottom: 8px;">${title} <span style="color:#888; font-weight:normal;">(${width}&times;${height}${scale !== 1 ? `, shown at ${Math.round(scale * 100)}%` : ""})</span></h2>
      <div style="width: ${displayW}px; height: ${displayH}px; overflow: hidden; border: 2px solid #ccc; border-radius: 8px;">
        <iframe
          srcdoc="${encoded}"
          width="${width}"
          height="${height}"
          style="transform: scale(${scale}); transform-origin: top left; border: none; background: #fff;"
        ></iframe>
      </div>
    </div>`;
}

export async function GET() {
  const fullHtml = renderFull(SAMPLE_DATA);
  const halfHHtml = renderHalfHorizontal(SAMPLE_DATA);
  const halfVHtml = renderHalfVertical(SAMPLE_DATA);
  const quadHtml = renderQuadrant(SAMPLE_DATA);

  const fullXHtml = renderFull(SAMPLE_DATA, SCREEN_X);
  const halfHXHtml = renderHalfHorizontal(SAMPLE_DATA, SCREEN_X);
  const halfVXHtml = renderHalfVertical(SAMPLE_DATA, SCREEN_X);
  const quadXHtml = renderQuadrant(SAMPLE_DATA, SCREEN_X);

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TRMNL Transit Plugin - Example Layouts</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 1920px;
      margin: 40px auto;
      padding: 0 20px;
      color: #1a1a1a;
      background: #f5f5f5;
    }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    h2 { font-family: system-ui, sans-serif; }
    p.subtitle { color: #666; margin-top: 0; margin-bottom: 32px; }
    .device-section { margin-bottom: 64px; }
    .device-section h2.device-title {
      font-size: 1.3rem;
      border-bottom: 2px solid #ddd;
      padding-bottom: 8px;
      margin-bottom: 24px;
    }
    .device-badge {
      display: inline-block;
      font-size: 0.75rem;
      background: #333;
      color: #fff;
      padding: 2px 8px;
      border-radius: 4px;
      margin-left: 8px;
      vertical-align: middle;
      font-weight: normal;
    }
  </style>
</head>
<body>
  <h1>TRMNL Transit Plugin</h1>
  <p class="subtitle">Example layouts showing upcoming departures for <strong>${SAMPLE_DATA.stopName}</strong></p>

  <div class="device-section">
    <h2 class="device-title">TRMNL OG <span class="device-badge">800&times;480 &middot; B&amp;W</span></h2>
    ${layoutIframe("Full", fullHtml, 800, 480)}
    ${layoutIframe("Half Horizontal", halfHHtml, 800, 240)}
    ${layoutIframe("Half Vertical", halfVHtml, 400, 480)}
    ${layoutIframe("Quadrant", quadHtml, 400, 240)}
  </div>

  <div class="device-section">
    <h2 class="device-title">TRMNL X <span class="device-badge">1872&times;1404 &middot; 16-level Grayscale</span></h2>
    ${layoutIframe("Full", fullXHtml, 1872, 1404, 0.75)}
    ${layoutIframe("Half Horizontal", halfHXHtml, 1872, 702, 0.75)}
    ${layoutIframe("Half Vertical", halfVXHtml, 936, 1404, 0.75)}
    ${layoutIframe("Quadrant", quadXHtml, 936, 702, 0.75)}
  </div>
</body>
</html>`;

  return new Response(page, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
