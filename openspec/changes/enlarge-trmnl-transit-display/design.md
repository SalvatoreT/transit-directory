## Context

The TRMNL plugin renders transit departure data as server-side HTML that gets displayed on e-ink screens. The rendering lives entirely in `src/lib/trmnl/render.ts`, which produces HTML strings for four layout variants (full, half_horizontal, half_vertical, quadrant). The HTML uses TRMNL's external CSS framework (`plugins.css`) plus minimal inline styles for a CSS Grid layout.

Currently, departure items use the TRMNL framework's `.title--small` and `.label--small` classes, producing text that is too small to read from more than a few feet away. The 2-column grid on wider layouts flows left-to-right (row-major), which is unnatural for scanning a departure board.

## Goals / Non-Goals

**Goals:**

- Make departure text large enough to read from across a room on both TRMNL (800x480) and TRMNL X (1872x1404) screens.
- Render each departure as a visually distinct card with clear separation.
- Order entries top-to-bottom first (column-major) rather than left-to-right.
- Maintain all four layout variants with appropriate departure counts.

**Non-Goals:**

- Changing the data model or API contract (markup endpoint stays the same).
- Adding interactivity or new TRMNL plugin features.
- Redesigning the title bar or stop name display.
- Supporting custom user-configurable font sizes.

## Decisions

### 1. Use custom inline CSS to override TRMNL framework sizing

**Decision:** Override `.title--small` and `.label--small` with larger font sizes via inline `<style>` in the generated HTML, rather than removing the TRMNL framework classes.

**Rationale:** The TRMNL framework CSS provides base layout, resets, and the `.environment.trmnl` / `.screen` / `.view` structure. Removing it would require reimplementing all of that. Overriding specific sizing classes is surgical and keeps compatibility.

**Alternative considered:** Dropping `plugins.css` entirely and writing fully custom CSS. Rejected because it would break the TRMNL rendering pipeline expectations around `.screen`, `.view`, etc.

### 2. Card-based departure items with border and padding

**Decision:** Each departure gets a `.dep-card` class with a 2px solid border, padding, and a bottom margin for visual separation. This replaces the current `.item` approach which relies on the framework's subtle styling.

**Rationale:** On e-ink displays, bold borders and high contrast are essential for visibility. Cards with borders are clearly distinguishable even in low-contrast e-ink rendering.

### 3. Column-major ordering via CSS `grid-auto-flow: column`

**Decision:** For 2-column layouts, use `grid-auto-flow: column` with explicit `grid-template-rows` to flow items top-to-bottom first, then wrap to the next column.

**Rationale:** This is the standard CSS Grid approach for column-major flow. It requires knowing the number of rows (half the item count, rounded up), which we calculate in the render functions.

### 4. Reduce departure counts and remove `--small` classes

**Decision:** Reduce departure counts per layout to fit larger cards:

- Full: 12 -> 6
- Half horizontal: 8 -> 4
- Half vertical: 10 -> 6
- Quadrant: 1+5 -> 1+3

Remove `title--small` and `label--small` classes; use base `.title` and `.label` classes with custom size overrides for maximum text size.

**Rationale:** Fewer entries at larger size is the explicit goal. The departure count reduction is necessary to prevent overflow while making each entry visually prominent.

## Risks / Trade-offs

- **Fewer visible departures** -> Users see fewer upcoming departures at a glance. Mitigated by the departure count still being shown in the title bar, and the primary goal being readability from distance.
- **TRMNL framework CSS updates could conflict** -> Future changes to `plugins.css` might override our custom styles. Mitigated by using specific selectors and `!important` where needed for critical sizing.
- **E-ink rendering differences** -> Borders and padding may render slightly differently on actual e-ink hardware vs browser preview. Mitigated by using simple solid borders which are well-supported on e-ink.
