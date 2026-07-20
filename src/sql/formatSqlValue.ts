/**
 * Typy z pakietu `mariadb` (field.type), które reprezentują dane binarne
 * (BLOB w różnych rozmiarach). Dla VARBINARY/BINARY sterownik zwraca
 * type='STRING'/'VAR_STRING', ale z kolacją 'binary' - to sprawdzamy osobno.
 */
const BINARY_BLOB_TYPES = new Set(['TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'BLOB']);

/**
 * Sprawdza (na podstawie metadanych z wyniku SELECT, bez dodatkowego zapytania
 * do bazy), czy kolumna przechowuje dane binarne (BLOB, VARBINARY, BINARY).
 */
export function isBinaryField(field: any): boolean {
    if (!field) { return false; }

    if (BINARY_BLOB_TYPES.has(field.type)) {
        return true;
    }

    // VARBINARY/BINARY - zgłaszane jako STRING/VAR_STRING, ale z kolacją "binary"
    if (field.collation?.name === 'binary') {
        return true;
    }

    return false;
}

/**
 * Formatuje pojedynczą wartość jako literał SQL, gotowy do wklejenia
 * w INSERT/UPDATE. `field` to metadane kolumny z wyniku SELECT (this._meta[i]),
 * używane wyłącznie do wykrycia kolumn binarnych - reszta typów jest
 * rozpoznawana na podstawie rzeczywistego typu wartości w JS.
 */
export function formatSqlValue(value: unknown, field?: any): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }

    if (typeof value === 'bigint') {
        return value.toString();
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value.toString() : 'NULL';
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }

    if (Buffer.isBuffer(value) || isBinaryField(field)) {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'binary');
        return buf.length > 0 ? `X'${buf.toString('hex')}'` : "X''";
    }

    // string (w tym daty) i reszta nieobsłużonych wyżej typów -> escapowany literał tekstowy
    return `'${String(value).replace(/'/g, "''")}'`;
}
