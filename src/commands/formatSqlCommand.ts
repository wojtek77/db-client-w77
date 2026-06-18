import * as vscode from 'vscode';

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

// ─── Normalizacja wejścia ─────────────────────────────────────────────────────

function normalize(sql: string): string {
    return sql.replace(/\r\n/g, '\n').replace(/[\n\r\t]/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// ─── Podział kolumn SELECT respektujący nawiasy ───────────────────────────────

function splitColumns(text: string): string[] {
    const cols: string[] = [];
    let depth = 0, col = '';
    for (const ch of text) {
        if (ch === '(') { depth++; col += ch; }
        else if (ch === ')') { depth--; col += ch; }
        else if (ch === ',' && depth === 0) { cols.push(col.trim()); col = ''; }
        else { col += ch; }
    }
    if (col.trim()) { cols.push(col.trim()); }
    return cols;
}

// ─── Wyciąganie zawartości nawiasów ──────────────────────────────────────────

function extractParen(col: string): { inner: string; suffix: string } | null {
    if (!col.startsWith('(')) { return null; }
    let depth = 0, closeIdx = -1;
    for (let i = 0; i < col.length; i++) {
        if (col[i] === '(') { depth++; }
        else if (col[i] === ')') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) { return null; }
    return { inner: col.slice(1, closeIdx).trim(), suffix: col.slice(closeIdx + 1).trim() };
}

// ─── Klauzule na poziomie głównym (poza nawiasami) ───────────────────────────

interface ClauseMatch { index: number; rawLen: number; keyword: string; }

function findClauses(sql: string): ClauseMatch[] {
    const dep: number[] = new Array(sql.length).fill(0);
    let d = 0;
    for (let i = 0; i < sql.length; i++) {
        if (sql[i] === '(') { d++; }
        dep[i] = d;
        if (sql[i] === ')') { d--; }
    }
    const pattern = CLAUSE_KEYWORDS.map(k => k.replace(/ /g, '\\s+')).join('|');
    const re = new RegExp(`(?<![\\w])(${pattern})(?![\\w])`, 'gi');
    const out: ClauseMatch[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
        if (dep[m.index] === 0) {
            out.push({ index: m.index, rawLen: m[0].length, keyword: m[0].replace(/\s+/g, ' ').toUpperCase() });
        }
    }
    return out;
}

// ─── Główna funkcja formatująca (rekurencyjna) ───────────────────────────────

function fmt(sql: string, lvl: number): string {
    const norm = normalize(sql);
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

    for (const { kw, rest } of segs) {
        if (!kw) { lines.push(pad + rest); continue; }

        if (kw === 'SELECT') {
            afterWhere = false; afterJoin = false;
            lines.push(fmtSelect(rest, lvl));
            continue;
        }

        // AND/OR po JOIN – doklejamy do linii JOIN lub łamiemy z wcięciem
        if (INDENTED_KEYWORDS.has(kw) && afterJoin) {
            const lastLine = lines[lines.length - 1] ?? '';
            const candidate = lastLine + ` ${kw}${rest ? ' ' + rest : ''}`;
            if (candidate.length <= SELECT_WRAP_AT) {
                lines[lines.length - 1] = candidate;
            } else {
                lines.push(`${pad}\t\t${kw}${rest ? ' ' + rest : ''}`);
            }
            continue; // afterJoin pozostaje true
        }

        if (RESET_INDENT_KEYWORDS.has(kw)) { afterWhere = false; }
        if (kw === 'WHERE') { afterWhere = true; }

        afterJoin = JOIN_KEYWORDS.has(kw);

        if (INDENTED_KEYWORDS.has(kw) && afterWhere) {
            lines.push(`${pad}\t${kw}${rest ? ' ' + rest : ''}`);
        } else {
            lines.push(`${pad}${kw}${rest ? ' ' + rest : ''}`);
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

// ─── Komenda VS Code ──────────────────────────────────────────────────────────

export async function formatSqlCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const selection = editor.selection;
    if (selection.isEmpty) {
        vscode.window.showWarningMessage('Zaznacz fragment SQL do sformatowania.');
        return;
    }

    const formatted = fmt(editor.document.getText(selection), 0);

    await editor.edit(eb => eb.replace(selection, formatted));
}
