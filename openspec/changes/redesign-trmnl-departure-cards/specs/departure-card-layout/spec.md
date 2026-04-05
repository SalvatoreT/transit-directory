## ADDED Requirements

### Requirement: Time displayed in meta area

Each departure card SHALL render the departure time inside the `.meta` div of the `.item` element, not in the `.content > .title` span.

#### Scenario: Time appears in meta column

- **WHEN** a departure card is rendered
- **THEN** the `.meta` div contains the departure time string
- **AND** the `.content > .title` span contains only the route name, delay label, and no time

### Requirement: 4-digit 24-hour time format

Departure times SHALL be formatted as 24-hour time with exactly 4 digits and a colon (HH:mm), e.g., "03:15", "15:32".

#### Scenario: Morning time formatting

- **WHEN** a departure time of 3:15 AM is rendered
- **THEN** the displayed time is "03:15"

#### Scenario: Afternoon time formatting

- **WHEN** a departure time of 3:15 PM is rendered
- **THEN** the displayed time is "15:15"

### Requirement: Monospace time font

The time in the meta area SHALL be rendered in a monospace font so that digits align vertically across stacked departure cards.

#### Scenario: Time uses monospace styling

- **WHEN** a departure card is rendered
- **THEN** the time element has `font-family: monospace` applied

### Requirement: Larger departure cards

Departure cards SHALL use higher emphasis levels than the current level 1. Standard departure items SHALL use `item--emphasis-3`. Compact departure items SHALL use `item--emphasis-2`.

#### Scenario: Standard item emphasis

- **WHEN** a standard departure item is rendered (in full, half_vertical, or as featured in quadrant)
- **THEN** the item element has class `item--emphasis-3`

#### Scenario: Compact item emphasis

- **WHEN** a compact departure item is rendered (in half_horizontal or as secondary in quadrant)
- **THEN** the item element has class `item--emphasis-2`

### Requirement: Multi-column grid on full-width layouts

The full layout SHALL use `grid--cols-2` to arrange departure cards in two columns. The half_horizontal layout SHALL also use `grid--cols-2`.

#### Scenario: Full layout uses two columns

- **WHEN** the full layout is rendered with departures
- **THEN** the grid container has class `grid--cols-2`

#### Scenario: Half horizontal layout uses two columns

- **WHEN** the half_horizontal layout is rendered with departures
- **THEN** the grid container has class `grid--cols-2`

### Requirement: Single-column on narrow layouts

The half_vertical and quadrant layouts SHALL continue to use `grid--cols-1`.

#### Scenario: Half vertical uses one column

- **WHEN** the half_vertical layout is rendered with departures
- **THEN** the grid container has class `grid--cols-1`

#### Scenario: Quadrant uses one column

- **WHEN** the quadrant layout is rendered with departures
- **THEN** the grid container has class `grid--cols-1`

### Requirement: Increased departure count for full layout

The full layout SHALL display up to 8 departures (to fill both columns) instead of the current 5.

#### Scenario: Full layout shows up to 8 departures

- **WHEN** the full layout is rendered with 10 available departures
- **THEN** exactly 8 departure cards are rendered
