import * as assert from 'assert';
import { SqlUtil } from '../sql/SqlUtil.js';

suite('SqlUtil.isDDL', () => {
    test('detects CREATE/ALTER/DROP/TRUNCATE/RENAME', () => {
        assert.strictEqual(SqlUtil.isDDL('CREATE TABLE t (id INT)'), true);
        assert.strictEqual(SqlUtil.isDDL('alter table t add column x int'), true);
        assert.strictEqual(SqlUtil.isDDL('DROP TABLE t'), true);
        assert.strictEqual(SqlUtil.isDDL('truncate table t'), true);
        assert.strictEqual(SqlUtil.isDDL('RENAME TABLE a TO b'), true);
    });

    test('does not flag DML/SELECT as DDL', () => {
        assert.strictEqual(SqlUtil.isDDL('SELECT * FROM t'), false);
        assert.strictEqual(SqlUtil.isDDL('UPDATE t SET x = 1'), false);
        assert.strictEqual(SqlUtil.isDDL('INSERT INTO t VALUES (1)'), false);
    });
});

suite('SqlUtil.hasWhereClause / isUpdateOrDelete', () => {
    test('detects UPDATE/DELETE without WHERE', () => {
        assert.strictEqual(SqlUtil.isUpdateOrDelete('UPDATE t SET x = 1'), true);
        assert.strictEqual(SqlUtil.hasWhereClause('UPDATE t SET x = 1'), false);
        assert.strictEqual(SqlUtil.isUpdateOrDelete('DELETE FROM t'), true);
        assert.strictEqual(SqlUtil.hasWhereClause('DELETE FROM t'), false);
    });

    test('recognizes a WHERE clause when present', () => {
        assert.strictEqual(SqlUtil.hasWhereClause('UPDATE t SET x = 1 WHERE id = 5'), true);
        assert.strictEqual(SqlUtil.hasWhereClause('DELETE FROM t WHERE id = 5'), true);
    });

    test('ignores the word "where" inside a string literal or comment', () => {
        // bez prawdziwej klauzuli WHERE (samo słowo w stringu) ma być uznane za jej brak, żeby nie dało się obejść zabezpieczenia literałem
        assert.strictEqual(SqlUtil.hasWhereClause("UPDATE t SET note = 'where is it'"), false);
        assert.strictEqual(SqlUtil.hasWhereClause('DELETE FROM t -- where clause missing'), false);
    });

    test('SELECT is never treated as UPDATE/DELETE', () => {
        assert.strictEqual(SqlUtil.isUpdateOrDelete('SELECT * FROM t'), false);
    });
});

suite('SqlUtil.appendLimit', () => {
    test('appends LIMIT to a plain SELECT without a trailing semicolon', () => {
        assert.strictEqual(SqlUtil.appendLimit('select 1'), 'select 1\nLIMIT 200');
    });

    test('strips the trailing semicolon before appending LIMIT (Linux LF, no trailing newline)', () => {
        assert.strictEqual(SqlUtil.appendLimit('select 1;'), 'select 1\nLIMIT 200');
    });

    test('regression: trailing semicolon + Windows CRLF must not leave "...;\\r\\nLIMIT" (a doubled statement terminator)', () => {
        assert.strictEqual(SqlUtil.appendLimit('select 1;\r\n'), 'select 1\nLIMIT 200');
    });

    test('regression: trailing semicolon + old Mac CR', () => {
        assert.strictEqual(SqlUtil.appendLimit('select 1;\r'), 'select 1\nLIMIT 200');
    });

    test('regression: trailing semicolon + Linux LF', () => {
        assert.strictEqual(SqlUtil.appendLimit('select 1;\n'), 'select 1\nLIMIT 200');
    });

    test('trailing semicolon followed by spaces/tabs, not just newline characters', () => {
        assert.strictEqual(SqlUtil.appendLimit('select 1;   \t'), 'select 1\nLIMIT 200');
    });

    test('does not add LIMIT when the query already has one', () => {
        assert.strictEqual(SqlUtil.appendLimit('select 1 limit 10;\r\n'), 'select 1 limit 10;\r\n');
    });

    test('does not add LIMIT to non-SELECT statements', () => {
        assert.strictEqual(SqlUtil.appendLimit('update t set x = 1;\r\n'), 'update t set x = 1;\r\n');
    });

    test('respects an explicit limit other than the default 200', () => {
        assert.strictEqual(SqlUtil.appendLimit('select 1;\r\n', 50), 'select 1\nLIMIT 50');
    });
});
