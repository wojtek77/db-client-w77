import * as assert from 'assert';
import { detectClauseEnd } from '../sql/clauseEnd.js';
import { detectExpressionPosition } from '../sql/expressionPosition.js';

suite('detectClauseEnd - select list', () => {
    test('after a column: alias and FROM', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT id ', 'select'), ['select-alias', 'end-select']);
    });

    test('after a star: only FROM', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT * ', 'select'), ['end-select']);
        assert.deepStrictEqual(detectClauseEnd('SELECT t.* ', 'select'), ['end-select']);
    });

    test('after an alias: only FROM', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT id x ', 'select'), ['end-select']);
        assert.deepStrictEqual(detectClauseEnd('SELECT id AS x ', 'select'), ['end-select']);
        assert.deepStrictEqual(detectClauseEnd('SELECT COUNT(*) c ', 'select'), ['end-select']);
    });

    test('nothing right after SELECT, a modifier, a comma or an operator', () => {
        assert.strictEqual(detectClauseEnd('SELECT ', 'select'), null);
        assert.strictEqual(detectClauseEnd('SELECT DISTINCT ', 'select'), null);
        assert.strictEqual(detectClauseEnd('SELECT a, ', 'select'), null);
        assert.strictEqual(detectClauseEnd('SELECT a + ', 'select'), null);
    });

    test('nothing inside a string', () => {
        assert.strictEqual(detectClauseEnd("SELECT 'abc ", 'select'), null);
    });
});

suite('detectClauseEnd - later clauses', () => {
    test('after WHERE condition', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT * FROM t WHERE id = 1 ', 'where'), ['end-where']);
    });

    test('after GROUP BY expression: WITH ROLLUP and next clauses', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t GROUP BY a ', 'group'), ['group-rollup', 'end-group']);
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t GROUP BY a WITH ROLLUP ', 'group'), ['end-group']);
    });

    test('after HAVING condition', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t GROUP BY a HAVING a > 1 ', 'having'), ['end-having']);
    });

    test('after ORDER BY expression: direction and next clauses', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t ORDER BY a ', 'order'), ['order-direction', 'end-order']);
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t ORDER BY a DESC ', 'order'), ['end-order']);
    });

    test('after LIMIT: OFFSET, ROWS EXAMINED and the end', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t LIMIT 10 ', 'limit'), ['limit-offset', 'limit-examined', 'end-limit']);
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t LIMIT 10 OFFSET 5 ', 'limit'), ['limit-examined', 'end-limit']);
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t LIMIT 5, 10 ', 'limit'), ['limit-examined', 'end-limit']);
    });

    test('after ROWS EXAMINED n only the end', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT a FROM t LIMIT 10 ROWS EXAMINED 100 ', 'limit'), ['end-limit']);
    });

    test('nothing right after LIMIT, OFFSET or ROWS', () => {
        assert.strictEqual(detectClauseEnd('SELECT a FROM t LIMIT ', 'limit'), null);
        assert.strictEqual(detectClauseEnd('SELECT a FROM t LIMIT 10 OFFSET ', 'limit'), null);
        assert.strictEqual(detectClauseEnd('SELECT a FROM t LIMIT 10 ROWS ', 'limit'), null);
    });

    test('after the ON condition the same clauses as after a table', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT * FROM a JOIN b ON a.id = b.id ', 'on'), ['end-from']);
    });
});

suite('detectClauseEnd - UNION, locks and parentheses', () => {
    test('nothing right after UNION, INTERSECT, EXCEPT, FOR or LOCK', () => {
        for (const word of ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'FOR', 'LOCK', 'LOCK IN']) {
            assert.strictEqual(detectClauseEnd(`SELECT * FROM t WHERE id = 1 ${word} `, 'where'), null, word);
        }
    });

    test('lock options only after a complete FOR UPDATE or LOCK IN SHARE MODE', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT * FROM t WHERE id = 1 FOR UPDATE ', 'where'), ['lock-wait']);
        assert.deepStrictEqual(detectClauseEnd('SELECT * FROM t LOCK IN SHARE MODE ', 'from'), ['lock-wait']);
        assert.deepStrictEqual(detectClauseEnd('SELECT * FROM t FOR UPDATE ', 'from'), ['lock-wait']);
        assert.strictEqual(detectClauseEnd('SELECT * FROM t FOR UPDATE NOWAIT ', 'from'), null);
        assert.strictEqual(detectClauseEnd('SELECT * FROM t FOR UPDATE SKIP LOCKED ', 'from'), null);
    });

    test('nothing after FETCH FIRST', () => {
        assert.strictEqual(detectClauseEnd('SELECT * FROM t ORDER BY a FETCH FIRST 10 ROWS ONLY ', 'order'), null);
    });

    test('a subquery has its own clauses', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE x = 1 ', 'where'), ['end-where']);
    });

    test('a grouping parenthesis or function arguments have no clause ends', () => {
        assert.strictEqual(detectClauseEnd('SELECT * FROM t WHERE id = 1 AND (id = 2 ', 'where'), null);
        assert.strictEqual(detectClauseEnd('SELECT COUNT(a ', 'select'), null);
    });

    test('OVER (ORDER BY a | only offers the direction', () => {
        assert.deepStrictEqual(detectClauseEnd('SELECT ROW_NUMBER() OVER (ORDER BY a ', 'order'), ['order-direction']);
    });

    test('unsupported or missing clause', () => {
        assert.strictEqual(detectClauseEnd('SELECT 1 ', undefined), null);
        assert.strictEqual(detectClauseEnd('INSERT INTO t VALUES (1) ', 'values'), null);
    });
});

suite('detectExpressionPosition - star and end-of-query words', () => {
    test('a star at the start of the select list is an operand', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * '), 'after-operand');
        assert.strictEqual(detectExpressionPosition('SELECT DISTINCT * '), 'after-operand');
        assert.strictEqual(detectExpressionPosition('SELECT a, * '), 'after-operand');
        assert.strictEqual(detectExpressionPosition('SELECT t.* '), 'after-operand');
    });

    test('a star between operands is multiplication', () => {
        assert.strictEqual(detectExpressionPosition('SELECT a * '), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a * '), null);
    });

    test('UNION, INTERSECT, EXCEPT, FOR UPDATE and LOCK IN SHARE MODE are not operands', () => {
        for (const tail of ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'FOR UPDATE', 'LOCK IN SHARE MODE']) {
            assert.strictEqual(detectExpressionPosition(`SELECT * FROM t WHERE id = 1 ${tail} `), null, tail);
        }
    });
});
