import type { SqlKeyword, KeywordContext } from './sqlKeywords.js';

interface KeywordSpec {
    name: string;
    contexts: KeywordContext[];
    syntax: string;
    description: string;
    examples: string[];
    // snippet wstawiany zamiast samej nazwy - placeholdery otwierają od razu miejsce do uzupełnienia
    snippet?: string;
}

// składa dokumentację w tym samym formacie markdown co ręcznie zapisane wpisy w sqlKeywords.ts
function buildKeyword(spec: KeywordSpec): SqlKeyword {
    const fence = '```';
    const examples = spec.examples.map(example => `${fence}sql\n${example}\n${fence}`).join('\n\n');
    return {
        name: spec.name,
        contexts: spec.contexts,
        snippet: spec.snippet,
        signature: spec.syntax,
        documentation: `\n# ${spec.name}\n\n${fence}sql\n${spec.syntax}\n${fence}\n\n${spec.description}\n\n## Examples\n\n${examples}\n`,
    };
}

const AT_START: KeywordContext[] = ['expression-start'];
const AFTER_OPERAND: KeywordContext[] = ['after-operand'];
// słowo pasuje zarówno bezpośrednio po operandzie, jak i po postfiksowym NOT (np. "id NOT IN", "id NOT LIKE")
const AFTER_OPERAND_OR_NOT: KeywordContext[] = ['after-operand', 'after-not'];

// kolejność na liście decyduje o kolejności podpowiedzi w danym kontekście
export const CONDITION_KEYWORDS: SqlKeyword[] = [
    buildKeyword({
        name: 'NOT',
        contexts: AT_START,
        syntax: 'NOT condition',
        description: 'Negates a condition: returns 1 when the condition is 0, 0 when it is non-zero, and NULL when it is NULL. `!` is a synonym.',
        examples: ['SELECT * FROM customers WHERE NOT active', 'SELECT * FROM customers WHERE NOT (city = \'Paris\' OR city = \'Rome\')'],
    }),
    buildKeyword({
        name: 'EXISTS',
        contexts: AT_START,
        snippet: 'EXISTS (SELECT 1 FROM ${1:table_name} WHERE ${2:1})',
        syntax: 'EXISTS (subquery)',
        description: 'Returns 1 if the subquery returns at least one row, otherwise 0 (never NULL). The select list of the subquery does not matter, so `SELECT 1` is the usual choice. Typically used with a correlated subquery that references the outer table.',
        examples: [
            'SELECT * FROM customers c\nWHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)',
        ],
    }),
    buildKeyword({
        name: 'NOT EXISTS',
        contexts: AT_START,
        snippet: 'NOT EXISTS (SELECT 1 FROM ${1:table_name} WHERE ${2:1})',
        syntax: 'NOT EXISTS (subquery)',
        description: 'Returns 1 if the subquery returns no rows, otherwise 0 (never NULL). A common way to find rows that have no match in another table, and unlike `NOT IN` it is not affected by NULL values in the subquery result.',
        examples: [
            'SELECT * FROM customers c\nWHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)',
        ],
    }),

    buildKeyword({
        name: 'AND',
        contexts: AFTER_OPERAND,
        syntax: 'condition AND condition',
        description: 'Logical AND: returns 1 if both operands are non-zero and not NULL, 0 if any operand is 0, otherwise NULL. `&&` is a synonym. AND binds tighter than OR, so use parentheses when mixing them.',
        examples: ['SELECT * FROM customers WHERE active = 1 AND city = \'Paris\''],
    }),
    buildKeyword({
        name: 'OR',
        contexts: AFTER_OPERAND,
        syntax: 'condition OR condition',
        description: 'Logical OR: returns 1 if any operand is non-zero and not NULL, 0 if both are 0, otherwise NULL. AND binds tighter than OR, so use parentheses when mixing them.',
        examples: ['SELECT * FROM customers WHERE city = \'Paris\' OR city = \'Rome\''],
    }),
    buildKeyword({
        name: 'IN',
        contexts: AFTER_OPERAND_OR_NOT,
        snippet: 'IN ($1)$0',
        syntax: 'expr IN (value, ...)\nexpr IN (subquery)',
        description: 'Returns 1 if expr equals any value in the list or in the subquery result, otherwise 0. If expr is NULL, or there is no match and the list contains NULL, the result is NULL.',
        examples: ['SELECT * FROM customers WHERE city IN (\'Paris\', \'Rome\')', 'SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders)'],
    }),
    buildKeyword({
        name: 'NOT IN',
        contexts: AFTER_OPERAND,
        snippet: 'NOT IN ($1)$0',
        syntax: 'expr NOT IN (value, ...)\nexpr NOT IN (subquery)',
        description: 'Negation of `IN`. Beware of NULL: if the list or the subquery result contains NULL and there is no match, the result is NULL (not 1), so the row is filtered out. Prefer `NOT EXISTS` when the subquery column can be NULL.',
        examples: ['SELECT * FROM customers WHERE city NOT IN (\'Paris\', \'Rome\')'],
    }),
    buildKeyword({
        name: 'BETWEEN',
        contexts: AFTER_OPERAND_OR_NOT,
        snippet: 'BETWEEN ${1:min} AND ${2:max}',
        syntax: 'expr BETWEEN min AND max',
        description: 'Returns 1 if expr lies in the range from min to max, both bounds included. Equivalent to `min <= expr AND expr <= max`.',
        examples: ['SELECT * FROM orders WHERE total BETWEEN 100 AND 500', 'SELECT * FROM orders WHERE created_at BETWEEN \'2024-01-01\' AND \'2024-12-31\''],
    }),
    buildKeyword({
        name: 'NOT BETWEEN',
        contexts: AFTER_OPERAND,
        snippet: 'NOT BETWEEN ${1:min} AND ${2:max}',
        syntax: 'expr NOT BETWEEN min AND max',
        description: 'Negation of `BETWEEN`: returns 1 if expr lies outside the range from min to max.',
        examples: ['SELECT * FROM orders WHERE total NOT BETWEEN 100 AND 500'],
    }),
    buildKeyword({
        name: 'LIKE',
        contexts: AFTER_OPERAND_OR_NOT,
        snippet: 'LIKE \'%$1\'$0',
        syntax: 'expr LIKE pattern [ESCAPE escape_char]',
        description: 'Simple pattern matching: `%` matches any sequence of characters (including none) and `_` matches exactly one character. Case sensitivity depends on the collation of the operands.',
        examples: ['SELECT * FROM customers WHERE name LIKE \'Ann%\'', 'SELECT * FROM files WHERE name LIKE \'%\\_backup\' ESCAPE \'\\\\\''],
    }),
    buildKeyword({
        name: 'NOT LIKE',
        contexts: AFTER_OPERAND,
        snippet: 'NOT LIKE \'%$1\'$0',
        syntax: 'expr NOT LIKE pattern [ESCAPE escape_char]',
        description: 'Negation of `LIKE`: returns 1 if expr does not match the pattern.',
        examples: ['SELECT * FROM customers WHERE name NOT LIKE \'Ann%\''],
    }),
    buildKeyword({
        name: 'IS NULL',
        contexts: AFTER_OPERAND,
        syntax: 'expr IS NULL',
        description: 'Returns 1 if expr is NULL, otherwise 0. Use it instead of `= NULL`, which is never true. For a NULL-safe comparison of two values use the `<=>` operator.',
        examples: ['SELECT * FROM customers WHERE phone IS NULL'],
    }),
    buildKeyword({
        name: 'IS NOT NULL',
        contexts: AFTER_OPERAND,
        syntax: 'expr IS NOT NULL',
        description: 'Returns 1 if expr is not NULL, otherwise 0.',
        examples: ['SELECT * FROM customers WHERE phone IS NOT NULL'],
    }),
    buildKeyword({
        name: 'REGEXP',
        contexts: AFTER_OPERAND_OR_NOT,
        snippet: 'REGEXP \'$1\'$0',
        syntax: 'expr REGEXP pattern',
        description: 'Returns 1 if expr matches the regular expression pattern (PCRE), otherwise 0. If either operand is NULL the result is NULL. `RLIKE` is a synonym.',
        examples: ['SELECT * FROM customers WHERE email REGEXP \'^[a-z]+@example\\\\.com$\''],
    }),
    buildKeyword({
        name: 'NOT REGEXP',
        contexts: AFTER_OPERAND,
        snippet: 'NOT REGEXP \'$1\'$0',
        syntax: 'expr NOT REGEXP pattern',
        description: 'Negation of `REGEXP`: returns 1 if expr does not match the regular expression.',
        examples: ['SELECT * FROM customers WHERE email NOT REGEXP \'@example\\\\.com$\''],
    }),
    buildKeyword({
        name: 'RLIKE',
        contexts: AFTER_OPERAND_OR_NOT,
        snippet: 'RLIKE \'$1\'$0',
        syntax: 'expr RLIKE pattern',
        description: 'Synonym of `REGEXP`: returns 1 if expr matches the regular expression pattern.',
        examples: ['SELECT * FROM customers WHERE name RLIKE \'^A\''],
    }),
    buildKeyword({
        name: 'NOT RLIKE',
        contexts: AFTER_OPERAND,
        snippet: 'NOT RLIKE \'$1\'$0',
        syntax: 'expr NOT RLIKE pattern',
        description: 'Synonym of `NOT REGEXP`: returns 1 if expr does not match the regular expression.',
        examples: ['SELECT * FROM customers WHERE name NOT RLIKE \'^A\''],
    }),
    buildKeyword({
        name: 'IS TRUE',
        contexts: AFTER_OPERAND,
        syntax: 'expr IS TRUE',
        description: 'Returns 1 if expr is non-zero and not NULL, otherwise 0 (never NULL).',
        examples: ['SELECT * FROM customers WHERE active IS TRUE'],
    }),
    buildKeyword({
        name: 'IS FALSE',
        contexts: AFTER_OPERAND,
        syntax: 'expr IS FALSE',
        description: 'Returns 1 if expr is 0, otherwise 0 (never NULL). Unlike `NOT expr`, a NULL value gives 0, not NULL.',
        examples: ['SELECT * FROM customers WHERE active IS FALSE'],
    }),
    buildKeyword({
        name: 'XOR',
        contexts: AFTER_OPERAND,
        syntax: 'condition XOR condition',
        description: 'Logical XOR: returns 1 if exactly one operand is non-zero, 0 if both are zero or both are non-zero, and NULL if either operand is NULL.',
        examples: ['SELECT * FROM customers WHERE is_vip XOR has_discount'],
    }),
];
