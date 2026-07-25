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
 * Sprawdza, czy `match` jest "przodkiem" (lub tym samym poziomem) względem `cursor` —
 * czyli czy dopasowanie FROM/JOIN znajduje się w zasięgu widoczności kursora (na poziomie
 * głównego zapytania, albo w tym samym podzapytaniu co kursor, albo w podzapytaniu, które
 * go otacza — jak przy skorelowanych podzapytaniach) ORAZ w tej samej gałęzi zapytania
 * złożonego (UNION/UNION ALL/INTERSECT/EXCEPT) na każdym wspólnym poziomie zagnieżdżenia,
 * łącznie z głównym zapytaniem (poziom 0) - bez tego `t1` z pierwszej gałęzi UNION
 * przeciekałoby do podpowiedzi w drugiej, niepowiązanej gałęzi.
 */
function isAncestorScope(match: ScopeSignature, cursor: ScopeSignature): boolean {
    if (match.parenStack.length > cursor.parenStack.length) {
        return false;
    }
    for (let i = 0; i < match.parenStack.length; i++) {
        if (match.parenStack[i] !== cursor.parenStack[i]) {
            return false;
        }
    }
    for (let i = 0; i <= match.parenStack.length; i++) {
        if (match.branchStack[i] !== cursor.branchStack[i]) {
            return false;
        }
    }
    return true;
}

interface ScopeSignature {
    parenStack: number[];
    branchStack: number[];
}

// granice gałęzi zapytania złożonego - każda "przełącza" na nową, niepowiązaną listę tabel na danym poziomie zagnieżdżenia
const BRANCH_KEYWORD_REGEX = /\b(?:union|intersect|except)\b/gi;

/**
 * Liczy sygnaturę zasięgu (stos nawiasów + stos numerów gałęzi UNION/INTERSECT/EXCEPT na
 * każdym poziomie zagnieżdżenia) w KILKU punktach tekstu naraz, jednym przebiegiem od lewej
 * do prawej (zamiast liczyć go od zera dla każdego punktu osobno, jak robił to poprzednio
 * `computeParenStack` wywoływane w pętli w `findQueryTables`).
 *
 * Tekst jest maskowany (`maskStringLiterals`) TYLKO RAZ, a nie raz na punkt -
 * przy zapytaniu z wieloma FROM/JOIN dawało to niepotrzebne O(n * liczba_dopasowań).
 *
 * Każde wejście w nawias odkłada nowy licznik gałęzi = 0 (podzapytanie liczy swoje
 * UNION-y niezależnie od zapytania zewnętrznego); wyjście z nawiasu go zdejmuje.
 */
function computeScopeSignaturesAt(sql: string, checkpoints: number[]): ScopeSignature[] {
    const masked = maskStringLiterals(sql);

    const branchKeywordStarts = new Set<number>();
    let keywordMatch: RegExpExecArray | null;
    while ((keywordMatch = BRANCH_KEYWORD_REGEX.exec(masked)) !== null) {
        branchKeywordStarts.add(keywordMatch.index);
    }

    // sortujemy punkty rosnąco żeby przejść tekst jednym przebiegiem, ale wynik zwracamy w oryginalnej kolejności
    const order = checkpoints
        .map((pos, originalIndex) => ({ pos, originalIndex }))
        .sort((a, b) => a.pos - b.pos);

    const results: ScopeSignature[] = new Array(checkpoints.length);
    const parenStack: number[] = [];
    const branchStack: number[] = [0]; // poziom 0 = główne zapytanie, zawsze obecny
    let cursor = 0;

    for (const { pos, originalIndex } of order) {
        const end = Math.min(pos, masked.length);
        while (cursor < end) {
            if (branchKeywordStarts.has(cursor)) {
                branchStack[branchStack.length - 1]++;
            }
            const ch = masked[cursor];
            if (ch === '(') {
                parenStack.push(cursor);
                branchStack.push(0);
            } else if (ch === ')') {
                parenStack.pop();
                branchStack.pop();
            }
            cursor++;
        }
        results[originalIndex] = { parenStack: [...parenStack], branchStack: [...branchStack] };
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

    // `?` wokół schematu/tabeli obsługuje cytowanie w backtickach (standard MySQL/MariaDB, np. FROM `mydb`.`users`)
    const regex =
        /\b(?:from|join)\s+(?:`?(\w+)`?\s*\.\s*)?`?(\w+)`?/gi;

    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sql)) !== null) {
        matches.push(match);
    }

    // przy podanym kursorze ograniczamy dopasowania do jego zasięgu (pomijamy tabele z obcych podzapytań/gałęzi UNION) i liczymy sygnatury zasięgu jednym przebiegiem
    let cursorSignature: ScopeSignature | null = null;
    let matchSignatures: ScopeSignature[] | null = null;

    if (cursorOffset !== undefined) {
        const checkpoints = matches.map(m => m.index);
        checkpoints.push(cursorOffset);

        const signatures = computeScopeSignaturesAt(sql, checkpoints);
        matchSignatures = signatures.slice(0, matches.length);
        cursorSignature = signatures[matches.length];
    }

    matches.forEach((match, i) => {
        if (cursorSignature !== null && matchSignatures !== null) {
            if (!isAncestorScope(matchSignatures[i], cursorSignature)) {
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
