import * as assert from 'assert';
import { detectUsingColumnList } from '../sql/usingColumns.js';

suite('detectUsingColumnList - cursor inside USING (...)', () => {
    test('right after the opening parenthesis', () => {
        const result = detectUsingColumnList('SELECT * FROM a JOIN b USING (');
        assert.deepStrictEqual(result, { filter: '', used: new Set() });
    });

    test('while typing a column name', () => {
        const result = detectUsingColumnList('SELECT * FROM a JOIN b USING (cu');
        assert.deepStrictEqual(result, { filter: 'cu', used: new Set() });
    });

    test('after a comma, remembering the columns that are already listed', () => {
        const result = detectUsingColumnList('SELECT * FROM a JOIN b USING (id, `code`, ');
        assert.deepStrictEqual(result, { filter: '', used: new Set(['id', 'code']) });
    });

    test('typing the second column', () => {
        const result = detectUsingColumnList('SELECT * FROM a JOIN b USING (id, na');
        assert.deepStrictEqual(result, { filter: 'na', used: new Set(['id']) });
    });

    test('typing a backtick-quoted column', () => {
        const result = detectUsingColumnList('SELECT * FROM a JOIN b USING (`or');
        assert.deepStrictEqual(result, { filter: 'or', used: new Set() });
    });

    test('works in lower case, without a space before the parenthesis and across lines', () => {
        assert.deepStrictEqual(detectUsingColumnList('select * from a join b using('), { filter: '', used: new Set() });
        assert.deepStrictEqual(detectUsingColumnList('SELECT * FROM a\nJOIN b\nUSING (\n  id,\n  '), { filter: '', used: new Set(['id']) });
    });

    test('works inside a subquery', () => {
        const result = detectUsingColumnList('SELECT * FROM t WHERE id IN (SELECT x.id FROM x JOIN y USING (');
        assert.deepStrictEqual(result, { filter: '', used: new Set() });
    });
});

suite('detectUsingColumnList - positions without USING columns', () => {
    test('after a finished column name without a comma', () => {
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a JOIN b USING (id '), null);
    });

    test('after the closing parenthesis', () => {
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a JOIN b USING (id) '), null);
    });

    test('inside a different parenthesis', () => {
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a WHERE id IN ('), null);
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a USE INDEX ('), null);
        assert.strictEqual(detectUsingColumnList('SELECT COUNT('), null);
    });

    test('a nested parenthesis inside USING is not a column list', () => {
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a JOIN b USING (id, ('), null);
    });

    test('inside a string literal or a comment', () => {
        assert.strictEqual(detectUsingColumnList("SELECT * FROM a JOIN b USING ('ab"), null);
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a JOIN b USING (id, -- note '), null);
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a JOIN b USING (/* note '), null);
    });

    test('a qualified name is not a valid USING column', () => {
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a JOIN b USING (a.'), null);
    });

    test('without any parenthesis', () => {
        assert.strictEqual(detectUsingColumnList('SELECT * FROM a JOIN b USING '), null);
        assert.strictEqual(detectUsingColumnList(''), null);
    });
});
