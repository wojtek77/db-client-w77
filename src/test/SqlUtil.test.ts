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
        // bez prawdziwej klauzuli WHERE (tylko słowo w stringu) - powinno zostać uznane
        // za BRAK klauzuli WHERE, żeby nie dało się obejść zabezpieczenia literałem
        assert.strictEqual(SqlUtil.hasWhereClause("UPDATE t SET note = 'where is it'"), false);
        assert.strictEqual(SqlUtil.hasWhereClause('DELETE FROM t -- where clause missing'), false);
    });

    test('SELECT is never treated as UPDATE/DELETE', () => {
        assert.strictEqual(SqlUtil.isUpdateOrDelete('SELECT * FROM t'), false);
    });
});
