## ADDED Requirements

### Requirement: Departure entries SHALL render as large cards

Each departure entry SHALL be rendered as a visually distinct card with a solid border, padding, and clear vertical separation from adjacent cards. The card MUST contain the route name, departure time, delay status, and headsign.

#### Scenario: Card rendering on full layout

- **WHEN** the full layout renders departure entries
- **THEN** each departure is wrapped in a card element with a visible border and internal padding

#### Scenario: Card rendering on quadrant layout

- **WHEN** the quadrant layout renders the featured departure
- **THEN** the featured departure card has enhanced emphasis (larger text, thicker border) compared to remaining cards

### Requirement: Text sizes SHALL be significantly enlarged

All departure text (route name, time, delay status, headsign) SHALL use large font sizes suitable for reading from several feet away. The rendering MUST NOT use the `title--small` or `label--small` CSS classes. Font sizes SHALL be at minimum:

- Route name and time: 28px on OG screens, scaling proportionally on X screens
- Headsign: 22px on OG screens, scaling proportionally on X screens
- Delay status: 22px on OG screens, scaling proportionally on X screens

#### Scenario: Text legibility on TRMNL OG full layout (800x480)

- **WHEN** the full layout is rendered for TRMNL OG
- **THEN** route name and time text is at least 28px and headsign text is at least 22px

#### Scenario: Text legibility on TRMNL X full layout (1872x1404)

- **WHEN** the full layout is rendered for TRMNL X
- **THEN** text sizes scale proportionally larger to fill the increased screen area

### Requirement: Entries SHALL be ordered top-to-bottom first

In multi-column layouts, departure entries SHALL flow top-to-bottom within each column before wrapping to the next column (column-major order), rather than left-to-right across columns (row-major order).

#### Scenario: Column-major ordering on full layout with 6 departures

- **WHEN** 6 departures are rendered on the full layout with 2 columns
- **THEN** departures 1-3 appear in the left column (top to bottom) and departures 4-6 appear in the right column (top to bottom)

#### Scenario: Single-column layouts remain unchanged

- **WHEN** departures are rendered on half_vertical or quadrant layouts (single column)
- **THEN** departures flow top-to-bottom as before (no change in ordering)

### Requirement: Departure counts SHALL be reduced to fit larger cards

Each layout variant SHALL display fewer departures to accommodate the increased card and text sizes:

- Full layout: SHALL display at most 6 departures (previously 12)
- Half horizontal layout: SHALL display at most 4 departures (previously 8)
- Half vertical layout: SHALL display at most 6 departures (previously 10)
- Quadrant layout: SHALL display 1 featured + at most 3 remaining (previously 1+5)

#### Scenario: Full layout departure limit

- **WHEN** there are 12 available departures
- **THEN** the full layout renders only the first 6

#### Scenario: Quadrant layout departure limit

- **WHEN** there are 10 available departures
- **THEN** the quadrant layout renders 1 featured departure and 3 remaining departures

### Requirement: All four layout variants SHALL use card-based rendering

The card-based large-text rendering SHALL apply consistently to all four layout variants: full, half_horizontal, half_vertical, and quadrant. The API response structure (markup, markup_half_horizontal, markup_half_vertical, markup_quadrant) SHALL remain unchanged.

#### Scenario: API response structure preserved

- **WHEN** the TRMNL markup endpoint is called
- **THEN** the response JSON contains all four markup keys with HTML string values using the new card-based rendering
