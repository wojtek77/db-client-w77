import * as assert from 'assert';
import { detectTableRefPosition } from '../sql/tableRefPosition.js';

suite('detectTableRefPosition - after a table reference', () => {
    test('right after a table name in FROM, an alias can still follow', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM users '), { canAlias: true, canJoinCondition: false, filter: '' });
    });

    test('after an alias, with or without AS', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM users u '), { canAlias: false, canJoinCondition: false, filter: '' });
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM users AS u '), { canAlias: false, canJoinCondition: false, filter: '' });
    });

    test('after a table joined with JOIN, ON and USING are possible', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a JOIN b '), { canAlias: true, canJoinCondition: true, filter: '' });
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a LEFT JOIN b x '), { canAlias: false, canJoinCondition: true, filter: '' });
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a STRAIGHT_JOIN b '), { canAlias: true, canJoinCondition: true, filter: '' });
    });

    test('after a table following a comma there is no join condition', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a, b '), { canAlias: true, canJoinCondition: false, filter: '' });
    });

    test('after a comma that ends an ON condition there is no join condition either', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a JOIN b ON a.id = b.id, c '), { canAlias: true, canJoinCondition: false, filter: '' });
    });

    test('the second JOIN after an ON condition starts a new table reference', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a JOIN b ON a.id = b.id JOIN c '), { canAlias: true, canJoinCondition: true, filter: '' });
    });

    test('schema-qualified and backtick-quoted names', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM shop.users '), { canAlias: true, canJoinCondition: false, filter: '' });
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM `users` `u` '), { canAlias: false, canJoinCondition: false, filter: '' });
    });

    test('after a derived table with an alias', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM (SELECT 1) x '), { canAlias: false, canJoinCondition: false, filter: '' });
    });

    test('after an index hint', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a JOIN b USE INDEX (i) '), { canAlias: false, canJoinCondition: true, filter: '' });
    });

    test('after USING (...) the join condition is complete', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a JOIN b USING (id) '), { canAlias: false, canJoinCondition: false, filter: '' });
    });

    test('inside a subquery the position is relative to the subquery', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM t WHERE id IN (SELECT id FROM u '), { canAlias: true, canJoinCondition: false, filter: '' });
    });

    test('returns the word being typed as a lowercase filter', () => {
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM users LE'), { canAlias: true, canJoinCondition: false, filter: 'le' });
        assert.deepStrictEqual(detectTableRefPosition('SELECT * FROM a JOIN b O'), { canAlias: true, canJoinCondition: true, filter: 'o' });
    });
});

suite('detectTableRefPosition - positions without table keywords', () => {
    test('where a table name is expected', () => {
        assert.strictEqual(detectTableRefPosition('SELECT * FROM '), null);
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a JOIN '), null);
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a, '), null);
    });

    test('where an alias is expected after AS', () => {
        assert.strictEqual(detectTableRefPosition('SELECT * FROM users AS '), null);
    });

    test('in the middle of a join condition or an index hint', () => {
        assert.strictEqual(detectTableRefPosition('SELECT * FROM users INNER '), null);
        assert.strictEqual(detectTableRefPosition('SELECT * FROM users USING '), null);
        assert.strictEqual(detectTableRefPosition('SELECT * FROM users USE INDEX '), null);
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a JOIN b ON a.id = b.id '), null);
    });

    test('while typing a schema-qualified name', () => {
        assert.strictEqual(detectTableRefPosition('SELECT * FROM shop.'), null);
    });

    test('inside a string literal or an unclosed comment', () => {
        assert.strictEqual(detectTableRefPosition("SELECT * FROM users 'abc "), null);
        assert.strictEqual(detectTableRefPosition('SELECT * FROM users /* note '), null);
    });

    test('without any FROM', () => {
        assert.strictEqual(detectTableRefPosition('SELECT 1 '), null);
        assert.strictEqual(detectTableRefPosition(''), null);
    });
});

suite('detectTableRefPosition - LEFT / RIGHT waiting for JOIN', () => {
    test('after LEFT and RIGHT', () => {
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a LEFT ')?.joinSide, 'side');
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a RIGHT ')?.joinSide, 'side');
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a x JOIN b LEFT ')?.joinSide, 'side');
    });

    test('after LEFT OUTER and RIGHT OUTER', () => {
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a LEFT OUTER ')?.joinSide, 'outer');
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a RIGHT OUTER ')?.joinSide, 'outer');
    });

    test('NATURAL before LEFT changes nothing', () => {
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a NATURAL LEFT ')?.joinSide, 'side');
    });

    test('typed prefix is kept as the filter', () => {
        const position = detectTableRefPosition('SELECT * FROM a LEFT O');
        assert.strictEqual(position?.joinSide, 'side');
        assert.strictEqual(position?.filter, 'o');
    });

    test('no joinSide in other places', () => {
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a ')?.joinSide, undefined);
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a LEFT JOIN b ')?.joinSide, undefined);
        assert.strictEqual(detectTableRefPosition('SELECT * FROM a LEFT OUTER JOIN b ')?.joinSide, undefined);
    });
});
