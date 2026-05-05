import type { TrmnlStopData } from "../../../../src/lib/trmnl/data";
import {
  DEMO_STYLES,
  SCREEN_OG as DEMO_SCREEN_OG,
  SCREEN_X as DEMO_SCREEN_X,
} from "../../../../src/lib/trmnl/demoStyles";
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
  departureCount: 24,
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
    {
      routeName: "Express",
      headsign: "San Jose Diridon",
      time: "18:50",
      delayText: "Sched.",
    },
    {
      routeName: "Local",
      headsign: "San Jose Diridon",
      time: "19:15",
      delayText: "On Time",
    },
    {
      routeName: "Limited",
      headsign: "Gilroy",
      time: "19:32",
      delayText: "+2 min late",
    },
    {
      routeName: "Local",
      headsign: "Tamien",
      time: "19:47",
      delayText: "On Time",
    },
    {
      routeName: "Express",
      headsign: "San Jose Diridon",
      time: "20:05",
      delayText: "Sched.",
    },
    {
      routeName: "Local",
      headsign: "San Jose Diridon",
      time: "20:15",
      delayText: "-1 min early",
    },
    {
      routeName: "Limited",
      headsign: "San Jose Diridon",
      time: "20:32",
      delayText: "On Time",
    },
    {
      routeName: "Express",
      headsign: "Gilroy",
      time: "20:50",
      delayText: "Sched.",
    },
    {
      routeName: "Local",
      headsign: "San Jose Diridon",
      time: "21:15",
      delayText: "+3 min late",
    },
    {
      routeName: "Limited",
      headsign: "Tamien",
      time: "21:32",
      delayText: "On Time",
    },
    {
      routeName: "Express",
      headsign: "San Jose Diridon",
      time: "21:50",
      delayText: "Sched.",
    },
    {
      routeName: "Local",
      headsign: "San Jose Diridon",
      time: "22:15",
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

// Use a fixed reference time so countdown styles render predictably in the
// demo. SAMPLE_DATA's first departure is at 15:15.
const NOW_HHMM = "15:00";

export async function GET() {
  const styleSection = DEMO_STYLES.map(
    ({ id, name, description, render }) => `
    <div class="style-card">
      <h3 class="style-title">${name} <code class="style-id">${id}</code></h3>
      <p class="style-desc">${description}</p>
      ${layoutIframe("OG (800x480)", render(SAMPLE_DATA, NOW_HHMM, DEMO_SCREEN_OG), DEMO_SCREEN_OG.width, DEMO_SCREEN_OG.height)}
      ${layoutIframe("TRMNL X (1872x1404)", render(SAMPLE_DATA, NOW_HHMM, DEMO_SCREEN_X), DEMO_SCREEN_X.width, DEMO_SCREEN_X.height, 0.5)}
    </div>`,
  ).join("\n");

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
    .style-card {
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 32px;
    }
    .style-title {
      font-size: 1.1rem;
      margin: 0 0 4px 0;
      display: flex;
      align-items: baseline;
      gap: 12px;
    }
    .style-id {
      font-size: 0.75rem;
      background: #eee;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: normal;
      color: #555;
    }
    .style-desc {
      color: #666;
      margin: 0 0 16px 0;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <h1>TRMNL Transit Plugin</h1>
  <p class="subtitle">Example layouts showing upcoming departures for <strong>${SAMPLE_DATA.stopName}</strong></p>

  <div class="device-section">
    <h2 class="device-title">Brutalist <span class="device-badge">Full layout &middot; OG &amp; X &middot; ignores TRMNL CSS</span></h2>
    <p class="subtitle">Custom HTML/CSS targeting e-ink. Two columns on OG, three on TRMNL X.</p>
    ${styleSection}
  </div>

  <div class="device-section">
    <h2 class="device-title">TRMNL OG <span class="device-badge">800&times;480 &middot; B&amp;W</span> <span style="font-size:0.85rem; color:#888; font-weight:normal;">(current production layout, for reference)</span></h2>
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
