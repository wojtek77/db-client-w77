# Changelog

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
