export interface SqlFunction {
    category: string;
    name: string;
    signature: string;
    snippet: string;
    documentation: string;
}

export const SQL_FUNCTIONS: SqlFunction[] = [

    // aggregate

{
    category: 'Aggregate',

    name: 'COUNT',

    signature:
        'COUNT(expr)',

    snippet:
        'COUNT(${1:column})',

    documentation: `
# COUNT

\`\`\`sql
COUNT(expr)
\`\`\`

Counts matching non-NULL values.

## Full Syntax

\`\`\`sql
COUNT(expr)
\`\`\`

## Examples

\`\`\`sql
COUNT(id)
\`\`\`

\`\`\`sql
COUNT(email1)
\`\`\`

\`\`\`sql
COUNT(*)
\`\`\`
`
},

{
    category: 'Aggregate',

    name: 'SUM',

    signature:
        'SUM(expr)',

    snippet:
        'SUM(${1:column})',

    documentation: `
# SUM

\`\`\`sql
SUM(expr)
\`\`\`

Returns the sum of all values.

## Full Syntax

\`\`\`sql
SUM(expr)
\`\`\`

## Examples

\`\`\`sql
SUM(amount)
\`\`\`

\`\`\`sql
SUM(total_revenue)
\`\`\`

\`\`\`sql
SUM(hours_worked)
\`\`\`
`
},

{
    category: 'Aggregate',

    name: 'AVG',

    signature:
        'AVG(expr)',

    snippet:
        'AVG(${1:column})',

    documentation: `
# AVG

\`\`\`sql
AVG(expr)
\`\`\`

Returns the average value.

## Full Syntax

\`\`\`sql
AVG(expr)
\`\`\`

## Examples

\`\`\`sql
AVG(amount)
\`\`\`

\`\`\`sql
AVG(score)
\`\`\`

\`\`\`sql
AVG(price)
\`\`\`
`
},

{
    category: 'Aggregate',

    name: 'MIN',

    signature:
        'MIN(expr)',

    snippet:
        'MIN(${1:column})',

    documentation: `
# MIN

\`\`\`sql
MIN(expr)
\`\`\`

Returns the smallest value.

## Full Syntax

\`\`\`sql
MIN(expr)
\`\`\`

## Examples

\`\`\`sql
MIN(created_date)
\`\`\`

\`\`\`sql
MIN(amount)
\`\`\`

\`\`\`sql
MIN(price)
\`\`\`
`
},

{
    category: 'Aggregate',

    name: 'MAX',

    signature:
        'MAX(expr)',

    snippet:
        'MAX(${1:column})',

    documentation: `
# MAX

\`\`\`sql
MAX(expr)
\`\`\`

Returns the largest value.

## Full Syntax

\`\`\`sql
MAX(expr)
\`\`\`

## Examples

\`\`\`sql
MAX(created_date)
\`\`\`

\`\`\`sql
MAX(amount)
\`\`\`

\`\`\`sql
MAX(price)
\`\`\`
`
},

{
    category: 'Aggregate',

    name: 'GROUP_CONCAT',

    signature:
        'GROUP_CONCAT([DISTINCT] expr [ORDER BY ...] [SEPARATOR str])',

    snippet:
        'GROUP_CONCAT(${1:column})',

    documentation: `
# GROUP_CONCAT

\`\`\`sql
GROUP_CONCAT(
    [DISTINCT] expr
    [ORDER BY expr]
    [SEPARATOR str]
)
\`\`\`

Concatenates values from grouped rows into a single string.

## Full Syntax

\`\`\`sql
SELECT
    col1,
    col2,
    ...,
    colN,
    GROUP_CONCAT(
        [DISTINCT] col_name1
        [ORDER BY clause]
        [SEPARATOR str_val]
    )
FROM table_name
GROUP BY col_name2;
\`\`\`

## Examples

\`\`\`sql
GROUP_CONCAT(first_name)
\`\`\`

\`\`\`sql
GROUP_CONCAT(
    first_name
    ORDER BY first_name
)
\`\`\`

\`\`\`sql
GROUP_CONCAT(
    first_name
    SEPARATOR ', '
)
\`\`\`
`
},
// string

{
    category: 'String',

    name: 'CONCAT',

    signature:
        'CONCAT(str1, str2, ...)',

    snippet:
        'CONCAT(${1:str1}, ${2:str2})',

    documentation: `
# CONCAT

\`\`\`sql
CONCAT(str1, str2, ...)
\`\`\`

Concatenates multiple strings into a single string.

## Full Syntax

\`\`\`sql
CONCAT(str1, str2, ...)
\`\`\`

## Examples

\`\`\`sql
CONCAT(first_name, ' ', last_name)
\`\`\`

\`\`\`sql
CONCAT(city, ', ', country)
\`\`\`

\`\`\`sql
CONCAT('User: ', user_name)
\`\`\`
`
},

{
    category: 'String',

    name: 'SUBSTRING',

    signature:
        'SUBSTRING(str, pos, len)',

    snippet:
        'SUBSTRING(${1:str}, ${2:1}, ${3:length})',

    documentation: `
# SUBSTRING

\`\`\`sql
SUBSTRING(str, pos, len)
\`\`\`

Extracts part of a string.

## Full Syntax

\`\`\`sql
SUBSTRING(str, pos, len)
\`\`\`

## Examples

\`\`\`sql
SUBSTRING(first_name, 1, 3)
\`\`\`

\`\`\`sql
SUBSTRING(email1, 1, 10)
\`\`\`

\`\`\`sql
SUBSTRING(phone_mobile, 4, 3)
\`\`\`
`
},

{
    category: 'String',

    name: 'LENGTH',

    signature:
        'LENGTH(str)',

    snippet:
        'LENGTH(${1:str})',

    documentation: `
# LENGTH

\`\`\`sql
LENGTH(str)
\`\`\`

Returns the length of a string in bytes.

## Full Syntax

\`\`\`sql
LENGTH(str)
\`\`\`

## Examples

\`\`\`sql
LENGTH(first_name)
\`\`\`

\`\`\`sql
LENGTH(email1)
\`\`\`

\`\`\`sql
LENGTH(description)
\`\`\`
`
},

{
    category: 'String',

    name: 'REPLACE',

    signature:
        'REPLACE(str, from_str, to_str)',

    snippet:
        'REPLACE(${1:str}, ${2:from}, ${3:to})',

    documentation: `
# REPLACE

\`\`\`sql
REPLACE(str, from_str, to_str)
\`\`\`

Replaces occurrences of a substring.

## Full Syntax

\`\`\`sql
REPLACE(str, from_str, to_str)
\`\`\`

## Examples

\`\`\`sql
REPLACE(phone_mobile, '-', '')
\`\`\`

\`\`\`sql
REPLACE(email1, '@old.com', '@new.com')
\`\`\`

\`\`\`sql
REPLACE(name, 'Ltd', 'Limited')
\`\`\`
`
},

{
    category: 'String',

    name: 'TRIM',

    signature:
        'TRIM(str)',

    snippet:
        'TRIM(${1:str})',

    documentation: `
# TRIM

\`\`\`sql
TRIM(str)
\`\`\`

Removes leading and trailing spaces.

## Full Syntax

\`\`\`sql
TRIM(str)
\`\`\`

## Examples

\`\`\`sql
TRIM(first_name)
\`\`\`

\`\`\`sql
TRIM(email1)
\`\`\`

\`\`\`sql
TRIM(description)
\`\`\`
`
},

{
    category: 'String',

    name: 'LOWER',

    signature:
        'LOWER(str)',

    snippet:
        'LOWER(${1:str})',

    documentation: `
# LOWER

\`\`\`sql
LOWER(str)
\`\`\`

Converts text to lowercase.

## Full Syntax

\`\`\`sql
LOWER(str)
\`\`\`

## Examples

\`\`\`sql
LOWER(first_name)
\`\`\`

\`\`\`sql
LOWER(email1)
\`\`\`

\`\`\`sql
LOWER(user_name)
\`\`\`
`
},

{
    category: 'String',

    name: 'UPPER',

    signature:
        'UPPER(str)',

    snippet:
        'UPPER(${1:str})',

    documentation: `
# UPPER

\`\`\`sql
UPPER(str)
\`\`\`

Converts text to uppercase.

## Full Syntax

\`\`\`sql
UPPER(str)
\`\`\`

## Examples

\`\`\`sql
UPPER(first_name)
\`\`\`

\`\`\`sql
UPPER(email1)
\`\`\`

\`\`\`sql
UPPER(user_name)
\`\`\`
`
},
// date & Time

{
    category: 'Date & Time',

    name: 'NOW',

    signature:
        'NOW()',

    snippet:
        'NOW()',

    documentation: `
# NOW

\`\`\`sql
NOW()
\`\`\`

Returns the current date and time.

## Full Syntax

\`\`\`sql
NOW()
\`\`\`

## Examples

\`\`\`sql
NOW()
\`\`\`

\`\`\`sql
SELECT NOW()
\`\`\`

\`\`\`sql
created_date < NOW()
\`\`\`
`
},

{
    category: 'Date & Time',

    name: 'CURDATE',

    signature:
        'CURDATE()',

    snippet:
        'CURDATE()',

    documentation: `
# CURDATE

\`\`\`sql
CURDATE()
\`\`\`

Returns the current date.

## Full Syntax

\`\`\`sql
CURDATE()
\`\`\`

## Examples

\`\`\`sql
CURDATE()
\`\`\`

\`\`\`sql
SELECT CURDATE()
\`\`\`

\`\`\`sql
date_entered >= CURDATE()
\`\`\`
`
},

{
    category: 'Date & Time',

    name: 'DATE_ADD',

    signature:
        'DATE_ADD(date, INTERVAL expr unit)',

    snippet:
        'DATE_ADD(${1:date}, INTERVAL ${2:1} ${3:DAY})',

    documentation: `
# DATE_ADD

\`\`\`sql
DATE_ADD(date, INTERVAL expr unit)
\`\`\`

Adds an interval to a date.

## Full Syntax

\`\`\`sql
DATE_ADD(
    date,
    INTERVAL expr unit
)
\`\`\`

## Examples

\`\`\`sql
DATE_ADD(NOW(), INTERVAL 1 DAY)
\`\`\`

\`\`\`sql
DATE_ADD(date_entered, INTERVAL 7 DAY)
\`\`\`

\`\`\`sql
DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
\`\`\`
`
},

{
    category: 'Date & Time',

    name: 'DATE_SUB',

    signature:
        'DATE_SUB(date, INTERVAL expr unit)',

    snippet:
        'DATE_SUB(${1:date}, INTERVAL ${2:1} ${3:DAY})',

    documentation: `
# DATE_SUB

\`\`\`sql
DATE_SUB(date, INTERVAL expr unit)
\`\`\`

Subtracts an interval from a date.

## Full Syntax

\`\`\`sql
DATE_SUB(
    date,
    INTERVAL expr unit
)
\`\`\`

## Examples

\`\`\`sql
DATE_SUB(NOW(), INTERVAL 1 DAY)
\`\`\`

\`\`\`sql
DATE_SUB(date_entered, INTERVAL 30 DAY)
\`\`\`

\`\`\`sql
DATE_SUB(CURDATE(), INTERVAL 1 YEAR)
\`\`\`
`
},

{
    category: 'Date & Time',

    name: 'DATEDIFF',

    signature:
        'DATEDIFF(expr1, expr2)',

    snippet:
        'DATEDIFF(${1:date1}, ${2:date2})',

    documentation: `
# DATEDIFF

\`\`\`sql
DATEDIFF(expr1, expr2)
\`\`\`

Returns the number of days between two dates.

## Full Syntax

\`\`\`sql
DATEDIFF(expr1, expr2)
\`\`\`

## Examples

\`\`\`sql
DATEDIFF(NOW(), date_entered)
\`\`\`

\`\`\`sql
DATEDIFF(due_date, CURDATE())
\`\`\`

\`\`\`sql
DATEDIFF(closed_date, created_date)
\`\`\`
`
},

{
    category: 'Date & Time',

    name: 'DATE_FORMAT',

    signature:
        'DATE_FORMAT(date, format)',

    snippet:
        'DATE_FORMAT(${1:date}, ${2:\'%Y-%m-%d\'})',

    documentation: `
# DATE_FORMAT

\`\`\`sql
DATE_FORMAT(date, format)
\`\`\`

Formats a date according to the specified format string.

## Full Syntax

\`\`\`sql
DATE_FORMAT(date, format)
\`\`\`

## Examples

\`\`\`sql
DATE_FORMAT(NOW(), '%Y-%m-%d')
\`\`\`

\`\`\`sql
DATE_FORMAT(date_entered, '%d.%m.%Y')
\`\`\`

\`\`\`sql
DATE_FORMAT(created_date, '%Y-%m-%d %H:%i:%s')
\`\`\`
`
},
// numeric & Math

{
    category: 'Numeric & Math',

    name: 'ABS',

    signature:
        'ABS(X)',

    snippet:
        'ABS(${1:number})',

    documentation: `
# ABS

\`\`\`sql
ABS(X)
\`\`\`

Returns the absolute value of a number.

## Full Syntax

\`\`\`sql
ABS(X)
\`\`\`

## Examples

\`\`\`sql
ABS(-10)
\`\`\`

\`\`\`sql
ABS(balance)
\`\`\`

\`\`\`sql
ABS(amount_difference)
\`\`\`
`
},

{
    category: 'Numeric & Math',

    name: 'ROUND',

    signature:
        'ROUND(X, D)',

    snippet:
        'ROUND(${1:number}, ${2:2})',

    documentation: `
# ROUND

\`\`\`sql
ROUND(X, D)
\`\`\`

Rounds a number to a specified number of decimal places.

## Full Syntax

\`\`\`sql
ROUND(X, D)
\`\`\`

## Examples

\`\`\`sql
ROUND(price, 2)
\`\`\`

\`\`\`sql
ROUND(amount, 0)
\`\`\`

\`\`\`sql
ROUND(AVG(total), 2)
\`\`\`
`
},

{
    category: 'Numeric & Math',

    name: 'CEIL',

    signature:
        'CEIL(X)',

    snippet:
        'CEIL(${1:number})',

    documentation: `
# CEIL

\`\`\`sql
CEIL(X)
\`\`\`

Returns the smallest integer greater than or equal to X.

## Full Syntax

\`\`\`sql
CEIL(X)
\`\`\`

## Examples

\`\`\`sql
CEIL(10.2)
\`\`\`

\`\`\`sql
CEIL(price)
\`\`\`

\`\`\`sql
CEIL(AVG(amount))
\`\`\`
`
},

{
    category: 'Numeric & Math',

    name: 'FLOOR',

    signature:
        'FLOOR(X)',

    snippet:
        'FLOOR(${1:number})',

    documentation: `
# FLOOR

\`\`\`sql
FLOOR(X)
\`\`\`

Returns the largest integer less than or equal to X.

## Full Syntax

\`\`\`sql
FLOOR(X)
\`\`\`

## Examples

\`\`\`sql
FLOOR(10.9)
\`\`\`

\`\`\`sql
FLOOR(price)
\`\`\`

\`\`\`sql
FLOOR(AVG(amount))
\`\`\`
`
},

{
    category: 'Numeric & Math',

    name: 'MOD',

    signature:
        'MOD(N, M)',

    snippet:
        'MOD(${1:number}, ${2:divisor})',

    documentation: `
# MOD

\`\`\`sql
MOD(N, M)
\`\`\`

Returns the remainder of a division.

## Full Syntax

\`\`\`sql
MOD(N, M)
\`\`\`

## Examples

\`\`\`sql
MOD(10, 3)
\`\`\`

\`\`\`sql
MOD(invoice_number, 2)
\`\`\`

\`\`\`sql
MOD(record_id, 10)
\`\`\`
`
},

{
    category: 'Numeric & Math',

    name: 'POW',

    signature:
        'POW(X, Y)',

    snippet:
        'POW(${1:base}, ${2:power})',

    documentation: `
# POW

\`\`\`sql
POW(X, Y)
\`\`\`

Raises a number to the power of another number.

## Full Syntax

\`\`\`sql
POW(X, Y)
\`\`\`

## Examples

\`\`\`sql
POW(2, 8)
\`\`\`

\`\`\`sql
POW(amount, 2)
\`\`\`

\`\`\`sql
POW(score, 3)
\`\`\`
`
},
// control Flow

{
    category: 'Control Flow',

    name: 'IF',

    signature:
        'IF(expr1, expr2, expr3)',

    snippet:
        'IF(${1:condition}, ${2:true_value}, ${3:false_value})',

    documentation: `
# IF

\`\`\`sql
IF(expr1, expr2, expr3)
\`\`\`

Returns one value if the condition is TRUE and another if FALSE.

## Full Syntax

\`\`\`sql
IF(expr1, expr2, expr3)
\`\`\`

## Examples

\`\`\`sql
IF(amount > 0, 'YES', 'NO')
\`\`\`

\`\`\`sql
IF(status = 'Active', 1, 0)
\`\`\`

\`\`\`sql
IF(email1 IS NULL, 'Missing', email1)
\`\`\`
`
},

{
    category: 'Control Flow',

    name: 'IFNULL',

    signature:
        'IFNULL(expr1, expr2)',

    snippet:
        'IFNULL(${1:value}, ${2:replacement})',

    documentation: `
# IFNULL

\`\`\`sql
IFNULL(expr1, expr2)
\`\`\`

Returns an alternative value when the first expression is NULL.

## Full Syntax

\`\`\`sql
IFNULL(expr1, expr2)
\`\`\`

## Examples

\`\`\`sql
IFNULL(phone_mobile, '')
\`\`\`

\`\`\`sql
IFNULL(amount, 0)
\`\`\`

\`\`\`sql
IFNULL(email1, 'unknown@example.com')
\`\`\`
`
},

{
    category: 'Control Flow',

    name: 'COALESCE',

    signature:
        'COALESCE(value, ...)',

    snippet:
        'COALESCE(${1:value1}, ${2:value2})',

    documentation: `
# COALESCE

\`\`\`sql
COALESCE(value, ...)
\`\`\`

Returns the first non-NULL value from the provided list.

## Full Syntax

\`\`\`sql
COALESCE(value1, value2, value3, ...)
\`\`\`

## Examples

\`\`\`sql
COALESCE(phone_mobile, phone_work)
\`\`\`

\`\`\`sql
COALESCE(email1, email2, 'no-email')
\`\`\`

\`\`\`sql
COALESCE(amount, 0)
\`\`\`
`
},

{
    category: 'Control Flow',

    name: 'CASE',

    signature:
        'CASE WHEN condition THEN value ... END',

    snippet:
        'CASE\n    WHEN ${1:condition} THEN ${2:value}\n    ELSE ${3:value}\nEND',

    documentation: `
# CASE

\`\`\`sql
CASE
    WHEN condition THEN value
    ELSE value
END
\`\`\`

Evaluates conditions and returns the first matching result.

## Full Syntax

\`\`\`sql
CASE
    WHEN condition1 THEN result1
    WHEN condition2 THEN result2
    ELSE result
END
\`\`\`

## Examples

\`\`\`sql
CASE
    WHEN amount > 1000 THEN 'High'
    ELSE 'Normal'
END
\`\`\`

\`\`\`sql
CASE
    WHEN status = 'Active' THEN 1
    ELSE 0
END
\`\`\`

\`\`\`sql
CASE
    WHEN score >= 90 THEN 'A'
    WHEN score >= 80 THEN 'B'
    ELSE 'C'
END
\`\`\`
`
},

// information & System

{
    category: 'Information & System',

    name: 'VERSION',

    signature:
        'VERSION()',

    snippet:
        'VERSION()',

    documentation: `
# VERSION

\`\`\`sql
VERSION()
\`\`\`

Returns the MariaDB server version.

## Full Syntax

\`\`\`sql
VERSION()
\`\`\`

## Examples

\`\`\`sql
SELECT VERSION();
\`\`\`

\`\`\`sql
SELECT CONCAT('MariaDB ', VERSION());
\`\`\`

\`\`\`sql
SELECT VERSION() AS server_version;
\`\`\`
`
},

{
    category: 'Information & System',

    name: 'USER',

    signature:
        'USER()',

    snippet:
        'USER()',

    documentation: `
# USER

\`\`\`sql
USER()
\`\`\`

Returns the current authenticated user and host.

## Full Syntax

\`\`\`sql
USER()
\`\`\`

## Examples

\`\`\`sql
SELECT USER();
\`\`\`

\`\`\`sql
SELECT USER() AS current_user;
\`\`\`

\`\`\`sql
SELECT CONCAT('Logged as ', USER());
\`\`\`
`
},

{
    category: 'Information & System',

    name: 'DATABASE',

    signature:
        'DATABASE()',

    snippet:
        'DATABASE()',

    documentation: `
# DATABASE

\`\`\`sql
DATABASE()
\`\`\`

Returns the currently selected database.

## Full Syntax

\`\`\`sql
DATABASE()
\`\`\`

## Examples

\`\`\`sql
SELECT DATABASE();
\`\`\`

\`\`\`sql
SELECT DATABASE() AS current_database;
\`\`\`

\`\`\`sql
SELECT CONCAT('DB: ', DATABASE());
\`\`\`
`
},

{
    category: 'Information & System',

    name: 'LAST_INSERT_ID',

    signature:
        'LAST_INSERT_ID()',

    snippet:
        'LAST_INSERT_ID()',

    documentation: `
# LAST_INSERT_ID

\`\`\`sql
LAST_INSERT_ID()
\`\`\`

Returns the most recently generated AUTO_INCREMENT value.

## Full Syntax

\`\`\`sql
LAST_INSERT_ID()
\`\`\`

## Examples

\`\`\`sql
SELECT LAST_INSERT_ID();
\`\`\`

\`\`\`sql
INSERT INTO contacts(name)
VALUES('John');

SELECT LAST_INSERT_ID();
\`\`\`

\`\`\`sql
SELECT CONCAT('New ID: ', LAST_INSERT_ID());
\`\`\`
`
},
];
