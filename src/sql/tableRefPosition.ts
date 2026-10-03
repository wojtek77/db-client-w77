import { tokenize, computeDepths, currentDepth, Token } from './tokenizer.js';
import { isOpenToken } from './expressionPosition.js';

// pozycja kursora tuż po odwołaniu do tabeli w FROM/JOIN (nazwa, opcjonalny alias, opcjonalne index hinty)
export interface TableRefPosition {
    // tabela nie ma jeszcze aliasu, więc można wpisać AS
    canAlias: boolean;
    // tabela jest dołączona przez JOIN i nie ma jeszcze warunku, więc można wpisać ON albo USING
    canJoinCondition: boolean;
    // aktualnie pisane słowo małymi literami (puste, gdy kursor stoi po spacji)
    filter: string;
    // tabela kończy się słowem LEFT/RIGHT ('side', można dopisać JOIN albo OUTER JOIN) albo LEFT/RIGHT OUTER ('outer', można dopisać JOIN)
    joinSide?: 'side' | 'outer';
}

const JOIN_WORDS = new Set(['JOIN', 'STRAIGHT_JOIN']);
// słowa, które nie mogą być aliasem, bo zaczynają kolejną część złączenia
const NON_ALIAS_WORDS = new Set(['USE', 'FORCE', 'IGNORE', 'PARTITION', 'USING', 'ON', 'INNER', 'CROSS', 'NATURAL', 'LEFT', 'RIGHT', 'OUTER', 'JOIN', 'STRAIGHT_JOIN', 'UNION', 'INTERSECT', 'EXCEPT', 'FOR', 'LOCK']);
// słowa, po których występuje nawias (index hint, wybór partycji)
const PAREN_SUFFIX_WORDS = new Set(['USE', 'FORCE', 'IGNORE', 'PARTITION']);
// słowa, które otwierają coś innego niż nazwa tabeli
const NOT_A_TABLE_WORDS = new Set(['SELECT', 'WITH', 'LATERAL']);

function isIdentifier(token: Token | undefined): token is Token {
    if (!token) { return false; }
    if (token.type === 'string') { return true; }
    return token.type === 'word' && /^[\w$.]+$/.test(token.value);
}

function endsWithParenPair(tokens: Token[]): boolean {
    const n = tokens.length;
    return n >= 2 && tokens[n - 2].type === 'lparen' && tokens[n - 1].type === 'rparen';
}

// wykrywa, czy kursor stoi tuż po odwołaniu do tabeli w klauzuli FROM (po nazwie, aliasie albo index hincie) i co można tam jeszcze wpisać
// zakłada, że kursor jest w klauzuli FROM (patrz detectCurrentClause), zwraca null w każdym innym miejscu (po JOIN, po przecinku, po AS, w stringu itd.)
export function detectTableRefPosition(sqlBeforeCursor: string): TableRefPosition | null {
    const all = tokenize(sqlBeforeCursor);
    const lastToken = all[all.length - 1];
    if (lastToken && isOpenToken(lastToken, sqlBeforeCursor)) { return null; }

    const depth = currentDepth(all);
    const depths = computeDepths(all);
    // tylko tokeny na głębokości kursora, zagnieżdżone nawiasy zostają jako sam lparen i rparen
    let tokens = all.filter((t, i) => depths[i] === depth && t.type !== 'comment');

    // ostatni token dotykający kursora to pisane słowo - zapamiętujemy je jako filtr i pomijamy w analizie
    let filter = '';
    const tail = tokens[tokens.length - 1];
    if (tail && tail.type === 'word' && tail.start + tail.value.length === sqlBeforeCursor.length) {
        if (!/^\w+$/.test(tail.value)) { return null; }
        filter = tail.value.toLowerCase();
        tokens = tokens.slice(0, -1);
    }

    // ostatnie słowo wprowadzające nową tabelę: FROM, JOIN albo przecinek
    let intro = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t.type === 'comma') { intro = i; break; }
        if (t.type === 'word') {
            const upper = t.value.toUpperCase();
            if (upper === 'FROM' || JOIN_WORDS.has(upper)) { intro = i; break; }
        }
    }
    if (intro < 0) { return null; }
    const joined = tokens[intro].type === 'word' && JOIN_WORDS.has(tokens[intro].value.toUpperCase());

    const rest = tokens.slice(intro + 1);
    let i = 0;

    // nazwa tabeli albo tabela pochodna w nawiasie
    const first = rest[i];
    if (!first) { return null; }
    if (first.type === 'lparen') {
        if (rest[i + 1]?.type !== 'rparen') { return null; }
        i += 2;
    } else if (isIdentifier(first)) {
        if (first.type === 'word' && NOT_A_TABLE_WORDS.has(first.value.toUpperCase())) { return null; }
        i += 1;
    } else {
        return null;
    }

    // opcjonalny alias, z AS albo bez
    let hasAlias = false;
    const next = rest[i];
    if (next?.type === 'word' && next.value.toUpperCase() === 'AS') {
        if (!isIdentifier(rest[i + 1])) { return null; }
        hasAlias = true;
        i += 2;
    } else if (isIdentifier(next) && !(next.type === 'word' && NON_ALIAS_WORDS.has(next.value.toUpperCase()))) {
        hasAlias = true;
        i += 1;
    }

    const tail2 = rest.slice(i);
    if (tail2.length === 0) { return { canAlias: !hasAlias, canJoinCondition: joined, filter }; }

    const head = tail2[0];
    const headUpper = head.type === 'word' ? head.value.toUpperCase() : '';

    // LEFT/RIGHT [OUTER] czeka na JOIN, a NATURAL przed nimi nic nie zmienia
    const words = tail2.map(t => (t.type === 'word' ? t.value.toUpperCase() : ''));
    if (words[0] === 'NATURAL' && words.length > 1) { words.shift(); }
    if (words.length === 1 && (words[0] === 'LEFT' || words[0] === 'RIGHT')) { return { canAlias: false, canJoinCondition: false, filter, joinSide: 'side' }; }
    if (words.length === 2 && (words[0] === 'LEFT' || words[0] === 'RIGHT') && words[1] === 'OUTER') { return { canAlias: false, canJoinCondition: false, filter, joinSide: 'outer' }; }

    // index hinty i wybór partycji kończą się nawiasem, np. USE INDEX (a, b)
    if (PAREN_SUFFIX_WORDS.has(headUpper) && endsWithParenPair(tail2)) {
        return { canAlias: false, canJoinCondition: joined, filter };
    }
    // USING (kolumny) zamyka warunek złączenia
    if (headUpper === 'USING' && tail2.length === 3 && tail2[1].type === 'lparen' && tail2[2].type === 'rparen') {
        return { canAlias: false, canJoinCondition: false, filter };
    }
    return null;
}
