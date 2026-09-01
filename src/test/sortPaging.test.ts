import * as assert from 'assert';
import { buildEqualRanges, getAscPageKeys, getDescPageKeys, getPageKeys, ColumnSortCache } from '../panel/sortPaging.js';

// buduje cache z gotowej tablicy WARTOŚCI już posortowanych rosnąco (indeks pozycji = indeks wiersza, dla czytelności testów) - odpowiednik tego, co realnie zwraca radix sort + buildColumnSortCache w SqlResultsProvider.ts
function cacheFromSortedValues(sortedValues: number[]): ColumnSortCache {
    const flatKeysAsc = Int32Array.from(sortedValues.map((_, i) => i));
    const equalRanges = buildEqualRanges(flatKeysAsc, (posA, posB) => sortedValues[posA] - sortedValues[posB]);
    return { flatKeysAsc, equalRanges };
}

// naiwna referencja - materializuje PEŁNĄ tablicę DESC dokładnie tym samym algorytmem co dawny kod (grupy odwrócone, wnętrze grupy bez zmian), do porównania z leniwą wersją
function naiveFullDesc(cache: ColumnSortCache): number[] {
    const { flatKeysAsc, equalRanges } = cache;
    const isGroupEnd = new Uint8Array(flatKeysAsc.length);
    const groupStartOf = new Int32Array(flatKeysAsc.length);
    for (let g = 0; g < equalRanges.length; g += 2) {
        const start = equalRanges[g], end = equalRanges[g + 1];
        for (let p = start; p <= end; p++) {groupStartOf[p] = start; isGroupEnd[p] = (p === end) ? 1 : 0;}
    }

    const reversed: number[] = [];
    let p = flatKeysAsc.length - 1;
    while (p >= 0) {
        const start = isGroupEnd[p] ? groupStartOf[p] : p;
        for (let q = start; q <= p; q++) {reversed.push(flatKeysAsc[q]);}
        p = start - 1;
    }
    return reversed;
}

suite('sortPaging.getDescPageKeys - przykład z rozmowy (a,b,b,c,d,d,d,e)', () => {
    // wartości: 0:a 1:b 2:b 3:c 4:d 5:d 6:d 7:e
    const values = [0, 1, 1, 2, 3, 3, 3, 4];
    const cache = cacheFromSortedValues(values);

    test('equalRanges zawiera tylko grupy b i d, bez singletonów', () => {
        assert.deepStrictEqual(Array.from(cache.equalRanges), [1, 2, 4, 6]);
    });

    test('pełne DESC to e,d,d,d,c,b,b,a', () => {
        assert.deepStrictEqual(naiveFullDesc(cache), [7, 4, 5, 6, 3, 1, 2, 0]);
    });

    test('strona [3,6) daje dokładnie d,c,b - tak jak ustalone ręcznie w rozmowie', () => {
        const page = getDescPageKeys(cache, 3, 3);
        assert.deepStrictEqual(page.map((k) => values[k]), [3, 2, 1]); // wartości d,c,b
        assert.deepStrictEqual(page, [6, 3, 1]); // konkretne indeksy wierszy - d czytane z ostatniej pozycji grupy (6), b z pierwszej (1)
    });
});

suite('sortPaging.getDescPageKeys - przykład bez remisów (1:a 2:b 3:c 4:d)', () => {
    const cache = cacheFromSortedValues([0, 1, 2, 3]);

    test('strona [1,3) daje c,b - dokładnie jak w ręcznym przykładzie z rozmowy', () => {
        const page = getDescPageKeys(cache, 1, 2);
        assert.deepStrictEqual(page, [2, 1]);
    });
});

suite('sortPaging.getDescPageKeys - zgodność z naiwną pełną rewersją', () => {
    function randomValuesWithTies(length: number, cardinality: number, seed: number): number[] {
        let s = seed;
        const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
        const values = Array.from({ length }, () => next() % cardinality);
        values.sort((a, b) => a - b);
        return values;
    }

    test('losowe zbiory z remisami - każda strona zgadza się z naiwną rewersją', () => {
        for (const [length, cardinality] of [[0, 1], [1, 1], [2, 1], [50, 5], [50, 50], [200, 3], [777, 40]]) {
            const values = randomValuesWithTies(length, cardinality, length * 7919 + cardinality);
            const cache = cacheFromSortedValues(values);
            const full = naiveFullDesc(cache);

            for (let pageStart = 0; pageStart < length + 5; pageStart += 7) {
                for (const pageSize of [1, 3, 10]) {
                    const expected = full.slice(pageStart, pageStart + pageSize);
                    const actual = getDescPageKeys(cache, pageStart, pageSize);
                    assert.deepStrictEqual(actual, expected, `length=${length} cardinality=${cardinality} pageStart=${pageStart} pageSize=${pageSize}`);
                }
            }
        }
    });

    test('cały zbiór to jedna wielka grupa remisowa', () => {
        const cache = cacheFromSortedValues(new Array(30).fill(5));
        assert.deepStrictEqual(getDescPageKeys(cache, 0, 30), naiveFullDesc(cache));
        assert.deepStrictEqual(getDescPageKeys(cache, 10, 5), naiveFullDesc(cache).slice(10, 15));
    });

    test('pusty zbiór i strona poza zakresem', () => {
        const cache = cacheFromSortedValues([]);
        assert.deepStrictEqual(getDescPageKeys(cache, 0, 10), []);

        const small = cacheFromSortedValues([0, 1, 2]);
        assert.deepStrictEqual(getDescPageKeys(small, 10, 5), []);
        assert.deepStrictEqual(getDescPageKeys(small, 2, 5), [0]); // ostatnia (niepełna) strona
    });
});

suite('sortPaging.getAscPageKeys / getPageKeys', () => {
    const cache = cacheFromSortedValues([0, 1, 1, 2]);

    test('ASC to zwykły wycinek flatKeysAsc, remisy zostają w naturalnej kolejności', () => {
        assert.deepStrictEqual(getAscPageKeys(cache, 1, 2), [1, 2]);
    });

    test('getPageKeys deleguje wg kierunku', () => {
        assert.deepStrictEqual(getPageKeys(cache, 'asc', 0, 4), [0, 1, 2, 3]);
        assert.deepStrictEqual(getPageKeys(cache, 'desc', 0, 4), [3, 1, 2, 0]);
    });
});
