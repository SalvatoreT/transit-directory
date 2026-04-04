## 1. Update CSS and card structure

- [x] 1.1 Replace inline CSS in `page()` function: remove `.dep-grid` small gap, add `.dep-card` styles with border, padding, and large font-size overrides for `.title` and `.label` classes
- [x] 1.2 Add `grid-auto-flow: column` and `grid-template-rows` to `.dep-grid--2col` for column-major ordering
- [x] 1.3 Update `departureItem()` to wrap each departure in a `.dep-card` element and remove `title--small` / `label--small` classes

## 2. Update layout render functions

- [x] 2.1 Update `renderFull()`: reduce departure limit from 12 to 6, compute grid-template-rows for column-major flow
- [x] 2.2 Update `renderHalfHorizontal()`: reduce departure limit from 8 to 4, use column-major 2-column grid
- [x] 2.3 Update `renderHalfVertical()`: reduce departure limit from 10 to 6, keep single-column layout with card styling
- [x] 2.4 Update `renderQuadrant()`: reduce remaining departures from 5 to 3, apply card styling with enhanced featured card

## 3. Update compact item rendering

- [x] 3.1 Update `departureItemCompact()` to use `.dep-card` wrapper and remove `--small` class modifiers

## 4. Verify and test

- [x] 4.1 Run `yarn build` to verify no TypeScript or build errors
- [x] 4.2 Run `yarn test` to verify existing tests pass
- [x] 4.3 Run `yarn lint` to verify formatting
