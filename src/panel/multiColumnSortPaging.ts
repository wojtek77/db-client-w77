import { ColumnSortCache, buildEqualRanges, getPageKeys } from './sortPaging.js';

export interface SortCriterion {
    columnIndex: number;
    direction: 'asc' | 'desc';
}

// dostarcza wszystko czego rekurencja potrzebuje z zewnątrz - celowo odseparowane od SqlResultsProvider, żeby dało się to testować bez całej klasy i bez prawdziwej bazy danych
export interface MultiColumnSortContext {
    // globalny, trwały cache kolumny (poziom 0, sortCriteria[0]) - budowany raz na kolumnę i reużywany między stronami/kombinacjami kryteriów, dokładnie jak przy sortowaniu jednokolumnowym
    getColumnCache(columnIndex: number): ColumnSortCache;
    // porównanie surowych wartości dwóch wierszy w danej kolumnie - używane TYLKO lokalnie, do doprecyzowania małej/średniej grupy remisowej kolejnym kryterium, nigdy do całego zbioru
    compareCellValues(rowA: number, rowB: number, columnIndex: number): number;
}

// jeden odwiedzony blok w oknie strony - grupa remisowa (do ewentualnej rekurencji) albo "goły" fragment bez remisów (już w pełni ustalony, czytany bezpośrednio)
type BlockOverlapHandler = (
    flatKeysAsc: Int32Array,
    blockStart: number,
    blockEnd: number,
    localFrom: number,
    localTo: number,
    isGroup: boolean,
    // true tylko dla "gołego" fragmentu czytanego pod DESC (fizyczne odwrócenie) - grupy remisowe NIGDY nie są odwracane wewnątrz, niezależnie od kierunku (patrz sortPaging.ts)
    reversedPhysicalRead: boolean
) => void;

// odpowiednik getAscPageKeys z sortPaging.ts, ale zamiast czytać elementy wprost, zgłasza każdy nachodzący na okno blok wywołującemu - potrzebne, bo nawet przy ASC grupa remisowa może wymagać zejścia do kolejnego kryterium
function walkPageWindowAsc(cache: ColumnSortCache, pageStart: number, pageEnd: number, onOverlap: BlockOverlapHandler): void {
    const { flatKeysAsc, equalRanges } = cache;
    const n = flatKeysAsc.length;
    if (pageStart >= n || pageStart >= pageEnd) {return;}

    let accumulated = 0; // logiczna pozycja ASC == fizyczna pozycja, więc to jednocześnie cursor fizyczny
    let rangeIdx = 0; // indeks NAJBLIŻSZEJ w prawo, jeszcze nieodwiedzonej pary [start,end]
    let cursor = 0;

    while (cursor < n && accumulated < pageEnd) {
        let blockStart: number, blockEnd: number, isGroup: boolean;

        if (rangeIdx * 2 < equalRanges.length && equalRanges[rangeIdx * 2] === cursor) {
            blockStart = equalRanges[rangeIdx * 2];
            blockEnd = equalRanges[rangeIdx * 2 + 1];
            isGroup = true;
            rangeIdx++;
        } else {
            const upperBound = (rangeIdx * 2 < equalRanges.length) ? equalRanges[rangeIdx * 2] - 1 : n - 1;
            blockStart = cursor;
            blockEnd = upperBound;
            isGroup = false;
        }

        const blockSize = blockEnd - blockStart + 1;
        const blockAscStart = accumulated;
        const blockAscEnd = accumulated + blockSize;

        const overlapStart = Math.max(blockAscStart, pageStart);
        const overlapEnd = Math.min(blockAscEnd, pageEnd);

        if (overlapStart < overlapEnd) {
            const localFrom = overlapStart - blockAscStart;
            const localTo = overlapEnd - blockAscStart;
            // ASC nigdy nie odwraca fizycznej kolejności - reversedPhysicalRead zawsze false
            onOverlap(flatKeysAsc, blockStart, blockEnd, localFrom, localTo, isGroup, false);
        }

        accumulated += blockSize;
        cursor = blockEnd + 1;
    }
}

// odpowiednik getDescPageKeys z sortPaging.ts, ale z callbackiem zamiast bezpośredniego zapisu do wyniku
function walkPageWindowDesc(cache: ColumnSortCache, pageStart: number, pageEnd: number, onOverlap: BlockOverlapHandler): void {
    const { flatKeysAsc, equalRanges } = cache;
    const n = flatKeysAsc.length;
    if (pageStart >= n || pageStart >= pageEnd) {return;}

    let accumulated = 0;
    let rangeIdx = equalRanges.length / 2 - 1;
    let cursor = n - 1;

    while (cursor >= 0 && accumulated < pageEnd) {
        let blockStart: number, blockEnd: number, isGroup: boolean;

        if (rangeIdx >= 0 && equalRanges[rangeIdx * 2 + 1] === cursor) {
            blockStart = equalRanges[rangeIdx * 2];
            blockEnd = equalRanges[rangeIdx * 2 + 1];
            isGroup = true;
            rangeIdx--;
        } else {
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
            // grupa remisowa -> nigdy nie odwracamy wnętrza (reversedPhysicalRead=false), goły fragment pod DESC -> pełne odwrócenie fizyczne
            onOverlap(flatKeysAsc, blockStart, blockEnd, localFrom, localTo, isGroup, !isGroup);
        }

        accumulated += blockSize;
        cursor = blockStart - 1;
    }
}

/**
 * buduje TYMCZASOWY, jednorazowy cache dla podzbioru wierszy (członków jednej grupy remisowej z poziomu wyżej) wg kolejnego kryterium.
 * W odróżnieniu od globalnego cache'a per kolumna (context.getColumnCache) NIE jest nigdzie zapamiętywany - zależy od konkretnej grupy
 * (czyli pośrednio od tego, którą stronę ktoś akurat ogląda), więc trwałe cache'owanie nie miałoby sensu.
 * celowo Array.sort (O(k log k)) niezależnie od rozmiaru grupy - przy wpinaniu do SqlResultsProvider.ts dla bardzo dużych grup (rzadki
 * przypadek: niska kardynalność wcześniejszej kolumny) opłaca się zamiast tego użyć już istniejącego w klasie radix sortu (scoped do
 * samych memberRowIds zamiast całego this._allRows) żeby zejść z O(k log k) do O(k) - tu zostawione jako TODO, nieblokujące poprawności
 */
function buildLocalCache(memberRowIds: number[], columnIndex: number, context: MultiColumnSortContext): ColumnSortCache {
    // Array.sort jest stabilny (gwarancja ECMAScript 2019+) - remis w compareCellValues zachowuje kolejność z memberRowIds, czyli naturalną kolejność wierszy odziedziczoną z poziomu wyżej
    const sorted = Int32Array.from([...memberRowIds].sort((a, b) => context.compareCellValues(a, b, columnIndex)));
    const equalRanges = buildEqualRanges(sorted, (posA, posB) => context.compareCellValues(sorted[posA], sorted[posB], columnIndex));
    return { flatKeysAsc: sorted, equalRanges };
}

// rdzeń rekurencji - odwiedza tylko buckety/fragmenty faktycznie nachodzące na okno strony, dla trafionych grup remisowych (jeśli są jeszcze kolejne kryteria) schodzi rekurencyjnie zamiast czytać wprost
function resolveWindow(
    criteria: SortCriterion[],
    level: number,
    cache: ColumnSortCache,
    context: MultiColumnSortContext,
    pageStart: number,
    pageEnd: number,
    out: number[]
): void {
    const direction = criteria[level].direction;
    const walker = direction === 'asc' ? walkPageWindowAsc : walkPageWindowDesc;
    const isLastCriterion = level === criteria.length - 1;

    walker(cache, pageStart, pageEnd, (flatKeysAsc, blockStart, blockEnd, localFrom, localTo, isGroup, reversedPhysicalRead) => {
        if (!isGroup || isLastCriterion) {
            // singleton (już jednoznacznie ustalony przez to kryterium) albo ostatnie kryterium (remis rozstrzyga naturalna kolejność) - czytamy bezpośrednio
            if (reversedPhysicalRead) {
                for (let k = localFrom; k < localTo; k++) {out.push(flatKeysAsc[blockEnd - k]);}
            } else {
                for (let p = blockStart + localFrom; p < blockStart + localTo; p++) {out.push(flatKeysAsc[p]);}
            }
            return;
        }

        // grupa remisowa na tym poziomie i są jeszcze kolejne kryteria - materializujemy TYLKO członków tej jednej grupy (nie cały zbiór) i schodzimy niżej
        const memberRowIds: number[] = [];
        for (let p = blockStart; p <= blockEnd; p++) {memberRowIds.push(flatKeysAsc[p]);}

        const localCache = buildLocalCache(memberRowIds, criteria[level + 1].columnIndex, context);
        resolveWindow(criteria, level + 1, localCache, context, localFrom, localTo, out);
    });
}

// jedyne wejście do modułu - dla jednego kryterium deleguje wprost do sortPaging.ts (bez narzutu), dla wielu kryteriów uruchamia rekurencję MSD zaczynając od globalnego cache'a kryterium najważniejszego (sortCriteria[0])
export function getMultiColumnPageKeys(criteria: SortCriterion[], context: MultiColumnSortContext, pageStart: number, pageSize: number): number[] {
    if (criteria.length === 0 || pageSize <= 0) {return [];}

    if (criteria.length === 1) {
        return getPageKeys(context.getColumnCache(criteria[0].columnIndex), criteria[0].direction, pageStart, pageSize);
    }

    const out: number[] = [];
    resolveWindow(criteria, 0, context.getColumnCache(criteria[0].columnIndex), context, pageStart, pageStart + pageSize, out);
    return out;
}
