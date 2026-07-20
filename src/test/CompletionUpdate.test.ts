import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCompletions, labelOf, makeColumn } from './testHelpers.js';

// CompletionUpdate — podpowiedzi dla zapytań UPDATE

suite('CompletionUpdate — table / schema suggestions (before SET)', () => {

    test('suggests tables and schemas after "UPDATE "', async () => {
        const sql = 'UPDATE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => ['public', 'analytics'],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),     'missing users');
        assert.ok(labels.includes('orders'),    'missing orders');
        assert.ok(labels.includes('public'),    'missing public schema');
        assert.ok(labels.includes('analytics'), 'missing analytics schema');
    });

    test('filters tables to the typed prefix', async () => {
        const sql = 'UPDATE us';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),   'missing users for "us"');
        assert.ok(!labels.includes('orders'), 'orders should not match "us"');
    });

    test('suggests tables after "UPDATE schema."', async () => {
        // regresja: `!linePrefix.match(REGEX_ALIAS_DOT)` blokował tę gałąź też dla samego 'schema.' – poprawiono jak w CompletionDelete.ts
        const sql = 'UPDATE public.';
        const items = await getCompletions(sql, sql.length, {
            getTables:                (schema) => schema === 'public' ? ['users', 'orders'] : [],
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),  'missing users after UPDATE public.');
        assert.ok(labels.includes('orders'), 'missing orders after UPDATE public.');
    });

    test('filters tables after "UPDATE schema." by the typed prefix', async () => {
        const sql = 'UPDATE public.us';
        const items = await getCompletions(sql, sql.length, {
            getTables: (schema) => schema === 'public' ? ['users', 'orders'] : [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),   'missing users for "public.us"');
        assert.ok(!labels.includes('orders'), 'orders should not match "public.us"');
    });

    test('ignores modifiers like LOW_PRIORITY / IGNORE when suggesting tables', async () => {
        const sql = 'UPDATE LOW_PRIORITY IGNORE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'), 'missing users after UPDATE LOW_PRIORITY IGNORE');
    });
});

suite('CompletionUpdate — SET clause', () => {

    test('suggests columns after an alias with a dot (t1.) in SET', async () => {
        const sql = 'UPDATE users u SET u.';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id after alias in SET');
        assert.ok(labels.includes('email'), 'missing email after alias in SET');
    });

    test('suggests columns of the target table without an alias in SET', async () => {
        const sql = 'UPDATE users SET ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id in SET without alias');
        assert.ok(labels.includes('email'), 'missing email in SET without alias');
    });

    test('filters columns in SET by the typed prefix', async () => {
        const sql = 'UPDATE users SET em';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('email'), 'missing email for "em" filter');
        assert.ok(!labels.includes('id'),   'id should not match "em"');
    });
});

suite('CompletionUpdate — JOIN', () => {

    test('suggests columns from both tables after JOIN, in SET', async () => {
        const sql = 'UPDATE orders o INNER JOIN users u ON o.user_id = u.id SET ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.orders': [
                makeColumn('id',      'int'),
                makeColumn('user_id', 'int'),
            ],
            'public.users': [
                makeColumn('id',    'int'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('user_id'), 'missing user_id from orders');
        assert.ok(labels.includes('email'),   'missing email from users');
    });

    test('suggests columns after an alias inside the JOIN...ON clause', async () => {
        const sql = 'UPDATE orders o INNER JOIN users u ON u.';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.orders': [
                makeColumn('id', 'int'),
            ],
            'public.users': [
                makeColumn('id',    'int'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id after alias in JOIN...ON');
        assert.ok(labels.includes('email'), 'missing email after alias in JOIN...ON');
    });
});

suite('CompletionUpdate — multi-table UPDATE (comma-separated)', () => {

    test('suggests columns from all comma-separated tables in SET', async () => {
        const sql = 'UPDATE client c, student s SET ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.client': [
                makeColumn('agency_id', 'int'),
            ],
            'public.student': [
                makeColumn('grade', 'int'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('agency_id'), 'missing agency_id from client');
        assert.ok(labels.includes('grade'),     'missing grade from student');
    });
});

suite('CompletionUpdate — WHERE clause', () => {

    test('suggests columns after an alias with a dot (u.) in WHERE', async () => {
        const sql = 'UPDATE users u SET u.email = 1 WHERE u.';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
                makeColumn('age',   'int'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id in WHERE');
        assert.ok(labels.includes('email'), 'missing email in WHERE');
        assert.ok(labels.includes('age'),   'missing age in WHERE');
    });

    test('suggests columns from all tables at a free position in WHERE (e.g. after AND)', async () => {
        const sql = 'UPDATE orders o INNER JOIN users u ON o.user_id = u.id SET o.total = 1 WHERE u.id = 1 AND ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.orders': [
                makeColumn('id',    'int'),
                makeColumn('total', 'decimal'),
            ],
            'public.users': [
                makeColumn('id',    'int'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('total'), 'missing total from orders after AND');
        assert.ok(labels.includes('email'), 'missing email from users after AND');
    });
});

suite('CompletionUpdate — safety', () => {

    test('suggests nothing while inside an unterminated string literal', async () => {
        const sql = "UPDATE users SET email = 'unterminated";
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('email', 'varchar'),
            ],
        });
        assert.strictEqual(items.length, 0, 'expected no suggestions inside an open string literal');
    });
});
