import * as assert from 'assert';
import { splitLines, findCurrentQuery, findAllQueries } from '../sql/findCurrentQuery.js';

suite('splitLines - handling different EOL styles', () => {
    test('splits Windows (CRLF) text into the same lines as Linux (LF)', () => {
        assert.deepStrictEqual(splitLines('select 1;\r\nselect 2;'), ['select 1;', 'select 2;']);
    });

    test('splits old Mac (lone CR) text into the same lines as Linux (LF)', () => {
        assert.deepStrictEqual(splitLines('select 1;\rselect 2;'), ['select 1;', 'select 2;']);
    });

    test('splits Linux/new Mac (LF) text normally', () => {
        assert.deepStrictEqual(splitLines('select 1;\nselect 2;'), ['select 1;', 'select 2;']);
    });

    test('regression: must not swallow blank lines the way /[\\r\\n]+/ would - a blank line stays its own array element', () => {
        assert.deepStrictEqual(splitLines('a\n\nb'), ['a', '', 'b']);
        assert.deepStrictEqual(splitLines('a\r\n\r\nb'), ['a', '', 'b']);
        assert.deepStrictEqual(splitLines('a\r\rb'), ['a', '', 'b']);
    });

    test('keeps multiple consecutive blank lines as separate elements, regardless of EOL style', () => {
        assert.deepStrictEqual(splitLines('a\n\n\nb'), ['a', '', '', 'b']);
        assert.deepStrictEqual(splitLines('a\r\n\r\n\r\nb'), ['a', '', '', 'b']);
    });
});

suite('findCurrentQuery - behaves identically regardless of EOL style', () => {
    test('Windows CRLF: detects a whole query split across several lines', () => {
        const text = 'select id,\r\n  name\r\nfrom users;';
        const result = findCurrentQuery(text, 1);
        assert.strictEqual(result?.sql, 'select id,\n  name\nfrom users;');
        assert.strictEqual(result?.startLine, 0);
        assert.strictEqual(result?.endLine, 2);
    });

    test('old Mac CR: detects a whole query split across several lines', () => {
        const text = 'select id,\r  name\rfrom users;';
        const result = findCurrentQuery(text, 1);
        assert.strictEqual(result?.sql, 'select id,\n  name\nfrom users;');
    });

    test('Linux LF: detects a whole query split across several lines', () => {
        const text = 'select id,\n  name\nfrom users;';
        const result = findCurrentQuery(text, 1);
        assert.strictEqual(result?.sql, 'select id,\n  name\nfrom users;');
    });
});

suite('findAllQueries - blank-line count between queries preserved for every EOL style', () => {
    test('Windows CRLF: two queries separated by one blank line', () => {
        const queries = findAllQueries('select 1;\r\n\r\nselect 2;');
        assert.strictEqual(queries.length, 2);
        assert.strictEqual(queries[0].sql, 'select 1;');
        assert.strictEqual(queries[1].sql, 'select 2;');
        // odstęp 1 pustej linii odzwierciedlony w indeksach linii (startLine drugiego zapytania o 2 większy niż endLine pierwszego)
        assert.strictEqual(queries[1].startLine - queries[0].endLine, 2);
    });

    test('old Mac CR: two queries separated by one blank line', () => {
        const queries = findAllQueries('select 1;\r\rselect 2;');
        assert.strictEqual(queries.length, 2);
        assert.strictEqual(queries[1].startLine - queries[0].endLine, 2);
    });

    test('Linux LF: two queries separated by two blank lines', () => {
        const queries = findAllQueries('select 1;\n\n\nselect 2;');
        assert.strictEqual(queries.length, 2);
        assert.strictEqual(queries[1].startLine - queries[0].endLine, 3);
    });

    test('three queries, different gaps, Windows (CRLF) file', () => {
        const text = 'select 1;\r\n\r\nselect 2;\r\n\r\n\r\nselect 3;';
        const queries = findAllQueries(text);
        assert.strictEqual(queries.length, 3);
        assert.deepStrictEqual(queries.map(q => q.sql), ['select 1;', 'select 2;', 'select 3;']);
    });
});
