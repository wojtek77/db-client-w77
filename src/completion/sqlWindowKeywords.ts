import type { SqlKeyword } from './sqlKeywords.js';
import { buildKeyword } from './sqlConditionKeywords.js';

// słowa składni okna MariaDB (10.2+) - podpowiadane tylko w kontekstach wykrywanych przez detectWindowPosition, kolejność na liście = kolejność podpowiedzi
export const WINDOW_KEYWORDS: SqlKeyword[] = [
    buildKeyword({
        name: 'OVER',
        contexts: ['after-window-function'],
        snippet: 'OVER ($1)$0',
        retriggerSuggest: true,
        syntax: 'function(...) OVER ([PARTITION BY expr, ...] [ORDER BY expr [ASC | DESC], ...] [frame_clause])',
        description: 'Turns a function into a window function: it is computed over a set of rows related to the current row (the window) without collapsing them into one row, as GROUP BY does. Available in MariaDB 10.2+. Window functions are allowed only in the SELECT list and in ORDER BY.',
        examples: [
            'SELECT name, salary, ROW_NUMBER() OVER (ORDER BY salary DESC) AS rn\nFROM employees',
            'SELECT department, salary, SUM(salary) OVER (PARTITION BY department) AS department_total\nFROM employees',
        ],
    }),
    buildKeyword({
        name: 'PARTITION BY',
        contexts: ['window-spec-start'],
        snippet: 'PARTITION BY $0',
        retriggerSuggest: true,
        syntax: 'OVER (PARTITION BY expr [, expr] ...)',
        description: 'Splits the rows into partitions inside OVER (...). The window function is computed separately for each partition, and the numbering or aggregation restarts in each of them. Without PARTITION BY the whole result set is one partition.',
        examples: [
            'SELECT *, ROW_NUMBER() OVER (PARTITION BY study_id ORDER BY id) AS rn\nFROM study_qualification',
        ],
    }),
    buildKeyword({
        name: 'ORDER BY',
        contexts: ['window-spec-start', 'window-spec-after-partition'],
        snippet: 'ORDER BY $0',
        retriggerSuggest: true,
        syntax: 'OVER ([PARTITION BY ...] ORDER BY expr [ASC | DESC] [, expr [ASC | DESC]] ...)',
        description: 'Defines the order of rows inside each partition of the window. Functions such as ROW_NUMBER, RANK or LAG depend on it, and for aggregates it makes the window grow row by row (running total).',
        examples: [
            'SELECT *, ROW_NUMBER() OVER (PARTITION BY study_id ORDER BY FIELD(type, \'a\', \'b\', \'c\')) AS rn\nFROM study_qualification',
            'SELECT day, SUM(amount) OVER (ORDER BY day) AS running_total\nFROM payments',
        ],
    }),
];
