import { tokenize, Token } from './tokenizer.js';

// pozycja kursora względem wyrażenia warunkowego (WHERE/HAVING): początek warunku, tuż po operandzie albo po słowie NOT stojącym po operandzie
export type ExpressionPosition = 'expression-start' | 'after-operand' | 'after-not';

// słowa, po których zaczyna się nowy warunek logiczny
const CONDITION_START_WORDS = new Set(['WHERE', 'HAVING', 'ON', 'AND', 'OR', 'XOR', 'WHEN']);

// słowa, po których oczekiwana jest wartość lub dalsza część konstrukcji, a nie operator - po nich nie proponujemy żadnych słów kluczowych
const VALUE_EXPECTED_WORDS = new Set([
    'IN', 'LIKE', 'REGEXP', 'RLIKE', 'BETWEEN', 'IS', 'ESCAPE', 'DIV', 'MOD', 'INTERVAL', 'EXISTS', 'ANY', 'SOME', 'ALL',
    'CASE', 'THEN', 'ELSE', 'BINARY', 'DISTINCT', 'SEPARATOR', 'COLLATE', 'SOUNDS', 'MEMBER', 'OF', 'AS', 'SELECT', 'FROM', 'JOIN', 'BY',
    // słowa zarezerwowane, po których zaczyna się kolejny SELECT albo opcja blokady
    'UNION', 'INTERSECT', 'EXCEPT', 'FOR', 'LOCK', 'FETCH', 'WITH',
]);

// słowa, po których może zaczynać się lista wyrażeń SELECT (po nich gwiazdka jest operandem, a nie mnożeniem)
const SELECT_LIST_START_WORDS = new Set([
    'SELECT', 'DISTINCT', 'ALL', 'DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN',
    'SQL_SMALL_RESULT', 'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS',
]);

// czy token jest niedomkniętym stringiem/komentarzem, czyli kursor stoi w jego wnętrzu
export function isOpenToken(token: Token, sql: string): boolean {
    if (token.type === 'comment') {
        if (token.value.startsWith('/*')) { return !(token.value.length >= 4 && token.value.endsWith('*/')); }
        // komentarz liniowy trwa do końca linii, więc jest otwarty, dopóki po nim nie ma nowej linii
        return !sql.slice(token.start).includes('\n');
    }
    if (token.type === 'string') {
        return token.value.length < 2 || token.value[token.value.length - 1] !== token.value[0];
    }
    return false;
}

// sprawdza, czy AND na pozycji andIndex należy do konstrukcji BETWEEN ... AND ... (wtedy po nim jest wartość, a nie nowy warunek)
function isBetweenAnd(tokens: Token[], andIndex: number): boolean {
    let depth = 0;
    for (let i = andIndex - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t.type === 'rparen') { depth++; continue; }
        if (t.type === 'lparen') {
            // wyszliśmy poza nawias, w którym stoi AND
            if (depth === 0) { return false; }
            depth--;
            continue;
        }
        if (depth > 0 || t.type !== 'word') { continue; }

        const upper = t.value.toUpperCase();
        if (upper === 'BETWEEN') { return true; }
        // wcześniejszy AND/OR/WHERE itd. oznacza, że nasz AND jest zwykłym spójnikiem logicznym
        if (CONDITION_START_WORDS.has(upper)) { return false; }
    }
    return false;
}

// klasyfikuje pozycję tuż za tokenem o indeksie end (włącznie); end = -1 oznacza brak wcześniejszych tokenów
function classifyEnd(tokens: Token[], end: number): ExpressionPosition | null {
    if (end < 0) { return 'expression-start'; }

    const token = tokens[end];
    switch (token.type) {
        case 'rparen':
        case 'string':
            return 'after-operand';
        case 'lparen':
            // nawias otwiera nowy warunek tylko wtedy, gdy sam stoi na początku warunku (a nie np. po IN albo nazwie funkcji)
            return classifyEnd(tokens, end - 1) === 'expression-start' ? 'expression-start' : null;
        case 'word':
            break;
        default:
            return null;
    }

    const value = token.value;
    // gwiazdka w liście SELECT (SELECT *, SELECT t.*, SELECT a, *) jest operandem, w innym miejscu to mnożenie
    if (/^[\w$`.]*\.\*$/.test(value)) { return 'after-operand'; }
    if (value === '*') {
        const before = tokens[end - 1];
        const startsList = !before || before.type === 'comma' || (before.type === 'word' && SELECT_LIST_START_WORDS.has(before.value.toUpperCase()));
        return startsList ? 'after-operand' : null;
    }
    // słowo kończące się operatorem albo kropką (np. "a=", "u.") nie jest operandem
    if (!/\w$/.test(value)) { return null; }

    const upper = value.toUpperCase();
    if (upper === 'NOT') {
        const before = classifyEnd(tokens, end - 1);
        if (before === 'expression-start') { return 'expression-start'; }
        return before === 'after-operand' ? 'after-not' : null;
    }
    if (upper === 'AND') { return isBetweenAnd(tokens, end) ? null : 'expression-start'; }
    if (CONDITION_START_WORDS.has(upper)) { return 'expression-start'; }
    if (VALUE_EXPECTED_WORDS.has(upper)) { return null; }
    // FOR UPDATE i LOCK IN SHARE MODE to końcówki zapytania, a nie operandy
    const prev = tokens[end - 1];
    const prevUpper = prev && prev.type === 'word' ? prev.value.toUpperCase() : '';
    if ((upper === 'UPDATE' && prevUpper === 'FOR') || (upper === 'MODE' && prevUpper === 'SHARE')) { return null; }
    return 'after-operand';
}

// wykrywa, jakiego rodzaju słowa kluczowe pasują w miejscu kursora (koniec sqlBeforeCursor) w wyrażeniu warunkowym
// zwraca null, gdy żadne nie pasują (po operatorze porównania, w stringu, w komentarzu, po przecinku itd.)
export function detectExpressionPosition(sqlBeforeCursor: string): ExpressionPosition | null {
    const allTokens = tokenize(sqlBeforeCursor);
    const lastToken = allTokens[allTokens.length - 1];
    if (lastToken && isOpenToken(lastToken, sqlBeforeCursor)) { return null; }

    const tokens = allTokens.filter(t => t.type !== 'comment');

    // ostatni token dotykający kursora to pisane słowo - pomijamy je, a jeśli zawiera coś poza znakami słowa (np. "a=I"), nie podpowiadamy nic
    const tail = tokens[tokens.length - 1];
    if (tail && tail.type === 'word' && tail.start + tail.value.length === sqlBeforeCursor.length) {
        if (!/^\w+$/.test(tail.value)) { return null; }
        tokens.pop();
    }

    if (tokens.length === 0) { return null; }
    return classifyEnd(tokens, tokens.length - 1);
}
