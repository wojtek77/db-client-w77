import type { SqlKeyword, KeywordContext } from './sqlKeywords.js';
import { buildKeyword } from './keywordSpec.js';

const JOIN_KIND: KeywordContext[] = ['join-kind'];
// po LEFT/RIGHT pasuje JOIN i OUTER JOIN, po LEFT/RIGHT OUTER już tylko JOIN
const JOIN_PLAIN: KeywordContext[] = ['join-kind', 'join-side', 'join-outer'];
const JOIN_CONDITION: KeywordContext[] = ['join-condition'];
const ALIAS: KeywordContext[] = ['table-alias', 'select-alias'];

// STRAIGHT_JOIN jako operator złączenia jest zdefiniowany razem z modyfikatorami SELECT w sqlKeywords.ts (to to samo słowo)
// kolejność na liście decyduje o kolejności podpowiedzi w danym kontekście
export const JOIN_KEYWORDS: SqlKeyword[] = [
    buildKeyword({
        name: 'JOIN',
        contexts: JOIN_PLAIN,
        syntax: 'table_reference [INNER | CROSS] JOIN table_reference [ON search_condition | USING (column, ...)]',
        description: 'Combines rows from two tables. In MariaDB `JOIN`, `INNER JOIN` and `CROSS JOIN` are equivalent: only rows that satisfy the join condition are returned. Without `ON` or `USING` the result is the Cartesian product of both tables.',
        examples: ['SELECT * FROM orders o\nJOIN customers c ON c.id = o.customer_id'],
    }),
    buildKeyword({
        name: 'INNER JOIN',
        contexts: JOIN_KIND,
        syntax: 'table_reference INNER JOIN table_reference [ON search_condition | USING (column, ...)]',
        description: 'Returns only the rows that have a match in both tables. Same as a plain `JOIN`.',
        examples: ['SELECT * FROM orders o\nINNER JOIN customers c ON c.id = o.customer_id'],
    }),
    buildKeyword({
        name: 'LEFT JOIN',
        contexts: JOIN_KIND,
        syntax: 'table_reference LEFT [OUTER] JOIN table_reference {ON search_condition | USING (column, ...)}',
        description: 'Returns every row from the left table. When a row has no match in the right table, the columns of the right table are NULL. A condition is required. Conditions on the right table belong in `ON`: putting them in `WHERE` removes the NULL rows and turns the query into an inner join.',
        examples: ['SELECT c.name, o.id FROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id', 'SELECT c.* FROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nWHERE o.id IS NULL'],
    }),
    buildKeyword({
        name: 'RIGHT JOIN',
        contexts: JOIN_KIND,
        syntax: 'table_reference RIGHT [OUTER] JOIN table_reference {ON search_condition | USING (column, ...)}',
        description: 'Returns every row from the right table. When a row has no match in the left table, the columns of the left table are NULL. A condition is required. It is the mirror image of `LEFT JOIN`, which is usually easier to read.',
        examples: ['SELECT c.name, o.id FROM orders o\nRIGHT JOIN customers c ON o.customer_id = c.id'],
    }),
    buildKeyword({
        name: 'LEFT OUTER JOIN',
        contexts: JOIN_KIND,
        syntax: 'table_reference LEFT OUTER JOIN table_reference {ON search_condition | USING (column, ...)}',
        description: 'Synonym of `LEFT JOIN`: returns every row from the left table, with NULLs for the right table where there is no match.',
        examples: ['SELECT c.name, o.id FROM customers c\nLEFT OUTER JOIN orders o ON o.customer_id = c.id'],
    }),
    buildKeyword({
        name: 'RIGHT OUTER JOIN',
        contexts: JOIN_KIND,
        syntax: 'table_reference RIGHT OUTER JOIN table_reference {ON search_condition | USING (column, ...)}',
        description: 'Synonym of `RIGHT JOIN`: returns every row from the right table, with NULLs for the left table where there is no match.',
        examples: ['SELECT c.name, o.id FROM orders o\nRIGHT OUTER JOIN customers c ON o.customer_id = c.id'],
    }),
    buildKeyword({
        name: 'OUTER JOIN',
        contexts: ['join-side'],
        syntax: 'table_reference {LEFT | RIGHT} OUTER JOIN table_reference {ON search_condition | USING (column, ...)}',
        description: 'The `OUTER` word is optional: `LEFT OUTER JOIN` is the same as `LEFT JOIN` and `RIGHT OUTER JOIN` is the same as `RIGHT JOIN`. All rows of one table are returned, with NULLs for the other table where there is no match.',
        examples: ['SELECT c.name, o.id FROM customers c\nLEFT OUTER JOIN orders o ON o.customer_id = c.id'],
    }),
    buildKeyword({
        name: 'CROSS JOIN',
        contexts: JOIN_KIND,
        syntax: 'table_reference CROSS JOIN table_reference [ON search_condition | USING (column, ...)]',
        description: 'Returns the Cartesian product: every row of the left table combined with every row of the right table. In MariaDB it is a synonym of `INNER JOIN`, so a condition is allowed but not required.',
        examples: ['SELECT * FROM sizes\nCROSS JOIN colors'],
    }),
    buildKeyword({
        name: 'NATURAL JOIN',
        contexts: JOIN_KIND,
        syntax: 'table_reference NATURAL [LEFT | RIGHT] JOIN table_reference',
        description: 'Joins the tables on all columns that have the same name in both of them, so neither `ON` nor `USING` is written. The common columns appear once in the result of `SELECT *`. It breaks silently when a column is added or renamed, so an explicit `ON` is safer.',
        examples: ['SELECT * FROM orders\nNATURAL JOIN customers'],
    }),

    buildKeyword({
        name: 'ON',
        contexts: JOIN_CONDITION,
        syntax: 'table_reference JOIN table_reference ON search_condition',
        description: 'Condition that decides which rows of the joined tables match. It can be any expression, not only an equality, and can combine several conditions with `AND` and `OR`. For `LEFT JOIN` and `RIGHT JOIN` the condition decides which rows are NULL-extended, unlike `WHERE`, which filters the final result.',
        examples: ['SELECT * FROM orders o\nJOIN customers c ON c.id = o.customer_id AND c.active = 1'],
    }),
    buildKeyword({
        name: 'USING',
        contexts: JOIN_CONDITION,
        snippet: 'USING ($1)$0',
        syntax: 'table_reference JOIN table_reference USING (column, ...)',
        description: 'Shorthand for `ON` when the join columns have the same name in both tables: `USING (id)` means `a.id = b.id`. The column appears once in the result of `SELECT *`, and it can be referenced without a table prefix.',
        examples: ['SELECT * FROM orders\nJOIN customers USING (customer_id)'],
    }),

    buildKeyword({
        name: 'AS',
        contexts: ALIAS,
        syntax: 'table_name [AS] alias\nexpr [AS] alias',
        description: 'Gives a table or a selected expression an alias. A table alias can be used instead of the table name in the rest of the query, and once it is defined the table can only be referenced by the alias. A column alias becomes the name of the column in the result and can be used in `GROUP BY`, `HAVING` and `ORDER BY`. The `AS` keyword is optional.',
        examples: ['SELECT c.name FROM customers AS c\nWHERE c.active = 1', 'SELECT price * quantity AS total FROM order_items'],
    }),
];
