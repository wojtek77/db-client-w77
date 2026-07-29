# Changelog

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
