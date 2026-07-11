# Changelog

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

## 0.1.34

### Fixed
- `production`/`readonly` moved out of `[client]` into a new, dedicated `[db-client]` section. `[client]` is also read by the real `mysql`/`mariadb` CLI tools, which reject unknown variables there (`unknown variable 'production=true'`); unknown *sections* are simply ignored by them, so the same `.cnf` file now still works as a `--defaults-file` for the real CLI.
- The "no connection configured" prompt no longer disappears before it can be read (it's now a modal dialog), and its actions no longer silently do nothing - command registration was happening after the prompt could already need it; commands are now registered first thing in `activate()`.

### Changed
- Onboarding is now a single, consistent flow instead of three different paths: whenever there are zero usable `.cnf` files (whether the config directory doesn't exist yet, or it exists but is empty), the same prompt offers to create a default `localhost.cnf` (or "Cancel"). Deliberately skipped if any `.cnf` file already exists, whether valid or not (ambiguous which file to touch with 2+, and with exactly 1 existing file the user clearly already set something up on purpose).
- The default connection template now matches the most common real-world case (Windows + WAMP: `root`, no password, `127.0.0.1:3306`) instead of arbitrary placeholders, and is opened in the editor immediately after creation instead of requiring an extra button click.
- When running a query fails and there's exactly one `.cnf` file configured, the error message now includes an "Edit `<file>`.cnf" action (we don't try to guess *what's* wrong with it - just make it one click to open, since there's no ambiguity about which file that would be).
- Command renamed: `DB client: Create Connection Config Directory` → `DB client: Create Default Connection (localhost)` (same command id, `db-client.createConfigDir`).

## 0.1.33

### Security fixes
- `.cnf` config parser no longer converts arbitrary values to numbers/booleans
  - passwords, usernames, hosts and database names are always kept as strings
    (e.g. a password of `001234` or `true` is no longer mangled). Only a
    whitelist of known options (`port`, timeouts, `reconnect`, `compress`, ...)
    is converted.
- Webview now runs with a strict Content Security Policy (per-render nonce),
  no more inline `onclick` handlers, and every message received from the
  webview is validated before being acted on.
- Column names used in bulk "Save column edits" are now checked against the
  actual SELECT/table metadata before being interpolated into the generated
  `UPDATE` statement, instead of being trusted as-is from the webview.

### Fixed
- "Run SQL Whole File" now runs every statement in the file (previously only
  the first `SELECT` ran and subsequent `SELECT`s were silently skipped). The
  results grid shows the results of the last `SELECT` executed. A warning is
  now shown when a script mixes DDL with other statements, since DDL
  auto-commits in MySQL/MariaDB and can't be rolled back with the rest of the
  script.
- A missing connection config directory (`~/.db_configs`) no longer crashes
  extension activation; a friendly setup prompt is shown instead, with a
  one-click "Create Connection Config Directory" action.
- Query execution now always resets the loading spinner and cancel button
  (`try`/`finally`), even if obtaining a database connection fails.

### Added
- Recommend using TLS for remote connections; `skip-ssl` is documented as
  dev/test-only. See README for details.
- `production` / `readonly` options for `.cnf` files: production connections
  show a red warning banner in the results panel; read-only connections block
  all write/DDL statements.
- New settings: `db-client.blockUnsafeUpdateDelete` (blocks `UPDATE`/`DELETE`
  without `WHERE`, default on) and `db-client.requireConnectionNameConfirmation`
  (require typing the connection name before a bulk delete/edit, default off).
  Destructive confirmations now show the target host and database.
- New commands: `db-client.createConfigDir`, `db-client.reloadConnections`,
  `db-client.testConnection`.
- Explicit `GPL-2.0-only` license in `package.json`.
- Tests for the config parser whitelist and the new SQL safety helpers.

### Changed
- Results panel is now named "SQL Results" (was Polish "Wyniki SQL").
- Loading the full table list for autocomplete/schema explorer no longer
  blocks the initial database connection; it now loads in the background so
  connecting to large servers with many schemas doesn't feel slow.

## 0.1.0

- Initial release
