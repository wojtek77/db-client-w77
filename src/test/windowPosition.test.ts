import * as assert from 'assert';
import { detectWindowPosition } from '../sql/windowPosition.js';

suite('detectWindowPosition - after a window function', () => {
    test('right after ROW_NUMBER()', () => {
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() '), 'after-window-function');
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER()'), 'after-window-function');
    });

    test('right after other window functions with arguments', () => {
        assert.strictEqual(detectWindowPosition('SELECT LAG(price, 1, 0) '), 'after-window-function');
        assert.strictEqual(detectWindowPosition('SELECT NTILE(4) '), 'after-window-function');
        assert.strictEqual(detectWindowPosition('SELECT RANK() '), 'after-window-function');
    });

    test('after an aggregate, which can also be used as a window function', () => {
        assert.strictEqual(detectWindowPosition('SELECT SUM(amount) '), 'after-window-function');
        assert.strictEqual(detectWindowPosition('SELECT COUNT(*) '), 'after-window-function');
    });

    test('after a comma-separated list element and a partly typed word', () => {
        assert.strictEqual(detectWindowPosition('SELECT *, ROW_NUMBER() OV'), 'after-window-function');
        assert.strictEqual(detectWindowPosition('SELECT id,\n    ROW_NUMBER() '), 'after-window-function');
    });

    test('not after a function that cannot take OVER', () => {
        assert.strictEqual(detectWindowPosition('SELECT FIELD(id, 1, 2) '), null);
        assert.strictEqual(detectWindowPosition('SELECT CONCAT(a, b) '), null);
    });

    test('not after a parenthesised expression or a subquery without a function name', () => {
        assert.strictEqual(detectWindowPosition('SELECT (a + b) '), null);
        assert.strictEqual(detectWindowPosition('SELECT x IN (1, 2) '), null);
    });

    test('not after the closing parenthesis of OVER (...) itself', () => {
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (ORDER BY id) '), null);
    });

    test('not inside a string or a comment', () => {
        assert.strictEqual(detectWindowPosition("SELECT 'ROW_NUMBER() "), null);
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() -- '), null);
    });
});

suite('detectWindowPosition - inside OVER (...)', () => {
    test('right after the opening parenthesis', () => {
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER ('), 'window-spec-start');
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER(\n    '), 'window-spec-start');
    });

    test('with a partly typed word', () => {
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (PAR'), 'window-spec-start');
    });

    test('after a PARTITION BY list', () => {
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (PARTITION BY dept '), 'window-spec-after-partition');
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (PARTITION BY dept, team '), 'window-spec-after-partition');
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (PARTITION BY dept O'), 'window-spec-after-partition');
    });

    test('after a PARTITION BY expression ending with a function call', () => {
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (PARTITION BY LOWER(dept) '), 'window-spec-after-partition');
    });

    test('nothing right after PARTITION BY or after a comma', () => {
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (PARTITION BY '), null);
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (PARTITION BY dept, '), null);
    });

    test('nothing once ORDER BY is already there', () => {
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (PARTITION BY dept ORDER BY id '), null);
        assert.strictEqual(detectWindowPosition('SELECT ROW_NUMBER() OVER (ORDER BY id '), null);
    });

    test('nothing inside a function call nested in the window specification', () => {
        assert.strictEqual(detectWindowPosition("SELECT ROW_NUMBER() OVER (PARTITION BY dept ORDER BY FIELD("), null);
        assert.strictEqual(detectWindowPosition("SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY FIELD(type, 'x') "), null);
    });

    test('nothing in a parenthesis that does not belong to OVER', () => {
        assert.strictEqual(detectWindowPosition('SELECT * FROM t WHERE x IN ('), null);
        assert.strictEqual(detectWindowPosition('SELECT COUNT('), null);
    });
});
