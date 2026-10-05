import * as assert from 'assert';
import { detectExpressionPosition } from '../sql/expressionPosition.js';

suite('detectExpressionPosition - start of a condition', () => {
    test('right after WHERE', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM users WHERE '), 'expression-start');
    });

    test('right after HAVING', () => {
        assert.strictEqual(detectExpressionPosition('SELECT a FROM t GROUP BY a HAVING '), 'expression-start');
    });

    test('after AND / OR / XOR', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = 1 AND '), 'expression-start');
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = 1 OR '), 'expression-start');
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = 1 XOR '), 'expression-start');
    });

    test('after a prefix NOT', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE NOT '), 'expression-start');
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = 1 AND NOT '), 'expression-start');
    });

    test('after an opening parenthesis that itself starts a condition', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE ('), 'expression-start');
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = 1 AND ('), 'expression-start');
    });

    test('while typing a word at the start of a condition', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE EXI'), 'expression-start');
    });

    test('after the AND that closes a previous BETWEEN, it is a plain logical AND', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a BETWEEN 1 AND 2 AND '), 'expression-start');
    });
});

suite('detectExpressionPosition - after an operand', () => {
    test('after a column name', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE id '), 'after-operand');
    });

    test('after a qualified column name', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t u WHERE u.id '), 'after-operand');
    });

    test('after a number or a string literal', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = 1 '), 'after-operand');
        assert.strictEqual(detectExpressionPosition("SELECT * FROM t WHERE a = 'x' "), 'after-operand');
    });

    test('after a comparison glued to its operand (no spaces)', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a=1 '), 'after-operand');
    });

    test('after a closing parenthesis', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a IN (1, 2) '), 'after-operand');
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE COUNT(*) '), 'after-operand');
    });

    test('after a backtick-quoted identifier', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE `order` '), 'after-operand');
    });

    test('while typing a word right after an operand', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE id I'), 'after-operand');
    });

    test('after NULL / TRUE / FALSE literals', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = NULL '), 'after-operand');
    });

    test('the AND of a BETWEEN is followed by a value, not by a new condition', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a BETWEEN 1 AND '), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE x = 1 AND a NOT BETWEEN 1 AND '), null);
    });
});

suite('detectExpressionPosition - SELECT list', () => {
    test('right after SELECT and its modifiers', () => {
        assert.strictEqual(detectExpressionPosition('SELECT '), 'expression-start');
        assert.strictEqual(detectExpressionPosition('SELECT DISTINCT '), 'expression-start');
        assert.strictEqual(detectExpressionPosition('SELECT SQL_NO_CACHE DISTINCT '), 'expression-start');
    });

    test('while typing the first word of the list', () => {
        assert.strictEqual(detectExpressionPosition('SELECT EXI'), 'expression-start');
        assert.strictEqual(detectExpressionPosition('SELECT DISTINCT EXI'), 'expression-start');
    });

    test('after a comma between select expressions', () => {
        assert.strictEqual(detectExpressionPosition('SELECT id, '), 'expression-start');
    });

    test('after a select expression', () => {
        assert.strictEqual(detectExpressionPosition('SELECT id '), 'after-operand');
        assert.strictEqual(detectExpressionPosition('SELECT * '), 'after-operand');
    });

    test('ALL and DISTINCT outside the start of the list still expect a value', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a > ALL '), null);
        assert.strictEqual(detectExpressionPosition('SELECT COUNT(DISTINCT '), null);
    });
});

suite('detectExpressionPosition - after a postfix NOT', () => {
    test('operand followed by NOT', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE id NOT '), 'after-not');
    });

    test('NOT after IS is not a postfix NOT of an operand', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE id IS NOT '), null);
    });
});

suite('detectExpressionPosition - positions without condition keywords', () => {
    test('after a comparison operator a value is expected', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = '), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a >= '), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a + '), null);
    });

    test('while typing a value right after an operator glued to the word', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a=I'), null);
    });

    test('after keywords that expect a value', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a IN '), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a LIKE '), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a IS '), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a BETWEEN '), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE EXISTS '), null);
    });

    test('after an opening parenthesis that is not the start of a condition', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a IN ('), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE COUNT('), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a = ('), null);
    });

    test('after a comma inside parentheses', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE a IN (1, '), null);
        assert.strictEqual(detectExpressionPosition('SELECT CONCAT(a, '), null);
    });

    test('after an alias dot', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t u WHERE u.'), null);
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t u WHERE u.na'), null);
    });

    test('inside a string literal', () => {
        assert.strictEqual(detectExpressionPosition("SELECT * FROM t WHERE a = 'abc "), null);
    });

    test('inside a line comment', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE id -- note '), null);
    });

    test('inside an unclosed block comment', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE id /* note '), null);
    });

    test('on the line after a line comment the position is detected normally', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE id -- note\n '), 'after-operand');
    });

    test('after a closed block comment the position is detected normally', () => {
        assert.strictEqual(detectExpressionPosition('SELECT * FROM t WHERE id /* note */ '), 'after-operand');
    });

    test('for an empty text', () => {
        assert.strictEqual(detectExpressionPosition(''), null);
    });
});
