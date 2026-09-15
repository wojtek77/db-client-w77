import * as assert from 'assert';
import { buildCsv, buildTxt } from '../panel/resultsExport.js';

suite('buildCsv', () => {
    test('nagłówek + wiersze, proste wartości bez escapowania', () => {
        const csv = buildCsv(['id', 'name'], [[1, 'Alice'], [2, 'Bob']]);
        assert.strictEqual(csv, 'id,name\n1,Alice\n2,Bob\n');
    });

    test('escapuje wartości zawierające przecinek, cudzysłów albo nową linię (RFC 4180 - podwojenie cudzysłowu)', () => {
        const csv = buildCsv(['note'], [['a,b'], ['he said "hi"'], ['line1\nline2']]);
        assert.strictEqual(csv, 'note\n"a,b"\n"he said ""hi"""\n"line1\nline2"\n');
    });

    test('null/undefined w komórce -> pusty string, nie "null"/"undefined"', () => {
        const csv = buildCsv(['a', 'b'], [[null, undefined]]);
        assert.strictEqual(csv, 'a,b\n,\n');
    });

    test('brak wierszy -> sam nagłówek', () => {
        const csv = buildCsv(['id', 'name'], []);
        assert.strictEqual(csv, 'id,name\n');
    });
});

suite('buildTxt', () => {
    test('generuje tabelę ASCII z separatorami i wyrównaniem kolumn do najdłuższej wartości', () => {
        const txt = buildTxt(['id', 'name'], [[1, 'Alice'], [22, 'Bo']]);
        const lines = txt.trimEnd().split('\n');

        // separator, header, separator, 2x wiersz, separator, licznik wierszy
        assert.strictEqual(lines.length, 7);
        assert.strictEqual(lines[0], lines[2]);
        assert.strictEqual(lines[0], lines[5]);
        assert.ok(lines[1].includes('id') && lines[1].includes('name'));
        assert.strictEqual(lines[6], 'Row count: 2');
    });

    test('przycina wartości dłuższe niż 50 znaków i dodaje "..."', () => {
        const longValue = 'x'.repeat(60);
        const txt = buildTxt(['col'], [[longValue]]);
        const dataLine = txt.split('\n')[3];

        assert.ok(dataLine.includes('...'));
        assert.ok(!dataLine.includes(longValue));
    });

    test('null/undefined w komórce -> pusty string zamiast "null"/"undefined"', () => {
        const txt = buildTxt(['a'], [[null]]);
        assert.ok(!txt.includes('null'));
    });

    test('brak wierszy -> tylko nagłówek i "Row count: 0"', () => {
        const txt = buildTxt(['id'], []);
        assert.ok(txt.includes('Row count: 0'));
    });
});
