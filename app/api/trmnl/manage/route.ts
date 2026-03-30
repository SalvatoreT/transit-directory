import { env } from "cloudflare:workers";
import { getAgencies } from "../../../../src/db";
import type { TrmnlUserConfig } from "../../../../src/lib/trmnl/data";

export const dynamic = "force-dynamic";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const uuid = url.searchParams.get("uuid");
  if (!uuid) {
    return new Response("Missing uuid", { status: 400 });
  }

  const kv = (env as any).TRMNL_USERS as KVNamespace;
  const raw = await kv.get(`user:${uuid}`);
  const config: TrmnlUserConfig = raw
    ? JSON.parse(raw)
    : { agency_id: "", stop_id: "", display_name: "My Stop", access_token: "" };

  const saved = url.searchParams.get("saved") === "1";

  const agencies = await getAgencies();
  const agencyOptions = agencies
    .sort((a, b) => a.agency_name.localeCompare(b.agency_name))
    .map(
      (a) =>
        `<option value="${esc(a.agency_id)}"${a.agency_id === config.agency_id ? " selected" : ""}>${esc(a.agency_name)}</option>`,
    )
    .join("\n      ");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TRMNL Transit Settings</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 24px; }
    label { display: block; font-weight: 500; margin-bottom: 4px; font-size: 0.9em; }
    input, select { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 0.9em; margin-bottom: 16px; box-sizing: border-box; background: #fff; }
    button { background: #000; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; font-size: 0.9em; cursor: pointer; }
    button:hover { background: #333; }
    .success { background: #e6f9e6; border: 1px solid #4caf50; padding: 10px; border-radius: 6px; margin-bottom: 16px; font-size: 0.9em; }
    small { color: #666; display: block; margin-top: -12px; margin-bottom: 16px; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <h1>Transit Stop Settings</h1>
  ${saved ? '<div class="success">Settings saved!</div>' : ""}
  <form method="POST" action="/api/trmnl/manage">
    <input type="hidden" name="uuid" value="${esc(uuid)}"/>
    <label for="agency_id">Agency</label>
    <select id="agency_id" name="agency_id" required>
      <option value="">Select an agency...</option>
      ${agencyOptions}
    </select>
    <small>Select your transit agency.</small>
    <label for="stop_id">Stop</label>
    <input type="text" id="stop_id" name="stop_id" list="stop_list" value="${esc(config.stop_id)}" placeholder="Type to search for a stop..." required/>
    <datalist id="stop_list"></datalist>
    <small>Type to search for your stop.</small>
    <label for="display_name">Display Name</label>
    <input type="text" id="display_name" name="display_name" value="${esc(config.display_name)}" placeholder="My Stop"/>
    <small>Custom label shown on your TRMNL screen.</small>
    <button type="submit">Save</button>
  </form>
  ${config.plugin_setting_id ? `<p style="margin-top:24px;"><a href="https://trmnl.com/plugin_settings/${config.plugin_setting_id}?force_refresh=true">&larr; Back to TRMNL</a></p>` : ""}
  <script>
    function loadStops(agencyId) {
      var datalist = document.getElementById('stop_list');
      datalist.innerHTML = '';
      if (!agencyId) return;
      fetch('/api/trmnl/stops?agency_id=' + encodeURIComponent(agencyId))
        .then(function(r) { return r.json(); })
        .then(function(stops) {
          stops.forEach(function(s) {
            var opt = document.createElement('option');
            opt.value = s.stop_id;
            opt.textContent = s.stop_name + ' (' + s.stop_id + ')';
            datalist.appendChild(opt);
          });
        });
    }
    document.getElementById('agency_id').addEventListener('change', function() {
      document.getElementById('stop_id').value = '';
      loadStops(this.value);
    });
    var initialAgency = document.getElementById('agency_id').value;
    if (initialAgency) loadStops(initialAgency);
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const uuid = form.get("uuid") as string | null;
  if (!uuid) {
    return new Response("Missing uuid", { status: 400 });
  }

  const kv = (env as any).TRMNL_USERS as KVNamespace;
  const raw = await kv.get(`user:${uuid}`);
  const config: TrmnlUserConfig = raw
    ? JSON.parse(raw)
    : { agency_id: "", stop_id: "", display_name: "My Stop", access_token: "" };

  config.agency_id = (form.get("agency_id") as string) || "";
  config.stop_id = (form.get("stop_id") as string) || "";
  config.display_name = (form.get("display_name") as string) || "My Stop";

  await kv.put(`user:${uuid}`, JSON.stringify(config));

  return Response.redirect(
    new URL(`/api/trmnl/manage?uuid=${uuid}&saved=1`, request.url).toString(),
  );
}
