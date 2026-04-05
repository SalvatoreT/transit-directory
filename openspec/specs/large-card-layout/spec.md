## ADDED Requirements

### Requirement: Single-column top-to-bottom layout

All four TRMNL layout views (full, half_horizontal, half_vertical, quadrant) SHALL render departure entries in a single-column grid (`grid--cols-1`) so entries read top-to-bottom.

#### Scenario: Full layout uses single column

- **WHEN** the full layout is rendered
- **THEN** departures SHALL be in a `grid--cols-1` grid (not `grid--cols-2`)

#### Scenario: Half horizontal layout uses single column

- **WHEN** the half_horizontal layout is rendered
- **THEN** departures SHALL be in a `grid--cols-1` grid (not `grid--cols-2`)

#### Scenario: Half vertical layout uses single column

- **WHEN** the half_vertical layout is rendered
- **THEN** departures SHALL be in a `grid--cols-1` grid

#### Scenario: Quadrant layout uses single column

- **WHEN** the quadrant layout is rendered
- **THEN** departures SHALL be in a `grid--cols-1` grid

### Requirement: Large text rendering for departure items

Departure items SHALL use large TRMNL CSS class variants instead of small variants to maximize readability from a distance.

#### Scenario: Standard departure items use large title class

- **WHEN** a departure item is rendered via `departureItem`
- **THEN** the route and time text SHALL use `title` class (not `title--small`)

#### Scenario: Standard departure items use large label class

- **WHEN** a departure item is rendered via `departureItem`
- **THEN** the headsign text SHALL use `label` class (not `label--small`)
- **AND** delay status labels SHALL use `label` class (not `label--small`)

#### Scenario: Compact departure items use large title class

- **WHEN** a compact departure item is rendered via `departureItemCompact`
- **THEN** the route and time text SHALL use `title` class (not `title--small`)

#### Scenario: Compact departure items use large label class

- **WHEN** a compact departure item is rendered via `departureItemCompact`
- **THEN** the headsign and delay labels SHALL use `label` class (not `label--small`)

### Requirement: Reduced departure counts per layout

Each layout SHALL show fewer departures to accommodate the larger card sizes.

#### Scenario: Full layout shows at most 5 departures

- **WHEN** the full layout is rendered with available departures
- **THEN** at most 5 departures SHALL be displayed

#### Scenario: Half horizontal layout shows at most 3 departures

- **WHEN** the half_horizontal layout is rendered with available departures
- **THEN** at most 3 departures SHALL be displayed

#### Scenario: Half vertical layout shows at most 5 departures

- **WHEN** the half_vertical layout is rendered with available departures
- **THEN** at most 5 departures SHALL be displayed

#### Scenario: Quadrant layout shows 1 featured plus at most 2 compact

- **WHEN** the quadrant layout is rendered with available departures
- **THEN** 1 featured departure (emphasis-3) SHALL be displayed
- **AND** at most 2 additional compact departures SHALL be displayed

### Requirement: Card-based visual separation

Each departure entry SHALL be rendered as a visually distinct card element.

#### Scenario: Departure items retain item class structure

- **WHEN** a departure is rendered
- **THEN** it SHALL be wrapped in a `div` with class `item` and an emphasis class

#### Scenario: Gap between cards

- **WHEN** multiple departures are displayed
- **THEN** the grid container SHALL include the `gap--small` class for visual spacing between cards
