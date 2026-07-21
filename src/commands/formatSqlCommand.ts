import * as vscode from 'vscode';
import { Token, tokenize, computeDepths, extractParenGroup, splitTopLevelByComma } from '../sql/tokenizer.js';

export async function formatSqlCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const selection = editor.selection;
    if (selection.isEmpty) {
        vscode.window.showWarningMessage('Select a SQL fragment to format.');
        return;
    }

    const formatted = formatSql(editor.document.getText(selection));

    await editor.edit(eb => eb.replace(selection, formatted));
}

// słowa zastrzeżone są zawsze wielkimi literami, bez kontekstowości - nieocudzysłowione słowo zastrzeżone jako nazwa kolumny/tabeli i tak nie jest poprawnym SQL-em (wymagałoby `` `backtickow` ``)
// jedyny wyjątek to zawartość '', "", `` oraz komentarzy (-- # /* */) - te są renderowane bez zmian, patrz renderTokens
const reservedWords = new Set([
    'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'GROUP', 'BY', 'ORDER', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
    'AND', 'OR', 'NOT', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON',
    'IN', 'AS', 'IS', 'LIKE', 'BETWEEN', 'EXISTS', 'DISTINCT', 'UNION', 'ALL',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'TRUE', 'FALSE', 'OVER',
    'ASC', 'DESC', 'PARTITION',
]);

interface AppendOptions {
    looseCommas?: boolean;
    // wymusza/wyklucza spację przed tokenem niezależnie od domyślnej reguły (tylko dla '(', żeby zachować count(*) vs t (a,b))
    forceSpaceBefore?: boolean;
}

// dokłada kolejny token do stringa: bez spacji przed ',' i ')', bez spacji po '(', spacja po przecinku tylko gdy looseCommas === true
function appendTok(out: string, val: string, opts: AppendOptions = {}): string {
    if (out === '') { return val; }
    if (val === ',' || val === ')' || val === ';') { return out + val; }
    const prevChar = out[out.length - 1];
    if (prevChar === '(') { return out + val; }
    if (opts.forceSpaceBefore === false) { return out + val; }
    if (opts.forceSpaceBefore === true) { return out + ' ' + val; }
    if (prevChar === ',' && !opts.looseCommas) { return out + val; }
    return out + ' ' + val;
}

function renderWord(value: string): string {
    if (/^[A-Za-z_]+$/.test(value)) {
        const upper = value.toUpperCase();
        if (reservedWords.has(upper)) { return upper; }
    }
    return value;
}

// renderuje listę tokenów do tekstu – looseCommas steruje spacją po przecinku (przekazywane jawnie, bo nie da się tego wywnioskować z głębokości nawiasów)
// IN (...) z kilkoma krotkami rozbijane na wiele linii
// samodzielny komentarz zawsze zaczyna nową linię i zmusza też kolejny token do zaczęcia nowej linii (startNewLine)
// initial to tekst już obecny w bieżącej linii (np. nagłówek klauzuli) – dzięki temu komentarz na starcie tokens też trafia w nową linię
function renderTokens(tokens: Token[], indent: string, looseCommas = false, initial = ''): string {
    let out = initial;
    let i = 0;
    let startNewLine = false;

    const append = (val: string, opts: AppendOptions = {}) => {
        if (startNewLine) {
            out = out + '\n' + indent + val;
            startNewLine = false;
        } else {
            out = appendTok(out, val, opts);
        }
    };

    while (i < tokens.length) {
        const t = tokens[i];

        if (t.type === 'comment') {
            out = out === '' ? t.value : out + '\n' + indent + t.value;
            startNewLine = true;
            i++;
            continue;
        }

        // funkcja okienkowa OVER (...) - wnętrze (PARTITION BY / ORDER BY) renderowane tak samo jak reszta, bez własnego kontekstu
        if (t.type === 'word' && t.value.toUpperCase() === 'OVER' && tokens[i + 1]?.type === 'lparen') {
            const [inner, endIdx] = extractParenGroup(tokens, i + 1);
            const rendered = 'OVER (' + renderTokens(inner, indent, true) + ')';
            append(rendered, { looseCommas });
            i = endIdx + 1;
            continue;
        }

        if (t.type === 'word' && t.value.toUpperCase() === 'IN' && tokens[i + 1]?.type === 'lparen') {
            const [inner, endIdx] = extractParenGroup(tokens, i + 1);
            const groups = splitTopLevelByComma(inner);
            const looksLikeTupleList = groups.length > 1 &&
                groups.every(g => g[0]?.type === 'lparen' && g[g.length - 1]?.type === 'rparen');

            if (looksLikeTupleList) {
                append('IN', { looseCommas });
                out += ' (\n';
                groups.forEach((g, idx) => {
                    out += indent + '\t' + renderTokens(g, indent + '\t', true);
                    out += idx < groups.length - 1 ? ',\n' : '\n';
                });
                out += indent + ')';
                i = endIdx + 1;
                continue;
            }
        }

        if (t.type === 'lparen') {
            const [inner, endIdx] = extractParenGroup(tokens, i);
            const next = tokens[endIdx + 1];
            const followedByIn = next?.type === 'word' && next.value.toUpperCase() === 'IN';
            const hasTopComma = splitTopLevelByComma(inner).length > 1;

            if (followedByIn && hasTopComma) {
                const rendered = '(' + renderTokens(inner, indent, true) + ')';
                append(rendered, { looseCommas, forceSpaceBefore: t.spaceBefore });
                i = endIdx + 1;
                continue;
            }

            append('(', { looseCommas, forceSpaceBefore: t.spaceBefore });
            i++;
            continue;
        }

        const val = t.type === 'word' ? renderWord(t.value) : t.value;
        append(val, { looseCommas });
        i++;
    }

    return out;
}

// nazwy klauzul jako enum zamiast gołych stringów – literówka przy dodawaniu nowej klauzuli da błąd kompilacji, a nie cichy brak dopasowania
enum ClauseName {
    Unknown = 'UNKNOWN', // tekst przed pierwszą rozpoznaną klauzulą - patrz segmentClauses
    Select = 'SELECT',
    From = 'FROM',
    Where = 'WHERE',
    Having = 'HAVING',
    GroupBy = 'GROUP_BY',
    OrderBy = 'ORDER_BY',
    Limit = 'LIMIT',
    Insert = 'INSERT',
    InsertInto = 'INSERT_INTO',
    Values = 'VALUES',
    Update = 'UPDATE',
    Set = 'SET',
    Delete = 'DELETE',
}

interface Clause {
    name: ClauseName;
    // dokładny tekst nagłówka klauzuli do wypisania (np. 'GROUP BY') – enum ClauseName służy tylko do dopasowania formattera
    displayName: string;
    tokens: Token[];
}

// pojedyncze słowo rozpoczynające klauzulę -> jej nazwa (enum); GROUP/ORDER/INSERT mogą zostać 'podbite' do dwuwyrazowej klauzuli, patrz CLAUSE_COMBO
const WORD_TO_CLAUSE: Record<string, ClauseName> = {
    SELECT: ClauseName.Select,
    FROM: ClauseName.From,
    WHERE: ClauseName.Where,
    HAVING: ClauseName.Having,
    LIMIT: ClauseName.Limit,
    GROUP: ClauseName.GroupBy,
    ORDER: ClauseName.OrderBy,
    INSERT: ClauseName.Insert,
    VALUES: ClauseName.Values,
    UPDATE: ClauseName.Update,
    SET: ClauseName.Set,
    DELETE: ClauseName.Delete,
};

const CLAUSE_WORDS = Object.keys(WORD_TO_CLAUSE);

// dwuwyrazowe nagłówki klauzul: GROUP BY, ORDER BY, INSERT INTO
const CLAUSE_COMBO: Record<string, { nextWord: string; combined: ClauseName }> = {
    GROUP: { nextWord: 'BY', combined: ClauseName.GroupBy },
    ORDER: { nextWord: 'BY', combined: ClauseName.OrderBy },
    INSERT: { nextWord: 'INTO', combined: ClauseName.InsertInto },
};

// dzieli zapytanie na klauzule po słowach kluczowych na najwyższym poziomie, żeby słowo w literale/podzapytaniu nie było mylone z granicą klauzuli
// tekst przed pierwszą rozpoznaną klauzulą nie jest gubiony – trafia jako ClauseName.Unknown i jest wypisany as-is
function segmentClauses(tokens: Token[]): Clause[] {
    const depths = computeDepths(tokens);
    const boundaries: { name: ClauseName; displayName: string; start: number; bodyStart: number }[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (depths[i] === 0 && t.type === 'word' && CLAUSE_WORDS.includes(t.value.toUpperCase())) {
            const word = t.value.toUpperCase();
            let name = WORD_TO_CLAUSE[word];
            let displayName = word;
            let skip = 1;

            const combo = CLAUSE_COMBO[word];
            if (combo && tokens[i + 1]?.type === 'word' && tokens[i + 1].value.toUpperCase() === combo.nextWord) {
                name = combo.combined;
                displayName = word + ' ' + combo.nextWord;
                skip = 2;
            }

            boundaries.push({ name, displayName, start: i, bodyStart: i + skip });
        }
    }

    const clauses: Clause[] = [];
    const firstBoundaryStart = boundaries.length ? boundaries[0].start : tokens.length;
    if (firstBoundaryStart > 0) {
        clauses.push({ name: ClauseName.Unknown, displayName: '', tokens: tokens.slice(0, firstBoundaryStart) });
    }
    for (let b = 0; b < boundaries.length; b++) {
        const bodyEnd = b + 1 < boundaries.length ? boundaries[b + 1].start : tokens.length;
        clauses.push({ name: boundaries[b].name, displayName: boundaries[b].displayName, tokens: tokens.slice(boundaries[b].bodyStart, bodyEnd) });
    }
    return clauses;
}

type SelectItem =
    | { type: 'col'; tokens: Token[] }
    | { type: 'comment'; value: string };

// maksymalna szerokość linii dla pakowanych kolumn w SELECT (w znakach)
const SELECT_MAX_WIDTH = 160;

// formatuje listę kolumn po SELECT: pakowane do linii o długości do SELECT_MAX_WIDTH znaków, komentarz zawsze zaczyna nową linię
function formatSelect(tokens: Token[]): string {
    const depths = computeDepths(tokens);
    const items: SelectItem[] = [];
    let cur: Token[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'comma' && depths[i] === 0) {
            items.push({ type: 'col', tokens: cur });
            cur = [];
        } else if (t.type === 'comment') {
            if (cur.length > 0) { items.push({ type: 'col', tokens: cur }); cur = []; }
            items.push({ type: 'comment', value: t.value });
        } else {
            cur.push(t);
        }
    }
    if (cur.length > 0) { items.push({ type: 'col', tokens: cur }); }

    const colIndices = items.map((it, idx) => (it.type === 'col' ? idx : -1)).filter(x => x >= 0);
    const lastColIdx = colIndices[colIndices.length - 1];

    const lines: string[] = [];
    let currentParts: string[] = [];
    let currentIsFirstLine = true;

    const currentPrefix = () => (currentIsFirstLine ? 'SELECT ' : '\t');

    const flush = () => {
        if (currentParts.length === 0) { return; }
        lines.push(currentPrefix() + currentParts.join(' '));
        currentParts = [];
        currentIsFirstLine = false;
    };

    items.forEach((it, idx) => {
        if (it.type === 'comment') {
            flush();
            lines.push('\t' + it.value);
            return;
        }

        const isLastCol = idx === lastColIdx;
        const part = renderTokens(it.tokens, '\t') + (isLastCol ? '' : ',');
        const candidateLength = currentPrefix().length +
            (currentParts.length === 0 ? part.length : currentParts.join(' ').length + 1 + part.length);

        if (currentParts.length > 0 && candidateLength > SELECT_MAX_WIDTH) {
            flush();
        }
        currentParts.push(part);
    });
    flush();

    return lines.join('\n');
}

const JOIN_MODIFIERS = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS']);

// formatuje referencję do tabel (FROM albo UPDATE) oraz kolejne JOIN-y – każdy JOIN (wraz z ON) na osobnej linii, bez dodatkowego wcięcia
// header to tekst nagłówka klauzuli ('FROM' albo 'UPDATE') - JOIN w UPDATE (multi-table update) korzysta z tej samej logiki co FROM
function formatTableRef(tokens: Token[], header: string): string {
    const depths = computeDepths(tokens);
    const boundaries: number[] = [];

    for (let i = 0; i < tokens.length; i++) {
        if (depths[i] === 0 && tokens[i].type === 'word' && tokens[i].value.toUpperCase() === 'JOIN') {
            let start = i;
            while (start - 1 >= 0 && tokens[start - 1].type === 'word' &&
                JOIN_MODIFIERS.has(tokens[start - 1].value.toUpperCase())) {
                start--;
            }
            boundaries.push(start);
        }
    }

    const firstTable = tokens.slice(0, boundaries.length ? boundaries[0] : tokens.length);
    const lines = [header + ' ' + renderTokens(firstTable, '')];

    boundaries.forEach((b, idx) => {
        const end = idx + 1 < boundaries.length ? boundaries[idx + 1] : tokens.length;
        lines.push(renderTokens(tokens.slice(b, end), ''));
    });

    return lines.join('\n');
}

type CondItem =
    | { type: 'cond'; tokens: Token[]; keyword: string | null }
    | { type: 'comment'; value: string };

// formatuje WHERE/AND/OR: pierwszy warunek w tej samej linii co słowo kluczowe, kolejne poprzedzone AND/OR na nowej wciętej linii
// BETWEEN x AND y: 'AND' z BETWEEN nie jest separatorem – liczymy je (betweenPending), żeby odróżnić od prawdziwego AND
function formatWhereLike(tokens: Token[], keyword: string): string {
    const depths = computeDepths(tokens);
    const items: CondItem[] = [];
    let cur: Token[] = [];
    let pendingKeyword: string | null = null;
    let betweenPending = 0;

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const isAndOr = depths[i] === 0 && t.type === 'word' &&
            (t.value.toUpperCase() === 'AND' || t.value.toUpperCase() === 'OR');

        if (isAndOr && t.value.toUpperCase() === 'AND' && betweenPending > 0) {
            cur.push(t);
            betweenPending--;
            continue;
        }

        if (isAndOr) {
            if (cur.length > 0) {
                items.push({ type: 'cond', tokens: cur, keyword: pendingKeyword });
                cur = [];
            }
            pendingKeyword = t.value.toUpperCase();
            continue;
        }

        if (t.type === 'comment') {
            if (cur.length > 0) {
                items.push({ type: 'cond', tokens: cur, keyword: pendingKeyword });
                pendingKeyword = null;
                cur = [];
            }
            items.push({ type: 'comment', value: t.value });
            continue;
        }

        if (depths[i] === 0 && t.type === 'word' && t.value.toUpperCase() === 'BETWEEN') {
            betweenPending++;
        }
        cur.push(t);
    }
    if (cur.length > 0 || items.length === 0) {
        items.push({ type: 'cond', tokens: cur, keyword: pendingKeyword });
    }

    const lines = items.map((it, idx) => {
        if (it.type === 'comment') { return '\t' + it.value; }
        const rendered = renderTokens(it.tokens, '\t');
        return idx === 0 ? keyword + ' ' + rendered : '\t' + it.keyword + ' ' + rendered;
    });

    return lines.join('\n');
}

type ClauseFormatter = (tokens: Token[], displayName: string) => string;

// formatter dla każdej klauzuli – nowa klauzula to wpis w WORD_TO_CLAUSE (ew. CLAUSE_COMBO) i wpis tutaj, bez dotykania formatSql
const CLAUSE_FORMATTERS: Map<ClauseName, ClauseFormatter> = new Map([
    // nierozpoznana klauzula (np. tekst przed pierwszym słowem kluczowym) nie jest formatowana specjalnie, ale też nie jest tracona (patrz segmentClauses)
    [ClauseName.Unknown, (tokens) => renderTokens(tokens, '')],
    [ClauseName.Select, (tokens) => formatSelect(tokens)],
    [ClauseName.From, (tokens) => formatTableRef(tokens, 'FROM')],
    [ClauseName.Where, (tokens) => formatWhereLike(tokens, 'WHERE')],
    [ClauseName.Having, (tokens) => formatWhereLike(tokens, 'HAVING')],
    [ClauseName.GroupBy, (tokens, displayName) => renderTokens(tokens, '', true, displayName)],
    [ClauseName.OrderBy, (tokens, displayName) => renderTokens(tokens, '', true, displayName)],
    [ClauseName.Limit, (tokens, displayName) => renderTokens(tokens, '', true, displayName)],
    [ClauseName.Insert, (tokens, displayName) => renderTokens(tokens, '', false, displayName)],
    [ClauseName.InsertInto, (tokens, displayName) => renderTokens(tokens, '', false, displayName)],
    [ClauseName.Values, (tokens, displayName) => renderTokens(tokens, '', true, displayName)],
    // UPDATE t1 JOIN t2 ON ... (multi-table update) korzysta z tej samej logiki co FROM/JOIN
    [ClauseName.Update, (tokens) => formatTableRef(tokens, 'UPDATE')],
    // przypisania w SET rozdzielone przecinkiem ze spacją (looseCommas), bez łamania na osobne linie (jak VALUES)
    [ClauseName.Set, (tokens, displayName) => renderTokens(tokens, '', true, displayName)],
    // DELETE (ew. z aliasami tabel przy multi-table delete) - dalszy ciąg to osobno rozpoznana klauzula FROM
    [ClauseName.Delete, (tokens, displayName) => renderTokens(tokens, '', false, displayName)],
]);

const SET_OPERATOR_WORDS = new Set(['UNION', 'INTERSECT', 'EXCEPT']);
const SET_OPERATOR_MODIFIERS = new Set(['ALL', 'DISTINCT']);

// dzieli tokeny na osobne zapytania (statementy) wg UNION/INTERSECT/EXCEPT na najwyższym poziomie zagnieżdżenia
// operatorBefore to tekst operatora poprzedzającego dany segment (np. 'UNION ALL'), null dla pierwszego segmentu
function splitBySetOperator(tokens: Token[]): { segment: Token[]; operatorBefore: string | null }[] {
    const depths = computeDepths(tokens);
    const result: { segment: Token[]; operatorBefore: string | null }[] = [];
    let cur: Token[] = [];
    let pendingOperator: string | null = null;

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (depths[i] === 0 && t.type === 'word' && SET_OPERATOR_WORDS.has(t.value.toUpperCase())) {
            result.push({ segment: cur, operatorBefore: pendingOperator });
            cur = [];
            let opText = t.value.toUpperCase();
            const next = tokens[i + 1];
            if (next?.type === 'word' && SET_OPERATOR_MODIFIERS.has(next.value.toUpperCase())) {
                opText += ' ' + next.value.toUpperCase();
                i++;
            }
            pendingOperator = opText;
            continue;
        }
        cur.push(t);
    }
    result.push({ segment: cur, operatorBefore: pendingOperator });
    return result;
}

// formatuje pojedynczy statement (jeden SELECT/INSERT/... bez UNION/INTERSECT/EXCEPT) rozbijając go na klauzule
function formatStatement(tokens: Token[]): string {
    const clauses = segmentClauses(tokens);
    const out: string[] = [];

    for (const c of clauses) {
        const formatter = CLAUSE_FORMATTERS.get(c.name);
        if (formatter) {
            out.push(formatter(c.tokens, c.displayName));
        }
    }

    return out.join('\n');
}

// formatuje SQL: słowa kluczowe wielkimi literami, kolumny SELECT pakowane do SELECT_MAX_WIDTH, JOIN-y bez wcięcia, WHERE/HAVING łączone AND/OR
// UNION/INTERSECT/EXCEPT dzielą zapytanie na osobne statementy formatowane niezależnie, z operatorem na własnej linii pomiędzy nimi
export function formatSql(sql: string): string {
    const tokens = tokenize(sql);
    const segments = splitBySetOperator(tokens);

    const parts: string[] = [];
    for (const { segment, operatorBefore } of segments) {
        if (operatorBefore) { parts.push(operatorBefore); }
        parts.push(formatStatement(segment));
    }

    return parts.join('\n');
}
