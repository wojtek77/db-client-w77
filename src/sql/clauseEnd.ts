import { tokenize, computeDepths, currentDepth, Token } from './tokenizer.js';
import { isOpenToken, detectExpressionPosition } from './expressionPosition.js';

// miejsce kursora tuż po gotowym wyrażeniu w klauzuli, w którym można zakończyć klauzulę albo dopisać jej końcówkę
export type ClauseEndContext =
    | 'end-select'      // po liście SELECT: FROM
    | 'select-alias'    // po wyrażeniu w liście SELECT bez aliasu: AS
    | 'end-from'        // po FROM/JOIN/ON: kolejne klauzule zaczynające się od WHERE
    | 'end-where'       // po WHERE: GROUP BY i dalej
    | 'end-group'       // po GROUP BY: HAVING i dalej
    | 'end-having'      // po HAVING: ORDER BY i dalej
    | 'end-order'       // po ORDER BY: LIMIT i dalej
    | 'end-limit'       // po LIMIT: UNION, blokady
    | 'group-rollup'    // po wyrażeniu w GROUP BY: WITH ROLLUP
    | 'order-direction' // po wyrażeniu w ORDER BY bez kierunku: ASC, DESC
    | 'limit-offset'    // po LIMIT n: OFFSET
    | 'limit-examined'  // po LIMIT n: ROWS EXAMINED
    | 'lock-wait';      // po FOR UPDATE albo LOCK IN SHARE MODE: WAIT, NOWAIT, SKIP LOCKED

// FROM jest na liście tylko dla opcji blokady (FROM t FOR UPDATE |), reszta słów po tabeli jest w detectTableRefPosition
const SUPPORTED_CLAUSES = new Set(['select', 'from', 'where', 'on', 'group', 'having', 'order', 'limit']);

// słowa, po których zaczyna się lista wyrażeń SELECT, więc samo wystąpienie ostatnim tokenem nie jest jeszcze wyrażeniem
const SELECT_START_WORDS = new Set([
    'SELECT', 'DISTINCT', 'ALL', 'DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN',
    'SQL_SMALL_RESULT', 'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS',
]);
// słowa zarezerwowane, po których oczekiwana jest dalsza część konstrukcji (kolejny SELECT, ROLLUP, UPDATE...), a nie kolejna klauzula
const DANGLING_WORDS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'WITH', 'FOR', 'LOCK', 'FETCH']);
// to samo w klauzuli LIMIT, gdzie te słowa nie mogą być kolumnami
const DANGLING_LIMIT_WORDS = new Set(['OFFSET', 'ROWS', 'EXAMINED']);

function upperWord(token: Token | undefined): string {
    return token && token.type === 'word' ? token.value.toUpperCase() : '';
}

// indeks najbardziej wewnętrznego niedomkniętego nawiasu, -1 gdy kursor nie jest w nawiasie
function innermostOpenParen(all: Token[]): number {
    const stack: number[] = [];
    for (let i = 0; i < all.length; i++) {
        if (all[i].type === 'lparen') { stack.push(i); }
        else if (all[i].type === 'rparen') { stack.pop(); }
    }
    return stack.length > 0 ? stack[stack.length - 1] : -1;
}

// nawias zaczynający się od SELECT albo WITH to podzapytanie, które ma własne klauzule
function isSubquery(all: Token[], openIndex: number): boolean {
    for (let i = openIndex + 1; i < all.length; i++) {
        if (all[i].type === 'comment') { continue; }
        const word = upperWord(all[i]);
        return word === 'SELECT' || word === 'WITH';
    }
    return false;
}

type LockState = 'none' | 'incomplete' | 'ready' | 'done';

// FOR UPDATE i LOCK IN SHARE MODE: 'ready' gdy tekst kończy się dokładnie na kompletnej blokadzie (można dopisać WAIT/NOWAIT/SKIP LOCKED),
// 'incomplete' gdy kończy się w jej środku, 'done' gdy po blokadzie jest już coś dalej
function lockState(tokens: Token[]): LockState {
    const lockPattern = ['IN', 'SHARE', 'MODE'];
    for (let i = 0; i < tokens.length; i++) {
        const word = upperWord(tokens[i]);
        if (word === 'FOR') {
            if (i === tokens.length - 1) { return 'incomplete'; }
            if (upperWord(tokens[i + 1]) === 'UPDATE') { return i + 2 === tokens.length ? 'ready' : 'done'; }
        }
        if (word === 'LOCK') {
            let matched = 0;
            while (matched < lockPattern.length && i + 1 + matched < tokens.length && upperWord(tokens[i + 1 + matched]) === lockPattern[matched]) { matched++; }
            if (matched === lockPattern.length) { return i + 4 === tokens.length ? 'ready' : 'done'; }
            if (i + 1 + matched === tokens.length) { return 'incomplete'; }
        }
    }
    return 'none';
}

function hasWordPair(tokens: Token[], first: string, second: string[]): boolean {
    return tokens.some((t, i) => upperWord(t) === first && second.includes(upperWord(tokens[i + 1])));
}

// czy ostatnie wyrażenie listy SELECT może jeszcze dostać alias (nie ma go już i nie jest gwiazdką)
function selectItemCanHaveAlias(tokens: Token[]): boolean {
    const last = tokens[tokens.length - 1];
    if (!last) { return false; }
    if (last.type === 'word' && (last.value === '*' || last.value.endsWith('.*'))) { return false; }
    // nawias zamykający albo string nie jest aliasem, a pojedyncze słowo trzeba porównać z poprzednim tokenem
    if (last.type !== 'word' || !/^\w+$/.test(last.value)) { return true; }

    const prev = tokens[tokens.length - 2];
    if (!prev) { return true; }
    // "COUNT(*) c" i "'x' y": po nawiasie albo stringu słowo jest już aliasem
    if (prev.type === 'rparen' || prev.type === 'string') { return false; }
    if (prev.type === 'word') {
        if (SELECT_START_WORDS.has(prev.value.toUpperCase())) { return true; }
        // "a + b": poprzedni token kończy się operatorem, więc ostatnie słowo jest operandem, a "id x" i "id AS x" mają już alias
        return !/\w$/.test(prev.value);
    }
    return true;
}

// wykrywa, co może zakończyć bieżącą klauzulę w miejscu kursora (koniec sqlBeforeCursor), np. FROM po liście SELECT albo GROUP BY po WHERE
// clause to nazwa klauzuli z detectCurrentClause, zwraca null poza gotowym wyrażeniem (po operatorze, przecinku, w stringu, po słowie czekającym na dalszą część itd.)
export function detectClauseEnd(sqlBeforeCursor: string, clause: string | undefined): ClauseEndContext[] | null {
    if (!clause || !SUPPORTED_CLAUSES.has(clause)) { return null; }

    const all = tokenize(sqlBeforeCursor);
    const lastToken = all[all.length - 1];
    if (lastToken && isOpenToken(lastToken, sqlBeforeCursor)) { return null; }

    const depth = currentDepth(all);
    const depths = computeDepths(all);
    // tylko tokeny na głębokości kursora, zagnieżdżone nawiasy zostają jako sam lparen i rparen
    let tokens = all.filter((t, i) => depths[i] === depth && t.type !== 'comment');

    // ostatni token dotykający kursora to pisane słowo, pomijamy je w analizie
    const tail = tokens[tokens.length - 1];
    if (tail && tail.type === 'word' && tail.start + tail.value.length === sqlBeforeCursor.length) {
        if (!/^\w+$/.test(tail.value)) { return null; }
        tokens = tokens.slice(0, -1);
    }

    // klauzule kończące się tylko w zapytaniu głównym i w podzapytaniu, a nie w dowolnym nawiasie (argumenty funkcji, grupowanie warunków)
    const openIndex = depth > 0 ? innermostOpenParen(all) : -1;
    const topLevel = depth === 0 || (openIndex >= 0 && isSubquery(all, openIndex));

    // po FOR UPDATE i LOCK IN SHARE MODE mogą być tylko opcje blokady
    const lock = lockState(tokens);
    if (lock === 'ready') { return topLevel ? ['lock-wait'] : null; }
    if (lock !== 'none') { return null; }

    // po FETCH FIRST/NEXT ... nie podpowiadamy już klauzul
    if (hasWordPair(tokens, 'FETCH', ['FIRST', 'NEXT'])) { return null; }

    const last = tokens[tokens.length - 1];
    const lastUpper = upperWord(last);
    if (DANGLING_WORDS.has(lastUpper) || SELECT_START_WORDS.has(lastUpper)) { return null; }
    if (clause === 'limit' && DANGLING_LIMIT_WORDS.has(lastUpper)) { return null; }

    if (detectExpressionPosition(sqlBeforeCursor) !== 'after-operand') { return null; }

    const contexts: ClauseEndContext[] = [];
    switch (clause) {
        case 'from':
            return null;
        case 'select':
            if (selectItemCanHaveAlias(tokens)) { contexts.push('select-alias'); }
            contexts.push('end-select');
            break;
        case 'where':
            contexts.push('end-where');
            break;
        case 'on':
            // po warunku ON zaczynają się te same klauzule co po tabeli w FROM
            contexts.push('end-from');
            break;
        case 'having':
            contexts.push('end-having');
            break;
        case 'group':
            if (!(lastUpper === 'ROLLUP' && upperWord(tokens[tokens.length - 2]) === 'WITH')) { contexts.push('group-rollup'); }
            contexts.push('end-group');
            break;
        case 'order':
            if (lastUpper !== 'ASC' && lastUpper !== 'DESC') { contexts.push('order-direction'); }
            contexts.push('end-order');
            break;
        case 'limit': {
            const limitIndex = tokens.map(upperWord).lastIndexOf('LIMIT');
            const rest = limitIndex >= 0 ? tokens.slice(limitIndex + 1) : [];
            if (rest.length === 0) { return null; }
            const hasComma = rest.some(t => t.type === 'comma');
            const hasOffset = rest.some(t => upperWord(t) === 'OFFSET');
            const hasExamined = rest.some(t => upperWord(t) === 'EXAMINED');
            // LIMIT a, b nie przyjmuje OFFSET, a ROWS EXAMINED jest ostatnią opcją
            if (!hasComma && !hasOffset && !hasExamined) { contexts.push('limit-offset'); }
            if (!hasExamined) { contexts.push('limit-examined'); }
            contexts.push('end-limit');
            break;
        }
    }

    if (topLevel) { return contexts; }
    // w nawiasie niebędącym podzapytaniem kończy się tylko własne ORDER BY, np. OVER (ORDER BY a DESC)
    if (clause === 'order' && hasWordPair(tokens, 'ORDER', ['BY']) && contexts.includes('order-direction')) { return ['order-direction']; }
    return null;
}
