import * as assert from 'assert';
import { computeSortKinds, computeColumnTypes } from '../sql/fieldMetadata.js';

suite('computeSortKinds (mapowanie field.type z meta na NUMBER/STRING/DATE)', () => {

    test('typy numeryczne z NUMERIC_SORT_TYPE_NAMES -> number', () => {
        const meta = ['TINY', 'SHORT', 'INT', 'INT24', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR', 'BIT']
            .map((type) => ({ type }));

        assert.deepStrictEqual(computeSortKinds(meta), meta.map(() => 'number'));
    });

    test('CHAR/VARCHAR (raportowane przez driver jako VAR_STRING/STRING) i pozostałe typy -> string', () => {
        const meta = ['VARCHAR', 'VAR_STRING', 'STRING', 'JSON', 'ENUM', 'SET', 'BLOB']
            .map((type) => ({ type }));

        assert.deepStrictEqual(computeSortKinds(meta), meta.map(() => 'string'));
    });

    test('DATE/DATETIME/TIMESTAMP/TIME z DATE_SORT_TYPE_NAMES -> date', () => {
        const meta = ['DATE', 'DATETIME', 'TIMESTAMP', 'TIME'].map((type) => ({ type }));

        assert.deepStrictEqual(computeSortKinds(meta), meta.map(() => 'date'));
    });

    test('BIGINT konkretnie -> number (nie "LONGLONG" - to nieprawidłowa nazwa typu dla tego drivera, prawdziwa nazwa to BIGINT)', () => {
        assert.deepStrictEqual(computeSortKinds([{ type: 'BIGINT' }]), ['number']);
        assert.deepStrictEqual(computeSortKinds([{ type: 'LONGLONG' }]), ['string']);
    });

    test('typ zapisany małymi literami też jest rozpoznawany (String().toUpperCase())', () => {
        assert.deepStrictEqual(computeSortKinds([{ type: 'bigint' }]), ['number']);
    });

    test('brakujące/puste field.type nie wysypuje się, domyślnie string', () => {
        assert.deepStrictEqual(computeSortKinds([{}, { type: null }]), ['string', 'string']);
    });

    test('pusta lista meta -> pusta lista wyników', () => {
        assert.deepStrictEqual(computeSortKinds([]), []);
    });
});

suite('computeColumnTypes (wykrywanie kolumn TEXT-owych do edycji wieloliniowej)', () => {

    test('pusta/brakująca meta -> pusta tablica', () => {
        assert.deepStrictEqual(computeColumnTypes([]), []);
        assert.deepStrictEqual(computeColumnTypes(undefined as unknown as any[]), []);
    });

    test('TINY_BLOB/BLOB/MEDIUM_BLOB/LONG_BLOB z collation tekstową (bez flagi BINARY) -> tinytext/text/mediumtext/longtext', () => {
        const meta = [
            { type: 'TINY_BLOB', flags: 0 },
            { type: 'BLOB', flags: 0 },
            { type: 'MEDIUM_BLOB', flags: 0 },
            { type: 'LONG_BLOB', flags: 0 },
        ];

        assert.deepStrictEqual(computeColumnTypes(meta), ['tinytext', 'text', 'mediumtext', 'longtext']);
    });

    test('ta sama grupa typów, ale z ustawioną flagą BINARY_COLLATION (bit 1<<7) -> prawdziwy BLOB, pusty string', () => {
        const BINARY_COLLATION_FLAG = 1 << 7;
        const meta = [
            { type: 'BLOB', flags: BINARY_COLLATION_FLAG },
            // flaga może współwystępować z innymi bitami - liczy się tylko bit 1<<7
            { type: 'MEDIUM_BLOB', flags: BINARY_COLLATION_FLAG | 0b1 },
        ];

        assert.deepStrictEqual(computeColumnTypes(meta), ['', '']);
    });

    test('typy spoza BLOB_TEXT_TYPE_NAMES (np. VARCHAR, INT) -> pusty string', () => {
        const meta = [{ type: 'VARCHAR', flags: 0 }, { type: 'INT', flags: 0 }];

        assert.deepStrictEqual(computeColumnTypes(meta), ['', '']);
    });

    test('brak pola flags traktowany jak 0 (nie wysypuje się, nie jest binarny)', () => {
        assert.deepStrictEqual(computeColumnTypes([{ type: 'BLOB' }]), ['text']);
    });
});
