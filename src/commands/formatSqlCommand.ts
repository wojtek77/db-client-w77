import * as vscode from 'vscode';
import { maskStringLiterals } from '../sql/maskStringLiterals.js';

const SELECT_WRAP_AT = 120;
const SUBQUERY_LARGE = 80;  // subquery >= tej długości idzie na nową linię

const CLAUSE_KEYWORDS = [
    'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'INNER JOIN',
    'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'INSERT INTO', 'DELETE FROM', 'CREATE TABLE',
    'ALTER TABLE', 'DROP TABLE', 'UNION ALL', 'GROUP BY', 'ORDER BY',
    'SELECT', 'FROM', 'JOIN', 'WHERE', 'AND', 'OR', 'HAVING', 'LIMIT', 'OFFSET',
    'VALUES', 'UPDATE', 'SET', 'UNION', 'EXCEPT', 'INTERSECT',
];

const INDENTED_KEYWORDS = new Set(['AND', 'OR']);
const RESET_INDENT_KEYWORDS = new Set([
    'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'FROM', 'JOIN',
    'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN',
    'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'UNION', 'UNION ALL',
]);

function tabs(n: number): string { return '\t'.repeat(n); }

const ORDER_DIRECTION_KEYWORDS = new Set(['ORDER BY', 'GROUP BY']);

// Uppercase ASC/DESC w klauzuli ORDER BY (i GROUP BY - stara składnia MySQL/MariaDB)
function uppercaseOrderDirection(text: string): string {
    return text.replace(/\b(asc|desc)\b/gi, m => m.toUpperCase());
}

// Pozostałe słowa kluczowe SQL, które fmt nie traktuje jako granice klauzul,
// ale mimo to warto ujednolicić ich wielkość liter (spójnie z SELECT/FROM/WHERE/...).
// 'AND' jest tu też potrzebny, bo BETWEEN...AND nie jest wykrywany jako granica
// klauzuli (patrz neutralizeBetweenAnd) i inaczej zostałby nietknięty.
const RESERVED_KEYWORDS_TO_UPPERCASE = [
    'IS NOT NULL', 'IS NULL', 'NOT BETWEEN', 'NOT LIKE', 'NOT IN',
    'BETWEEN', 'DISTINCT', 'EXISTS', 'LIKE', 'IN', 'NOT', 'AND', 'AS',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'NULL', 'TRUE', 'FALSE',
];

// Uppercase powyższych słów kluczowych, pomijając zawartość literałów tekstowych
// ('...', "...", `...`), żeby np. nazwa kolumny w cudzysłowie nie została ruszona.
function uppercaseReservedWords(sql: string): string {
    const masked = maskStringLiterals(sql);
    const chars = sql.split('');
    for (const kw of RESERVED_KEYWORDS_TO_UPPERCASE) {
        const pattern = kw.replace(/ /g, '\\s+');
        const re = new RegExp(`\\b${pattern}\\b`, 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(masked)) !== null) {
            for (let i = m.index; i < m.index + m[0].length; i++) {
                chars[i] = chars[i].toUpperCase();
            }
        }
    }
    return chars.join('');
}

// BETWEEN x AND y - to "AND" nie jest granicą klauzuli tylko częścią BETWEEN,
// więc trzeba je "zneutralizować" (podmienić na znaki niepasujące do wzorca
// klauzul) zanim findClauses zacznie szukać granic - inaczej BETWEEN 1 AND 2
// zostaje błędnie rozbite na dwie linie, jakby to były dwa osobne warunki.
function neutralizeBetweenAnd(sql: string, dep: number[]): string {
    const chars = sql.split('');
    const betweenRe = /\bBETWEEN\b/gi;
    let m: RegExpExecArray | null;
    while ((m = betweenRe.exec(sql)) !== null) {
        const d = dep[m.index];
        const andRe = /\bAND\b/gi;
        andRe.lastIndex = m.index + m[0].length;
        let am: RegExpExecArray | null;
        while ((am = andRe.exec(sql)) !== null) {
            if (dep[am.index] < d) { break; } // wyszliśmy poza nawias, w którym jest BETWEEN
            if (dep[am.index] === d) {
                for (let i = am.index; i < am.index + am[0].length; i++) { chars[i] = '#'; }
                break;
            }
        }
    }
    return chars.join('');
}

// ─── Wyciąganie i przywracanie komentarzy ─────────────────────────────────────

interface CommentSlot { placeholder: string; comment: string; standalone: boolean; }

function extractComments(sql: string): { sql: string; slots: CommentSlot[] } {
    const slots: CommentSlot[] = [];
    const lines = sql.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];

    for (const line of lines) {
        const idx = line.indexOf('--');
        if (idx === -1) { out.push(line); continue; }

        const before = line.slice(0, idx).trim();
        const comment = line.slice(idx).trimEnd();
        const n = slots.length;
        const placeholder = `__CMT_${n}__`;

        if (before === '') {
            // Samodzielny komentarz – wstawiamy placeholder jako osobny "token" w strumieniu.
            // Żeby normalize go nie scalił z sąsiednimi liniami, owijamy go separatorami
            // które przetrwają normalizację (normalize zamienia \n na spację, więc
            // używamy specjalnego prefiksu który fmt rozpozna).
            slots.push({ placeholder, comment, standalone: true });
            out.push(placeholder);
        } else {
            // Komentarz końcowy – SQL przed nim + placeholder na końcu linii
            slots.push({ placeholder, comment, standalone: false });
            out.push(`${before} ${placeholder}`);
        }
    }

    return { sql: out.join('\n'), slots };
}

function restoreComments(formatted: string, slots: CommentSlot[]): string {
    let result = formatted;
    for (const { placeholder, comment } of slots) {
        // Samodzielny: placeholder jest całą linią (może mieć wcięcie nadane przez fmt)
        result = result.replace(
            new RegExp(`^([ \\t]*)${placeholder}[ \\t]*$`, 'm'),
            (_m, indent) => `${indent}${comment}`,
        );
        // Końcowy: placeholder na końcu linii
        result = result.replace(placeholder, comment);
    }
    return result;
}


// ─── Normalizacja wejścia ─────────────────────────────────────────────────────

function normalize(sql: string): string {
    return sql.replace(/\r\n/g, '\n').replace(/[\n\r\t]/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// ─── Podział kolumn SELECT respektujący nawiasy ───────────────────────────────

function splitColumns(text: string): string[] {
    const masked = maskStringLiterals(text);
    const cols: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = masked[i];
        if (ch === '(') { depth++; }
        else if (ch === ')') { depth--; }
        else if (ch === ',' && depth === 0) { cols.push(text.slice(start, i).trim()); start = i + 1; }
    }
    const last = text.slice(start).trim();
    if (last) { cols.push(last); }
    return cols;
}

// ─── Wyciąganie zawartości nawiasów ──────────────────────────────────────────

function extractParen(col: string): { inner: string; suffix: string } | null {
    if (!col.startsWith('(')) { return null; }
    const masked = maskStringLiterals(col);
    let depth = 0, closeIdx = -1;
    for (let i = 0; i < masked.length; i++) {
        if (masked[i] === '(') { depth++; }
        else if (masked[i] === ')') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) { return null; }
    return { inner: col.slice(1, closeIdx).trim(), suffix: col.slice(closeIdx + 1).trim() };
}

// ─── Klauzule na poziomie głównym (poza nawiasami) ───────────────────────────

interface ClauseMatch { index: number; rawLen: number; keyword: string; }

function findClauses(sql: string): ClauseMatch[] {
    const masked = maskStringLiterals(sql);
    const dep: number[] = new Array(sql.length).fill(0);
    let d = 0;
    for (let i = 0; i < sql.length; i++) {
        if (masked[i] === '(') { d++; }
        dep[i] = d;
        if (masked[i] === ')') { d--; }
    }
    // Szukamy granic klauzul na wersji z zamaskowanymi literałami tekstowymi,
    // żeby np. słowo "where" wewnątrz stringa ('select this and where that')
    // nie zostało błędnie wzięte za prawdziwą klauzulę i nie rozwaliło zapytania.
    const search = neutralizeBetweenAnd(masked, dep);
    const pattern = CLAUSE_KEYWORDS.map(k => k.replace(/ /g, '\\s+')).join('|');
    // Dodajemy wzorzec na placeholdery komentarzy
    const re = new RegExp(`(?<![\\w])(${pattern}|__CMT_\\d+__)(?![\\w])`, 'gi');
    const out: ClauseMatch[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(search)) !== null) {
        if (dep[m.index] === 0) {
            out.push({ index: m.index, rawLen: m[0].length, keyword: m[0].replace(/\s+/g, ' ').toUpperCase() });
        }
    }
    return out;
}

// ─── Główna funkcja formatująca (rekurencyjna) ───────────────────────────────

function fmt(sql: string, lvl: number): string {
    const norm = uppercaseReservedWords(normalize(sql));
    const clauses = findClauses(norm);
    if (clauses.length === 0) { return tabs(lvl) + norm; }

    const segs: Array<{ kw: string; rest: string }> = [];
    const pre = norm.slice(0, clauses[0].index).trim();
    if (pre) { segs.push({ kw: '', rest: pre }); }
    for (let i = 0; i < clauses.length; i++) {
        const c = clauses[i];
        const end = i + 1 < clauses.length ? clauses[i + 1].index : norm.length;
        segs.push({ kw: c.keyword, rest: norm.slice(c.index + c.rawLen, end).trim() });
    }

    const pad = tabs(lvl);
    const lines: string[] = [];
    let afterWhere = false;
    let afterJoin = false;

    const JOIN_KEYWORDS = new Set([
        'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN',
        'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
    ]);

    const CMT_RE = /^__CMT_\d+__$/;

    for (const { kw, rest } of segs) {
        if (!kw) { lines.push(pad + rest); continue; }

        // Samodzielny komentarz – emituj z wcięciem odpowiadającym bieżącemu kontekstowi
        if (CMT_RE.test(kw)) {
            const cmtIndent = afterWhere ? pad + '\t' : pad;
            lines.push(`${cmtIndent}${kw}`);
            continue;
        }

        if (kw === 'SELECT') {
            afterWhere = false; afterJoin = false;
            lines.push(fmtSelect(rest, lvl));
            continue;
        }

        // AND/OR po JOIN – doklejamy do linii JOIN lub łamiemy z wcięciem
        if (INDENTED_KEYWORDS.has(kw) && afterJoin) {
            const restFmt = rest.replace(/\bon\b/gi, 'ON');
            const lastLine = lines[lines.length - 1] ?? '';
            const candidate = lastLine + ` ${kw}${restFmt ? ' ' + restFmt : ''}`;
            if (candidate.length <= SELECT_WRAP_AT) {
                lines[lines.length - 1] = candidate;
            } else {
                lines.push(`${pad}\t\t${kw}${restFmt ? ' ' + restFmt : ''}`);
            }
            continue; // afterJoin pozostaje true
        }

        if (RESET_INDENT_KEYWORDS.has(kw)) { afterWhere = false; }
        if (kw === 'WHERE') { afterWhere = true; }

        afterJoin = JOIN_KEYWORDS.has(kw);

        // Uppercase słowa kluczowego ON w tekście po JOIN
        let restFmt = afterJoin ? rest.replace(/\bon\b/gi, 'ON') : rest;
        // Uppercase ASC/DESC w ORDER BY / GROUP BY
        if (ORDER_DIRECTION_KEYWORDS.has(kw)) { restFmt = uppercaseOrderDirection(restFmt); }

        if (INDENTED_KEYWORDS.has(kw) && afterWhere) {
            lines.push(`${pad}\t${kw}${restFmt ? ' ' + restFmt : ''}`);
        } else {
            lines.push(`${pad}${kw}${restFmt ? ' ' + restFmt : ''}`);
        }
    }

    return lines.join('\n');
}

// ─── Formatowanie listy kolumn po SELECT ─────────────────────────────────────

function fmtSelect(rest: string, lvl: number): string {
    const cols = splitColumns(rest);
    if (!cols.length) { return tabs(lvl) + 'SELECT'; }

    const pad = tabs(lvl);
    const cont = tabs(lvl + 1);   // wcięcie kontynuacji i subquery
    const lines: string[] = [];
    let cur = pad + 'SELECT ';

    const flush = () => {
        const t = cur.trimEnd();
        if (t && t !== pad + 'SELECT') { lines.push(t); }
        cur = cont;
    };

    for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const comma = i < cols.length - 1 ? ',' : '';
        const p = extractParen(col);

        if (p !== null) {
            // Całkowita długość subquery = '(' + inner + ')' + suffix
            const full = `(${p.inner})${p.suffix ? ' ' + p.suffix : ''}`;
            const isLarge = full.length >= SUBQUERY_LARGE;

            if (!isLarge) {
                // Małe – jak zwykła kolumna
                const add = full + comma;
                if ((cur + add).length > SELECT_WRAP_AT && cur.trim() && cur.trim() !== (pad + 'SELECT').trim()) {
                    flush();
                }
                cur += add + ' ';
            } else {
                // Duże – nowa linia: '(' na początku, rekurencja, ')' na końcu
                flush();
                lines.push(cont + '(');
                lines.push(fmt(p.inner, lvl + 2));
                lines.push(`${cont})${p.suffix ? ' ' + p.suffix : ''}${comma}`);
                cur = cont;
            }
        } else {
            const add = col + comma;
            if ((cur + add).length > SELECT_WRAP_AT && cur.trim() && cur.trim() !== (pad + 'SELECT').trim()) {
                flush();
            }
            cur += add + ' ';
        }
    }

    const last = cur.trimEnd();
    if (last && last !== pad + 'SELECT' && last.trim() && last.trim() !== cont.trim()) {
        lines.push(last);
    }

    return lines.join('\n');
}

// ─── Publiczna, czysta funkcja formatująca (bez zależności od vscode) ────────

export function formatSql(sql: string): string {
    const { sql: sqlNoComments, slots } = extractComments(sql);
    return restoreComments(fmt(sqlNoComments, 0), slots);
}

// ─── Komenda VS Code ──────────────────────────────────────────────────────────

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
