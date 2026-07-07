import { TableColumnsCache, TableRef } from '../cache/TableColumnsCache.js';
import { Connection } from '../db/Connection.js';

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
function computeParenStack(sql: string, uptoIndex: number): number[] {
    const stack: number[] = [];
    let inString = false;
    let stringChar = '';
    const end = Math.min(uptoIndex, sql.length);

    for (let i = 0; i < end; i++) {
        const ch = sql[i];

        if (inString) {
            if (ch === stringChar) {
                inString = false;
            }
            continue;
        }

        if (ch === '\'' || ch === '"' || ch === '`') {
            inString = true;
            stringChar = ch;
        } else if (ch === '(') {
            stack.push(i);
        } else if (ch === ')') {
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

export function findQueryTables(
    sql: string,
    defaultSchema: string,
    db: Connection,
    cursorOffset?: number
): TableRef[] {

    const tableRefs: TableRef[] = [];

    const regex =
        /\b(?:from|join)\s+(?:(\w+)\s*\.\s*)?(\w+)/gi;

    // Jeśli podano pozycję kursora, ograniczamy dopasowania do tych, które są
    // w zasięgu widoczności kursora (pomijamy tabele z "obcych" podzapytań,
    // np. z innej gałęzi WHERE ... IN (...) niż ta, w której stoi kursor).
    const cursorStack = cursorOffset !== undefined
        ? computeParenStack(sql, cursorOffset)
        : null;

    let match:
        RegExpExecArray | null;

    while (
        (match = regex.exec(sql))
        !== null
    ) {

        if (cursorStack !== null) {
            const matchStack = computeParenStack(sql, match.index);
            if (!isAncestorScope(matchStack, cursorStack)) {
                continue;
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
    }

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
