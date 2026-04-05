## Context

The TRMNL transit display currently renders departure information using TRMNL's built-in CSS classes (`title--small`, `label--small`) in multi-column grids (`grid--cols-2`). This produces compact, information-dense layouts that are difficult to read from across a room. The rendering lives entirely in `src/lib/trmnl/render.ts`, which generates HTML strings for four layout sizes: full, half_horizontal, half_vertical, and quadrant.

The TRMNL CSS framework provides larger class variants (e.g., `title` without `--small`, `label` without `--small`) and supports single-column grids (`grid--cols-1`). The e-ink screens have fixed pixel dimensions but the CSS framework handles scaling.

## Goals / Non-Goals

**Goals:**

- Make transit departure information readable from several feet away on both TRMNL OG and TRMNL X screens.
- Each departure entry should be a visually distinct card with large route name, time, delay status, and headsign.
- Entries should read top-to-bottom (single column) instead of left-to-right (multi-column grid).
- Maximize text size by using larger TRMNL CSS class variants and reducing departure count per layout.

**Non-Goals:**

- Changing the data model, API endpoints, or configuration system.
- Adding custom CSS (we continue to rely on TRMNL's hosted CSS framework).
- Changing the quadrant layout's featured-item pattern (keep emphasis-3 for next departure).
- Supporting user-configurable density or layout preferences.

## Decisions

### 1. Switch all layouts to single-column (`grid--cols-1`)

**Rationale:** The 2-column grid is the primary reason entries appear small. A single column allows each card to span the full width, enabling much larger text. This also naturally produces top-to-bottom reading order.

**Alternative considered:** Keep 2 columns but increase font size via custom CSS. Rejected because it would require hosting custom CSS and fighting TRMNL's framework, and wouldn't fix the reading order.

### 2. Use larger TRMNL CSS class variants

**Rationale:** Replace `title--small` with `title` and `label--small` with `label` for departure items. The TRMNL CSS framework already provides these larger variants. This is the simplest way to increase text size without custom CSS.

### 3. Reduce departure counts per layout

**Rationale:** Fewer entries with larger cards means each entry is more visible. Proposed limits:

- **Full:** 12 -> 5 departures
- **Half Horizontal:** 8 -> 3 departures
- **Half Vertical:** 10 -> 5 departures
- **Quadrant:** 1+5 -> 1+2 departures (1 featured + 2 compact)

These counts prioritize readability. Users see the most imminent departures, which are the most actionable.

### 4. Add visual card separation with `item--row` class

**Rationale:** TRMNL's CSS framework supports `item--row` for horizontal card layouts. Using distinct card boundaries makes each departure visually scannable at a glance.

## Risks / Trade-offs

- **Fewer departures visible** -> Users see less information at once. Mitigated by showing the most imminent departures, which are the most useful. The title bar still shows total departure count.
- **Reliance on TRMNL CSS class behavior** -> If TRMNL changes their CSS framework, the larger classes might render differently. Mitigated by using only well-documented TRMNL CSS classes.
- **No custom styling escape hatch** -> We rely entirely on TRMNL's class system. If the built-in large variants aren't big enough, we'd need to add inline styles or custom CSS later.
