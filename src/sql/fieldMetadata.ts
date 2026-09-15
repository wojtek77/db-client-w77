// klasyfikacja metadanych kolumny SQL (field.type/field.flags z drivera mariadb) na potrzeby SqlResultsProvider.ts -
// zarówno strategia sortowania (computeSortKinds), jak i wykrywanie kolumn tekstowych do edycji wieloliniowej (computeColumnTypes);
// wydzielone jako czyste funkcje (meta[] -> wynik), zero zależności od stanu klasy, żeby dało się je testować w izolacji

import { SortKind } from '../panel/radixEngine.js';

/**
 * nazwy typów z field.type (mariadb driver, enum Types) klasyfikowane jako NUMBER na potrzeby sortowania - reszta (w tym VARCHAR/VAR_STRING/STRING)
 * to STRING, poza DATE_SORT_TYPE_NAMES niżej. Nazwy dokładnie wg node_modules/mariadb/lib/const/field-type.js (sterownik 'mariadb', nie 'mysql2' - stąd 'INT', nie 'LONG'). DECIMAL/NEWDECIMAL trafiają tu mimo że driver zwraca je jako JS string (decimalAsNumber nie jest
 * ustawione w Connection.ts) - komparator numeryczny (odejmowanie) działa poprawnie niezależnie od tego, czy wartość jest JS number czy numerycznym
 * stringiem, bo operator '-' zawsze wymusza konwersję obu argumentów na liczbę. YEAR jest już liczbą 4-cyfrową, więc nie potrzebuje osobnego parsera dat.
 */
const NUMERIC_SORT_TYPE_NAMES = new Set(['TINY', 'SHORT', 'INT', 'INT24', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR', 'BIT']);
// nazwy typów z field.type klasyfikowane jako DATE na potrzeby sortowania - wszystkie u nas zawsze stringi (dateStrings:true, patrz Connection.ts), więc idą przez parseDateOrTimeToSortableNumber zamiast wprost przez Number()
const DATE_SORT_TYPE_NAMES = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'TIME']);

// MySQL/MariaDB flaga BINARY_COLLATION z FieldInfo.flags (bit 1<<7); odróżnia prawdziwy BLOB (collation binarne) od TEXT (collation tekstowe) - na poziomie protokołu oba typy są raportowane tym samym field.type
const BINARY_COLLATION_FLAG = 1 << 7;

// field.type dla kolumn TEXT-owych - protokół MySQL/MariaDB raportuje je pod tymi samymi nazwami co odpowiadające im rozmiarowo typy BLOB
const BLOB_TEXT_TYPE_NAMES: Record<string, string> = {
    TINY_BLOB: 'tinytext',
    BLOB: 'text',
    MEDIUM_BLOB: 'mediumtext',
    LONG_BLOB: 'longtext'
};

// określa strategię sortowania na podstawie metadanych wyniku SQL - WYŁĄCZNIE na podstawie field.type (bez próbkowania wartości, bez specjalnego traktowania UUID - patrz NUMERIC_SORT_TYPE_NAMES/DATE_SORT_TYPE_NAMES); wszystko poza tymi listami to 'string', w tym VARCHAR/CHAR (raportowane przez driver jako VAR_STRING/STRING)
export function computeSortKinds(meta: any[]): SortKind[] {
    return meta.map((field: any) => {
        const type = String(field?.type ?? '').toUpperCase();
        if (NUMERIC_SORT_TYPE_NAMES.has(type)) {return 'number';}
        if (DATE_SORT_TYPE_NAMES.has(type)) {return 'date';}
        return 'string';
    });
}

/**
 * Na podstawie metadanych kolumn (meta z mariadb) ustala typ danych
 * potrzebny wyłącznie do decyzji input/textarea przy edycji komórki
 * (patrz media/editor.js: MULTILINE_COLUMN_TYPES). Typy TEXT/TINYTEXT/
 * MEDIUMTEXT/LONGTEXT rozpoznajemy bez żadnego dodatkowego zapytania do
 * bazy - metadane zwrócone razem z wynikiem (field.type + field.flags)
 * już to zawierają. Dla pozostałych kolumn zwracamy '', bo nic więcej
 * z tej wartości nie korzysta.
 */
export function computeColumnTypes(meta: any[]): string[] {
    if (!meta || meta.length === 0) {
        return [];
    }

    return meta.map((field: any) => {
        const textTypeName = BLOB_TEXT_TYPE_NAMES[field?.type];
        if (!textTypeName) {
            return '';
        }

        const isBinaryBlob =
            ((field.flags ?? 0) & BINARY_COLLATION_FLAG) !== 0;

        return isBinaryBlob ? '' : textTypeName;
    });
}
