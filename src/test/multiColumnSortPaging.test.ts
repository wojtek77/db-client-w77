import * as assert from 'assert';
import { buildEqualRanges, ColumnSortCache } from '../panel/sortPaging.js';
import { getMultiColumnPageKeys, MultiColumnSortContext, SortCriterion } from '../panel/multiColumnSortPaging.js';

// prosty kontekst testowy - rows to tablica wierszy, każdy wiersz to tablica wartości kolumn (liczby albo stringi), porównywane naiwnie operatorem < / >
function makeContext(rows: (number | string)[][]): MultiColumnSortContext {
    const cacheByColumn = new Map<number, ColumnSortCache>();

    const compareCellValues = (rowA: number, rowB: number, columnIndex: number): number => {
        const a = rows[rowA][columnIndex];
        const b = rows[rowB][columnIndex];
        if (a < b) {return -1;}
        if (a > b) {return 1;}
        return 0;
    };

    const getColumnCache = (columnIndex: number): ColumnSortCache => {
        let cache = cacheByColumn.get(columnIndex);
        if (!cache) {
            const flatKeysAsc = Int32Array.from(rows.map((_, i) => i)).sort((a, b) => compareCellValues(a, b, columnIndex) || (a - b));
            const equalRanges = buildEqualRanges(flatKeysAsc, (posA, posB) => compareCellValues(flatKeysAsc[posA], flatKeysAsc[posB], columnIndex));
            cache = { flatKeysAsc, equalRanges };
            cacheByColumn.set(columnIndex, cache);
        }
        return cache;
    };

    return { getColumnCache, compareCellValues };
}

// referencja "na chłopski rozum" - pełne posortowanie wielokluczowe + zwykły slice, do porównania z leniwą rekurencją
function bruteForcePage(rows: (number | string)[][], criteria: SortCriterion[], pageStart: number, pageSize: number): number[] {
    const order = rows.map((_, i) => i).sort((rowA, rowB) => {
        for (const { columnIndex, direction } of criteria) {
            const a = rows[rowA][columnIndex];
            const b = rows[rowB][columnIndex];
            let cmp = a < b ? -1 : a > b ? 1 : 0;
            if (direction === 'desc') {cmp = -cmp;}
            if (cmp !== 0) {return cmp;}
        }
        return rowA - rowB; // remis wszystkich kryteriów - naturalna kolejność źródłowa
    });
    return order.slice(pageStart, pageStart + pageSize);
}

suite('multiColumnSortPaging - przykład status/name z rozmowy', () => {
    const rows: (number | string)[][] = [
        ['active', 'b'], // 0
        ['closed', 'a'], // 1
        ['active', 'a'], // 2
        ['closed', 'c'], // 3
        ['active', 'c'], // 4
        ['closed', 'b'], // 5
    ];
    const context = makeContext(rows);

    test('ORDER BY status ASC, name ASC - pełny wynik zgadza się z ręcznym przykładem', () => {
        const criteria: SortCriterion[] = [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'asc' }];
        const page = getMultiColumnPageKeys(criteria, context, 0, 6);
        assert.deepStrictEqual(page, [2, 0, 4, 1, 5, 3]);
    });

    test('ORDER BY status ASC, name ASC - okno [2,4) daje wiersze 4 i 1, dokładnie jak w rozmowie', () => {
        const criteria: SortCriterion[] = [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'asc' }];
        assert.deepStrictEqual(getMultiColumnPageKeys(criteria, context, 2, 2), [4, 1]);
    });

    test('ORDER BY name ASC, status ASC - inna kolejność kryteriów daje inny wynik', () => {
        const criteria: SortCriterion[] = [{ columnIndex: 1, direction: 'asc' }, { columnIndex: 0, direction: 'asc' }];
        assert.deepStrictEqual(getMultiColumnPageKeys(criteria, context, 0, 6), [2, 1, 0, 5, 4, 3]);
    });

    test('ORDER BY status ASC, name DESC - kierunek drugiego kryterium działa niezależnie od pierwszego', () => {
        const criteria: SortCriterion[] = [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'desc' }];
        assert.deepStrictEqual(getMultiColumnPageKeys(criteria, context, 0, 6), [4, 0, 2, 3, 5, 1]);
    });
});

suite('multiColumnSortPaging - zgodność z brute force (2 i 3 kryteria, różne kardynalności)', () => {
    function randomRows(count: number, cardinalities: number[], seed: number): number[][] {
        let s = seed;
        const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
        return Array.from({ length: count }, () => cardinalities.map((c) => next() % c));
    }

    test('losowe zbiory - każda strona zgadza się z brute force', () => {
        const configs: { count: number; cardinalities: number[]; criteria: SortCriterion[] }[] = [
            { count: 40, cardinalities: [5, 5], criteria: [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'asc' }] },
            { count: 40, cardinalities: [5, 5], criteria: [{ columnIndex: 0, direction: 'desc' }, { columnIndex: 1, direction: 'asc' }] },
            { count: 40, cardinalities: [5, 5], criteria: [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'desc' }] },
            { count: 40, cardinalities: [5, 5], criteria: [{ columnIndex: 0, direction: 'desc' }, { columnIndex: 1, direction: 'desc' }] },
            { count: 300, cardinalities: [2, 300], criteria: [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'asc' }] }, // bardzo duża grupa remisowa na poziomie 0
            { count: 60, cardinalities: [3, 3, 60], criteria: [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'desc' }, { columnIndex: 2, direction: 'asc' }] }, // 3 kryteria
            { count: 200, cardinalities: [200, 200], criteria: [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'asc' }] }, // praktycznie same singletony na poziomie 0
        ];

        for (const { count, cardinalities, criteria } of configs) {
            const rows = randomRows(count, cardinalities, count * 104729 + cardinalities.length);
            const context = makeContext(rows);

            for (let pageStart = 0; pageStart < count + 5; pageStart += 11) {
                for (const pageSize of [1, 4, 13]) {
                    const expected = bruteForcePage(rows, criteria, pageStart, pageSize);
                    const actual = getMultiColumnPageKeys(criteria, context, pageStart, pageSize);
                    assert.deepStrictEqual(actual, expected, `count=${count} cardinalities=${cardinalities} criteria=${JSON.stringify(criteria)} pageStart=${pageStart} pageSize=${pageSize}`);
                }
            }
        }
    });

    test('pusty zbiór i strona poza zakresem', () => {
        const context = makeContext([]);
        const criteria: SortCriterion[] = [{ columnIndex: 0, direction: 'asc' }, { columnIndex: 1, direction: 'asc' }];
        assert.deepStrictEqual(getMultiColumnPageKeys(criteria, context, 0, 10), []);
    });

    test('brak kryteriów zwraca pustą stronę', () => {
        const context = makeContext([[1], [2]]);
        assert.deepStrictEqual(getMultiColumnPageKeys([], context, 0, 10), []);
    });
});
