export interface SqlKeyword {
    name: string;
    signature: string;
    documentation: string;
}

export const SQL_KEYWORDS: SqlKeyword[] = [

{
    name: 'ALL',

    signature:
        'SELECT ALL select_expr [, select_expr ...]',

    documentation: `
# ALL

\`\`\`sql
SELECT ALL select_expr [, select_expr ...]
\`\`\`

Returns every matching row, including duplicates. This is the default behavior of SELECT, so ALL is rarely written explicitly - it exists mainly as the opposite of DISTINCT.

## Full Syntax

\`\`\`sql
SELECT ALL
    col1,
    col2,
    ...
FROM table_name;
\`\`\`

## Examples

\`\`\`sql
SELECT ALL city FROM customers
\`\`\`

\`\`\`sql
SELECT city FROM customers
\`\`\`
`
},

{
    name: 'DISTINCT',

    signature:
        'SELECT DISTINCT select_expr [, select_expr ...]',

    documentation: `
# DISTINCT

\`\`\`sql
SELECT DISTINCT select_expr [, select_expr ...]
\`\`\`

Removes duplicate rows from the result set. When multiple columns are listed, the combination of their values is used to determine distinctness. DISTINCTROW is a synonym for DISTINCT.

## Full Syntax

\`\`\`sql
SELECT DISTINCT
    col1,
    col2,
    ...
FROM table_name;
\`\`\`

## Examples

\`\`\`sql
SELECT DISTINCT city FROM customers
\`\`\`

\`\`\`sql
SELECT DISTINCT city, country FROM customers
\`\`\`
`
},

{
    name: 'DISTINCTROW',

    signature:
        'SELECT DISTINCTROW select_expr [, select_expr ...]',

    documentation: `
# DISTINCTROW

\`\`\`sql
SELECT DISTINCTROW select_expr [, select_expr ...]
\`\`\`

Synonym for DISTINCT. Removes duplicate rows from the result set, based on the combination of values in the selected columns.

## Full Syntax

\`\`\`sql
SELECT DISTINCTROW
    col1,
    col2,
    ...
FROM table_name;
\`\`\`

## Examples

\`\`\`sql
SELECT DISTINCTROW city FROM customers
\`\`\`

\`\`\`sql
SELECT DISTINCTROW city, country FROM customers
\`\`\`
`
},

{
    name: 'HIGH_PRIORITY',

    signature:
        'SELECT HIGH_PRIORITY select_expr [, select_expr ...]',

    documentation: `
# HIGH_PRIORITY

\`\`\`sql
SELECT HIGH_PRIORITY select_expr [, select_expr ...]
\`\`\`

Gives the SELECT higher priority than a statement that updates a table, letting it run even while another statement is waiting for the table to be free. Intended only for queries that are very fast and must run immediately.

## Full Syntax

\`\`\`sql
SELECT HIGH_PRIORITY
    col1,
    col2,
    ...
FROM table_name;
\`\`\`

## Examples

\`\`\`sql
SELECT HIGH_PRIORITY * FROM settings WHERE id = 1
\`\`\`
`
},

{
    name: 'STRAIGHT_JOIN',

    signature:
        'SELECT STRAIGHT_JOIN select_expr [, select_expr ...]',

    documentation: `
# STRAIGHT_JOIN

\`\`\`sql
SELECT STRAIGHT_JOIN select_expr [, select_expr ...]
\`\`\`

Forces the optimizer to join tables in the exact order they are listed in the FROM clause, instead of choosing an order it thinks is more efficient. Useful when the optimizer picks a suboptimal join order.

## Full Syntax

\`\`\`sql
SELECT STRAIGHT_JOIN
    col1,
    col2,
    ...
FROM table_a
JOIN table_b ON table_a.id = table_b.a_id;
\`\`\`

## Examples

\`\`\`sql
SELECT STRAIGHT_JOIN * FROM small_table, big_table WHERE small_table.id = big_table.small_id
\`\`\`
`
},

{
    name: 'SQL_SMALL_RESULT',

    signature:
        'SELECT SQL_SMALL_RESULT select_expr [, select_expr ...]',

    documentation: `
# SQL_SMALL_RESULT

\`\`\`sql
SELECT SQL_SMALL_RESULT select_expr [, select_expr ...]
\`\`\`

Tells the optimizer that the result set is expected to be small, hinting it to use fast in-memory temporary tables rather than on-disk ones for GROUP BY or DISTINCT processing.

## Full Syntax

\`\`\`sql
SELECT SQL_SMALL_RESULT
    col1,
    col2,
    ...
FROM table_name
GROUP BY col1;
\`\`\`

## Examples

\`\`\`sql
SELECT SQL_SMALL_RESULT DISTINCT status FROM orders
\`\`\`
`
},

{
    name: 'SQL_BIG_RESULT',

    signature:
        'SELECT SQL_BIG_RESULT select_expr [, select_expr ...]',

    documentation: `
# SQL_BIG_RESULT

\`\`\`sql
SELECT SQL_BIG_RESULT select_expr [, select_expr ...]
\`\`\`

Tells the optimizer that the result set is expected to be large, hinting it to use on-disk temporary tables with sorting directly, instead of an in-memory temporary table, for GROUP BY or DISTINCT processing.

## Full Syntax

\`\`\`sql
SELECT SQL_BIG_RESULT
    col1,
    col2,
    ...
FROM table_name
GROUP BY col1;
\`\`\`

## Examples

\`\`\`sql
SELECT SQL_BIG_RESULT DISTINCT customer_id FROM orders
\`\`\`
`
},

{
    name: 'SQL_BUFFER_RESULT',

    signature:
        'SELECT SQL_BUFFER_RESULT select_expr [, select_expr ...]',

    documentation: `
# SQL_BUFFER_RESULT

\`\`\`sql
SELECT SQL_BUFFER_RESULT select_expr [, select_expr ...]
\`\`\`

Forces the result to be put into a temporary table right away, releasing the locks on the source tables as soon as possible. Useful when sending the result to the client would otherwise take a long time.

## Full Syntax

\`\`\`sql
SELECT SQL_BUFFER_RESULT
    col1,
    col2,
    ...
FROM table_name;
\`\`\`

## Examples

\`\`\`sql
SELECT SQL_BUFFER_RESULT * FROM large_table
\`\`\`
`
},

{
    name: 'SQL_NO_CACHE',

    signature:
        'SELECT SQL_NO_CACHE select_expr [, select_expr ...]',

    documentation: `
# SQL_NO_CACHE

\`\`\`sql
SELECT SQL_NO_CACHE select_expr [, select_expr ...]
\`\`\`

Tells the server not to cache the result of this query in the query cache, and not to check the cache for a previously cached result. Useful for queries whose result changes often or should always be read fresh.

## Full Syntax

\`\`\`sql
SELECT SQL_NO_CACHE
    col1,
    col2,
    ...
FROM table_name;
\`\`\`

## Examples

\`\`\`sql
SELECT SQL_NO_CACHE NOW(), status FROM system_state
\`\`\`
`
},

{
    name: 'SQL_CALC_FOUND_ROWS',

    signature:
        'SELECT SQL_CALC_FOUND_ROWS select_expr [, select_expr ...]',

    documentation: `
# SQL_CALC_FOUND_ROWS

\`\`\`sql
SELECT SQL_CALC_FOUND_ROWS select_expr [, select_expr ...]
\`\`\`

Tells the server to calculate how many rows would have been returned without the LIMIT clause. That number can then be retrieved with a following \`SELECT FOUND_ROWS()\` call, without running the query a second time.

## Full Syntax

\`\`\`sql
SELECT SQL_CALC_FOUND_ROWS
    col1,
    col2,
    ...
FROM table_name
LIMIT 10;

SELECT FOUND_ROWS();
\`\`\`

## Examples

\`\`\`sql
SELECT SQL_CALC_FOUND_ROWS * FROM customers LIMIT 10
\`\`\`

\`\`\`sql
SELECT FOUND_ROWS()
\`\`\`
`
},

];
