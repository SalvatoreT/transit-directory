## Why

The current TRMNL departure cards are small and hard to read at a glance, especially on the larger TRMNL X display. The time is buried in the title text alongside the route name, and the layout uses a single column even on full-width screens that have room for multiple columns. These changes will make the display more scannable and better utilize available screen real estate.

## What Changes

- Move departure time into the `.meta` area (icon/left column) of each item card, formatted as 4-digit 24-hour time (e.g., "15:32") in a monospace font for alignment
- Increase item emphasis levels significantly so departure cards are much larger and more readable from across a room
- Use multi-column grid layouts (`grid--cols-2`) on full-width screens (full and half_horizontal) to display more departures and fill the space
- Keep single-column layout on narrower screens (half_vertical and quadrant)

## Capabilities

### New Capabilities

- `departure-card-layout`: Redesigned departure card rendering with time in meta area, monospace 4-digit time, larger emphasis, and multi-column grids for full-width layouts

### Modified Capabilities

## Impact

- `src/lib/trmnl/render.ts` - All departure item rendering functions (`departureItem`, `departureItemCompact`) and layout functions (`renderFull`, `renderHalfHorizontal`)
- `test/trmnl-render.test.ts` - Tests will need updating to match new HTML structure
- `app/api/trmnl/example/route.ts` - Example page will reflect new layout automatically
- No API changes, no dependency changes
