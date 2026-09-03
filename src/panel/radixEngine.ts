// Silnik radix sort używany DWUKROTNIE przez SqlResultsProvider.ts: dla pełnego zbioru (this._allRows, wynik trafia do trwałego
// this._sortColumnCache per kolumna) i dla przefiltrowanego podzbioru przy aktywnym wyszukiwaniu (bez cache'a - wynik jednorazowy,
// patrz applyFilteredPrimarySort w SqlResultsProvider.ts). Ten moduł jest celowo pozbawiony jakiejkolwiek zależności od stanu klasy - rows/sortKinds są
// zawsze przekazywane jawnie, dzięki czemu buildColumnSortCache poniżej obsługuje OBA przypadki identycznym kodem (patrz sourceIndices).
import { ColumnSortCache } from './sortPaging.js';

// typ danych kolumny na potrzeby wyboru komparatora sortowania - ustalany WYŁĄCZNIE z metadanych SQL (field.type), patrz computeSortKinds w SqlResultsProvider.ts; 'date' to DATE/DATETIME/TIMESTAMP - mimo że wartość przychodzi jako string (dateStrings:true), na potrzeby sortowania jest parsowana na liczbę (patrz parseDateOrTimeToSortableNumber) i idzie tą samą szybką ścieżką radix co 'number'
export type SortKind = 'number' | 'string' | 'date';

// dopasowuje 'YYYY-MM-DD' albo 'YYYY-MM-DD HH:MM:SS[.ułamek]' (DATE/DATETIME/TIMESTAMP z dateStrings:true) - patrz parseDateOrTimeToSortableNumber
const DATE_STRING_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/;
// dopasowuje TIME MariaDB/MySQL: opcjonalny minus, godziny 1-3 cyfry (zakres do 838), MM:SS, opcjonalny ułamek sekundy - patrz parseDateOrTimeToSortableNumber
const TIME_STRING_PATTERN = /^(-)?(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
// ile pierwszych znaków (jednostek UTF-16) stringa wchodzi do klucza radix sortu - patrz buildStringPrefixWords/STRING_RADIX_WORD_COUNT; reszta rozstrzygana pełnym porównaniem tylko w obrębie grup o identycznym prefiksie
const STRING_RADIX_PREFIX_CHARS = 4;
// 2 znaki UTF-16 (2x16 bit) na słowo 32-bitowe -> STRING_RADIX_PREFIX_CHARS/2 słów na string
const STRING_RADIX_WORD_COUNT = STRING_RADIX_PREFIX_CHARS / 2;
// liczba (JS number/Float64) zajmuje dokładnie 2 słowa 32-bitowe (64-bitowa reprezentacja IEEE-754) - patrz buildNumberWords
const NUMBER_RADIX_WORD_COUNT = 2;
// pojedynczy, reużywany bufor do konwersji Float64 -> bity IEEE-754 (uint32 x2) - unikamy alokacji nowego ArrayBuffer/DataView dla każdej porównywanej wartości
const float64Scratch = new DataView(new ArrayBuffer(8));

/**
 * Zamienia string DATE/DATETIME/TIMESTAMP/TIME (dateStrings:true, patrz Connection.ts) na liczbę porządkującą wartości tak samo jak
 * natywny SQL ORDER BY - dzięki temu kolumna typu 'date' idzie tą samą szybką ścieżką radix co 'number' (pełna wartość w kluczu,
 * bez dużych grup remisowych jak przy sortowaniu prefiksu stringa - patrz buildStringPrefixWords). Nie jest to prawdziwy unix time
 * (DATE/DATETIME są bez strefy czasowej), liczy się wyłącznie monotoniczność względem innych wartości tej samej kolumny.
 * '0000-00-00'/'0000-00-00 00:00:00' (MySQL dopuszcza taki "zerowy" DATE/DATETIME) oraz wartości niepasujące do żadnego wzorca -> 0,
 * czyli najmniejsza możliwa wartość.
 */
export function parseDateOrTimeToSortableNumber(value: string): number {
    const trimmed = value.trim();

    const dateMatch = DATE_STRING_PATTERN.exec(trimmed);
    if (dateMatch) {
        const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, fracStr] = dateMatch;
        const year = Number(yearStr);
        const month = Number(monthStr);
        const day = Number(dayStr);
        if (year === 0 || month === 0 || day === 0) {return 0;} // zerowy DATE/DATETIME MySQL
        const hour = hourStr ? Number(hourStr) : 0;
        const minute = minuteStr ? Number(minuteStr) : 0;
        const second = secondStr ? Number(secondStr) : 0;
        const fracMs = fracStr ? Number(fracStr.padEnd(3, '0').slice(0, 3)) : 0; // mikrosekundy (fsp do 6 cyfr) obcinamy do milisekund - wystarczająca precyzja do sortowania
        return Date.UTC(year, month - 1, day, hour, minute, second, fracMs);
    }

    const timeMatch = TIME_STRING_PATTERN.exec(trimmed);
    if (timeMatch) {
        const [, signStr, hourStr, minuteStr, secondStr, fracStr] = timeMatch;
        const sign = signStr === '-' ? -1 : 1;
        const totalMs = ((Number(hourStr) * 3600 + Number(minuteStr) * 60 + Number(secondStr)) * 1000)
            + (fracStr ? Number(fracStr.padEnd(3, '0').slice(0, 3)) : 0);
        return sign * totalMs;
    }

    return 0; // wartość niepasująca do żadnego znanego formatu - traktujemy jak zerowy DATE/DATETIME
}

// zamienia surową wartość komórki na liczbę do zapakowania w słowa radix - 'number' wprost przez Number(), 'date' przez parser DATE/DATETIME/TIMESTAMP/TIME (patrz parseDateOrTimeToSortableNumber)
export function resolveNumericValue(value: number | string, kind: SortKind): number {
    if (kind === 'date') {return parseDateOrTimeToSortableNumber(typeof value === 'string' ? value : String(value));}
    return typeof value === 'number' ? value : Number(value);
}

// null-aware porównanie dwóch surowych wartości komórki wg typu kolumny - NULL zawsze najmniejszy, tak jak bucket 0 w buildColumnSortCache; string porównywany operatorami < > (ten sam porządek UTF-16 co charCodeAt w buildStringPrefixWords), number/date przez resolveNumericValue
export function compareCellValues(a: any, b: any, kind: SortKind): number {
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull || bNull) {return aNull === bNull ? 0 : (aNull ? -1 : 1);}

    if (kind === 'string') {
        const av = typeof a === 'string' ? a : String(a);
        const bv = typeof b === 'string' ? b : String(b);
        return av < bv ? -1 : (av > bv ? 1 : 0);
    }

    const av = resolveNumericValue(a, kind);
    const bv = resolveNumericValue(b, kind);
    return av < bv ? -1 : (av > bv ? 1 : 0);
}

// zamienia liczbę na dwa słowa 32-bitowe tak, żeby zwykłe porównanie bez znaku (jak w radix sorcie) odpowiadało prawdziwemu porządkowi liczbowemu IEEE-754
function encodeFloat64SortableWords(numericValue: number): [number, number] {
    float64Scratch.setFloat64(0, numericValue, false);
    let hi = float64Scratch.getUint32(0, false);
    let lo = float64Scratch.getUint32(4, false);

    // standardowa sztuczka bitowa: liczby ujemne (bit znaku=1) odwracamy całe, nieujemne (bit znaku=0) odwracamy tylko bit znaku - bez tego -5 wypadłoby "większe" niż 5 przy prostym porównaniu bitowym
    if ((hi & 0x80000000) !== 0) {
        hi = (~hi) >>> 0;
        lo = (~lo) >>> 0;
    } else {
        hi = (hi | 0x80000000) >>> 0;
    }

    return [hi, lo];
}

// pakuje wartości liczbowe/datowe kolumny w słowa 32-bitowe (2 słowa = 64-bitowa reprezentacja IEEE-754 double) - gęsta tablica indeksowana wprost pozycją w 'indices' (bez cache)
function buildNumberWords(rows: any[][], indices: number[], columnIndex: number, kind: SortKind): Uint32Array {
    const length = indices.length;
    const words = new Uint32Array(length * NUMBER_RADIX_WORD_COUNT);
    for (let i = 0; i < length; i++) {
        const numericValue = resolveNumericValue(rows[indices[i]][columnIndex], kind);
        const [hi, lo] = encodeFloat64SortableWords(numericValue);
        words[i * 2] = hi;
        words[i * 2 + 1] = lo;
    }
    return words;
}

// pakuje pierwsze STRING_RADIX_PREFIX_CHARS znaków (jednostek UTF-16) stringa w słowa 32-bitowe, po 2 znaki na słowo - gęsta tablica indeksowana wprost pozycją w 'indices'
function buildStringPrefixWords(rows: any[][], indices: number[], columnIndex: number): Uint32Array {
    const length = indices.length;
    const wordCount = STRING_RADIX_WORD_COUNT;
    const words = new Uint32Array(length * wordCount);

    for (let i = 0; i < length; i++) {
        const raw = rows[indices[i]][columnIndex];
        const value = typeof raw === 'string' ? raw : String(raw);
        const offset = i * wordCount;
        for (let w = 0; w < wordCount; w++) {
            const charIndex = w * 2;
            // brakujące znaki (string krótszy niż prefiks) dopełniamy zerami - to sortuje się PRZED każdym prawdziwym znakiem, więc "ab" trafia przed "abc" tak jak w zwykłym porządku leksykograficznym; pełne rozstrzygnięcie w razie potrzeby i tak dostaje grupa remisowa (patrz buildColumnSortCache)
            const c0 = charIndex < value.length ? value.charCodeAt(charIndex) : 0;
            const c1 = charIndex + 1 < value.length ? value.charCodeAt(charIndex + 1) : 0;
            words[offset + w] = ((c0 << 16) | c1) >>> 0;
        }
    }

    return words;
}

// porównuje wordCount słów dwóch pozycji bez odczytywania oryginalnej wartości
function wordsEqual(words: Uint32Array, a: number, b: number, wordCount: number): boolean {
    const aOffset = a * wordCount, bOffset = b * wordCount;
    for (let w = 0; w < wordCount; w++) {
        if (words[aOffset + w] !== words[bOffset + w]) {return false;}
    }
    return true;
}

// generyczny LSD radix sort (najmniej znaczący bajt najpierw) na dowolnej liczbie słów 32-bitowych - działa identycznie dla liczb (2 słowa) i prefiksów stringów (4 słowa); zwraca ROSNĄCO posortowaną permutację indeksów 0..length-1 (kierunek/desc obsługiwany przez wywołującego), albo null jeśli isValid() przestało zwracać true w trakcie oddawania event loop - isValid zamiast gołego numeru generation, bo przy sortowaniu wyszukiwania trzeba pilnować DWÓCH liczników naraz (sort + search), patrz applyFilteredPrimarySort w SqlResultsProvider.ts
export async function radixSortIndices(words: Uint32Array, length: number, wordCount: number, isValid: () => boolean): Promise<Uint32Array | null> {
    let source = new Uint32Array(length);
    for (let i = 0; i < length; i++) {source[i] = i;}
    let target = new Uint32Array(length);
    const counts = new Uint32Array(256);

    for (let word = wordCount - 1; word >= 0; word--) {
        for (let byte = 0; byte < 4; byte++) {
            counts.fill(0);
            const shift = byte * 8;

            for (let i = 0; i < length; i++) {
                counts[(words[source[i] * wordCount + word] >>> shift) & 0xff]++;
            }

            let total = 0;
            for (let i = 0; i < 256; i++) {
                const count = counts[i];
                counts[i] = total;
                total += count;
            }

            for (let i = 0; i < length; i++) {
                const idx = source[i];
                const bucket = (words[idx * wordCount + word] >>> shift) & 0xff;
                target[counts[bucket]++] = idx;
            }

            const swap = source;
            source = target;
            target = swap;

            // yield PO KAŻDYM przebiegu bajtowym, nie dopiero po całym słowie (4 przebiegi) - inaczej pojedyncza blokada event loop rośnie 4x (zmierzone: po słowie ~108ms max_lag przy 200k, po bajcie ~25-30ms)
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (!isValid()) {return null;}
        }
    }

    return source;
}

/**
 * Buduje ColumnSortCache (flatKeysAsc + equalRanges) dla JEDNEJ kolumny - radix dla realnych wartości, grupa NULL na początku bez
 * sortowania (już index-ascending u źródła). sourceIndices (opcjonalne) to DOWOLNY podzbiór indeksów do rows, w kolejności rosnącej
 * (np. filteredIndices przy wyszukiwaniu) - brak = cały zbiór (rows.length, indeksy 0..length-1), dokładnie jak przy pełnym zbiorze.
 * To jest właśnie ten sam silnik w obu trybach (z trwałym cache per kolumna albo bez niego) - różnica między nimi żyje WYŁĄCZNIE
 * po stronie wywołującego (SqlResultsProvider.ts), w tym, co się dzieje z wynikiem PO powrocie z tej funkcji.
 * Zwraca null, jeśli isValid() przestało zwracać true w trakcie oddawania event loop.
 */
export async function buildColumnSortCache(
    rows: any[][],
    sortKinds: SortKind[],
    columnIndex: number,
    isValid: () => boolean,
    sourceIndices?: number[],
): Promise<ColumnSortCache | null> {
    const length = sourceIndices ? sourceIndices.length : rows.length;
    const indexAt = sourceIndices ? (i: number) => sourceIndices[i] : (i: number) => i;
    const kind: SortKind = sortKinds[columnIndex] ?? 'string';

    const nullKeys: number[] = [];
    const valueIndices: number[] = [];
    for (let i = 0; i < length; i++) {
        const rowIndex = indexAt(i);
        const value = rows[rowIndex][columnIndex];
        if (value === null || value === undefined) {nullKeys.push(rowIndex);} else {valueIndices.push(rowIndex);}
    }

    // flatKeysAsc: grupa NULL na początku (indeks 0 - najmniejsza wartość w SQL ORDER BY), potem realne wartości rosnąco - rows/sourceIndices jest już index-ascending, więc nullKeys też, bez dodatkowego sortowania
    const flatKeysAsc = new Int32Array(length);
    flatKeysAsc.set(nullKeys, 0);
    // pary [start,end] (pozycje we flatKeysAsc, inclusive) TYLKO dla grup o co najmniej 2 elementach - patrz komentarz przy ColumnSortCache w sortPaging.ts; grupa NULL wchodzi tu na tych samych zasadach co każda inna wartość (nie jest specjalnym przypadkiem)
    const equalRanges: number[] = [];
    if (nullKeys.length > 1) {equalRanges.push(0, nullKeys.length - 1);}

    if (valueIndices.length === 1) {
        flatKeysAsc[nullKeys.length] = valueIndices[0];
    } else if (valueIndices.length > 1) {
        // 'date' idzie tą samą ścieżką co 'number' (buildNumberWords) - różni się tylko sposobem zamiany wartości komórki na liczbę, patrz resolveNumericValue
        const wordCount = kind === 'string' ? STRING_RADIX_WORD_COUNT : NUMBER_RADIX_WORD_COUNT;
        const words = kind === 'string'
            ? buildStringPrefixWords(rows, valueIndices, columnIndex)
            : buildNumberWords(rows, valueIndices, columnIndex, kind);

        const sortedIndices = await radixSortIndices(words, valueIndices.length, wordCount, isValid);
        if (sortedIndices === null) {return null;}

        let writePos = nullKeys.length;
        // grupy o identycznych słowach radix -> doprecyzowanie: dla NUMBER/DATE słowo = pełna wartość (remis = naprawdę ta sama liczba, jedna grupa); dla STRING słowo = tylko prefiks (remis może kryć różne pełne wartości - dogrupowujemy po pełnej wartości)
        let groupStart = 0;
        for (let i = 1; i <= sortedIndices.length; i++) {
            const sameWordGroup = i < sortedIndices.length && wordsEqual(words, sortedIndices[groupStart], sortedIndices[i], wordCount);
            if (sameWordGroup) {continue;}

            if (kind === 'string' && i - groupStart > 1) {
                // dogrupowanie po pełnej wartości w obrębie identycznego prefiksu - Map (lokalna, ograniczona do rozmiaru TEJ grupy, nie całego zbioru) zachowuje kolejność pierwszego wystąpienia, a ta jest już index-ascending (radix jest stabilny, valueIndices index-ascending u źródła)
                const queues = new Map<string, number[]>();
                for (let j = groupStart; j < i; j++) {
                    const idx = sortedIndices[j];
                    const value = rows[valueIndices[idx]][columnIndex] as string;
                    let queue = queues.get(value);
                    if (!queue) {queue = []; queues.set(value, queue);}
                    queue.push(valueIndices[idx]);
                }
                for (const value of [...queues.keys()].sort()) {
                    const queue = queues.get(value)!;
                    const groupWriteStart = writePos;
                    for (const key of queue) {flatKeysAsc[writePos++] = key;}
                    if (queue.length > 1) {equalRanges.push(groupWriteStart, writePos - 1);}
                }
            } else {
                const groupWriteStart = writePos;
                for (let j = groupStart; j < i; j++) {flatKeysAsc[writePos++] = valueIndices[sortedIndices[j]];}
                if (writePos - groupWriteStart > 1) {equalRanges.push(groupWriteStart, writePos - 1);}
            }

            groupStart = i;
        }
    }

    return { flatKeysAsc, equalRanges: Int32Array.from(equalRanges) };
}
