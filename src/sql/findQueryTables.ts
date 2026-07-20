import { TableColumnsCache, TableRef } from '../cache/TableColumnsCache.js';
import { Connection } from '../db/Connection.js';
import { maskStringLiterals } from './maskStringLiterals.js';

/**
 * Zwraca stos pozycji otwierających nawiasów `(`, które są jeszcze niezamknięte
 * tuż przed `uptoIndex` (z pominięciem nawiasów wewnątrz stringów tekstowych).
 * Np. dla "SELECT * FROM a WHERE x IN (SELECT * FROM b WHERE|" (kursor przy "|")
 * zwróci stos zawierający pozycję nawiasu otwierającego podzapytanie w IN(...).
 *
 * Dwie pozycje mają tę samą "gałąź zagnieżdżenia", jeśli ich stosy są identyczne
 * na wspólnej długości (patrz isAncestorScope) — dzięki temu można odróżnić
 * dwa niezależne podzapytania na tym samym poziomie głębokości.
 */
export function computeParenStack(sql: string, uptoIndex: number): number[] {
    const stack: number[] = [];
    const end = Math.min(uptoIndex, sql.length);
    const masked = maskStringLiterals(sql.slice(0, end));

    for (let i = 0; i < masked.length; i++) {
        if (masked[i] === '(') {
            stack.push(i);
        } else if (masked[i] === ')') {
            stack.pop();
        }
    }

    return stack;
}

/**
 * Sprawdza, czy `matchStack` jest "przodkiem" (lub tym samym poziomem) względem
 * `cursorStack` — czyli czy dopasowanie FROM/JOIN znajduje się w zasięgu widoczności
 * kursora (na poziomie głównego zapytania, albo w tym samym podzapytaniu co kursor,
 * albo w podzapytaniu, które go otacza — jak przy skorelowanych podzapytaniach).
 */
function isAncestorScope(matchStack: number[], cursorStack: number[]): boolean {
    if (matchStack.length > cursorStack.length) {
        return false;
    }
    for (let i = 0; i < matchStack.length; i++) {
        if (matchStack[i] !== cursorStack[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Liczy stos nawiasów w KILKU punktach tekstu naraz, jednym przebiegiem od lewej
 * do prawej (zamiast liczyć go od zera dla każdego punktu osobno, jak robił to
 * poprzednio `computeParenStack` wywoływane w pętli w `findQueryTables`).
 *
 * Tekst jest maskowany (`maskStringLiterals`) TYLKO RAZ, a nie raz na punkt -
 * przy zapytaniu z wieloma FROM/JOIN dawało to niepotrzebne O(n * liczba_dopasowań).
 *
 * Zwraca mapę: indeks punktu z `checkpoints` -> stos pozycji otwierających `(`
 * niezamkniętych przed tym punktem.
 */
function computeParenStacksAt(sql: string, checkpoints: number[]): number[][] {
    const masked = maskStringLiterals(sql);

    // sortujemy punkty rosnąco żeby przejść tekst jednym przebiegiem, ale wynik zwracamy w oryginalnej kolejności
    const order = checkpoints
        .map((pos, originalIndex) => ({ pos, originalIndex }))
        .sort((a, b) => a.pos - b.pos);

    const results: number[][] = new Array(checkpoints.length);
    const stack: number[] = [];
    let cursor = 0;

    for (const { pos, originalIndex } of order) {
        const end = Math.min(pos, masked.length);
        while (cursor < end) {
            const ch = masked[cursor];
            if (ch === '(') { stack.push(cursor); }
            else if (ch === ')') { stack.pop(); }
            cursor++;
        }
        results[originalIndex] = [...stack];
    }

    return results;
}

export function findQueryTables(
    sql: string,
    defaultSchema: string,
    db: Connection,
    cursorOffset?: number
): TableRef[] {

    const tableRefs: TableRef[] = [];

    const regex =
        /\b(?:from|join)\s+(?:(\w+)\s*\.\s*)?(\w+)/gi;

    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sql)) !== null) {
        matches.push(match);
    }

    // przy podanym kursorze ograniczamy dopasowania do jego zasięgu (pomijamy tabele z obcych podzapytań) i liczymy stosy nawiasów jednym przebiegiem
    let cursorStack: number[] | null = null;
    let matchStacks: number[][] | null = null;

    if (cursorOffset !== undefined) {
        const checkpoints = matches.map(m => m.index);
        checkpoints.push(cursorOffset);

        const stacks = computeParenStacksAt(sql, checkpoints);
        matchStacks = stacks.slice(0, matches.length);
        cursorStack = stacks[matches.length];
    }

    matches.forEach((match, i) => {
        if (cursorStack !== null && matchStacks !== null) {
            if (!isAncestorScope(matchStacks[i], cursorStack)) {
                return;
            }
        }

        tableRefs.push({

            schema:
                match[1]
                    || defaultSchema
                    || db.findSchemaByTable(
                        match[2]
                    )
                    || '',

            table:
                match[2]
        });
    });

    const tableColumnsService = TableColumnsCache.getInstance();
    return Array.from(
        new Map(
            tableRefs.map(
                tableRef => [
                    tableColumnsService.getTableRefKey(tableRef),
                    tableRef
                ]
            )
        ).values()
    );
}
