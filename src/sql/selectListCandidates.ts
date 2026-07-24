import { computeParenStack } from './findQueryTables.js';
import { maskStringLiterals } from './maskStringLiterals.js';

// zamienia zawartość nawiasów (podzapytania, wywołania funkcji) na spacje tej samej długości, żeby regexy szukające SELECT/FROM na najwyższym poziomie nie łapały się na te wewnątrz nawiasów
function flattenSubqueries(sql: string): string {
    let text = sql;
    let masked = maskStringLiterals(sql);

    for (;;) {
        const regex = /\([^()]*\)/g;
        let m: RegExpExecArray | null;
        let lastIndex = 0;
        let nextText = '';
        let nextMasked = '';
        let changed = false;

        while ((m = regex.exec(masked)) !== null) {
            changed = true;
            const blank = ' '.repeat(m[0].length);
            nextText += text.slice(lastIndex, m.index) + blank;
            nextMasked += masked.slice(lastIndex, m.index) + blank;
            lastIndex = m.index + m[0].length;
        }

        if (!changed) { return text; }

        nextText += text.slice(lastIndex);
        nextMasked += masked.slice(lastIndex);
        text = nextText;
        masked = nextMasked;
    }
}

/**
 * Wycina fragment "SELECT ... FROM" na poziomie zagnieżdżenia, na którym kończy się `sqlBeforeCursor`
 * (czyli tekst listy kolumn ostatniego SELECT-a przed najbliższym FROM na tym poziomie).
 * Używane zarówno do wykrywania kandydatów dla HAVING/GROUP BY/ORDER BY (koniec = pozycja kursora),
 * jak i do wyciągania kolumn wyjściowych ciała CTE (koniec = koniec całego ciała CTE).
 */
export function extractSelectPartAtCursorLevel(sqlBeforeCursor: string): string {
    const stack = computeParenStack(sqlBeforeCursor, sqlBeforeCursor.length);
    const blockStart = stack.length > 0 ? stack[stack.length - 1] + 1 : 0;

    const block = sqlBeforeCursor.slice(blockStart);
    const flat = flattenSubqueries(block);

    const selectRegex = /\bselect\b/gi;
    let lastSelectEnd = -1;
    let m: RegExpExecArray | null;
    while ((m = selectRegex.exec(flat)) !== null) {
        lastSelectEnd = m.index + m[0].length;
    }
    if (lastSelectEnd === -1) { return ''; }

    const fromRegex = /\bfrom\b/gi;
    fromRegex.lastIndex = lastSelectEnd;
    const fromResult = fromRegex.exec(flat);
    if (!fromResult) { return ''; }

    return block.slice(lastSelectEnd, fromResult.index);
}

// dzieli listę SELECT po przecinkach na najwyższym poziomie zagnieżdżenia i z każdego wyrażenia bierze ostatni token (alias, jeśli jest, albo samą nazwę/wyrażenie)
export function extractHavingCandidates(selectPart: string): string[] {
    const masked = maskStringLiterals(selectPart);
    const entries: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < selectPart.length; i++) {
        const ch = masked[i];
        if (ch === '(') { depth++; }
        else if (ch === ')') { depth--; }
        else if (ch === ',' && depth === 0) {
            entries.push(selectPart.slice(start, i));
            start = i + 1;
        }
    }
    entries.push(selectPart.slice(start));

    const result: string[] = [];

    for (const entry of entries) {
        const rtrimmed = entry.trimEnd();
        if (!rtrimmed) { continue; }

        if (rtrimmed.endsWith(')')) {
            const e1 = rtrimmed.trimStart();
            if (e1.startsWith('(')) {
                result.push(e1);
                continue;
            }
        }

        const e1 = rtrimmed.trimStart();
        if (e1.endsWith('.*')) {
            result.push(e1);
            continue;
        }

        const parts = rtrimmed.split(/[ .]/);
        const last = parts[parts.length - 1].trimStart();
        if (last) { result.push(last); }
    }

    return [...new Set(result)];
}
