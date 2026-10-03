import * as assert from 'assert';
import { detectSubqueryStart } from '../sql/subqueryStart.js';

suite('detectSubqueryStart - cursor right after a subquery parenthesis', () => {
    test('after EXISTS (', () => {
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE EXISTS ('), true);
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE NOT EXISTS ('), true);
    });

    test('after IN, ANY, SOME and ALL', () => {
        for (const word of ['IN', 'NOT IN', '= ANY', '> SOME', '> ALL']) {
            assert.strictEqual(detectSubqueryStart(`SELECT * FROM t WHERE id ${word} (`), true, word);
        }
    });

    test('while typing the first word', () => {
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE id IN (SE'), true);
    });

    test('lowercase and a comment before the parenthesis', () => {
        assert.strictEqual(detectSubqueryStart('select * from t where exists ('), true);
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE id IN /* x */ ('), true);
    });

    test('not after something that already follows the parenthesis', () => {
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE id IN (SELECT '), false);
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE id IN (1, '), false);
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE id IN (1 '), false);
    });

    test('not after a function name or a plain grouping parenthesis', () => {
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE LOWER('), false);
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE id = 1 AND ('), false);
    });

    test('not inside a string or without a parenthesis', () => {
        assert.strictEqual(detectSubqueryStart("SELECT * FROM t WHERE a = 'x IN ("), false);
        assert.strictEqual(detectSubqueryStart('SELECT * FROM t WHERE id IN '), false);
        assert.strictEqual(detectSubqueryStart(''), false);
    });
});
