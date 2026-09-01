// nowa reprezentacja cache'a kolumny sortowania - flatKeysAsc bez zmian, ale bucketStart+keyToBucket (oba O(n)) zastąpione jednym equalRanges O(d), d = liczba grup remisowych
export interface ColumnSortCache {
    // indeksy wierszy w kolejności rosnącej wg wartości kolumny - identyczne jak w poprzedniej wersji cache'a
    flatKeysAsc: Int32Array;
    // pary [start,end] (pozycje w flatKeysAsc, inclusive) tylko dla grup mających co najmniej 2 elementy - grupy jednoelementowe (typowy przypadek dla kolumn wysokiej kardynalności) nie mają tu żadnego wpisu, posortowane rosnąco wg start, bez nakładania się
    equalRanges: Int32Array;
}

// prosty, niezoptymalizowany komparator do budowy flatKeysAsc/equalRanges - docelowo w SqlResultsProvider.ts zamiast tego zostanie użyty istniejący radix sort (asynchroniczny, z yieldowaniem event loop), a ta funkcja tylko dogrupowuje już posortowany wynik w equalRanges
export function buildEqualRanges(flatKeysAsc: Int32Array, compareByPosition: (posA: number, posB: number) => number): Int32Array {
    const ranges: number[] = [];
    let groupStart = 0;

    for (let i = 1; i <= flatKeysAsc.length; i++) {
        // koniec zbioru albo zmiana wartości względem poprzedniej pozycji zamyka bieżącą grupę
        const sameAsPrevious = i < flatKeysAsc.length && compareByPosition(i - 1, i) === 0;
        if (sameAsPrevious) {continue;}

        // grupa [groupStart, i-1] ma więcej niż 1 element -> warta zapisania, singletony pomijamy (implicit)
        if (i - 1 > groupStart) {ranges.push(groupStart, i - 1);}
        groupStart = i;
    }

    return Int32Array.from(ranges);
}

// strona ASC to zwykły, bezpośredni wycinek flatKeysAsc - kolejność grup ORAZ kolejność wewnątrz grup są już dokładnie takie, jak ma być, więc equalRanges nie jest tu w ogóle potrzebne
export function getAscPageKeys(cache: ColumnSortCache, pageStart: number, pageSize: number): number[] {
    const end = Math.min(pageStart + pageSize, cache.flatKeysAsc.length);
    if (pageStart >= end) {return [];}
    return Array.from(cache.flatKeysAsc.subarray(pageStart, end));
}

/**
 * strona DESC bez materializowania całego odwróconego zbioru - idziemy "blokami" od końca flatKeysAsc w stronę początku, gdzie blok to
 * albo cała grupa remisowa (czytana w środku BEZ odwracania - dokładnie jak w oryginalnym algorytmie, tylko kolejność SAMYCH grup jest odwrócona),
 * albo pojedynczy, "goły" fragment bez remisów (odczytywany wprost jako zwykła, prosta rewersja pozycji - to jest to samo co odwrócenie zwykłej listy unikalnych wartości)
 * bloki w całości poza oknem strony są tylko dodawane do licznika (bez czytania pojedynczych elementów) - stąd koszt O(liczba grup) + O(rozmiar strony), a nie O(n)
 */
export function getDescPageKeys(cache: ColumnSortCache, pageStart: number, pageSize: number): number[] {
    const { flatKeysAsc, equalRanges } = cache;
    const n = flatKeysAsc.length;
    const pageEnd = Math.min(pageStart + pageSize, n);
    if (pageStart >= pageEnd || pageStart >= n) {return [];}

    const result: number[] = [];
    let accumulated = 0; // ile elementów DESC już "przeszliśmy" logicznie, licząc od pozycji 0
    let rangeIdx = equalRanges.length / 2 - 1; // indeks OSTATNIEJ (najdalej w prawo) pary [start,end] jeszcze nieodwiedzonej
    let cursor = n - 1; // najwyższa jeszcze nieprzetworzona pozycja fizyczna we flatKeysAsc

    while (cursor >= 0 && accumulated < pageEnd) {
        let blockStart: number;
        let blockEnd: number;
        let isGroup: boolean;

        if (rangeIdx >= 0 && equalRanges[rangeIdx * 2 + 1] === cursor) {
            // cursor trafił dokładnie na koniec grupy remisowej -> cały blok to ta grupa
            blockStart = equalRanges[rangeIdx * 2];
            blockEnd = equalRanges[rangeIdx * 2 + 1];
            isGroup = true;
            rangeIdx--;
        } else {
            // "goły" odcinek bez remisów, od końca poprzedniej grupy (albo początku tablicy) do cursor
            const lowerBound = rangeIdx >= 0 ? equalRanges[rangeIdx * 2 + 1] + 1 : 0;
            blockStart = lowerBound;
            blockEnd = cursor;
            isGroup = false;
        }

        const blockSize = blockEnd - blockStart + 1;
        const blockDescStart = accumulated;
        const blockDescEnd = accumulated + blockSize;

        const overlapStart = Math.max(blockDescStart, pageStart);
        const overlapEnd = Math.min(blockDescEnd, pageEnd);

        if (overlapStart < overlapEnd) {
            const localFrom = overlapStart - blockDescStart;
            const localTo = overlapEnd - blockDescStart;

            if (isGroup) {
                // wewnątrz grupy remisowej BEZ odwracania - rosnąco po pozycji fizycznej, dokładnie jak w oryginalnym algorytmie
                for (let p = blockStart + localFrom; p < blockStart + localTo; p++) {result.push(flatKeysAsc[p]);}
            } else {
                // goły odcinek - w DESC czytany w pełni odwrócony (malejąco po pozycji fizycznej)
                for (let k = localFrom; k < localTo; k++) {result.push(flatKeysAsc[blockEnd - k]);}
            }
        }

        accumulated += blockSize;
        cursor = blockStart - 1;
    }

    return result;
}

// jedno wejście do modułu - kierunek decyduje, czy strona to zwykły wycinek, czy leniwa rewersja blokowa
export function getPageKeys(cache: ColumnSortCache, direction: 'asc' | 'desc', pageStart: number, pageSize: number): number[] {
    return direction === 'asc'
        ? getAscPageKeys(cache, pageStart, pageSize)
        : getDescPageKeys(cache, pageStart, pageSize);
}
