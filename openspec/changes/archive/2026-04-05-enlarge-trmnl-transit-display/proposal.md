## Why

The TRMNL transit display renders departure information too small to read from a distance, defeating the purpose of an always-on e-ink display. Both the TRMNL OG (800x480) and TRMNL X (1872x1404) screens pack too many small entries into a multi-column grid, making the text difficult to read at a glance.

## What Changes

- Replace the current multi-column grid layout with a single-column, top-to-bottom card-based layout for all four TRMNL view sizes (full, half_horizontal, half_vertical, quadrant).
- Each departure entry will be rendered as its own visually distinct card with significantly larger text (route name, time, delay status, headsign).
- Reduce the number of departures shown per layout to prioritize readability over density (fewer, larger entries).
- Change reading order from left-to-right (multi-column) to top-to-bottom (single column).
- Use larger TRMNL CSS class variants (e.g., remove `title--small`, `label--small`) to increase text size.

## Capabilities

### New Capabilities

- `large-card-layout`: Card-based departure rendering with maximized text size and single-column top-to-bottom ordering for all TRMNL screen layouts.

### Modified Capabilities

## Impact

- `src/lib/trmnl/render.ts`: All four render functions (`renderFull`, `renderHalfHorizontal`, `renderHalfVertical`, `renderQuadrant`) will be updated with new HTML structure, larger CSS classes, and reduced departure counts.
- Existing tests in `test/` covering TRMNL rendering will need updates for the new HTML output.
- No API changes, no database changes, no configuration changes. The markup endpoint continues to return HTML in the same format.
