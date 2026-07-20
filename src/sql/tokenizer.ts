export type TokenType = 'comment' | 'word' | 'comma' | 'semicolon' | 'lparen' | 'rparen' | 'string';

export interface Token {
    type: TokenType;
    value: string;
    // offset początku tokena w oryginalnym tekście - potrzebne np. do przekazania indeksu do starszych metod opartych na tekście (isCursorInsideFunctionCall)
    start: number;
    // tylko dla 'lparen': czy w oryginalnym tekście przed '(' była spacja, żeby 'count(*)' i 't (a,b)' zachowały swój charakter zamiast normalizacji
    spaceBefore?: boolean;
}

// zamienia tekst SQL na listę tokenów – komentarze (-- oraz #), literały ('...', "...") i identyfikatory w `...` to pojedyncze tokeny, nigdy nie analizowane
// wejście może być urwane w dowolnym miejscu (np. sqlBeforeCursor przy podpowiedziach) - niedomknięty string/komentarz nie wywala błędu, po prostu konsumuje resztę tekstu jako jeden token
export function tokenize(sql: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const n = sql.length;
    let sawSpace = true;

    while (i < n) {
        const ch = sql[i];
        const start = i;

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            i++;
            sawSpace = true;
            continue;
        }

        if (ch === '-' && sql[i + 1] === '-') {
            let j = i;
            while (j < n && sql[j] !== '\n') { j++; }
            tokens.push({ type: 'comment', value: sql.slice(i, j).trimEnd(), start });
            i = j; sawSpace = false; continue;
        }

        if (ch === '#') {
            let j = i;
            while (j < n && sql[j] !== '\n') { j++; }
            tokens.push({ type: 'comment', value: sql.slice(i, j).trimEnd(), start });
            i = j; sawSpace = false; continue;
        }

        if (ch === "'") {
            let j = i + 1;
            while (j < n && sql[j] !== "'") { j++; }
            j++; // domykający apostrof
            tokens.push({ type: 'string', value: sql.slice(i, j), start });
            i = j; sawSpace = false; continue;
        }

        if (ch === '"') {
            let j = i + 1;
            while (j < n && sql[j] !== '"') { j++; }
            j++; // domykający cudzysłów
            tokens.push({ type: 'string', value: sql.slice(i, j), start });
            i = j; sawSpace = false; continue;
        }

        if (ch === '`') {
            let j = i + 1;
            while (j < n && sql[j] !== '`') { j++; }
            j++; // domykający backtick
            tokens.push({ type: 'string', value: sql.slice(i, j), start });
            i = j; sawSpace = false; continue;
        }

        if (ch === ',') { tokens.push({ type: 'comma', value: ',', start }); i++; sawSpace = false; continue; }
        if (ch === ';') { tokens.push({ type: 'semicolon', value: ';', start }); i++; sawSpace = false; continue; }
        if (ch === '(') { tokens.push({ type: 'lparen', value: '(', start, spaceBefore: sawSpace }); i++; sawSpace = false; continue; }
        if (ch === ')') { tokens.push({ type: 'rparen', value: ')', start }); i++; sawSpace = false; continue; }

        let j = i;
        while (
            j < n &&
            !' \t\n\r,();'.includes(sql[j]) &&
            !(sql[j] === '-' && sql[j + 1] === '-') &&
            sql[j] !== '#' &&
            sql[j] !== "'" && sql[j] !== '`' && sql[j] !== '"'
        ) { j++; }
        if (j === i) { j++; }
        tokens.push({ type: 'word', value: sql.slice(i, j), start });
        i = j; sawSpace = false;
    }

    return tokens;
}

// dla każdego tokena liczy głębokość zagnieżdżenia w nawiasach (0 = poziom najwyższy)
// dla 'lparen' zapisana głębokość to poziom SPRZED wejścia w nawias (tak jak dla formatowania - token '(' traktowany jest jako "na zewnątrz")
export function computeDepths(tokens: Token[]): number[] {
    const depths: number[] = [];
    let d = 0;
    for (const t of tokens) {
        if (t.type === 'lparen') { depths.push(d); d++; }
        else if (t.type === 'rparen') { d--; depths.push(d); }
        else { depths.push(d); }
    }
    return depths;
}

// głębokość zagnieżdżenia TUŻ PO ostatnim tokenie (czyli tam, gdzie faktycznie stoi kursor)
// różni się od computeDepths(tokens).at(-1) gdy ostatnim tokenem jest '(' - depths zapisuje wtedy poziom sprzed wejścia, a nie docelowy
export function currentDepth(tokens: Token[]): number {
    let d = 0;
    for (const t of tokens) {
        if (t.type === 'lparen') { d++; }
        else if (t.type === 'rparen') { d--; }
    }
    return d;
}

// zwraca zawartość nawiasu (bez samych nawiasów) oraz indeks domykającego ')'
export function extractParenGroup(tokens: Token[], lparenIdx: number): [Token[], number] {
    let d = 0;
    for (let k = lparenIdx; k < tokens.length; k++) {
        if (tokens[k].type === 'lparen') { d++; }
        else if (tokens[k].type === 'rparen') {
            d--;
            if (d === 0) { return [tokens.slice(lparenIdx + 1, k), k]; }
        }
    }
    return [tokens.slice(lparenIdx + 1), tokens.length - 1];
}

// dzieli listę tokenów po przecinkach znajdujących się na najwyższym poziomie zagnieżdżenia
export function splitTopLevelByComma(tokens: Token[]): Token[][] {
    const depths = computeDepths(tokens);
    const groups: Token[][] = [];
    let cur: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === 'comma' && depths[i] === 0) {
            groups.push(cur);
            cur = [];
        } else {
            cur.push(tokens[i]);
        }
    }
    groups.push(cur);
    return groups.filter(g => g.length > 0);
}
