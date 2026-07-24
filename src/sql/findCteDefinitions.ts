import { maskStringLiterals } from './maskStringLiterals.js';
import { extractSelectPartAtCursorLevel, extractHavingCandidates } from './selectListCandidates.js';

export interface CteDefinition {
    name: string;
    columns: string[];
}

// nazwa CTE (ew. w backtickach), opcjonalna jawna lista kolumn w nawiasach, potem "AS ("
const CTE_HEADER_REGEX = /^\s*`?(\w+)`?\s*(?:\(([^()]*)\))?\s*AS\s*\(/i;

// konsumuje listę "nazwa [(kolumny)] AS (ciało), ..." od `pos` (zaraz po WITH [RECURSIVE]); `complete=false` = przerwano na niezamkniętym nawiasie (user jeszcze pisze)
function consumeCteList(fullText: string, masked: string, startPos: number): { definitions: CteDefinition[]; endPos: number; complete: boolean } {
    const definitions: CteDefinition[] = [];
    let pos = startPos;

    for (;;) {
        const headerMatch = CTE_HEADER_REGEX.exec(fullText.slice(pos));
        if (!headerMatch) { break; }

        const name = headerMatch[1];
        const explicitColumns = headerMatch[2]
            ? headerMatch[2].split(',').map(c => c.trim().replace(/^`|`$/g, '')).filter(Boolean)
            : undefined;

        const bodyStart = pos + headerMatch[0].length;
        let depth = 1;
        let i = bodyStart;
        while (i < masked.length && depth > 0) {
            if (masked[i] === '(') { depth++; }
            else if (masked[i] === ')') { depth--; }
            i++;
        }
        if (depth > 0) { return { definitions, endPos: pos, complete: false }; } // niezamknięty nawias (np. użytkownik jeszcze pisze ciało CTE)
        const bodyEnd = i - 1;

        const body = fullText.slice(bodyStart, bodyEnd);
        const columns = explicitColumns && explicitColumns.length > 0
            ? explicitColumns
            : extractHavingCandidates(extractSelectPartAtCursorLevel(body));

        definitions.push({ name, columns });

        pos = bodyEnd + 1;
        const commaMatch = /^\s*,/.exec(masked.slice(pos));
        if (!commaMatch) { break; }
        pos += commaMatch[0].length;
    }

    return { definitions, endPos: pos, complete: true };
}

/**
 * Wyszukuje w całym tekście zapytania definicje CTE (`WITH [RECURSIVE] nazwa [(kolumny)] AS (ciało), ...`)
 * i dla każdej zwraca jej nazwę oraz listę kolumn wyjściowych - z jawnej listy po nazwie, jeśli podana,
 * a w przeciwnym razie wyciągniętą z listy SELECT ciała CTE (ta sama logika co przy aliasach w GROUP BY/ORDER BY).
 *
 * Celowo bez skopowania do zagnieżdżenia - CTE są widoczne "globalnie" w całym dokumencie, tak jak już
 * dziś dzieje się to przy tabelach z różnych gałęzi UNION (znana, zaakceptowana niedokładność).
 */
export function findCteDefinitions(fullText: string): CteDefinition[] {
    const masked = maskStringLiterals(fullText);
    const definitions: CteDefinition[] = [];

    const withRegex = /\bWITH\b/gi;
    let withMatch: RegExpExecArray | null;

    while ((withMatch = withRegex.exec(masked)) !== null) {
        let pos = withMatch.index + withMatch[0].length;

        const recursiveMatch = /^\s*RECURSIVE\b/i.exec(fullText.slice(pos));
        if (recursiveMatch) { pos += recursiveMatch[0].length; }

        definitions.push(...consumeCteList(fullText, masked, pos).definitions);
    }

    return definitions;
}

/**
 * Jeśli zapytanie zaczyna się od klauzuli WITH, zwraca pierwsze słowo właściwego zapytania PO tej klauzuli
 * (np. "select"/"update"/"delete"/"insert" po "WITH cte AS (...) "), pomijając nazwy CTE i ich ciała.
 * Używane w TableCompletionProvider do poprawnego routingu zapytań zaczynających się od WITH -
 * bez tego "firstWord" wychodziło jako "with", które nie pasowało do żadnej gałęzi switcha.
 */
export function findMainStatementFirstWord(fullText: string): string | undefined {
    const masked = maskStringLiterals(fullText);
    const withMatch = /^\s*WITH\b/i.exec(masked);
    if (!withMatch) { return undefined; }

    let pos = withMatch[0].length;
    const recursiveMatch = /^\s*RECURSIVE\b/i.exec(fullText.slice(pos));
    if (recursiveMatch) { pos += recursiveMatch[0].length; }

    const { endPos, complete } = consumeCteList(fullText, masked, pos);
    if (!complete) { return undefined; }
    return fullText.slice(endPos).match(/^\s*(\w+)/)?.[1]?.toLowerCase();
}

