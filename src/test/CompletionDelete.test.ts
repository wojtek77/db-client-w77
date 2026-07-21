import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCompletions, labelOf, makeColumn } from './testHelpers.js';

// CompletionDelete — podpowiedzi dla zapytań DELETE

suite('CompletionDelete — table / schema suggestions (before WHERE)', () => {

    test('suggests tables and schemas after "DELETE FROM "', async () => {
        const sql = 'DELETE FROM ';
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
        const sql = 'DELETE FROM us';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),   'missing users for "us"');
        assert.ok(!labels.includes('orders'), 'orders should not match "us"');
    });

    test('suggests tables after "DELETE FROM schema."', async () => {
        const sql = 'DELETE FROM public.';
        const items = await getCompletions(sql, sql.length, {
            getTables:                (schema) => schema === 'public' ? ['users', 'orders'] : [],
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),  'missing users after DELETE FROM public.');
        assert.ok(labels.includes('orders'), 'missing orders after DELETE FROM public.');
    });

    test('ignores modifiers like LOW_PRIORITY / QUICK / IGNORE when suggesting tables', async () => {
        const sql = 'DELETE LOW_PRIORITY QUICK IGNORE FROM ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'), 'missing users after DELETE LOW_PRIORITY QUICK IGNORE FROM');
    });
});

suite('CompletionDelete — WHERE clause', () => {

    test('suggests columns after an alias with a dot (u.) in WHERE', async () => {
        const sql = 'DELETE FROM users u WHERE u.';
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

    test('suggests columns of the target table without an alias in WHERE', async () => {
        const sql = 'DELETE FROM users WHERE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id in WHERE without alias');
        assert.ok(labels.includes('email'), 'missing email in WHERE without alias');
    });

    test('filters columns in WHERE by the typed prefix', async () => {
        const sql = 'DELETE FROM users WHERE em';
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

    // regresja: stare `beforeCursorLower.lastIndexOf('from')` łapało się na "from" jako podciąg wewnątrz
    // kolumny "from_date", przez co WHERE z taką kolumną było mylone z kontekstem tabel po FROM
    test('does not misdetect WHERE as FROM when a column name contains "from" as a substring (from_date)', async () => {
        const sql = "DELETE FROM users WHERE from_date > '2020-01-01' AND ";
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',        'int', 'PRI'),
                makeColumn('from_date', 'datetime'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'), 'expected column suggestions in WHERE despite "from_date" containing "from"');
    });
});

suite('CompletionDelete — JOIN', () => {

    test('suggests columns from both tables after JOIN, in WHERE', async () => {
        const sql = 'DELETE o FROM orders o INNER JOIN users u ON o.user_id = u.id WHERE ';
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
        assert.ok(labels.includes('total'), 'missing total from orders');
        assert.ok(labels.includes('email'), 'missing email from users');
    });

    test('suggests columns after an alias inside the JOIN...ON clause', async () => {
        const sql = 'DELETE o FROM orders o INNER JOIN users u ON u.';
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

suite('CompletionDelete — multi-table DELETE (comma-separated)', () => {

    test('suggests columns from all comma-separated tables in WHERE', async () => {
        const sql = 'DELETE client, student FROM client, student WHERE ';
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

suite('CompletionDelete — safety', () => {

    test('suggests nothing while inside an unterminated string literal', async () => {
        const sql = "DELETE FROM users WHERE email = 'unterminated";
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
