## Context

The TRMNL transit plugin renders departure cards using the TRMNL CSS framework's `.item` component. Currently, each departure shows `routeName -- time` in the `.content > .title`, with the `.meta` div empty. All layouts use single-column grids (`grid--cols-1`). The time is formatted as 12-hour (e.g., "3:15 PM") via Luxon's `h:mm a` format.

The departure cards are small relative to the available screen space, especially on full-width layouts (full: 800x480 OG / 1872x1404 X, half_horizontal: 800x240 OG / 1872x702 X).

## Goals / Non-Goals

**Goals:**

- Move time display into the `.meta` area so it's visually prominent and aligned across cards
- Use 4-digit 24-hour format (e.g., "15:32") in a monospace font for vertical alignment
- Increase emphasis levels to make cards much larger and readable from distance
- Use 2-column grids on full-width layouts (full, half_horizontal) to show more departures
- Keep single-column on narrow layouts (half_vertical, quadrant)

**Non-Goals:**

- Changing the data model or `TrmnlDeparture` interface
- Adding new departure data fields
- Changing the TRMNL CSS framework itself

## Decisions

### Time in meta area with monospace styling

Move the time string from `.content > .title` into `.meta` and style it with inline monospace font. The TRMNL framework's `.meta` width is controlled by `--item-meta-width` (default 10px). We'll override this via inline style to accommodate 5-character time strings (e.g., "15:32").

The time format changes from 12-hour (`h:mm a` / "3:15 PM") to 24-hour (`HH:mm` / "15:15"). This is more compact and aligns naturally since all times are exactly 5 characters.

**Alternative considered**: Keep 12-hour format. Rejected because variable width ("3:15 PM" vs "12:05 AM") breaks alignment, and the extra characters waste space in the meta column.

### Increased emphasis levels

Bump `item--emphasis` levels: primary items from 1 to 3, compact items from 1 to 2. The quadrant featured item stays at 3.

**Alternative considered**: Using `--large` or `--xlarge` CSS class variants on titles/labels. Rejected because the emphasis system is the TRMNL framework's intended mechanism for scaling item size.

### Multi-column grid on full-width layouts

Use `grid--cols-2` for `renderFull` and `renderHalfHorizontal`. This doubles visible departures and fills horizontal space. Increase max departures for full layout from 5 to 8 (4 per column) to take advantage of the space.

Keep `grid--cols-1` for `renderHalfVertical` (too narrow for 2 columns) and `renderQuadrant` (too small).

## Risks / Trade-offs

- [Monospace font availability] The TRMNL framework may not include a monospace font. -> Use inline `font-family: monospace` which falls back to the system monospace font on the e-ink device's rendering engine.
- [Meta width override] Overriding `--item-meta-width` via inline style is a coupling to the framework's internals. -> This is acceptable since the alternative (empty meta div) is already the status quo and the variable name is stable.
- [More departures in full layout] Increasing from 5 to 8 departures means more data, but the 2-column layout provides the space. -> If data is sparse (fewer departures available), the grid will simply have fewer items with no visual issue.
