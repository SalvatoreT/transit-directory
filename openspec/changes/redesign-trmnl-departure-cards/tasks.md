## 1. Time format change

- [x] 1.1 Update `formatDeparture` in `src/lib/trmnl/data.ts` to use 24-hour format (`HH:mm` instead of `h:mm a`)
- [x] 1.2 Update sample data in `app/api/trmnl/example/route.ts` to use 24-hour time strings

## 2. Departure card rendering

- [x] 2.1 Update `departureItem` in `src/lib/trmnl/render.ts`: move time into `.meta` div with monospace font styling, remove time from `.title`, increase emphasis default to 3
- [x] 2.2 Update `departureItemCompact` in `src/lib/trmnl/render.ts`: move time into `.meta` div with monospace font styling, remove time from `.title`, increase emphasis default to 2

## 3. Layout changes

- [x] 3.1 Update `renderFull` to use `grid--cols-2` and increase max departures from 5 to 8
- [x] 3.2 Update `renderHalfHorizontal` to use `grid--cols-2`
- [x] 3.3 Verify `renderHalfVertical` and `renderQuadrant` remain `grid--cols-1`

## 4. Tests

- [x] 4.1 Update tests in `test/trmnl-render.test.ts` to match new HTML structure (time in meta, new emphasis levels, multi-column grids, 8-departure limit for full)
- [x] 4.2 Run `yarn test` and verify all tests pass

## 5. Validation

- [x] 5.1 Run `yarn lint` and `yarn format` to ensure code style compliance
- [x] 5.2 Visually verify example page at `/api/trmnl/example` with Playwright
