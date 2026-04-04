## Why

The TRMNL transit display currently renders departure information too small to read from a distance. On both the TRMNL (800x480) and TRMNL X (1872x1404) screens, transit entries are tiny text clustered in a corner of the display, wasting most of the available screen real estate. The 2-column grid layout flows left-to-right, which is unnatural for scanning a departure board. Users need to be able to glance at the screen from across a room and quickly see upcoming departures.

## What Changes

- Replace the current small text rendering with large, card-based departure entries that fill available screen space.
- Increase font sizes significantly for route names, times, delay status, and headsigns.
- Change the grid flow from left-to-right (row-major) to top-to-bottom (column-major) ordering so entries read naturally in vertical scan order.
- Each departure becomes its own visually distinct card with padding and separation.
- Reduce the number of displayed departures per layout to allow larger rendering (fewer entries, but each one legible from far away).
- Apply these changes to all four layout variants: full, half_horizontal, half_vertical, and quadrant.

## Capabilities

### New Capabilities

- `large-card-departures`: Card-based departure rendering with enlarged text and top-to-bottom flow ordering for all TRMNL layout sizes.

### Modified Capabilities

_(none - no existing specs)_

## Impact

- `src/lib/trmnl/render.ts`: Primary file affected. All four render functions and the shared CSS/HTML structure need updates.
- No API changes - the markup endpoint contract remains the same (returns HTML strings for each layout).
- No data model changes - `TrmnlDeparture` and `TrmnlStopData` types are unchanged.
- The external TRMNL CSS (`plugins.css`) is still loaded, but custom inline styles will override sizing and layout behavior.
