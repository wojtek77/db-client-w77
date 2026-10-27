import { tokenize, Token } from './tokenizer.js';
import { isOpenToken } from './expressionPosition.js';

// pozycja kursora względem funkcji okna: tuż po wywołaniu funkcji (miejsce na OVER), tuż po "OVER (" albo po liście PARTITION BY w "OVER (...)"
export type WindowPosition = 'after-window-function' | 'window-spec-start' | 'window-spec-after-partition';

// funkcje, po których MariaDB dopuszcza OVER (funkcje okna oraz agregaty używane jako okno)
const WINDOW_CAPABLE_FUNCTIONS = new Set([
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
]);

// słowa, po których w specyfikacji okna oczekiwana jest dalsza część konstrukcji, a nie koniec listy wyrażeń
const SPEC_CONTINUATION_WORDS = new Set(['BY', 'PARTITION', 'ORDER']);

// indeks '(' otwierającego nawias zamknięty przez ')' na pozycji rparenIdx
function findMatchingLparen(tokens: Token[], rparenIdx: number): number {
    let depth = 0;
    for (let i = rparenIdx; i >= 0; i--) {
        if (tokens[i].type === 'rparen') { depth++; }
        else if (tokens[i].type === 'lparen') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1;
}

// indeks najbliższego niedomkniętego '(' przed pozycją end (włącznie) albo -1
function findInnermostOpenLparen(tokens: Token[], end: number): number {
    const stack: number[] = [];
    for (let i = 0; i <= end; i++) {
        if (tokens[i].type === 'lparen') { stack.push(i); }
        else if (tokens[i].type === 'rparen') { stack.pop(); }
    }
    return stack.length > 0 ? stack[stack.length - 1] : -1;
}

// wykrywa, czy kursor (koniec sqlBeforeCursor) stoi w miejscu, gdzie pasują słowa składni okna: OVER, PARTITION BY, ORDER BY
// zwraca null, gdy żadne nie pasują (po operatorze, w stringu, w komentarzu, po przecinku, po kompletnym ORDER BY itd.)
export function detectWindowPosition(sqlBeforeCursor: string): WindowPosition | null {
    const allTokens = tokenize(sqlBeforeCursor);
    const lastToken = allTokens[allTokens.length - 1];
    if (lastToken && isOpenToken(lastToken, sqlBeforeCursor)) { return null; }

    const tokens = allTokens.filter(t => t.type !== 'comment');

    // ostatni token dotykający kursora to pisane słowo - pomijamy je, a jeśli zawiera coś poza znakami słowa, nie podpowiadamy nic
    const tail = tokens[tokens.length - 1];
    if (tail && tail.type === 'word' && tail.start + tail.value.length === sqlBeforeCursor.length) {
        if (!/^\w+$/.test(tail.value)) { return null; }
        tokens.pop();
    }
    if (tokens.length === 0) { return null; }

    const end = tokens.length - 1;
    const last = tokens[end];

    // "ROW_NUMBER() |" - zamknięty nawias wywołania funkcji okna bez spacji przed '(' (tak samo jak przy wywołaniach funkcji w MariaDB)
    if (last.type === 'rparen') {
        const open = findMatchingLparen(tokens, end);
        const name = open > 0 ? tokens[open - 1] : undefined;
        if (name?.type === 'word' && tokens[open].spaceBefore === false && WINDOW_CAPABLE_FUNCTIONS.has(name.value.toUpperCase())) {
            return 'after-window-function';
        }
    }

    // wewnątrz "OVER (...)" - tylko jeśli najbliższy otwarty nawias należy do OVER
    const open = findInnermostOpenLparen(tokens, end);
    if (open <= 0 || tokens[open - 1].type !== 'word' || tokens[open - 1].value.toUpperCase() !== 'OVER') { return null; }
    if (open === end) { return 'window-spec-start'; }

    // analiza zawartości nawiasu OVER na jej własnym poziomie zagnieżdżenia
    let depth = 0;
    let hasPartition = false;
    let hasOrder = false;
    for (let i = open + 1; i <= end; i++) {
        const t = tokens[i];
        if (t.type === 'lparen') { depth++; continue; }
        if (t.type === 'rparen') { depth--; continue; }
        if (depth !== 0 || t.type !== 'word') { continue; }
        const next = tokens[i + 1];
        const nextIsBy = next?.type === 'word' && next.value.toUpperCase() === 'BY';
        const upper = t.value.toUpperCase();
        if (upper === 'PARTITION' && nextIsBy) { hasPartition = true; }
        if (upper === 'ORDER' && nextIsBy) { hasOrder = true; }
    }
    if (!hasPartition || hasOrder) { return null; }

    // po liście PARTITION BY (kolumna, wyrażenie, zamknięty nawias funkcji) pasuje ORDER BY; po przecinku albo po samym "BY" nie
    const endsOperand =
        last.type === 'rparen' || last.type === 'string' ||
        (last.type === 'word' && /\w$/.test(last.value) && !SPEC_CONTINUATION_WORDS.has(last.value.toUpperCase()));
    return endsOperand ? 'window-spec-after-partition' : null;
}
