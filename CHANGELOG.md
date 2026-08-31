# Changelog

## 1.2.2

### Fixed
- In the recent SQL files list, clicking a checkbox to select an item
  no longer resets the highlighted position back to the top of the
  list - the highlight now stays on the item you just checked, so
  arrow-key navigation continues from there instead of jumping back
  to the first entry.

## 1.2.1

### Changed
- Removed the `RowEntry` (`{key, data}`) wrapper backing every SQL
  result row, on both the backend and in the webview. Since deleting
  rows now always forces a full re-run of the query (see 1.2.0), row
  identity and array position could never drift apart in the first
  place, so a separate `key` field was redundant - the row's index in
  the (now immutable) results array serves as its identifier instead.
  Sorting no longer copies the whole result set into a new order;
  it stores the display order separately as a lightweight index
  permutation. No behavior change - same sorting, search, editing,
  and delete semantics as before, just less memory overhead and fewer
  linear lookups by row key.

## 1.2.0

### Changed
- Deleting rows now forces a full re-run of the last query instead of
  patching the local row cache - the grid always reflects a fresh
  `SELECT` from the database after a delete, staying on the same page,
  search filter, and sort order.

## 1.1.29

### Changed
- `State`'s constructor redefined ~25 property descriptors via
  `Object.defineProperty` on every `new State()` call, wrapping each
  field in a closure-based getter/setter over the shared per-file
  object - paid on every file switch that wasn't a cache hit. The
  constructor now returns the per-file object directly (with
  `Object.setPrototypeOf` to keep `State.prototype`), so field access
  is a plain property lookup instead of going through getters/setters,
  and switching files no longer rebuilds any descriptors at all.
  `init()`'s cache-hit check now compares `State.#instance` directly
  against the object in `#globalFiles` instead of the removed
  `#fileStateRef` field. No change in behavior or public API.

## 1.1.28

### Fixed
- `appendData` in the webview redefined ~26 property descriptors on every
  message via `Object.defineProperty`, even when the SQL file hadn't
  changed since the previous message - firing on every page change, sort,
  and search. `State.init()` now skips the rebuild when both the filename
  and the underlying per-file state object are unchanged (still correctly
  rebuilds after `State.clear()`, which invalidates that object). The
  `appendData` handler also now caches `State.getInstance()` in a local
  variable instead of calling it 18+ times per message.
- Search cancellation in `SqlResultsProvider` (`applySearchFilter`) wasn't
  covered by a real test - the test set `_allRows` instead of
  `_naturalOrderRows`, which is the field the method actually reads, so
  the 20k-row scenario never hit the code path meant to yield to the
  event loop and support cancellation. Test data now sets
  `_naturalOrderRows` as well.

## 1.1.27

### Changed
- Column header names now use the full header width when the sort
  arrow isn't shown, instead of always leaving space for it.
  `.sort-indicator-wrap` collapses to zero width by default and
  only expands on hover, when the column is actively sorted, or
  while the sort spinner is visible - at which point
  `.header-label` shrinks and truncates with an ellipsis as needed.

## 1.1.26

### Fixed
- Editing a single cell could leave a stale, never-actually-saved
  value visible in the grid if the write silently failed or was
  coerced by the database (e.g. entering `2` into a `BIT(1)` column).
  `saveEdit()` in `editor.js` updated the DOM immediately as an
  optimistic preview, but had no revert path, and `renderPage`'s
  row-diff cache in `tableRenderer.js` would then skip re-rendering
  the row on the next query run if the freshly fetched value matched
  the (unchanged) cached one - masking the fact that the displayed
  value was never real. `saveEdit()` now also invalidates
  `State.currentRows` for that cell (`undefined`, a value that never
  occurs in real SQL results) right after the optimistic write, so
  the next render always detects a mismatch and shows the real value.

## 1.1.25

### Fixed
- Pressing Esc in the recent SQL files picker (F3) could leave the
  UI in a broken state. In the "New SQL file", "Rename SQL file" and
  "Trim" sub-dialogs, Esc now fully closes the whole picker
  (`quickPick.hide()`) instead of calling `quickPick.show()`, which
  used to leave a stray, sometimes unresponsive "select SQL file(s)"
  window behind. In the connection filter sub-dialog, Esc still
  returns to the main list as intended, but `quickPick.items` is now
  rebuilt before `quickPick.show()` is called again - previously the
  list came back empty because the items were never reassigned after
  VS Code hid/replaced the picker. The same items refresh was applied
  to the three error-recovery paths (rename-on-disk failure, add-file
  failure, unexpected rename error) that had the same gap.

## 1.1.24

### Fixed
- `BIT` columns in SQL query results no longer show up as
  `[object Object]`. The `mariadb` driver returns `BIT` values as a
  raw `Buffer` regardless of length (`bitOneIsBoolean: false` in
  `Connection.ts` now makes `BIT(1)` behave the same way as longer
  `BIT(n)` columns). `executeQuery` in `query.ts` inspects `meta` for
  columns of type `BIT` and converts only those columns' `Buffer`
  values to a `number` (via `bitBufferToNumber`, safe up to `BIT(64)`
  through `BigInt`) - if no `BIT` column is present, no extra work is
  done per row. `BIT` was also added to `NUMERIC_SORT_TYPE_NAMES` in
  `SqlResultsProvider.ts` so the column sorts numerically instead of
  as a string.
- Editing a `BIT` column cell no longer writes the wrong value (e.g.
  entering `1` stored `49`, entering `2` stored `50`). The value from
  the webview input is always a string, and MariaDB interprets a
  string literal sent to a `BIT` column as raw bytes rather than a
  numeric text representation, unlike `INT`. A new shared
  `normalizeValueForField(value, field)` helper in
  `formatSqlValue.ts` now converts a numeric string to a `number` for
  `BIT` columns (and unifies the existing `"NULL"` string handling)
  before the value is sent to `db.query()`. It's used consistently by
  all three editing flows in `SqlResultsProvider.ts` -
  `updateCellInDB` (single cell), `saveCellEdits` (bulk edit of
  selected cells, normalized per column name since a shared value can
  target columns of different types) and `saveColumnEdits` (bulk edit
  of an entire column).

## 1.1.23

### Added
- New rename ("pencil") button in the recent SQL files picker (F3),
  shown to the left of the trash button on each list item. Clicking
  it opens an input box pre-filled with the current file name
  (without the `.sql` extension), validates that the new name is
  non-empty and different from the current one, and blocks it if a
  file with that name already exists in the same directory. On
  Enter, the file is renamed on disk and the entry in `sqlFiles` is
  updated (moved to the end of the list, since the map key can't be
  renamed in place) and persisted. If the rename on disk fails (e.g.
  no permissions), an error is shown and the existing entry is left
  unchanged. Solves files being dropped from the recent list when
  renamed manually outside the extension.

## 1.1.22

### Added
- New "+" button in the recent SQL files picker (F3), shown to the
  left of the star/funnel/trash buttons whenever the recent files
  list is non-empty. Prompts for a file name (defaulting to
  `Script-N`, based on existing `Script-*.sql` files found in the
  target directory), creates an empty `.sql` file in the same
  directory as the most recently used SQL file, and opens it in the
  editor. If a file with the entered name already exists, submission
  is blocked until a different, free name is entered.

## 1.1.21

### Added
- Column headers in the SQL results grid now show the full column
  name in a tooltip on hover (`label.title` on `.header-label` in
  `tableRenderer.js`), so names truncated by the `text-overflow:
  ellipsis` CSS rule are still fully readable.

## 1.1.20

### Fixed
- Sorting a column while a search filter is active no longer rebuilds
  the per-column sort cache (`buildColumnSortCache`) or recomputes
  `applySort`/`composeSortOrder` over the full result set. `performSort`
  now sorts only the already-filtered `_filteredEntries` in place
  (`resortFilteredEntries`, using a new lightweight, cache-free
  multi-column comparator - `compareRowsBySortCriteria`/
  `compareCellValues`). Previously, sorting while searching still built
  or reversed a per-column cache over `this._naturalOrderRows` and then
  re-ran `applySearchFilter` over the entire (potentially multi-million-
  row) `_allRows` on every single click, even when the search had
  already narrowed the results down to a single row - visible as a
  multi-second delay per sort click, with `DESC` appearing no faster
  than the initial `ASC` sort despite the column cache being reused.
- `applySearchFilter` now always filters from `this._naturalOrderRows`
  instead of `this._allRows`, so the filtered result no longer depends
  on the full result set being sorted first. `performSearch` now forces
  one full `applySort()` when the search query is cleared and sort
  criteria are active, to catch up `this._allRows` with any sorting
  that happened while search was active (sorting no longer touches
  `_allRows` in that case - see above).
- `INT` columns were misclassified as text for sorting purposes because
  `NUMERIC_SORT_TYPE_NAMES` checked for `'LONG'` (the `mysql2` driver's
  type name), while this driver (`mariadb`) reports `'INT'`
  (`node_modules/mariadb/lib/const/field-type.js`). `INT` columns
  sorted lexicographically (`1, 10, 2`) instead of numerically
  (`1, 2, 10`); fixed by replacing `'LONG'` with `'INT'` in
  `NUMERIC_SORT_TYPE_NAMES`. Verified the rest of
  `NUMERIC_SORT_TYPE_NAMES`/`DATE_SORT_TYPE_NAMES` against the driver's
  full type-name table - no other mismatches.

## 1.1.19

### Changed
- Sort arrow (`.sort-indicator`) is now 50% bigger (font-size
  10px -> 15px, min-width 16px -> 24px) with 2px padding, so hovering
  close to it is enough to click it - no more pixel-precise aiming.

### Added
- Loading spinner next to the sort arrow while a sort is in
  progress, matching the existing search spinner (same look, same
  delayed-show/min-hold timing so it doesn't flicker on fast sorts).
  Useful on large tables (e.g. millions of rows) where sorting can
  take a few seconds.

## 1.1.18

### Fixed
- Sorting a column in descending order (`DESC`) no longer reverses
  the relative order of rows with duplicate/`NULL` values in that
  column. Previously, flipping a single column between `ASC` and
  `DESC` would also flip the order of tied rows within it; now ties
  keep their original relative order and only the order of distinct
  value groups changes - matching native SQL `ORDER BY` behavior
  (verified against phpMyAdmin).

## 1.1.17

### Changed
- Sorting (`applySort`) no longer re-sorts the whole result set on
  every ASC/DESC/multi-column click. `this._allRows` is never
  mutated in place anymore - it's derived on demand from
  `this._naturalOrderRows` (an immutable, key-ascending copy of the
  query result) plus a per-column cache (`this._sortColumnCache`,
  built lazily the first time a column is used in any sort
  criteria).
- New `buildColumnSortCache`: groups a column's row keys by value
  once (same radix/tie-break logic as before), stored as flat
  `Int32Array` structures (CSR-style: `flatKeysAsc` + `bucketStart`
  + `keyToBucket`) instead of nested `number[][]`/`Map`. Avoids the
  per-object overhead of millions of tiny arrays/map entries on
  high-cardinality columns (e.g. primary keys) - measured ~150-190MB
  down to ~25-30MB per cached column on a 2M-row table.
- New `composeSortOrder`: recombines any combination of already-
  cached columns (processed least-to-most significant, like an LSD
  radix sort) purely by regrouping buckets - no comparisons and no
  re-sorting, for any ASC/DESC/multi-column combination once every
  involved column has been cached at least once.
- `this._naturalOrderRowsByKey` (key -> row lookup) is now built
  once per data load instead of being rebuilt on every single sort
  click.
- Re-running a query (Ctrl+Enter) always resets to the unsorted view
  and clears all sort state (`resetStateBeforeQuery`) *before* the
  query runs, instead of after. This also releases the previous
  result set and its sort cache still referenced by the per-file
  state (`_fileStates`) for the same file, which previously kept
  the old (potentially multi-million-row) dataset and every column
  cache built during the session reachable - and thus impossible to
  garbage-collect - for the entire duration of the next query,
  which could exhaust available memory on large tables.
- Column sort cache is invalidated for the affected column(s) only
  on cell edits, and cleared entirely on row deletion.
- Removed the now-superseded `radixSortSingleColumn`,
  `mergeSortRows`, `compareForSort`, `compareNumbers`,
  `compareStrings`, and `compareDates`.

## 1.1.16

### Changed
- Added a `date` `SortKind` for `DATE`/`DATETIME`/`TIMESTAMP`/`TIME`
  columns, alongside the existing `number` and `string` kinds
  (`computeSortKinds`). These columns arrive from the driver as
  strings (`dateStrings:true`, `Connection.ts`) and were previously
  sorted through the `STRING` radix path, which keys on only the
  first `STRING_RADIX_PREFIX_CHARS` characters. For datetime strings
  that prefix is mostly just the year, so a large share of rows with
  the same year collide into one tie-break group and fall back to a
  native `sort()` over every unique value in that group - measured
  ~10s for 2M rows vs 3-5s for plain string columns.
- Values with `kind=date` are now parsed into a sortable number
  before being packed into radix words, reusing the `NUMBER` radix
  path instead: epoch milliseconds (via `Date.UTC`) for
  `DATE`/`DATETIME`/`TIMESTAMP`, and signed milliseconds for `TIME`
  (to support MariaDB's `-838:59:59`..`838:59:59` range, which isn't
  a real time-of-day). Since the full value now discriminates rows
  in a single radix pass, the large tie-break groups - and their
  fallback to native `sort()` - no longer occur.
- `'0000-00-00'` and any other unparseable date/time string sort as
  `0`, the lowest possible value.
- `radixSortSingleColumn` (single-column path) and `compareForSort`
  (multi-column merge-sort path, used for shift-click sorting) both
  updated to dispatch on the new `date` kind. `compareStrings` and
  all existing `number`/`string` sorting are unaffected.

## 1.1.15

### Changed
- Within `radixSortSingleColumn`, tie-break groups for `STRING`
  columns (rows colliding on the `STRING_RADIX_PREFIX_CHARS` prefix)
  are now resolved by bucketing indices into per-unique-value queues
  (`Map<string, number[]>`, filled from a group pre-sorted by row key
  so each queue is already in the correct order) and sorting only the
  *distinct* values with a single native `Array.prototype.sort()` call
  - no custom comparator. For `desc`, reversing the sorted unique-value
  array is enough to flip value order while leaving each queue's
  key-ascending order intact, so the tie-break stays correct with no
  extra fix-up step.
- This replaces the previous `group.sort()` call, which invoked
  `compareStrings` once per pairwise comparison (O(m log m) calls for
  a group of m rows), and is faster than an earlier composite-string
  approach in every duplication scenario benchmarked: 58-68% faster
  with heavy duplication, 11-15% faster with light duplication, and
  equal when no tie-break groups occur at all (sanity baseline).
  Sort output is unchanged - verified against the previous
  implementation with 300 randomized trials (asc/desc, heavy
  duplication). `compareStrings`, the multi-column merge-sort path
  (`compareForSort`), and all numeric sorting are unaffected.

## 1.1.14

### Changed
- Within `radixSortSingleColumn`, tie-break groups for `STRING` columns
  (rows that collide on the `STRING_RADIX_PREFIX_CHARS` prefix) are no
  longer resolved with `group.sort()` calling `compareStrings` once per
  pairwise comparison. Instead, each group is sorted with a single
  native `Array.prototype.sort()` call: a composite string (value +
  row key zero-padded to `SORT_KEY_PAD_LENGTH`, 16 chars) is built per
  row and sorted once with no comparator; for `desc` direction the
  group is reversed and runs of equal values are re-fixed so the key
  tie-break stays ascending, matching the existing convention. Sort
  output is unchanged - verified against the previous implementation
  with 200 randomized trials (asc/desc, heavy duplication) - only the
  number of comparisons performed for large tie groups is reduced.
  `compareStrings` itself, the multi-column merge-sort path
  (`compareForSort`), and all numeric sorting are unaffected.

## 1.1.13

### Fixed
- Sorting large result sets (hundreds of thousands of rows) by clicking a
  column header could freeze the entire Extension Host for several seconds
  to over a minute, sometimes triggering VS Code's "Extension host is
  unresponsive" warning. The cause was `compareForSort` using
  `String.prototype.localeCompare()` (with `numeric: true, sensitivity:
  'base'`) for every pairwise comparison - each call implicitly builds an
  `Intl.Collator`, and doing this ~n·log(n) times on a large result set is
  extremely expensive. `localeCompare`/`Intl.Collator` have been removed
  entirely from sorting; see Changed below for the replacement.
- Editing a single cell (the non-bulk edit path) updated the row's value in
  the database but never wrote the new value into the in-memory
  `entry.data[cell.columnIndex]`, so the grid kept showing the pre-edit
  value until the query was re-run or the file was reloaded. Fixed by
  restoring the assignment that a prior refactor had accidentally dropped.
- `BIGINT` columns were misclassified as text for sorting purposes because
  the type-name lookup checked for `'LONGLONG'`, which is not a type name
  this driver (`mariadb`) actually reports (it reports `'BIGINT'`). BIGINT
  is now included in `NUMERIC_SORT_TYPE_NAMES` and sorts numerically.

### Changed
- Column sorting no longer determines "is this text or a number" by
  sampling row values. `computeSortKinds` now classifies every column
  once, up front, purely from the SQL result metadata (`field.type`)
  against a fixed `NUMERIC_SORT_TYPE_NAMES` list (`TINY`, `SHORT`, `LONG`,
  `INT24`, `BIGINT`, `FLOAT`, `DOUBLE`, `DECIMAL`, `NEWDECIMAL`, `YEAR`);
  everything else (`VARCHAR`/`VAR_STRING`/`STRING`, dates, JSON, enums,
  blobs, ...) is treated as text. `DECIMAL`/`NEWDECIMAL` are classified as
  numeric even though this driver returns them as JS strings (no
  `decimalAsNumber` option set) - the numeric comparator's `a - b`
  coerces numeric-looking strings correctly regardless.
- Single-column sorts (a plain header click) now use a radix sort
  (`radixSortSingleColumn`) instead of a comparator-based sort:
  - `NUMBER` columns are encoded as the raw IEEE-754 bits of the
    `Float64` value (2 `Uint32` words), with a sign-aware bit-flip so
    unsigned integer comparison of the encoded words matches true
    numeric order (`encodeFloat64SortableWords`). Two rows only end up
    with identical words if they are genuinely the same number, so ties
    are broken purely by row key (stable, ascending).
  - `STRING` columns are encoded from their first `STRING_RADIX_PREFIX_CHARS`
    (4) UTF-16 code units, 2 per word (`buildStringPrefixWords`); shorter
    strings are zero-padded, which sorts before any real character.
    Values that collide on this prefix fall into a tie-break group that is
    resolved with a direct `a < b` comparison (never `localeCompare`),
    then by row key.
  - Both paths share one generic LSD radix engine (`radixSortIndices`):
    a counting sort per byte (least-significant first), yielding to the
    event loop after every byte pass via `setImmediate` so a single sort
    never blocks the UI thread for more than one pass's worth of work,
    regardless of result-set size.
  - `NULL`/`undefined` values are split out before radix encoding (they
    have no bit/character representation to sort on) and placed first
    (ascending) or last (descending) after sorting the rest, matching
    native SQL `ORDER BY` semantics.
  - The sorted result is written back into the *same* `RowEntry[]`
    array in place rather than replacing `this._allRows` with a new
    array reference, so `fileState.rows` (captured once per query in
    `_fileStates`, used to restore state when switching between SQL file
    tabs) stays in sync with the sorted order instead of silently
    reverting to the pre-sort order on tab switch.
- Multi-column sorts (Shift+click, i.e. `_sortCriteria.length > 1`) remain
  out of scope for the radix path and continue to use a stable, chunked
  merge sort (`mergeSortRows`), also yielding periodically via
  `setImmediate`. The comparator for each active criterion (number vs.
  string) is now selected once before the sort starts rather than
  re-checked on every single comparison inside the loop.
- Sorting is cancellable: `_sortGeneration` is incremented at the start
  of every `applySort()` call, and both the radix and merge-sort paths
  check it after each yield, discarding their result instead of writing
  into `_allRows` if a newer sort (or a fresh query) started in the
  meantime. `performSort` additionally re-checks the generation after
  `applySearchFilter()` completes, since a newer sort can start while the
  (independently generationed) search filter is still running.

## 1.1.12

### Changed
- `highlightMatchesOnCurrentPage` (`search.js`) no longer sweeps every
  cell on the page to add/remove search `<mark>`s. Since search
  results are always a subset of the already-rendered
  `State.cachedGrid`, which cells are currently highlighted is now
  tracked explicitly in a new `State.searchHighlightedCells` (a `Set`
  of `"row-col"` positions) instead of the old boolean
  `State.hasHighlights`. Each call only touches cells whose status
  actually changed (newly matching, or previously matching but no
  longer): newly matching cells get wrapped in `<mark>`, no-longer-
  matching cells are reverted to plain text, and cells that were
  never a match are left completely untouched - same DOM node, same
  children, no rewrite. `messageHandler.js`'s `appendData` handler
  now checks `searchHighlightedCells.size` instead of the removed
  `hasHighlights`. No visible behavior change; added a regression
  test (`search.test.js`) asserting via DOM node identity that an
  unmatched cell's text node reference never changes across repeated
  searches and a clear.

## 1.1.11

### Fixed
- Copying to clipboard no longer merges unrelated row/column/cell
  selections into one sparse rectangle. Previously, selecting e.g. a
  whole row and then a single cell elsewhere copied a rectangle
  spanning all their rows and columns (mostly empty), instead of
  just the cell. Selection state now tracks which of the three
  types (row/col/cell) was most recently touched
  (`State.selectionTypeOrder`, maintained by new `selection.js`),
  and Ctrl+C copies only that type's positions
  (`getActiveClipboardPositions`). Other selections remain visually
  active as a reference point (e.g. keeping a row highlighted while
  copying a cell from it) but are excluded from the copied text.
  If the active type's selection is cleared, copying falls back to
  the previously active type.

## 1.1.10

### Changed
- Reduced redundant DOM work when refreshing sort-indicator arrows.
  `renderHeaders` (`tableRenderer.js`) now sets each header's sort
  glyph (`⇅`/`▲`/`▼`, plus priority number for multi-column sorts)
  directly while building the header DOM, using a
  `Map<columnIndex, {direction, criterionIndex}>` built from
  `State.sortCriteria` instead of a full follow-up
  `updateSortIndicators()` pass with `criteria.findIndex()` per
  column. `updateSortIndicators()` itself was switched to the same
  `Map`-based lookup. In `messageHandler.js`'s `appendData` handler,
  the trailing `updateSortIndicators()` call is now skipped whenever
  the header was just freshly rendered by `renderHeaders()` in that
  same pass, and still runs when the existing header DOM is reused
  as-is (e.g. after a sort click on an unchanged result shape) or
  restored from cache for a different file/tab. No visible behavior
  change.

## 1.1.9

### Added
- Column sorting in the SQL results grid. Click the sort arrow in a column
  header to cycle asc -> desc -> none (`SqlResultsProvider.toggleSort`,
  `applySort`). Shift+click adds/updates/removes that column as an
  additional sort criterion without disturbing existing ones, enabling
  multi-column sorting (`ORDER BY col1, col2, ...`); when more than one
  criterion is active, the header arrow shows its priority number (e.g.
  `▼1`, `▲2`). Sorting is applied on the backend (`_sortCriteria`) before
  the search filter, persists per SQL file, and survives reruns of the
  same query. New `sorting.js` webview module and `.sort-indicator`
  header markup (`tableRenderer.js`, `styles.css`).

### Fixed
- `compareForSort` now treats `NULL` the way native SQL `ORDER BY` does
  (smallest possible value: first on ascending, last on descending)
  instead of always placing it last regardless of direction.

## 1.1.8

### Changed
- `SqlResultsProvider.saveColumnEdits` and the independently-selected-cell
  bulk update path no longer show a `showInformationMessage` popup on
  success (`✅ Updated ... record(s) in ...`). Error notifications on
  failure are unchanged.

## 1.1.7

### Changed
- `SqlResultsProvider.performSearch` now trims the search query once, at
  the source, instead of leaving it untrimmed in `_searchQuery` and
  re-trimming it separately in every consumer. `applySearchFilter`
  (backend row matching) and `highlightMatchesOnCurrentPage`
  (`media/search.js`) no longer call `.trim()` themselves - they read the
  already-trimmed value. As a side effect, a whitespace-only search query
  no longer makes the "N record(s) matching the current SQL results and
  search filter" confirmation message claim a filter is active when
  `applySearchFilter` would have treated it as empty anyway.

## 1.1.6

### Changed
- Sped up search UI updates in the webview: `highlightMatchesOnCurrentPage`
  (`media/search.js`) now skips rewriting every cell on the page when there
  is no active search query and the page has no leftover highlights to
  clear, tracked via a new per-file `hasHighlights` flag in `State`
  (`media/state.js`). Also, `restoreSearchUI()` is no longer called at all
  after `appendData` when the same file has no active search and nothing to
  restore, since the input/count/clear-button are already kept in sync by
  the search input's own `input` listener in that case. The
  `showResultsForFile` tab-switch path is unchanged and always calls
  `restoreSearchUI()`, since the shared search input/count DOM may still
  reflect a different, previously viewed file.

## 1.1.5

### Fixed
- Cell-group edit previews are now applied only to the rows that were
  actually edited. Pending cell edits are identified by the stable row
  key and column instead of page-relative row and column coordinates,
  so switching between pages no longer displays edit previews for
  unrelated rows.

## 1.1.4

### Added
- Bulk edit for independently selected cells, in addition to the
  existing whole-column bulk edit (which is unchanged). Select two
  or more cells, double-click one of them, type a value and press
  Enter - the value is staged as a preview for the whole selection
  instead of being saved immediately (`State.pendingCellEdits`), and
  committed via the new "Save cells"/"Cancel cells" toolbar buttons.
  On save, `SqlResultsProvider.saveCellEdits` groups the staged
  cells by row (one `UPDATE` with multiple `SET` per row) and merges
  rows sharing the exact same set of edited columns into a single
  `UPDATE ... WHERE pk IN (...)`, to minimize the number of executed
  statements.

### Fixed
- Double-clicking a cell that was already part of a multi-cell
  selection collapsed the selection down to that one cell before the
  group edit could start, because the browser fires a plain `click`
  (detail=1) before `dblclick`. The collapse is now deferred by
  ~300ms and cancelled if a `dblclick` follows on the same cell.
- `highlightMatchesOnCurrentPage` (search.js) was missing the guard
  for the new `cell-edit-pending` class (it already had one for
  `column-edit-pending`), so a pending cell-group edit's preview was
  silently wiped when switching away from a file's tab and back,
  even with no active search query.
- Re-running the exact same SQL query on the same page no longer
  discards a pending cell-group edit; it's reapplied instead,
  mirroring the existing behavior of column bulk edits
  (`reapplyPendingCellEdits`).

## 1.1.3

### Added
- A "Cancel" button now sits next to "Save" in the bulk column-edit
  toolbar (`cancelColumnEditsBtn`), letting you discard all pending
  column edits without saving.

### Changed
- Deselecting a column no longer discards its pending bulk edit. The
  preview and the Save/Cancel buttons stay visible until you either
  save or explicitly cancel, so you can freely select/deselect
  columns while composing edits across several of them.

## 1.1.2

### Fixed
- The information popup shown after updating a cell (`✅ Updated
  table.column (pk)`) has been removed, as it could appear over the
  SQL results grid and get in the way while editing multiple cells
  in a row.

## 1.1.1

### Added
- A search box in the SQL results toolbar filters the grid to rows
  containing the typed text (case-insensitive, any column), with
  matched text highlighted in the visible cells. Search state
  (`_searchQuery`/`_filteredEntries`) is tracked per file, so it
  survives tab switches and query re-runs, and is recomputed after
  row deletes and bulk column edits (which are scoped to the filtered
  subset when a search is active). Rows continue to be addressed by
  their existing stable `.key` regardless of whether a filter is
  active - no special-casing needed in `updateCellInDB`,
  `deleteRowsInDB`, or `resolveSelectedRows`.
- Filtering a large result set no longer blocks the extension host:
  `applySearchFilter()` processes rows in batches, yielding to the
  event loop between them, and a generation counter cancels a search
  as soon as a newer one (or any other change to the underlying rows)
  supersedes it - so typing a new character interrupts a still-running
  search instead of waiting for it to finish.
- The search input now shows a small spinner if a search takes longer
  than ~150ms, and a clear ("x") button that empties the field and
  re-runs the search immediately, bypassing the input's debounce.

### Changed
- Search input debounce reduced from 300ms to 150ms, now that a new
  search cancels an in-flight one instead of queuing behind it.

## 1.1.0

### Changed
- Rows in the SQL results grid are now addressed by a stable,
  permanent identifier instead of their position on the current page.
  `SqlResultsProvider` tracks each row as `{ key, data }` (`RowEntry`)
  instead of a plain array, with `key` assigned once when results are
  loaded and never reassigned to a different row, even after other
  rows are deleted. `updateCellInDB`, `deleteRowsInDB`, and
  `resolveSelectedRows` now look rows up by this key instead of
  converting a page-relative row index to a position in the full
  result set. The webview mirrors this: `State.currentRows` now holds
  `{ key, data }` entries instead of two separate arrays
  (`currentRows`/`currentRowKeys`) that had to be kept in sync by
  hand. No user-visible behavior change.

## 1.0.24

### Changed
- The data grid (`#gridContainer`) now uses a monospace font instead
  of the default UI font. It reads `--vscode-editor-font-family` so
  it matches the user's editor font settings, with Consolas, Ubuntu
  Mono, DejaVu Sans Mono, Menlo, and Monaco as fallbacks for
  Windows/Linux/macOS, and a generic `monospace` as last resort.

## 1.0.23

### Fixed
- Running a SQL query ending in `;` followed by a Windows-style
  line ending (CRLF) appended `LIMIT 200` after the semicolon
  instead of replacing it, producing a syntax error. `select 1;`
  worked fine, but the same query with a trailing CRLF (common in
  Windows-saved files) did not. `SqlUtil.appendLimit` now trims
  trailing whitespace before removing the semicolon.
- Query-boundary detection (`findCurrentQuery`/`findAllQueries`) and
  multi-statement "Format SQL" now correctly split on CRLF (Windows)
  and CR (old Mac) line endings, not just LF, so running or
  formatting SQL files is no longer Linux-only in behavior.
- "Format SQL" no longer converts the whole file to LF line endings;
  it now preserves the original CRLF/CR/LF style of the file/
  selection being formatted.

## 1.0.22

### Added
- "Format SQL" (`Ctrl+Shift+F` with a selection, or the command
  palette) now also supports formatting the whole file when nothing
  is selected, and formatting a selection that spans multiple SQL
  statements. Each statement is formatted independently, and the
  original number of blank lines between statements (and before/after
  the whole block) is preserved. Formatting a single selected
  statement is unchanged.

### Changed
- `executeQueryWholeFile` (used by "Run SQL Whole File") now shares
  its statement-splitting logic with the new multi-statement SQL
  formatting via a new `findAllQueries()` helper, instead of having
  its own separate loop. No behavior change for running queries.

## 1.0.21

### Fixed
- Running a different SQL query in the same file, then re-running an
  earlier query, no longer requires clicking a column header or cell
  twice to select it. The grid rebuild only cleared the row selection
  Set (`selectedRowIndexes`), leaving stale entries in
  `selectedColIndexes`/`selectedCellPositions` that didn't match the
  freshly rebuilt DOM (no `selected-col`/`selected-cell` class), so
  the first click was interpreted as deselecting an already-selected
  column/cell instead of selecting it. Added `clearColumnSelection()`
  and `clearCellSelection()`, called alongside `clearRowSelection()`
  whenever the grid is rebuilt for a new/different query.

## 1.0.20

### Fixed
- Running a different SQL query in the same file no longer leaves
  the row tools buttons (generate INSERT/UPDATE/DELETE, delete rows)
  visible from the previous selection. `stopToolsBtn()` was called
  after `clearRowSelection()` had already emptied the selection Set,
  so its "nothing is selected, nothing to hide" check always fired
  and skipped hiding the buttons in the DOM.

## 1.0.19

### Fixed
- Replaced the 1.0.18 fix, which detected a cancelled connection
  change by matching the error message text
  ("No DB connection selected"), a fragile check that would break
  silently if that string ever changed. `RecentSqlFiles` now uses
  the existing `isOnlyUpdate` flag to tell an in-place connection
  change apart from an initial selection: cancelling (ESC) while
  changing an already-selected connection returns the previous
  connection name directly instead of throwing, so
  `SqlResultsProvider.changeConnection()` no longer needs to inspect
  the error message at all.

## 1.0.18

### Fixed
- Cancelling a connection change (pressing ESC in the connection
  picker) no longer shows a "Change connection error: No DB
  connection selected" error message. This was a deliberate user
  action, not an actual error, so the panel now just silently
  keeps the previous connection.

## 1.0.17

### Changed
- Reduced vertical whitespace in the results panel toolbar to reclaim
  screen space: removed the gap above the toolbar content (connection
  name, timers, buttons), removed the gap between the toolbar and the
  results table below it, and removed the separator line that used to
  sit between them. The two duplicate `.toolbar` rule definitions in
  `styles.css` were also merged into one.

## 1.0.16

### Fixed
- Switching the bottom panel's active tab from "SQL" to something
  else, such as the terminal, no longer gets undone by clicking
  between open editor files. Previously, `hasOpenPanel` couldn't tell
  "panel open, but on another tab" apart from "panel actually
  closed", so switching files would either force the panel back to
  the SQL results tab or close the panel outright, stealing focus
  from the tab the user had manually selected. `hasOpenPanel` is now
  `boolean | null`, with `null` tracking the "on another tab" case via
  a new `onDidChangeVisibility` listener, and both the active-editor
  handler and `stopExtension` only act on the panel when it's
  genuinely open and focused on the SQL results tab.

## 1.0.15

### Reverted
- Reverted the 1.0.14 fix for `hasOpenPanel` being reset whenever the
  active editor changed away from a `.sql` file. The change is being
  rolled back and will be revisited in a future release.

## 1.0.14

### Fixed
- Switching to a `.sql` file with existing results always force-showed
  the SQL results panel, even if the user had manually switched the
  bottom panel to something else, such as the terminal. This happened
  because `hasOpenPanel` was reset to false whenever the active editor
  changed away, regardless of whether the panel was actually closed,
  desyncing the flag from the real panel state. `hasOpenPanel` is now
  only updated when the panel is actually closed, and the results view
  is only re-shown when the panel isn't open yet or the results view
  is the one currently focused.

## 1.0.13

### Fixed
- Closing the last open `.sql` tab unconditionally closed the bottom
  panel, even when the SQL results panel wasn't the one actually
  showing there. This could force-close unrelated content docked in
  the same area, such as the terminal, whenever it happened to be
  open at that moment. The panel is now closed only when the SQL
  results view was actually open and visible, matching the same
  guard already used when switching editors.

## 1.0.12

### Fixed
- Switching to a `.sql` file that had never had a query run on it kept
  the results panel open with a cleared grid instead of closing it,
  because the active-editor listener treated any `.sql` file as a
  case to keep the panel around, with `hasResultsForFile` only
  deciding whether to also refresh its content. Simplified the
  listener's condition so a `.sql` file without existing results is
  now treated the same as switching to any non-SQL file, closing the
  panel.

## 1.0.11

### Fixed
- Switching to a `.sql` file that had never had a query run on it left
  the results panel showing data from the previously active file. The
  active-editor listener only handled the case of switching to a file
  with existing results or to a non-SQL file; a `.sql` file with no
  results yet fell through both branches and did nothing. The panel is
  now cleared in that case as well.

## 1.0.10

### Fixed
- hasOpenPanel could be incorrectly set to true as soon as the results
  view container became visible, even if no SQL query had ever been
  run. This happened because visibility was tracked via a separate
  event listener that couldn't distinguish an empty view being shown
  from actual results being displayed. Panel visibility is now checked
  directly at the point the panel would be closed, instead of being
  tracked as a standalone flag.
- Clearing the active file on every switch to a non-SQL file no longer
  unconditionally triggers closePanel; the panel is now closed only
  when it was actually open and currently visible.

## 1.0.9

### Fixed
- hasOpenPanel could go stale when the panel was shown or hidden
  manually (closing it, reopening it, or switching the bottom panel
  to another view such as the terminal) without changing the active
  editor, since it was only updated by the extension's own actions.
  This could cause an unrelated view docked in the same panel area to
  be force-closed on the next file switch. The panel's visibility
  state is now tracked directly, so it always reflects whether the
  SQL results view is the one currently showing.

## 1.0.8

### Fixed
- Switching to a non-SQL file (or a new empty tab) unconditionally
  closed the bottom panel, even when the SQL results panel wasn't
  actually open there. This could force-close unrelated content
  docked in the same area, such as the terminal, whenever it happened
  to be open. The panel is now closed only when it was the extension
  itself that last opened it.

## 1.0.7

### Fixed
- The SQL results panel stayed open at the bottom of the screen after
  switching to a non-SQL file (or a new empty tab), covering part of
  the editor, because clearing the active file only cleared its
  content without actually closing the panel. Switching to a
  different file now closes the panel; switching back to a SQL file
  that already has tracked results reopens it automatically.

## 1.0.6

### Fixed
- The results panel's "change connection" action refused to do
  anything if no SQL results were currently loaded (e.g. right after
  starting the extension, before running any query), because it
  required an already-tracked results file. It now falls back to the
  active SQL editor in that case, matching the connection to whichever
  file the change should apply to.

## 1.0.5

### Fixed
- SQL results panel stayed visible and fully interactive (editing cells,
  deleting rows, generating INSERT/UPDATE/DELETE, changing connection)
  after switching to a new empty tab (Ctrl+N) or to a file that isn't
  SQL, since it only updated when a *SQL* editor became active. The
  panel now clears itself as soon as the active editor is not a `.sql`
  file, and no longer lets you act on results that no longer correspond
  to any visible SQL tab.
- The list of recent SQL files could get polluted with a non-SQL file
  path (e.g. an empty untitled tab), because the fallback used to
  determine "the current SQL file" read the active editor without
  checking its language, so any action taken while a non-SQL tab was
  focused (such as the panel's own "change connection" button) could
  register that file as if it were a SQL file.
- Actions that write to the database from the results panel (editing a
  cell, deleting rows, bulk column edits, changing connection) could
  resolve the database connection from whatever editor happened to be
  active at the moment the action ran, instead of the connection that
  actually produced the results being edited. They now always use the
  connection saved together with the displayed file's results.

## 1.0.4

### Fixed
- SQL results: the row-number ("#") cell appeared visibly darker than the rest of the row on hover and on selection. The LP cell has its own opaque background, and the fix for it was re-applying the same theme color on top of the row's already-colored background — on themes where that color has alpha transparency, this double layering made it darker than the single layer used by the other cells. The LP cell now goes transparent in these states instead, letting the row's background show through consistently.

## 1.0.3

### Fixed
- Fixed `cursor: pointer` disappearing on a table row after it was selected (it only worked on hover, which was excluded for selected rows). The pointer cursor is now applied consistently to the whole row, except for the row-number ("#") column, which is not clickable.

## 1.0.2

### Fixed
- SQL results: row selection from a previous query result could
  incorrectly persist after running a different SQL query on the same
  file. A subsequent click on the row at the same page-relative index
  was misread as deselecting an already-selected row instead of
  selecting it. Row selection is now cleared whenever the query
  actually changes, while still being preserved when the exact same
  query is re-run (e.g. a refresh).

## 1.0.1

### Fixed
- SQL results: when "Require Connection Name Confirmation" is
  enabled and a destructive column edit is confirmed with a wrong
  connection name, the input box no longer closes and cancels the
  operation immediately — it now stays open and shows a validation
  error, letting the user correct the typed name before retrying.

## 1.0.0

### Fixed
- SQL results: generating INSERT/UPDATE/DELETE for a selected row no
  longer fails with "Not all PRIMARY KEY columns are present" when
  the SELECT list duplicates a column (e.g. `SELECT f.id, f.name,
  u.username, f.*`).

### Changed
- SQL results: cell editing, row deletion, and SQL generation now
  share the same primary-key column resolution logic, so they can no
  longer drift apart in how they locate PK columns in the result set.

## 0.3.25

### Added
- Recent SQL files list (F3): added a filter button that narrows the
  list down to one or more selected connections, with matching
  colored icons in the picker.
- Recent SQL files list (F3): added a quick-filter button that
  instantly filters the list to the currently active connection with
  a single click.

## 0.3.24

### Added
- Recent SQL files list (F3): each entry now shows a colored icon
  matching the connection's color defined in `ConnectionColors`,
  making it easier to tell connections apart at a glance.

## 0.3.23

### Added
- Recent SQL files list (F3) now supports multi-select: check multiple files with checkboxes and open them all at once with Enter.

### Changed
- Recent SQL files list (F3) highlights the first item by default; pressing Enter without checking any checkbox opens the currently highlighted file, just like before.

## 0.3.22

### Changed
- `extension.ts`: removed unused imports (`startExtension`, `ConnectionManager`).
- `extensionLifecycle.ts`: removed the unused `context` parameter from
  `startExtension()` and `safeStartExtension()`, since it was never
  actually read inside the function body.
- `runSqlCommand.ts`, `runSqlWholeFileCommand.ts`: removed the `context`
  parameter, which was only being forwarded to `safeStartExtension()`
  and is no longer needed after the change above.

## 0.3.21

### Added
- `CompletionUpdate.ts`: suggests `USE INDEX` / `FORCE INDEX` /
  `IGNORE INDEX` right after a table name (and optional alias) in
  `UPDATE` statements, before `SET` - covers the single-table form,
  comma-separated multi-table form (`UPDATE t1, t2 SET ...`), and
  JOIN-based multi-table form (`UPDATE t1 JOIN t2 ... SET ...`), since
  MySQL allows an index hint per table in all three.
- `CompletionDelete.ts`: suggests `USE INDEX` / `FORCE INDEX` /
  `IGNORE INDEX` in the `FROM` clause of multi-table `DELETE` statements
  (`DELETE t1 FROM t1 ...` / `DELETE t1, t2 FROM t1, t2 ...`), including
  after `JOIN`-ed and comma-separated tables. Deliberately excluded for
  single-table `DELETE FROM tbl ...`, since MySQL rejects index hints
  there (syntax error) - only the multi-table form supports them.
- `CompletionSelect.ts`: suggests `USE INDEX` / `FORCE INDEX` /
  `IGNORE INDEX` after comma-separated tables in the `FROM` clause
  (`FROM t1, t2 USE INDEX (...)`), in addition to the previously
  supported `FROM`/`JOIN` case.
- New shared module `completion/indexHints.ts` consolidating the
  regexes/constants used to detect and suggest index hints across
  `CompletionSelect`, `CompletionUpdate`, and `CompletionDelete`.

### Fixed
- `CompletionUpdate.ts`: a bare `LOW_PRIORITY`/`IGNORE` modifier typed
  before any table name (e.g. `UPDATE LOW_PRIORITY IGNORE `) could be
  mistakenly parsed as if `IGNORE` were the table name, incorrectly
  triggering index hint suggestions.
- `CompletionUpdate.ts`, `CompletionDelete.ts`, `CompletionSelect.ts`:
  when a query has several tables each with their own open index hint
  parens at once (e.g. `FROM t1 USE INDEX (), t2 USE INDEX (`), the table
  resolution used to combine multiple regexes with `??`, which always
  picked the first *matching* pattern rather than the one actually
  closest to the cursor - so suggestions could resolve to the wrong
  table (e.g. `t1`'s indexes while the cursor was inside `t2`'s parens).
  Replaced with `extractClosestPrecedingTableName()`, which considers
  all candidate matches and picks the one ending closest to the cursor.
- `CompletionSelect.ts`: verified and added regression test coverage for
  index hint suggestions inside subqueries and derived tables (`FROM
  (SELECT ...)`, correlated subqueries in `WHERE ... IN (...)`, and
  nested subqueries) - already worked correctly thanks to the
  tokenizer-based, depth-aware clause detection, no production code
  change was needed there.

## 0.3.20

### Fixed
- Restored `README.md`, `CHANGELOG.md`, and `LICENSE` in the packaged
  `.vsix`. Excluding them broke the Marketplace page: vsce reads these
  files locally at package time to populate the description, changelog
  tab, and license tab - it doesn't fetch them from GitHub. `images/**`
  stays excluded, since vsce rewrites its relative README/CHANGELOG
  image links to GitHub raw URLs automatically.

## 0.3.19

### Changed
- Reduced packaged extension size: `README.md`, `CHANGELOG.md`, `LICENSE`,
  and `images/**` are no longer bundled into the `.vsix` - all of them
  already live in the GitHub repository.

## 0.3.18

### Fixed
- `ConnectionManager.ts`: `stop()` (fired when the last SQL tab closes,
  or on extension deactivate) now also resets `lastShownConnectionError`
  along with the connection cache. Previously this map survived a
  stop/restart cycle, so if a connection failed again with the same
  error message after reconnecting, the friendly error popup could stay
  suppressed even though it was effectively a new connection attempt.
- `media/messageHandler.js`: on `queryFinished` with an error, the grid
  container is now hidden (`stopGridContainer()`) in addition to the
  loading spinner. Previously, if a prior query had already rendered
  results, those stale rows stayed visible behind/alongside the new
  error message instead of being cleared.

## 0.3.17

### Fixed
- `ConnectionManager.ts`: the friendly connection-error popup in `getDb()`
  used to remember only whether it had already been shown for a given
  connection name, not what the error actually was. This meant that
  after the first shown error, any later, genuinely different error for
  the same connection name (e.g. fixed the host but the user is still
  wrong) was silently swallowed and never reached the user. Now tracks
  the last shown error message per connection name and only skips
  re-showing the popup when the message is identical to the previous
  one - so real, changed errors always surface, while near-simultaneous
  duplicate popups (e.g. autocomplete's auto-trigger and a manual
  Ctrl+Space firing `getDb()` twice for the same failure) stay deduped.

## 0.3.16

### Changed
- `ConnectionManager.ts`: moved the friendly connection-error handling
  (native error popup with an "Edit X.cnf" action opening the config
  file) from `SqlResultsProvider`'s query-execution flow directly into
  `getDb()`. Every caller of `getDb()` now shows this same friendly
  error consistently - most notably autocomplete
  (`TableCompletionProvider`), which previously failed silently with
  only a `console.error` and gave no feedback about a broken DB
  connection while typing suggestions.
- `SqlResultsProvider.ts`: removed the now-redundant error-popup logic
  from the query-execution catch block. Plain SQL execution errors
  (e.g. syntax errors) no longer show the "Edit .cnf" button, which
  was misleading there - they still surface inline in the results
  panel as before.

### Fixed
- `ConnectionManager.ts`: renamed the local `path` variable in `getDb()`
  to `cnfFile`, since it shadowed the imported `path` module now needed
  there for `path.basename()`.

## 0.3.15

### Added
- `CompletionInsert.ts`: added keyword suggestions for the `LOW_PRIORITY`,
  `DELAYED`, `HIGH_PRIORITY` and `IGNORE` modifiers right after `INSERT`,
  merged with the existing table/schema suggestions - mirrors the
  `DISTINCT`/`ALL` modifier-zone pattern already used for `SELECT`.
  `LOW_PRIORITY`/`DELAYED`/`HIGH_PRIORITY` are mutually exclusive with
  each other; `IGNORE` is independent. All table/column/`VALUES`/`SET`/
  `ON DUPLICATE KEY UPDATE` regexes now tolerate these modifiers
  appearing before the table name.
- `CompletionReplace.ts`: same treatment for `REPLACE`, with its
  narrower modifier set (`LOW_PRIORITY` / `DELAYED`, mutually exclusive).
- `CompletionUpdate.ts`: added keyword suggestions for `LOW_PRIORITY`
  and `IGNORE` right after `UPDATE` (both independent), merged with the
  existing table/schema suggestions. Modifiers are only offered before
  the first table, never leaking into a later `JOIN` section.
- `CompletionDelete.ts`: added keyword suggestions for `LOW_PRIORITY`,
  `QUICK` and `IGNORE` right after `DELETE` (all independent), merged
  with the existing table/schema suggestions.
- `sqlKeywords.ts`: added full documentation for `LOW_PRIORITY`,
  `DELAYED`, `IGNORE` and `QUICK`; extended `HIGH_PRIORITY`'s
  documentation to also cover its `INSERT` usage.

### Fixed
- `CompletionUpdate.ts` / `CompletionDelete.ts`: `REGEX_UPDATE_OBJECT`
  and `REGEX_DELETE_OBJECT` started with a `\b` word-boundary anchor,
  which never matches an empty string. This silently skipped all
  table/modifier suggestions whenever the cursor sat on a new line with
  only indentation before it (e.g. right after `UPDATE`/`DELETE` on its
  own line). Removed the leading `\b` from both regexes.

### Tests
- Added coverage in `CompletionInsert.test.ts`, `CompletionReplace.test.ts`,
  `CompletionUpdate.test.ts` and `CompletionDelete.test.ts` for the new
  modifier suggestions (offering, filtering, mutual exclusion where
  applicable, and the modifier zone ending at the right place), plus a
  regression test in `CompletionUpdate.test.ts` and
  `CompletionDelete.test.ts` for the new-line/indentation-only cursor case.

## 0.3.14

### Added
- `sqlKeywords.ts`: added full MariaDB-style documentation (syntax, description,
  full syntax, examples) for the SELECT modifier keywords `ALL`, `DISTINCT`,
  `DISTINCTROW`, `HIGH_PRIORITY`, `STRAIGHT_JOIN`, `SQL_SMALL_RESULT`,
  `SQL_BIG_RESULT`, `SQL_BUFFER_RESULT`, `SQL_NO_CACHE` and `SQL_CALC_FOUND_ROWS`,
  in the same format already used for function completions in `sqlFunctions.ts`.

### Changed
- `CompletionAbstract.ts`: `createKeywordItem` now shows the full markdown
  documentation for keywords listed in `SQL_KEYWORDS` instead of the generic
  `SQL Keyword` detail, which previously pushed the heading below where it
  appears for functions.

## 0.3.13

### Fixed
- `CompletionSelect.ts`: `REGEX_INDEX_HINT_KEYWORD` and `REGEX_INDEX_HINT_TABLE`
  only matched a bare `\w+` table name, so `USE`/`FORCE`/`IGNORE INDEX` suggestions
  (and resolving the table for real index names inside the parens) never triggered
  when the table was schema-qualified (e.g. `FROM schema.users |`). Both regexes now
  accept an optional non-capturing `schema.` prefix before the table name.

### Tests
- Added coverage in `Completion.test.ts` for index-hint keyword suggestions and real
  index-name resolution when the table in `FROM` is schema-qualified (with and without
  an alias).

## 0.3.12

### Changed
- `TableIndexesCache.ts` / `query.ts`: index lookups now fetch `NON_UNIQUE` and
  per-column `COLUMN_NAME`/`SEQ_IN_INDEX` from `INFORMATION_SCHEMA.STATISTICS` instead of
  just distinct index names, and group the rows into a `TableIndex` carrying an index
  `type` (`primary` / `unique` / `index`) and its ordered `columns`.
- `CompletionAbstract.ts`: `createIndexNameItem` now shows the index type and its columns
  in the completion detail (e.g. `users · 🔑 PRIMARY KEY (id)`, `users · UNIQUE INDEX (email)`,
  `users · INDEX (last_name, first_name)`).
- `CompletionSelect.ts`: index suggestions inside `USE`/`FORCE`/`IGNORE INDEX (...)` are now
  sorted by their column list (e.g. `(aaa)` before `(aaa, bbb)` before `(bbb)`) instead of
  by index name.

### Tests
- Updated `makeIndex` test helper to include the new `type` and `columns` fields.

## 0.3.11

### Added
- `CompletionInsert.ts` / `CompletionReplace.ts`: added completion support for the alternative
  `INSERT INTO tbl SET col1 = val1, col2 = val2` / `REPLACE INTO tbl SET ...` syntax, which
  MySQL/MariaDB allows instead of `(columns) VALUES (...)`.
  - Right after the table name, `SET` is now suggested alongside the existing `(columns)` snippet.
  - Inside the `SET` clause, column names are suggested as `column = <default value>` snippets,
    reusing the same type-based default-value logic already used for the `VALUES (...)` row snippet
    (generated columns excluded, `NULL` for nullable/auto_increment columns, proper date/enum/numeric
    formatting, etc.).
  - Once the cursor is right after `=`, plain column-name suggestions are shown instead, without
    overriding with the `column = value` snippet.

### Changed
- `CompletionAbstract.ts`: extracted the per-column default-value token generation (previously
  duplicated in `CompletionInsert.ts` and `CompletionReplace.ts`) into a shared `buildDefaultValueToken`
  helper, reused by both the `VALUES (...)` row snippet and the new `SET` clause snippets.

### Tests
- Added dedicated test suites for the new `SET` syntax in `CompletionInsert.test.ts` and
  `CompletionReplace.test.ts` (column suggestions after `SET`, prefix filtering, multi-column
  completion after a comma, no snippet override right after `=`, schema-qualified tables).
- Updated the existing "column list in parentheses" tests to account for the new `SET` keyword
  suggestion shown alongside the `(columns)` snippet right after the table name.

## 0.3.10

### Fixed
- `CompletionUpdate.ts`: `updateSetRegex` required a literal `SET` in the
  text, so while the cursor was still inside a `JOIN ... ON` clause (before
  `SET` was typed) the main table right after `UPDATE` was never added to
  `allTableRefs` - `findQueryTables` only matches `FROM`/`JOIN`. Column
  suggestions for that table's alias silently returned nothing. The regex
  now falls back to the end of the string when `SET` is absent, matching
  the pattern already used in `CompletionDelete.ts`.
- `CompletionUpdate.ts` / `CompletionDelete.ts`: the keyword list used to
  reset the table-name filter after a `JOIN` keyword was missing `right`,
  `outer`, `cross`, and `straight_join`, so e.g. typing `RIGHT ` was
  treated as a text filter instead of resetting to the full table list.

## 0.3.9

### Added
- `CompletionSelect.ts`: `FROM`/`JOIN` now suggests MySQL/MariaDB index
  hints right after a table name or alias (`USE INDEX`, `FORCE INDEX`,
  `IGNORE INDEX`), inserted as a snippet that opens the parenthesis and
  places the cursor inside it. Once inside `USE/FORCE/IGNORE INDEX (`,
  real index names are suggested for that specific table, fetched from
  `INFORMATION_SCHEMA.STATISTICS` and cached the same way table columns
  already are. When a query has several `JOIN`s each with their own
  hint, the suggested index names always resolve to the table closest
  to the open parenthesis. New `TableIndexesCache` (`src/cache/`) and
  `getTableIndexesBatch` (`src/db/query.ts`) mirror the existing
  `TableColumnsCache`/`getTableColumnsBatch` pattern; `CompletionAbstract.ts`
  gains an optional `tableIndexesService` plus `createIndexHintKeywordItem`/
  `createIndexNameItem` helpers, wired up only for `CompletionSelect`.

### Fixed
- `CompletionSelect.ts`: the open parenthesis of `USE/FORCE/IGNORE INDEX (`
  raised the cursor's nesting depth, which made `detectCurrentClause` stop
  seeing the enclosing `FROM` (sitting at depth 0) - the same class of
  problem `isCursorInsideFunctionCall` already solves for `HAVING`. Index
  hint detection now runs independently of the standard clause detection.

## 0.3.8

### Added
- `sqlFunctions.ts`: added `FOUND_ROWS()` to the *Information & System*
  function list, so it now appears in `SELECT`-list completions
  alongside `LAST_INSERT_ID()`, `USER()`, and `DATABASE()`.

## 0.3.7

### Added
- `CompletionSelect.ts`: the `SELECT` clause now suggests `DISTINCT` and
  the other MySQL/MariaDB modifiers valid right after `SELECT` (`ALL`,
  `DISTINCTROW`, `HIGH_PRIORITY`, `STRAIGHT_JOIN`, `SQL_SMALL_RESULT`,
  `SQL_BIG_RESULT`, `SQL_BUFFER_RESULT`, `SQL_NO_CACHE`,
  `SQL_CALC_FOUND_ROWS`). A new `getSelectModifierContext` helper, built
  on the existing tokenizer, detects whether the cursor is still in the
  "modifier zone" between `SELECT` and the first real select-list
  expression - suggestions stop as soon as a column, `*`, comma, or
  parenthesis appears, already-used modifiers are excluded, and the
  partially typed word (e.g. `SELECT DIS|`) is used to filter the list.
  `CompletionAbstract.ts` gains a `createKeywordItem` helper for these
  entries.

## 0.3.6

### Added
- `CompletionSelect.ts`: `GROUP BY`/`ORDER BY` now also suggest aliases
  from the `SELECT` list (e.g. `SELECT id xxx FROM customer GROUP BY x|`
  now offers `xxx`), reusing the same select-list-candidate extraction
  already used for `HAVING`. A candidate is skipped when its name is
  already covered by a real column just loaded for the query's tables,
  so a plain, non-aliased column (`t.id`, `id`) never appears twice.

### Fixed
- `CompletionSelect.ts`: `FROM`/`JOIN` table and schema completion only
  matched against the current line's text (`linePrefix`), so it silently
  produced no suggestions whenever the keyword and the table name ended
  up on different lines (e.g. `FROM` on its own line, with the table name
  typed on the next one) - even though the clause itself was correctly
  detected as `FROM` via the (multi-line-aware) tokenizer. `REGEX_SCHEMA_TABLE`/
  `REGEX_FROM_OBJECT` now fall back to matching against the tail of
  `sqlBeforeCursor` starting at the detected clause, in addition to the
  single-line fast path.
- `CompletionSelect.ts` / `findQueryTables.ts`: identifiers quoted with
  backticks (the default MySQL/MariaDB quoting, commonly needed for
  reserved words like `` `order` ``) were never recognized by any of the
  `FROM`/`JOIN`/alias-dot regexes, all of which were built on plain `\w+`.
  `` `?...`? `` is now allowed around schema/table/alias segments
  everywhere those regexes are used; captured groups still contain the
  bare name, without backticks.
- `CompletionSelect.ts`: a second (or later) table in an old-style,
  comma-separated `FROM` list (`FROM t1, t2`) never got table/schema
  completion - the existing regexes only matched directly after the
  `FROM`/`JOIN` keyword itself. Added a comma-anchored fallback,
  restricted to when the cursor is actually inside a `FROM` clause (so a
  comma in the `SELECT` column list is never mistaken for a table
  separator).
- `CompletionSelect.ts`: `detectCurrentClause` looked at the token
  literally following `GROUP`/`ORDER`/`PARTITION` to confirm it was `BY`;
  a comment between the two keywords (e.g. `GROUP /* note */ BY`) made
  the clause undetectable, silently disabling completion for the rest of
  that clause. The lookup now skips over comment tokens.
- `CompletionSelect.ts`: `PARTITION BY` inside a window function
  (`OVER (PARTITION BY ...)`) wasn't a recognized clause at all (`PARTITION`
  was never added to `CLAUSE_WORD`), so it never got any column
  suggestions, regardless of nesting depth or a following comment.
  Added as its own clause, wired into the same column-suggestion branch
  as `SELECT`/`WHERE`/`GROUP BY`/`ORDER BY` - deliberately *not* into the
  new alias-suggestion behavior above, since a window function's
  `PARTITION BY` refers to source columns, not `SELECT`-list aliases.
- `TableCompletionProvider.ts` / new `findCteDefinitions.ts`: a query
  starting with `WITH` (a CTE) never reached any completion logic at all -
  the provider picks a handler by matching the query's first word against
  `select`/`insert`/`update`/`delete`/`replace`, and `with` matched none of
  them. The first word of the *main* statement (after skipping over all
  `WITH [RECURSIVE] name [(cols)] AS (...)` definitions) is now used for
  that routing instead, falling back to `select` if the `WITH` clause
  itself is still incomplete (e.g. an unclosed CTE body being typed).
- `CompletionSelect.ts` / `CompletionAbstract.ts`: once routing worked,
  a CTE's own alias (`WITH cte AS (...) ... FROM cte c WHERE c.|`) still
  resolved to nothing, because `findQueryTables` has no notion of CTEs
  and just treated `cte` as a literal (non-existent) catalog table name.
  CTE columns are now resolved from the CTE's own definition instead: an
  explicit column list (`WITH cte(a, b) AS (...)`) is used verbatim when
  given, otherwise columns are inferred from the CTE body's own `SELECT`
  list (same mechanism as the `GROUP BY`/`ORDER BY` alias suggestions
  above). Applies both to `alias.column` completion and to the general,
  no-dot column list.
- `CompletionSelect.ts` / `CompletionAbstract.ts` / new
  `findDerivedTables.ts`: the same problem as above, for an aliased
  derived table (a subquery used directly in `FROM`, e.g.
  `FROM (SELECT id, name FROM t) x`) - `x` isn't a `\w+` table name, so
  none of the alias-declaration regexes could ever match it, and `x.`
  resolved to nothing. Columns are now inferred the same way as for CTEs
  (explicit `AS x(a, b)` list if present, otherwise the subquery's own
  `SELECT` list); a derived table without an alias is ignored (invalid
  MySQL/MariaDB syntax anyway, since it can't be referenced).
- `findQueryTables.ts`: table-visibility scoping (`isAncestorScope`) was
  based purely on parenthesis nesting, with no notion of `UNION`/
  `UNION ALL`/`INTERSECT`/`EXCEPT` branches. Since every branch of a
  compound query sits at the *same* nesting depth, columns from one
  branch's tables leaked into completion for a sibling, unrelated branch
  (e.g. `SELECT id,name FROM customers UNION SELECT id,tax_id FROM
  suppliers WHERE |` also suggested `name`, which doesn't exist on
  `suppliers`). Scope tracking now also keeps a per-depth branch counter,
  incremented on each `UNION`/`INTERSECT`/`EXCEPT` and reset for every
  newly opened subquery; two positions are only in the same scope when
  both their paren nesting *and* their branch index match at every shared
  depth level, including the top-level query itself.

### Tests
- Extensive new coverage in `Completion.test.ts` for all of the above:
  multi-line `FROM`, backtick-quoted identifiers (table, schema, alias,
  and mixed with an unquoted declaration/reference on the other side),
  comma-separated table lists (including a negative check that a `SELECT`
  column-list comma is left alone), `GROUP`/`ORDER`/`PARTITION` split
  across a comment, `PARTITION BY` (including a negative check that it
  does *not* get alias suggestions), `GROUP BY`/`ORDER BY` alias
  suggestions (with and without `AS`, an aggregate expression, and
  negative checks for plain columns and for `WHERE`), CTEs (direct
  reference, aliased reference, explicit column list, `WITH RECURSIVE`,
  routing while the CTE body is still unclosed, and not mixing up a CTE
  with a real joined table), derived tables (dot reference, no-dot
  reference, explicit column list, `JOIN`/comma position, and not mixing
  up with a real joined table), and `UNION`/`UNION ALL`/`INTERSECT`/
  `EXCEPT` branch isolation (including a `UNION` nested inside an
  unrelated sibling subquery, and a correlated outer table staying
  visible inside a specific branch). Also updated one pre-existing
  derived-table test whose assertion happened to rely on the very gap
  being fixed here (columns it expected to stay hidden are now correctly
  exposed as the derived table's own output; the test was changed to
  check for a column the subquery doesn't select instead).

## 0.3.5

### Added
- SQL formatter (`formatSqlCommand.ts`): a subquery (any `(...)` whose
  content starts with `SELECT`) that would render on a line longer than
  160 characters is now broken onto its own, indented block instead of
  staying on one long line. If it still fits within 160 characters, it's
  left untouched, inline, exactly as before. When it doesn't fit, it's
  now fully reformatted with `formatStatement` (its own `SELECT`/`FROM`/
  `WHERE`/... on separate lines, `WHERE` conditions joined by `AND`/`OR`
  each on their own line, etc.) rather than just relocated as a single
  long line - so the result of breaking a subquery never itself still
  exceeds 160 characters. Nested subqueries are handled recursively, with
  indentation accumulating one extra level (`\t`) per nesting level; a
  level that already fits after its own inner subquery has been broken is
  left inline instead of being force-broken again. A plain `(...)` group
  that doesn't start with `SELECT` (e.g. an `IN (1,2,3,...)` list) is
  never treated as a subquery and is never wrapped, regardless of length.

### Fixed
- SQL formatter: `formatTableRef` (`FROM`/`UPDATE` + `JOIN`s) and
  `formatWhereLike` (`WHERE`/`HAVING`) concatenated their clause header
  (`FROM `, `WHERE `, `\tAND `, ...) onto the string returned by
  `renderTokens` instead of passing it in as the `initial` seed value,
  so any line-length calculation done inside `renderTokens` (such as the
  new subquery-wrapping check above) was short by the header's length.
  Both now pass the header through `renderTokens`'s existing `initial`
  parameter (the same mechanism already used by `GROUP BY`/`ORDER BY`/
  `LIMIT`), so line lengths are measured correctly.

### Tests
- Added regression coverage in `formatSqlCommand.test.ts` for the above:
  a short subquery in `FROM`/`WHERE` staying inline, the exact 160/161
  character boundary, a long subquery with an alias, a long subquery
  inside `WHERE ... IN (...)`, a subquery nested inside another subquery,
  a long non-subquery `IN` list intentionally staying inline, and a
  dedicated regression test for a subquery with a multi-`AND` `WHERE`
  clause that must be fully reformatted (not just relocated as one line)
  to stay within 160 characters per line.

## 0.3.4

### Fixed
- SQL formatter (`formatSqlCommand.ts`): `INSERT ... ON DUPLICATE KEY UPDATE`
  (upsert) was mis-segmented into clauses. `UPDATE` inside it was caught as a
  separate, standalone `UPDATE` clause (formatted like a real
  `UPDATE ... SET ...` statement), and `VALUES(col)` function calls used on
  the right-hand side of an assignment were mistaken for a second `VALUES`
  clause boundary - together splitting e.g. `id = VALUES(id)` across two
  lines with a line break right after `=`. `ON DUPLICATE KEY UPDATE` is now
  recognized as its own four-word clause header (new
  `ClauseName.OnDuplicateKeyUpdate`), and a `VALUES` immediately preceded by
  `=` is treated as a function call rather than a new clause boundary.
- SQL formatter: a space was incorrectly inserted around a `.` next to a
  backtick-quoted identifier (e.g. `` s.`status` `` became `` s. `status` ``).
  The tokenizer splits `alias.` +`` `col` `` into two separate tokens (the
  dot ends up glued to the preceding word, since backticks are a token
  boundary), and `appendTok` had no rule for `.`, so it fell through to the
  default "add a space" behavior. `appendTok` now treats `.` like the
  existing `(` rule: no space before a token starting with `.`, and no space
  after a token ending with `.`.
- SQL formatter: a tuple comparison / row constructor (`(a, b) = (c, d)`,
  e.g. a composite-key `JOIN ... ON`) lost the space after the comma inside
  each tuple when rendered in a `FROM`/`JOIN`/`UPDATE` context, because the
  generic `(...)` handling in `renderTokens` used the ambient `looseCommas`
  of that clause (`false` there) instead of treating the tuple as a value
  list. A `(...)` group with a top-level comma that sits directly next to
  `=` (on either side) is now always rendered with `looseCommas: true`,
  regardless of the surrounding clause. This is a narrow, `=`-anchored
  special case, so it doesn't affect the already-correct, tested behavior of
  `IN (1,2)` or the old-style `FROM t1, t2` (both intentionally kept
  comma-tight).

### Tests
- Added regression coverage in `formatSqlCommand.test.ts` for all three
  fixes above: single- and multi-column `ON DUPLICATE KEY UPDATE` staying on
  one line (plus a check that a plain `UPDATE ... SET ...` still formats
  correctly), `alias.`` `col` `` / `` `db`.table `` / `` `db`.`table`.`col` ``
  staying glued together, and tuple comparisons in `JOIN ... ON` and `WHERE`
  keeping their comma spacing (with explicit checks that `IN (1,2,3)` and
  `FROM t1, t2` are unaffected).

## 0.3.3

### Changed
- SQL formatter (`formatSqlCommand.ts`): reserved words are now uppercased
  unconditionally, with no context sensitivity - previously `ASC`/`DESC`/
  `PARTITION`/`BY` were only uppercased inside `ORDER BY`/`GROUP BY`/
  `OVER (...)`, and clause words like `SELECT`/`FROM`/`WHERE`/`INSERT`/
  `UPDATE`/`DELETE` were left untouched inside subqueries. The three
  separate keyword sets (`KEYWORDS`, `ORDER_GROUP_EXTRA_KEYWORDS`,
  `WINDOW_EXTRA_KEYWORDS`) are merged into a single `reservedWords` set, and
  the `extraKeywords` parameter threaded through `renderWord`/`renderTokens`
  is removed. An unquoted reserved word used as an identifier isn't valid
  SQL to begin with (it would require backtick-quoting), so the old
  context-sensitivity added complexity without real benefit.
- `NULLS`/`FIRST`/`LAST` are no longer treated as reserved words at all -
  they're plain English words that can legitimately be column names, and
  the `NULLS FIRST`/`NULLS LAST` syntax they belonged to doesn't exist in
  MariaDB.
- String/backtick literals (`'...'`, `"..."`, `` `...` ``) and comments
  (`--`, `#`, `/* ... */`) are still never touched, same as before.

### Tests
- Updated the 5 existing tests in `formatSqlCommand.test.ts` that asserted
  the old context-sensitive behavior (`WHERE asc = 1`, `NOT EXISTS (select
  1 from x)` inside a subquery, `UNION` inside a subquery, and `NULLS
  FIRST`/`NULLS LAST`) to reflect the new, intended behavior.

## 0.3.2

### Fixed
- SQL tokenizer (`src/sql/tokenizer.ts`): block comments (`/* ... */`) were not
  recognized as a token at all, so any word inside one (e.g. `select`) could be
  mistaken by the formatter for a real clause keyword and corrupt the whole
  output. `/* ... */` is now tokenized as a single `comment` token, consistent
  with the existing `--` and `#` handling; an unterminated `/* ...` consumes
  the rest of the input instead of erroring, matching the tokenizer's existing
  convention for unterminated strings/comments.
- SQL tokenizer: a doubled quote/backtick inside a `'...'`, `"..."` or
  `` `...` `` literal (e.g. `'it''s ok'`) was treated as the end of the
  literal instead of an escaped character, splitting one literal into two
  tokens. `'`/`"` literals also now support backslash-escaping (`'it\'s ok'`),
  matching default MySQL/MariaDB behavior.
- SQL formatter (`formatSqlCommand.ts`): `UNION`/`INTERSECT`/`EXCEPT` were not
  recognized as statement separators, so the operator got silently appended to
  the end of the first statement's `FROM` clause instead of separating the two
  statements. Each side of `UNION`/`UNION ALL`/`INTERSECT`/`EXCEPT` (detected
  at the top nesting level only, so one inside a subquery is left alone) is
  now formatted independently, with the operator on its own line between them.
- SQL formatter: `UPDATE`, `SET` and `DELETE` are now recognized clauses
  instead of falling through as unformatted text - closes the "not yet
  formatted as proper clauses" limitation noted in 0.2.26. `UPDATE` (including
  multi-table `UPDATE ... JOIN ...`) reuses the same JOIN-aware formatting as
  `FROM`; `SET` assignments now get `", "` spacing instead of `,`; `DELETE`
  handles both the common `DELETE FROM t` form and the multi-table
  `DELETE t1 FROM t1 JOIN t2 ...` form.
- SQL formatter: window function syntax (`OVER (...)`) was left entirely
  lowercase, including `PARTITION BY`/`ORDER BY` inside it. `OVER` is now
  uppercased, and its parenthesized contents get their own keyword set
  (`PARTITION`, `BY`, `ORDER`, `ASC`, `DESC`, `NULLS`, `FIRST`, `LAST`) that
  only applies inside that context. `NULLS FIRST`/`NULLS LAST` are also now
  uppercased in a regular top-level `ORDER BY`.

### Tests
- Added regression coverage in `formatSqlCommand.test.ts` for all of the
  above: keywords inside block comments not breaking clause detection,
  single-line/multi-line/unterminated block comments, doubled and
  backslash-escaped quotes in strings and a doubled backtick in an
  identifier, `UNION`/`UNION ALL`/`INTERSECT`/`EXCEPT` (including a nested
  one inside a subquery not being split), `UPDATE`/`SET`/`DELETE` with and
  without `WHERE`/`JOIN`, and window functions with/without `PARTITION BY`,
  empty `OVER ()`, `NULLS FIRST`/`LAST`, and identifiers like `over_col` /
  `partition_col` staying untouched outside a window context.

## 0.3.1

### Fixed
- `CompletionUpdate.ts` / `CompletionDelete.ts`: no column suggestions
  appeared when the cursor stood right after an alias dot with a
  partially or fully typed column name already there (e.g. `c.id|` in
  `... JOIN client c ON c.id`, or `u.id|` in `WHERE u.id`) - only the
  bare `alias.|` case (dot with nothing typed after it) worked.
  `REGEX_ALIAS_DOT` required the cursor to sit immediately after the
  dot; when text followed the dot, the query fell through to the
  free-position branch, whose filter then contained the `.` and never
  matched any column name. `REGEX_ALIAS_DOT` now also captures the
  text typed after the dot (`/([a-zA-Z0-9_]+)\.(\w*)$/`) and uses it to
  filter the returned columns, matching the fix already shipped for
  `CompletionSelect.ts`.

### Tests
- Added regression tests for the above in `CompletionUpdate.test.ts`
  and `CompletionDelete.test.ts`, covering a full column name after the
  alias dot in `JOIN...ON` and in `WHERE`, and a partial column name in
  `JOIN...ON` to confirm it still filters correctly.

## 0.3.0

### Changed
- Extracted the SQL tokenizer out of `formatSqlCommand.ts` into a shared
  `src/sql/tokenizer.ts` module (`tokenize`, `computeDepths`,
  `currentDepth`, `extractParenGroup`, `splitTopLevelByComma`), so it can
  be reused by the completion providers instead of being duplicated.
- `CompletionSelect.ts`: clause detection (SELECT/FROM/WHERE/GROUP BY/
  HAVING/ORDER BY/LIMIT) now scans SQL tokens at the cursor's nesting
  depth instead of comparing `lastIndexOf` positions on the raw text.
- `CompletionDelete.ts` / `CompletionUpdate.ts`: the WHERE / SET /
  JOIN...ON context check (`isInColumnContext`) is now token-based for
  the same reason. `CompletionInsert.ts` and `CompletionReplace.ts` were
  left untouched - they rely on locally anchored regexes with no
  equivalent issue.

### Fixed
- `lastIndexOf`-based clause detection could be fooled by a clause
  keyword appearing as a substring inside an identifier, silently
  breaking autocomplete in real queries, e.g.:
  - `SELECT` completion: a column like `transform_flag` or
    `limit_reached` in a `WHERE` clause was mistaken for a new `FROM` or
    `LIMIT` clause, making suggestions disappear entirely or fall back
    to `LIMIT`'s numeric-only values.
  - `DELETE` completion: a column like `from_date` in `WHERE` was
    mistaken for `FROM`, breaking column suggestions.
  - `UPDATE` completion: a column like `reset_password` in `WHERE` was
    mistaken for `SET`.
- `SELECT` completion: clause detection was always evaluated at the
  top-level nesting depth, so a clause keyword inside a subquery (e.g.
  its own `WHERE`) could be confused with a clause belonging to the
  outer query. Detection now uses the nesting depth at the cursor.

### Tests
- Added regression tests for all of the above (`Completion.test.ts`,
  `CompletionDelete.test.ts`, `CompletionUpdate.test.ts`).
- `formatSqlCommand.test.ts` continues to pass unchanged against the
  extracted tokenizer (no behavior change there).

## 0.2.31

### Fixed
- SQL formatter: a comment placed right after a clause header (e.g.
  `ORDER BY` followed immediately by a `#`/`--` comment before the first
  column) was glued onto the header's line instead of starting on its
  own line. The header (`GROUP BY`/`ORDER BY`/`LIMIT`/`INSERT`/
  `INSERT INTO`/`VALUES`) is now passed into `renderTokens` as existing
  line content (`initial` param) instead of being concatenated outside
  of it, so the existing "comment starts a new line" logic also applies
  to it.

### Tests
- Added coverage for a comment immediately following an `ORDER BY`
  clause header.

## 0.2.30

### Fixed
- SQL formatter (`formatSqlCommand.ts`): a trailing `;` was not treated as
  a token boundary, so a keyword glued directly to it (e.g. `desc;`) was
  never uppercased. `;` is now its own token type.
- SQL formatter: standalone `#` comments were not recognized at all (only
  `--` was), and any comment appearing before the first recognized clause
  (or elsewhere via the generic token renderer) got merged onto the same
  line as the following token/comment instead of staying on its own line.
  Both `#` and `--` comments are now always rendered on their own line,
  consistently across all clauses.

### Tests
- Added coverage for keywords glued to a trailing semicolon and for
  standalone comments staying on their own lines.
- Translated `formatSqlCommand.test.ts` test/suite names and test data to
  English (code comments stay in Polish, per project convention).

## 0.2.29

### Fixed
- The "Edit config" button on a connection error now shows up for any
  invalid connection, not just when there's exactly one connection
  configured overall. It now looks up the `.cnf` file that belongs to
  the connection actually used by the current SQL file, instead of only
  offering it when there was a single configured connection to avoid
  ambiguity.
- The loading spinner no longer gets stuck forever when a connection
  fails - it now stops immediately in that case, instead of only being
  cleared on a successful query.

## 0.2.28

### Fixed
- The "no database connection configured" first-run prompt now shows only
  once per VS Code session (checked once in `activate`), instead of every
  time the extension starts - previously it reappeared each time the last
  `.sql` tab was closed and a new one opened.

## 0.2.27

### Fixed
- Cancel query spinner now turns red (`--vscode-errorForeground`) as soon
  as the cancel button is clicked, instead of keeping its normal blue/
  amber color while the "Cancelling query…" text is shown.
- Starting a new query now clears any error message left over from the
  previous run - previously a stale error stayed visible even after a
  successful query started.

## 0.2.26

### Changed
- Rewrote the SQL formatter (`formatSqlCommand.ts`) from a regex/string-
  masking approach to a proper tokenizer. Should be more robust against
  edge cases (nested parens, literals, comments) going forward, and is
  easier to extend correctly - clause names are now a `ClauseName` enum
  matched against a per-clause formatter map instead of raw strings
  compared in an if/else-if chain.
- SELECT column list now wraps at 160 characters per line (was 120),
  packing as many columns as fit rather than one per line.
- Comma spacing in the formatted output is now context-aware: lists
  like ORDER BY columns, VALUES rows, and the `(col1, col2)` tuple
  before an `IN` list get `", "`; argument-style lists like
  `IN (1,2)` or `INSERT INTO t (a,b)` get `","` with no space, matching
  how they're conventionally written.
- `(` now keeps the spacing it had in the original text, so
  `count(*)` stays tight while grouping parens (`AND (...)`, `IN (...)`)
  stay loose - instead of a single blanket rule for all parens.

### Added
- Basic `INSERT INTO t (...) VALUES (...)` formatting.
- Double-quoted identifiers (`"column"`, common in PostgreSQL) are now
  left untouched, matching the existing handling of `'...'` and
  `` `...` ``.
- Text before the first recognized clause (e.g. an `UPDATE ... SET`,
  `DELETE FROM`, or `CREATE/ALTER/DROP TABLE` statement) is no longer
  silently dropped if the formatter doesn't recognize it as a clause -
  it's passed through unchanged instead.

### Known limitations (regression vs. 0.2.25, tracked as follow-up)
- Large subqueries nested inside SELECT columns are no longer broken
  out onto their own indented, recursively-formatted block - they stay
  on one line.
- Long `JOIN ... ON ... AND ...` conditions no longer wrap onto a new
  line when they exceed the line width.
- `UPDATE`, `DELETE FROM`, `CREATE/ALTER/DROP TABLE`, `UNION`, `SET`,
  and `OFFSET` are not yet formatted as proper clauses (no keyword
  casing, no line breaks) - they're preserved as-is rather than
  formatted, whereas 0.2.25 handled them like any other clause keyword.

## 0.2.25

### Fixed
- Format SQL (Ctrl+Shift+F) did not uppercase `ASC`/`DESC` in `ORDER BY`
  (and legacy `GROUP BY ... ASC/DESC`) clauses, leaving them in
  whatever case was typed.
- `BETWEEN x AND y` was incorrectly split across two lines, since the
  formatter treated the `AND` belonging to `BETWEEN` as if it were a
  boolean `AND` starting a new condition. Also fixed for multiple
  `BETWEEN`s and `NOT BETWEEN` in the same clause.
- Format SQL left several reserved keywords in their original case
  instead of uppercasing them like `SELECT`/`FROM`/`WHERE`: `DISTINCT`,
  `AS`, `IS NULL`/`IS NOT NULL`, `IN`/`NOT IN`, `LIKE`/`NOT LIKE`,
  `NOT`, `EXISTS`, `CASE`/`WHEN`/`THEN`/`ELSE`/`END`, `NULL`/`TRUE`/
  `FALSE`. String literals and backtick-quoted identifiers are left
  untouched.
- Fixed along the way: keywords occurring inside a string literal
  (e.g. `WHERE note = 'select this and where that'`) could be
  mistaken for a real clause boundary, corrupting the formatted
  output.

## 0.2.24

### Improved
- Cancelling a running query now shows immediate feedback ("Cancelling
  query…") instead of appearing to hang. Previously the UI gave no
  response to a cancel click until the extension's `KILL QUERY`
  round-trip finished, which could take several seconds on high-latency
  (intercontinental) DB connections. The button click is now handled
  entirely in the webview, with no waiting involved, and is also
  guarded against duplicate clicks firing multiple `KILL QUERY`
  commands while one is already in flight.

## 0.2.23

### Fixed
- Rare, hard-to-reproduce bug where a file other than `.sql` could appear
  in the recent SQL files list (F3). `RecentSqlFiles.getConnectionName()`
  re-read `vscode.window.activeTextEditor` after `executeQuery()` had
  already awaited webview readiness (`waitForViewReady`, which can take
  up to 5s on the very first run in a session). If the user switched to
  a different file during that window, that file - not the one the query
  was actually run from - got recorded as the "recent SQL file" for that
  editor. `getConnectionName()` now accepts the SQL file explicitly from
  the caller instead of re-resolving it later.

## 0.2.22

### Fixed
- `SqlUtil.appendLimit` failed to append `LIMIT 200` to SELECT queries
  starting with a single-line comment (`#` or `--`). The comment-stripping
  regex left a trailing newline before `SELECT`, breaking the `^select`
  anchor check used to detect whether a `LIMIT` clause was needed.

## 0.2.21

### Fixed
- Opening a file from the recent SQL files list (F3) when the underlying
  file had been renamed or deleted on disk showed a generic
  `Could not open file: ...` error message and left the stale entry in
  the list. The recent files list now detects this case (checks whether
  the file still exists on disk), automatically removes the missing
  entry from the list, persists the updated list, and shows a clear
  warning message (`File "..." no longer exists and has been removed
  from the list of recent SQL files`) instead of the raw error.

## 0.2.20

### Fixed
- Brief flash of unstyled content (raw buttons, hidden spans, emoji instead
  of icons) that could still appear for a moment when the results webview
  was created for the very first time in a session (e.g. right after
  opening VS Code, followed immediately by `Ctrl+Enter`). The 0.2.19 fix
  only papered over this with a small inline critical style; the actual
  cause was that the real stylesheet was still linked via
  `<link rel="stylesheet" href="...">`, pointing at a
  `vscode-webview-resource:` URI that the webview had to fetch through an
  extra, asynchronous round trip - and the page could be painted before
  that request completed. The full stylesheet is now inlined directly into
  a `<style>` tag in the webview HTML, so it's present from the very first
  paint and there's no window left for the flash to occur.

### Changed
- The webview's CSS is no longer read from disk at runtime, nor shipped as
  a separate `dist/styles.css` file. It's now imported directly in source
  (`import cssContent from '../../media/styles.css'`) and inlined by
  esbuild at build time (`loader: { '.css': 'text' }`), so it ends up as a
  plain string constant baked into `dist/extension.js` - zero disk I/O,
  zero extra files, no repeated reads no matter how many times a query is
  run.

## 0.2.19

### Removed
- Brief white/unstyled flash when a brand-new results webview instance
  was created (e.g. on a fresh VS Code start): for a short moment the raw,
  unstyled HTML was visible before the external stylesheet finished
  loading, which looked like a rendering glitch. Fixed by adding a small
  inline critical style (matching the VS Code theme background) that
  applies immediately with the HTML itself, before the full stylesheet
  arrives.

## 0.2.18

### Fixed
- SQL query results could silently fail to appear when a query was run
  very soon after the results webview had to be freshly created (e.g.
  right after opening VS Code and immediately pressing `Ctrl+Enter` on a
  `.sql` file). The old readiness check only confirmed that VS Code had
  created the webview *container*, not that the webview's own page had
  finished loading its JavaScript and was able to receive messages. Since
  page load is asynchronous and independent of container creation, result
  messages sent too early were silently dropped by VS Code - even though
  the query itself had executed correctly in the background. The webview
  now sends an explicit `webviewReady` signal once its script has fully
  loaded, and `SqlResultsProvider` waits for that signal (replacing the
  old container-only `waitForView()`) before sending query results, so
  they're no longer lost.
- Brief white/unstyled flash when a brand-new results webview instance
  was created (e.g. on a fresh VS Code start): for a short moment the raw,
  unstyled HTML was visible before the external stylesheet finished
  loading, which looked like a rendering glitch. Fixed by adding a small
  inline critical style (matching the VS Code theme background) that
  applies immediately with the HTML itself, before the full stylesheet
  arrives.

## 0.2.17

### Fixed
- Column header cells no longer changed background color on hover. This
  hover effect made sense for the row highlight, but on column headers it
  was misleading since only the header cell changed background while the
  column's data cells stayed unaffected.

## 0.2.16

### Fixed
- Occasional `"Failed to open the SQL results window."` error when running
  a SQL query immediately after opening a `.sql` file (e.g. via
  `Ctrl+Enter`), before the extension had finished starting up. The
  `sqlResultsView` webview is gated behind the `dbClientActive` context
  key, which is set asynchronously during extension start; `runSQLCommand`
  and `runSqlWholeFileCommand` now explicitly wait for the extension to be
  running (`isExtensionRunning`/`safeStartExtension`) before trying to show
  the results view, instead of assuming it was already started.
- Hardened webview lifecycle handling in `SqlResultsProvider` as a
  defensive follow-up to the above: the "view ready" signal now fires only
  after the view is fully set up (HTML loaded, event handlers registered)
  instead of before; `onDidDispose` now checks that the disposed webview
  is still the current one before clearing it, so a late dispose event
  from a stale/replaced view can no longer wipe out a newer, active view;
  and the `waitForView` timeout path now clears its pending resolver the
  same way the normal path already did, avoiding a stale reference.

## 0.2.15

### Fixed
- Confirming a cell edit with `ENTER` immediately reopened the edit
  `input` on the same cell instead of closing it. The document-level
  `keydown` listener added above (for starting edit mode) checked
  `document.activeElement` to skip cells already being edited, but
  `input.blur()` (triggered by the input's own `ENTER` handler) changes
  `document.activeElement` synchronously - before the same `keydown`
  event finishes bubbling up to `document`. So by the time the
  document listener ran, the input was already blurred/saved and no
  longer looked like the active element, and the listener immediately
  restarted editing on the just-saved cell. Fixed by checking
  `event.target` instead, which stays fixed to the original input for
  the whole bubbling phase regardless of any `blur()` calls in between.

## 0.2.14

### Added
- Pressing `ENTER` on a single selected cell (in the results grid) now starts
  cell editing, the same way double-click already did. `initCellEditing`
  (`media/editor.js`) had its dblclick body extracted into a shared
  `startEditingCell(cell, vscode)` function, now also called from a new
  `keydown` listener that fires only when exactly one cell is selected
  (`selectedCellPositions.size === 1`) and focus isn't already inside an
  edit `input`/`textarea`.
- Arrow-key navigation between cells in the results grid: with a single
  cell selected, `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight` move the
  selection to the neighboring cell (deselecting the previous one),
  instead of doing nothing. Implemented in `initCellSelection`
  (`media/editor.js`); ignored while an edit `input`/`textarea` is
  focused, and while more/fewer than one cell is selected. Arrows at the
  edge of the grid (e.g. `ArrowUp` on the first row) are simply no-ops.
  The newly selected cell is scrolled into view (`scrollIntoView`) if
  needed.

### Fixed
- Column headers in the results grid (`.header-cell`) are clickable
  (click selects the whole column, see `initColumnSelection` in
  `media/editor.js`), but had no `:hover` style in `media/styles.css` -
  unlike data rows, which already highlight and switch to a pointer
  cursor on hover. Added a matching `.header-cell:not(.lp-cell):hover`
  rule (the `#` row-number header is excluded, since it isn't clickable).
- Editing a cell (double-click, or now `ENTER` on a selected cell) saved
  the new value on **any** loss of focus, including clicking somewhere
  else on the page - not just when explicitly confirming with `ENTER`.
  `startEditingCell` (`media/editor.js`) now tracks a `committed` flag,
  set only right before `input.blur()` is called from the `ENTER`
  handler. The shared `blur` listener saves the value only if
  `committed` is `true`; otherwise (click-away, `Escape`, losing focus
  for any other reason) it cancels the edit and restores the original
  value.

## 0.2.13

### Added
- Recent SQL files list (`F3`) now shows a trash icon next to each
  individual entry, letting you remove a single file from the list
  without affecting the others. Previously the only way to remove
  entries was the "Trim list" button in the QuickPick title bar,
  which trimmed the list down to the N most recent files (or cleared
  it entirely) rather than removing one specific file. Clicking the
  new per-item button deletes just that entry from `sqlFiles`,
  persists the updated list to disk, and refreshes the QuickPick in
  place without closing it.

## 0.2.12

### Fixed
- Fixed webview unit tests broken by the tool-button caching introduced in
  0.2.10. `rowToolsBtnElements` (`media/editor.js`) and `toolsBtnElements`
  (`media/messageHandler.js`) were computed once at **module import time**
  via `document.getElementById(...)`, instead of inside a function. This
  assumed `document` already existed and stayed valid for the lifetime of
  the module, which broke webview tests two ways: several test files
  statically import `editor.js` before calling `setupDom()`, so `document`
  wasn't defined yet at import time; and even where it was defined, the
  cached elements went stale after any subsequent `setupDom()` call within
  the same test file (each call builds a fresh DOM), since the cache was
  never refreshed. Replaced both cached constants with lazy getter
  functions (`getRowToolsBtnElements()` / `getToolsBtnElements()`) that
  still use `getElementById` (avoiding the original `querySelectorAll`
  scans) but resolve the elements on each call instead of once at import.

## 0.2.11

### Fixed
- After saving a bulk column edit, the `column-edit-pending` highlight
  (red background on the edited column's cells and header) is no
  longer left behind once the backend confirms the save and the grid
  refreshes. In `media/messageHandler.js`, the `msg.clearSelection`
  handler called `stopToolsBtn()` before `cancelAllColumnEdits()`, and
  `stopToolsBtn()` immediately reset `State.pendingColumnEdits` to
  `{}`. By the time `cancelAllColumnEdits()` ran, it had nothing left
  to iterate over, so `clearColumnPreview()` never removed the
  highlight class from the affected cells/header. Fixed by calling
  `cancelAllColumnEdits()` first, while `pendingColumnEdits` still
  holds the columns to clear, and only then resetting the tool button
  state via `stopToolsBtn()`.

## 0.2.10

### Changed
- Sped up tools-btn visibility handling in the webview: `stopToolsBtn`
  (`media/messageHandler.js`) and `updateDeleteButtonVisibility`/
  `hideToolsButtons` (`media/editor.js`) now cache references to the
  5 tool buttons (`generateInsertBtn`, `generateUpdateBtn`,
  `generateDeleteBtn`, `deleteRowsBtn`, `saveColumnEditsBtn`) instead
  of calling `document.querySelectorAll('.tools-btn')` on every call.
  `stopToolsBtn` also skips the DOM update entirely when there is
  nothing to hide (no selected rows and no `pendingColumnEdits`).
  `updateDeleteButtonVisibility` runs on every row click, so this
  matters most when selecting many rows quickly (e.g. Shift-click).

## 0.2.9

### Fixed
- The loading spinner shown while a SQL query is running is now always
  visible, even when the results grid has been scrolled down. Previously
  the spinner overlay was a child of the same element that scrolls
  (`#gridContainer`), so `position: absolute; inset: 0` anchored it to
  the top of the scrolled content instead of the visible viewport -
  scrolling down (e.g. to rows starting at 50) moved the spinner out of
  view. Scrolling now happens in a new inner `#gridScroll` wrapper,
  while the overlay stays a direct child of `#gridContainer` and always
  covers the currently visible area.

## 0.2.8

### Changed
- Replaced the "cancel" query button text with an SVG (X) icon,
  whose color can now be easily customized via CSS.

## 0.2.7

### Fixed
- Closing a SQL file's tab now also frees the cached grid/rows kept in
  the **webview** (`cachedGrid`/`cachedGridHtml`/`currentRows` in
  `media/state.js`), not just the backend cache. Previously only the
  backend side was cleared (see 0.2.4), so the webview's per-file cache
  kept growing for every closed file until the panel was reloaded.

### Changed
- Simplified how the query-results cache is cleared: it now only ever
  happens per-file, when that file's last tab is closed
  (`closeSqlFile()`). Stopping the extension (closing the last SQL tab,
  or VS Code shutting down) no longer separately clears the whole
  cache - it was redundant, since closing the last tab is just a
  special case of closing any tab and is already covered by the
  per-file cleanup.

## 0.2.6

### Changed
- Faster column autocomplete for queries with several `JOIN`s or nested
  subqueries.

## 0.2.5

### Changed
- Faster page rendering: comparing rows to detect changes now checks
  columns directly instead of serializing each row to JSON.

## 0.2.4

### Fixed
- Closing a SQL file's tab now frees the memory used by its last query results.

## 0.2.3

### Added
- Column completion for `ENUM`/`SET` columns now shows the full list of
  allowed values in the hint.

## 0.2.2

### Changed
- Row, column and cell selection in the results grid no longer relies on
  querying the DOM for CSS classes (`.selected-row`/`.selected-col`/
  `.selected-cell`). `State` now holds three `Set`s
  (`selectedRowIndexes`/`selectedColIndexes`/`selectedCellPositions`) that are
  the single source of truth; the CSS classes are still applied for the
  visual highlight, but are now a side effect kept in sync with the `Set`s
  instead of being read back via `querySelectorAll`. This affects the
  clipboard copy (`collectSelectedPositions`) and the toolbar visibility
  (`updateDeleteButtonVisibility`), which previously re-scanned the whole
  rendered grid on every click and every copy.

## 0.2.1

### Changed
- Table/schema metadata (`INFORMATION_SCHEMA.TABLES`) is no longer read
  automatically on every `connect()`. It's now loaded lazily, only the first
  time it's actually needed - i.e. the first autocomplete request in a `.sql`
  file - and cached for the lifetime of the connection. Opening a file,
  running a query and closing it again no longer triggers this query at all;
  neither does the short-lived internal connection used to send `KILL QUERY`
  when cancelling a running query.
- The cached table list is invalidated (and transparently reloaded on the
  next autocomplete request) after any DDL statement (`CREATE`/`ALTER`/
  `DROP`/`TRUNCATE`/`RENAME`) runs on the connection, so newly created or
  renamed tables show up in completions without needing a manual reconnect.

### Fixed
- `Connection.waitForSchemaTables()` was never actually awaited by the
  completion provider, so autocomplete could momentarily race the background
  metadata load and show an empty table list right after connecting. It's
  now awaited before every completion request.

## 0.2.0

### Fixed
- The "no connection configured" modal showed **two** "Cancel" buttons. VS Code
  automatically adds its own "Cancel" affordance to modal dialogs; adding our
  own extra "Cancel" button duplicated it. Modals now only pass the
  affirmative action and rely on the built-in close/Cancel behavior.
- "Directory exists but has zero `.cnf` files" is now checked exactly once,
  at extension startup - not on every "Run SQL" - via the same modal used for
  "directory doesn't exist at all" ("Create Default Connection (localhost)" /
  Cancel).
- Deliberately did **not** add a proactive "test the connection at startup"
  check for the single-`.cnf`-file case: that would open a real database
  connection every time the extension starts, which it never did before.
  Connections stay lazy - only created the first time "Run SQL" actually
  runs. If that one `.cnf` file turns out to be broken, the existing
  "Edit `<file>`.cnf" action on the query-error message still covers it.
- Default `localhost.cnf` template: `database` is now left empty with a
  trailing comment (`database =  # your database name`) instead of a
  `your_database` placeholder value - true MySQL/MariaDB option-file syntax
  where "#" starts a comment anywhere on the line (not just at the very
  start), which this project's `.cnf` parser now also supports
  (`CnfLoader.stripInlineComment`).
- Template comments are in English (the file is read by end users); comments
  in `.ts`/`.js` source stay in Polish.
