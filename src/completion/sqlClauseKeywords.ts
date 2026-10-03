import type { SqlKeyword, KeywordContext } from './sqlKeywords.js';
import { buildKeyword } from './keywordSpec.js';

const AFTER_SELECT_LIST: KeywordContext[] = ['end-select'];
// wszystkie miejsca, po których może być jeszcze UNION albo blokada
const ANY_BODY_END: KeywordContext[] = ['end-from', 'end-where', 'end-group', 'end-having', 'end-order', 'end-limit'];
// miejsca przed LIMIT: po nim nie ma już ORDER BY ani LIMIT
const UP_TO_ORDER: KeywordContext[] = ['end-from', 'end-where', 'end-group', 'end-having', 'end-order'];

const SUBQUERY_START: KeywordContext[] = ['subquery-start'];

// kolejność na liście decyduje o kolejności podpowiedzi w danym kontekście, więc najczęstsze klauzule są na początku
export const CLAUSE_KEYWORDS: SqlKeyword[] = [
    buildKeyword({
        name: 'SELECT',
        contexts: SUBQUERY_START,
        snippet: 'SELECT ${1:1}',
        syntax: 'EXISTS (SELECT ...)\nexpr IN (SELECT column FROM ...)',
        description: 'Starts a subquery. After `EXISTS` only the existence of rows matters, so the selected expression is usually just `1`. After `IN` or a comparison with `ANY`, `SOME` or `ALL` the subquery must return a single column.',
        examples: ['SELECT * FROM customers c\nWHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)', 'SELECT * FROM orders\nWHERE customer_id IN (SELECT id FROM customers WHERE active = 1)'],
    }),

    buildKeyword({
        name: 'FROM',
        contexts: AFTER_SELECT_LIST,
        syntax: 'SELECT select_expr [, select_expr ...] FROM table_references',
        description: 'Lists the tables the rows are read from. Several tables can be combined with `JOIN`, and a table can be a subquery in parentheses with an alias.',
        examples: ['SELECT id, name FROM customers', 'SELECT c.name, o.total FROM customers c\nJOIN orders o ON o.customer_id = c.id'],
    }),

    buildKeyword({
        name: 'WHERE',
        contexts: ['end-from'],
        syntax: 'SELECT ... FROM table_references WHERE where_condition',
        description: 'Keeps only the rows for which the condition is true. It is applied before grouping, so it cannot use aggregate functions: use `HAVING` for conditions on aggregates.',
        examples: ['SELECT * FROM customers WHERE city = \'Paris\' AND active = 1'],
    }),
    buildKeyword({
        name: 'GROUP BY',
        contexts: ['end-from', 'end-where'],
        syntax: 'GROUP BY {column | expr | position} [, ...] [WITH ROLLUP]',
        description: 'Collapses rows that have the same value of the listed expressions into one row, so aggregate functions such as `COUNT` or `SUM` are computed per group.',
        examples: ['SELECT city, COUNT(*) FROM customers GROUP BY city'],
    }),
    buildKeyword({
        name: 'HAVING',
        contexts: ['end-where', 'end-group'],
        syntax: 'HAVING condition',
        description: 'Filters the groups after grouping, so unlike `WHERE` it can use aggregate functions and aliases from the select list.',
        examples: ['SELECT city, COUNT(*) AS total FROM customers\nGROUP BY city\nHAVING total > 10'],
    }),
    buildKeyword({
        name: 'ORDER BY',
        contexts: ['end-from', 'end-where', 'end-group', 'end-having'],
        syntax: 'ORDER BY {column | expr | position} [ASC | DESC] [, ...]',
        description: 'Sorts the result. Without `ASC` or `DESC` the order is ascending. Without `ORDER BY` the order of the rows is not guaranteed.',
        examples: ['SELECT * FROM orders ORDER BY created_at DESC, id'],
    }),
    buildKeyword({
        name: 'LIMIT',
        contexts: UP_TO_ORDER,
        syntax: 'LIMIT {[offset,] row_count | row_count OFFSET offset} [ROWS EXAMINED rows_limit]',
        description: 'Returns at most row_count rows, optionally skipping the first offset rows. Use it together with `ORDER BY`, otherwise it is not defined which rows are returned.',
        examples: ['SELECT * FROM orders ORDER BY id LIMIT 10', 'SELECT * FROM orders ORDER BY id LIMIT 10 OFFSET 20'],
    }),

    buildKeyword({
        name: 'UNION',
        contexts: ANY_BODY_END,
        syntax: 'SELECT ... UNION [ALL | DISTINCT] SELECT ...',
        description: 'Appends the rows of the second `SELECT` to those of the first one. Duplicate rows are removed unless `ALL` is given (`DISTINCT` is the default). Both queries must return the same number of columns. A trailing `ORDER BY` or `LIMIT` applies to the whole result.',
        examples: ['SELECT name FROM customers\nUNION\nSELECT name FROM suppliers'],
    }),
    buildKeyword({
        name: 'UNION ALL',
        contexts: ANY_BODY_END,
        syntax: 'SELECT ... UNION ALL SELECT ...',
        description: 'Appends the rows of the second `SELECT` to those of the first one and keeps duplicates. It is faster than `UNION`, because no duplicates have to be removed.',
        examples: ['SELECT id FROM orders_2023\nUNION ALL\nSELECT id FROM orders_2024'],
    }),
    buildKeyword({
        name: 'UNION DISTINCT',
        contexts: ANY_BODY_END,
        syntax: 'SELECT ... UNION DISTINCT SELECT ...',
        description: 'Same as `UNION`: duplicate rows are removed from the combined result.',
        examples: ['SELECT name FROM customers\nUNION DISTINCT\nSELECT name FROM suppliers'],
    }),
    buildKeyword({
        name: 'INTERSECT',
        contexts: ANY_BODY_END,
        syntax: 'SELECT ... INTERSECT [ALL | DISTINCT] SELECT ...',
        description: 'Returns only the rows that appear in the results of both `SELECT` statements. Duplicates are removed unless `ALL` is given (`DISTINCT` is the default).',
        examples: ['SELECT email FROM customers\nINTERSECT\nSELECT email FROM newsletter'],
    }),
    buildKeyword({
        name: 'EXCEPT',
        contexts: ANY_BODY_END,
        syntax: 'SELECT ... EXCEPT [ALL | DISTINCT] SELECT ...',
        description: 'Returns the rows of the first `SELECT` that do not appear in the second one. Duplicates are removed unless `ALL` is given (`DISTINCT` is the default).',
        examples: ['SELECT email FROM customers\nEXCEPT\nSELECT email FROM unsubscribed'],
    }),
    buildKeyword({
        name: 'FETCH FIRST',
        contexts: UP_TO_ORDER,
        snippet: 'FETCH FIRST ${1:n} ROWS ONLY',
        syntax: '[OFFSET start {ROW | ROWS}] FETCH {FIRST | NEXT} [count] {ROW | ROWS} {ONLY | WITH TIES}',
        description: 'Standard SQL alternative to `LIMIT`. `WITH TIES` also returns the rows that tie with the last returned row according to `ORDER BY`, so it only makes sense together with `ORDER BY`.',
        examples: ['SELECT * FROM orders ORDER BY total DESC\nFETCH FIRST 10 ROWS ONLY', 'SELECT * FROM orders ORDER BY total DESC\nFETCH FIRST 10 ROWS WITH TIES'],
    }),
    buildKeyword({
        name: 'FOR UPDATE',
        contexts: ANY_BODY_END,
        syntax: 'SELECT ... FOR UPDATE [WAIT n | NOWAIT | SKIP LOCKED]',
        description: 'Locks the rows that are read until the end of the transaction, so other transactions cannot change or lock them. It only has an effect inside a transaction (autocommit off or after `START TRANSACTION`).',
        examples: ['START TRANSACTION;\nSELECT * FROM accounts WHERE id = 1 FOR UPDATE;'],
    }),
    buildKeyword({
        name: 'LOCK IN SHARE MODE',
        contexts: ANY_BODY_END,
        syntax: 'SELECT ... LOCK IN SHARE MODE [WAIT n | NOWAIT | SKIP LOCKED]',
        description: 'Sets a shared lock on the rows that are read: other transactions can still read them, but cannot change them until the end of the transaction. It only has an effect inside a transaction.',
        examples: ['START TRANSACTION;\nSELECT * FROM accounts WHERE id = 1 LOCK IN SHARE MODE;'],
    }),

    buildKeyword({
        name: 'WITH ROLLUP',
        contexts: ['group-rollup'],
        syntax: 'GROUP BY expr [, expr ...] WITH ROLLUP',
        description: 'Adds extra rows with super-aggregates: a subtotal for every level of the `GROUP BY` list and a grand total. In these rows the grouped columns are NULL.',
        examples: ['SELECT country, city, COUNT(*) FROM customers\nGROUP BY country, city WITH ROLLUP'],
    }),
    buildKeyword({
        name: 'ASC',
        contexts: ['order-direction'],
        syntax: 'ORDER BY expr ASC',
        description: 'Ascending order, from the smallest to the largest value. It is the default, so it is only written for clarity.',
        examples: ['SELECT * FROM customers ORDER BY name ASC'],
    }),
    buildKeyword({
        name: 'DESC',
        contexts: ['order-direction'],
        syntax: 'ORDER BY expr DESC',
        description: 'Descending order, from the largest to the smallest value.',
        examples: ['SELECT * FROM orders ORDER BY created_at DESC'],
    }),
    buildKeyword({
        name: 'OFFSET',
        contexts: ['limit-offset'],
        syntax: 'LIMIT row_count OFFSET offset',
        description: 'Skips the first offset rows before the rows counted by `LIMIT` start. `LIMIT offset, row_count` is the same with the arguments in the other order.',
        examples: ['SELECT * FROM orders ORDER BY id LIMIT 10 OFFSET 20'],
    }),
    buildKeyword({
        name: 'ROWS EXAMINED',
        contexts: ['limit-examined'],
        snippet: 'ROWS EXAMINED ${1:n}',
        syntax: 'LIMIT ... ROWS EXAMINED rows_limit',
        description: 'Limits the number of rows the server may examine, in addition to the number it may return. The query stops once it has examined that many rows.',
        examples: ['SELECT * FROM orders WHERE note LIKE \'%gift%\'\nLIMIT 10 ROWS EXAMINED 100000'],
    }),

    buildKeyword({
        name: 'NOWAIT',
        contexts: ['lock-wait'],
        syntax: 'FOR UPDATE NOWAIT',
        description: 'Fails immediately with an error when a row is already locked by another transaction, instead of waiting for the lock.',
        examples: ['SELECT * FROM accounts WHERE id = 1 FOR UPDATE NOWAIT'],
    }),
    buildKeyword({
        name: 'SKIP LOCKED',
        contexts: ['lock-wait'],
        syntax: 'FOR UPDATE SKIP LOCKED',
        description: 'Skips the rows that are locked by another transaction instead of waiting for them, so the result may not contain all matching rows. Useful for work queues.',
        examples: ['SELECT * FROM jobs WHERE state = \'new\' LIMIT 1 FOR UPDATE SKIP LOCKED'],
    }),
    buildKeyword({
        name: 'WAIT',
        contexts: ['lock-wait'],
        snippet: 'WAIT ${1:seconds}',
        syntax: 'FOR UPDATE WAIT n',
        description: 'Waits up to n seconds for a row that is locked by another transaction, and fails with an error when the lock is still not released.',
        examples: ['SELECT * FROM accounts WHERE id = 1 FOR UPDATE WAIT 5'],
    }),
];
