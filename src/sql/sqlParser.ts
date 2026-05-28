export interface ParsedQuery {
    columns: string[];
    tables: string[];
    originalSql: string;
}

// Funkcja do pobierania kolumn z cache (będzie przekazana z zewnątrz)
let getCachedColumnsFn: ((tableName: string) => Promise<string[]>) | null = null;

export function setGetCachedColumnsFunction(fn: (tableName: string) => Promise<string[]>) {
    getCachedColumnsFn = fn;
}

function splitTopLevel(input: string, separator: string): string[] {
    const result: string[] = [];

    let current = '';
    let parentheses = 0;
    let singleQuote = false;
    let doubleQuote = false;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (char === "'" && !doubleQuote) {
            singleQuote = !singleQuote;
        }

        if (char === '"' && !singleQuote) {
            doubleQuote = !doubleQuote;
        }

        if (!singleQuote && !doubleQuote) {
            if (char === '(') {
                parentheses++;
            } else if (char === ')') {
                parentheses--;
            }

            if (char === separator && parentheses === 0) {
                result.push(current.trim());
                current = '';
                continue;
            }
        }

        current += char;
    }

    if (current.trim()) {
        result.push(current.trim());
    }

    return result;
}

function findTopLevelKeyword(sql: string, keyword: string): number {
    const lowerSql = sql.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();

    let parentheses = 0;
    let singleQuote = false;
    let doubleQuote = false;

    for (let i = 0; i < lowerSql.length; i++) {
        const char = lowerSql[i];

        if (char === "'" && !doubleQuote) {
            singleQuote = !singleQuote;
        }

        if (char === '"' && !singleQuote) {
            doubleQuote = !doubleQuote;
        }

        if (singleQuote || doubleQuote) {
            continue;
        }

        if (char === '(') {
            parentheses++;
            continue;
        }

        if (char === ')') {
            parentheses--;
            continue;
        }

        if (parentheses === 0) {
            const fragment = lowerSql.slice(i, i + lowerKeyword.length);

            if (
                fragment === lowerKeyword &&
                (i === 0 || /\s/.test(lowerSql[i - 1])) &&
                (i + lowerKeyword.length >= lowerSql.length || /\s/.test(lowerSql[i + lowerKeyword.length]))
            ) {
                return i;
            }
        }
    }

    return -1;
}

function extractTables(fromClause: string): string[] {
    const tables: string[] = [];

    const normalized = fromClause
        .replace(/\b(left|right|inner|outer|cross|full)\s+join\b/gi, ' join ')
        .replace(/\bon\b[\s\S]*?(?=\bjoin\b|$)/gi, '');

    const parts = normalized.split(/\bjoin\b|,/i);

    for (const part of parts) {
        const cleaned = part.trim();

        if (!cleaned || cleaned.startsWith('(')) {
            continue;
        }

        const match = cleaned.match(/^([a-zA-Z0-9_.]+)/);

        if (match?.[1]) {
            tables.push(match[1]);
        }
    }

    return [...new Set(tables)];
}

function extractColumnName(column: string): string | null {
    const cleaned = column.trim();

    if (!cleaned) {
        return null;
    }

    // alias: "expr AS alias"
    const asAliasMatch = cleaned.match(/\bas\s+([a-zA-Z0-9_]+)$/i);
    if (asAliasMatch?.[1]) {
        return asAliasMatch[1];
    }

    // alias bez AS: "expr alias"
    // działa również dla subquery:
    // (select ...) x
    const aliasMatch = cleaned.match(/(.+)\s+([a-zA-Z0-9_]+)$/s);
    if (aliasMatch?.[2]) {
        return aliasMatch[2];
    }

    // tabela.kolumna
    const dottedMatch = cleaned.match(/^(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_*]+)$/);
    if (dottedMatch?.[1]) {
        return dottedMatch[1];
    }

    // subquery lub funkcja
    return cleaned;
}

// Główna funkcja parsująca SELECT
export async function parseSelectQuery(sql: string): Promise<ParsedQuery> {
    const trimmedSql = sql.trim();

    if (!trimmedSql.toLowerCase().startsWith('select')) {
        return {
            columns: [],
            tables: [],
            originalSql: sql
        };
    }

    const fromIndex = findTopLevelKeyword(trimmedSql, 'from');

    // SELECT bez FROM, np. "SELECT 1"
    if (fromIndex === -1) {
        const selectClause = trimmedSql.replace(/^select\s+/i, '').trim();

        return {
            columns: splitTopLevel(selectClause, ',')
                .map(extractColumnName)
                .filter((c): c is string => Boolean(c)),
            tables: [],
            originalSql: sql
        };
    }

    const selectClause = trimmedSql
        .slice(trimmedSql.toLowerCase().indexOf('select') + 6, fromIndex)
        .trim();

    const fromClause = trimmedSql.slice(fromIndex + 4).trim();

    const tableNames = extractTables(fromClause);

    let columns: string[] = [];

    // SELECT * lub alias.*
    if (selectClause === '*' || /^\w+\.\*$/.test(selectClause)) {
        let tableName: string | null = null;

        const aliasMatch = selectClause.match(/^(\w+)\.\*$/);

        if (aliasMatch) {
            const alias = aliasMatch[1];

            const aliasRegex = new RegExp(
                `\\b([a-zA-Z0-9_]+)\\s+(?:as\\s+)?${alias}\\b`,
                'i'
            );

            const match = fromClause.match(aliasRegex);

            if (match?.[1]) {
                tableName = match[1];
            }
        } else if (tableNames.length > 0) {
            tableName = tableNames[0];
        }

        if (tableName && getCachedColumnsFn) {
            columns = await getCachedColumnsFn(tableName);
        }
    } else {
        columns = splitTopLevel(selectClause, ',')
            .map(extractColumnName)
            .filter((c): c is string => Boolean(c));
    }

    return {
        columns,
        tables: tableNames,
        originalSql: sql
    };
}
