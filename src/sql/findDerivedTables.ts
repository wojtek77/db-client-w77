import { maskStringLiterals } from './maskStringLiterals.js';
import { extractSelectPartAtCursorLevel, extractHavingCandidates } from './selectListCandidates.js';

export interface DerivedTableDefinition {
    alias: string;
    columns: string[];
}

// otwarcie podzapytania w pozycji tabeli: "FROM (", "JOIN (" albo ", (" (kolejna tabela po przecinku)
const DERIVED_TABLE_OPEN_REGEX = /\b(?:from|join)\s*\(|,\s*\(/gi;
// alias zaraz po zamknięciu nawiasu, opcjonalnie poprzedzony "AS" i z opcjonalną jawną listą kolumn (np. "AS dt(x, y)")
const ALIAS_AFTER_REGEX = /^\s*(?:as\s+)?`?(\w+)`?\s*(?:\(([^()]*)\))?/i;
// słowa kluczowe, które mogłyby przypadkiem zostać wzięte za alias przy podzapytaniu bez aliasu (w MySQL to błąd składni, ale user może to jeszcze pisać)
const RESERVED_WORDS = new Set(['where', 'group', 'order', 'having', 'limit', 'union', 'join', 'on', 'left', 'right', 'inner', 'outer', 'cross', 'using']);

/**
 * Wyszukuje w tekście zapytania podzapytania w pozycji tabeli z aliasem (`FROM (SELECT ...) alias`,
 * `JOIN (SELECT ...) AS alias`, `, (SELECT ...) alias`) i dla każdego zwraca alias oraz listę kolumn
 * wyjściowych - z jawnej listy po aliasie, jeśli podana (`AS alias(col1, col2)`), a w przeciwnym razie
 * wyciągniętą z listy SELECT ciała podzapytania (ta sama logika co przy CTE i aliasach w GROUP BY/ORDER BY).
 *
 * Podzapytanie bez aliasu jest pomijane - to i tak błąd składni w MySQL/MariaDB (derived table wymaga aliasu),
 * a bez aliasu nie ma jak się do niego odwołać przez kropkę.
 *
 * Celowo bez skopowania do zagnieżdżenia (tak jak przy CTE) - ta sama, zaakceptowana uproszczona zasada widoczności.
 */
export function findDerivedTables(fullText: string): DerivedTableDefinition[] {
    const masked = maskStringLiterals(fullText);
    const definitions: DerivedTableDefinition[] = [];

    const openRegex = new RegExp(DERIVED_TABLE_OPEN_REGEX.source, 'gi');
    let match: RegExpExecArray | null;

    while ((match = openRegex.exec(masked)) !== null) {
        const openParenPos = match.index + match[0].length - 1;

        let depth = 1;
        let i = openParenPos + 1;
        while (i < masked.length && depth > 0) {
            if (masked[i] === '(') { depth++; }
            else if (masked[i] === ')') { depth--; }
            i++;
        }
        if (depth > 0) { continue; } // niezamknięty nawias (użytkownik jeszcze pisze podzapytanie)
        const closeParenPos = i - 1;

        const body = fullText.slice(openParenPos + 1, closeParenPos);
        if (!/^\s*select\b/i.test(body)) { continue; } // nawias bez SELECT w środku - to nie jest derived table

        const aliasMatch = ALIAS_AFTER_REGEX.exec(fullText.slice(closeParenPos + 1));
        if (!aliasMatch) { continue; } // brak aliasu - bez niego nie da się odwołać przez kropkę

        const alias = aliasMatch[1];
        if (RESERVED_WORDS.has(alias.toLowerCase())) { continue; }

        const explicitColumns = aliasMatch[2]
            ? aliasMatch[2].split(',').map(c => c.trim().replace(/^`|`$/g, '')).filter(Boolean)
            : undefined;

        const columns = explicitColumns && explicitColumns.length > 0
            ? explicitColumns
            : extractHavingCandidates(extractSelectPartAtCursorLevel(body));

        definitions.push({ alias, columns });
    }

    return definitions;
}
