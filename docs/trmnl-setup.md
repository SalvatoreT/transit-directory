# TRMNL Transit Plugin Setup

Guide for registering the transit directory's TRMNL integration as an official plugin in the [TRMNL marketplace](https://usetrmnl.com), following the same pattern as [trmnl-calendar](https://github.com/SalvatoreT/trmnl-calendar).

## Prerequisites

- The transit-directory Worker is deployed to Cloudflare (e.g. `https://transit-directory.salgorithm.workers.dev`)
- You have a [TRMNL developer account](https://trmnl.com)

## 1. Set up the KV namespace

The KV namespace `TRMNL_USERS` is already configured in `wrangler.jsonc`. Verify it exists:

```bash
yarn wrangler kv namespace list
```

You should see `transit-directory-trmnl-users` in the list. If not, create it:

```bash
yarn wrangler kv namespace create TRMNL_USERS
```

Then update the `id` in `wrangler.jsonc` under `kv_namespaces`.

## 2. Create the plugin on TRMNL

Go to [trmnl.com/plugins/my/new](https://trmnl.com/plugins/my/new) and fill in:

| Field                                | Value                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| **Name**                             | Transit                                                                        |
| **Description**                      | Upcoming departures for a transit stop                                         |
| **Category**                         | `travel`, `personal`                                                           |
| **Supported Refresh Interval**       | Every 15 mins                                                                  |
| **Installation URL**                 | `https://transit-directory.salgorithm.workers.dev/api/trmnl/install`           |
| **Installation Success Webhook URL** | `https://transit-directory.salgorithm.workers.dev/api/trmnl/webhook/install`   |
| **Plugin Management URL**            | `https://transit-directory.salgorithm.workers.dev/api/trmnl/manage`            |
| **Plugin Markup URL**                | `https://transit-directory.salgorithm.workers.dev/api/trmnl/markup`            |
| **Uninstallation Webhook URL**       | `https://transit-directory.salgorithm.workers.dev/api/trmnl/webhook/uninstall` |
| **Knowledge Base URL**               | `https://github.com/SalvatoreT/transit-directory`                              |

After saving, TRMNL will give you a **Client ID** and **Client Secret**.

## 3. Set OAuth secrets

```bash
yarn wrangler secret put TRMNL_CLIENT_ID
yarn wrangler secret put TRMNL_CLIENT_SECRET
```

Paste the values from step 2 when prompted.

## 4. Deploy

```bash
yarn deploy
```

## How it works

1. A user installs the plugin from the TRMNL marketplace.
2. TRMNL redirects them to the **Installation URL** (`/api/trmnl/install`) with an OAuth code.
3. The Worker exchanges the code for an access token via `https://trmnl.com/oauth/token` and redirects back to TRMNL.
4. TRMNL calls the **Installation Success Webhook** (`/api/trmnl/webhook/install`) with the user's UUID.
5. The user is redirected to the **Plugin Management URL** (`/api/trmnl/manage?uuid=...`) where they configure:
   - **Agency ID** - the transit agency identifier (e.g. `SC` for Caltrain)
   - **Stop ID** - the GTFS stop ID to monitor (e.g. `70261`)
   - **Display Name** - custom label shown on the screen
6. Every 15 minutes, TRMNL calls the **Plugin Markup URL** (`/api/trmnl/markup`) with `user_uuid` in the form body. The Worker looks up the user's config in KV, fetches upcoming departures from the D1 database, renders HTML for all four layouts, and returns them as JSON.

## Endpoints

| Endpoint                       | Method   | Description                                                               |
| ------------------------------ | -------- | ------------------------------------------------------------------------- |
| `/api/trmnl/markup`            | POST     | Main TRMNL polling endpoint. Returns pre-rendered HTML for all 4 layouts. |
| `/api/trmnl/install`           | GET      | OAuth entry point. Exchanges code for access token.                       |
| `/api/trmnl/webhook/install`   | POST     | Receives user UUID after successful install.                              |
| `/api/trmnl/webhook/uninstall` | POST     | Cleans up user data on uninstall.                                         |
| `/api/trmnl/manage`            | GET/POST | Settings page for configuring agency, stop, and display name.             |
| `/api/trmnl/preview/[layout]`  | GET      | HTML preview for a specific layout. Params: `agency_id`, `stop_id`.       |
| `/api/trmnl/data`              | GET      | JSON debug endpoint. Params: `agency_id`, `stop_id`.                      |
| `/api/trmnl/example`           | GET      | Example page with sample Caltrain data showing all layouts.               |

## Layouts

Each departure shows route name, departure time, and delay status on the title line, with the headsign (destination) as a label below. Full-width layouts (full, half horizontal) use a 2-column grid.

| Layout            | OG size | X size    | Departures shown |
| ----------------- | ------- | --------- | ---------------- |
| `full`            | 800x480 | 1872x1404 | 12               |
| `half_horizontal` | 800x240 | 1872x702  | 8                |
| `half_vertical`   | 400x480 | 936x1404  | 10               |
| `quadrant`        | 400x240 | 936x702   | 1 + 5            |

## Differences from trmnl-calendar

| Aspect      | trmnl-calendar           | transit-directory                  |
| ----------- | ------------------------ | ---------------------------------- |
| Framework   | Hono (standalone Worker) | Next.js App Router (vinext)        |
| Routes      | `/trmnl/*`               | `/api/trmnl/*`                     |
| Data source | Remote ICS feed          | Local D1 database (GTFS)           |
| User config | ICS URL + calendar name  | Agency ID + stop ID + display name |
| Storage     | KV (`USERS`)             | KV (`TRMNL_USERS`)                 |

## Local development

```bash
yarn dev
```

Then visit:

- `http://localhost:3000/api/trmnl/example` - example page with sample data
- `http://localhost:3000/api/trmnl/preview/full?agency_id=SC&stop_id=70261` - live preview with real data
- `http://localhost:3000/api/trmnl/data?agency_id=SC&stop_id=70261` - JSON output
