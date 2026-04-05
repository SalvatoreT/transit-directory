## 1. Update departure item rendering functions

- [x] 1.1 In `src/lib/trmnl/render.ts`, update `departureItem()` to use `title` instead of `title--small` and `label` instead of `label--small` for route/time, headsign, and delay labels
- [x] 1.2 In `src/lib/trmnl/render.ts`, update `departureItemCompact()` to use `title` instead of `title--small` and `label` instead of `label--small` for route/time, headsign, and delay labels

## 2. Update layout functions to single-column with reduced counts

- [x] 2.1 Update `renderFull()` to use `grid--cols-1` instead of `grid--cols-2` and reduce max departures from 12 to 5
- [x] 2.2 Update `renderHalfHorizontal()` to use `grid--cols-1` instead of `grid--cols-2` and reduce max departures from 8 to 3
- [x] 2.3 Update `renderHalfVertical()` to keep `grid--cols-1` and reduce max departures from 10 to 5
- [x] 2.4 Update `renderQuadrant()` to reduce remaining departures from 5 to 2 (keep 1 featured + 2 compact)

## 3. Update tests

- [x] 3.1 Update existing TRMNL render tests to expect `grid--cols-1` instead of `grid--cols-2` for full and half_horizontal layouts
- [x] 3.2 Update test assertions for new departure count limits (5, 3, 5, 1+2)
- [x] 3.3 Update test assertions for large CSS classes (`title` instead of `title--small`, `label` instead of `label--small`)

## 4. Verify

- [x] 4.1 Run `yarn test` and ensure all tests pass
- [x] 4.2 Run `yarn lint` and `yarn format` to ensure code style compliance
