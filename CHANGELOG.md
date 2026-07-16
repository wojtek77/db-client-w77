# Changelog

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
