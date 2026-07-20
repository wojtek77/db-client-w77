import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCompletions, insertTextOf, labelOf, makeColumn } from './testHelpers.js';

// CompletionInsert — podpowiedzi dla zapytań INSERT

suite('CompletionInsert — table / schema suggestions', () => {

    test('suggests tables and schemas after "INSERT INTO "', async () => {
        const sql = 'INSERT INTO ';
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
        const sql = 'INSERT INTO us';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),   'missing users for "us"');
        assert.ok(!labels.includes('orders'), 'orders should not match "us"');
    });

    test('suggests tables after "INSERT INTO schema."', async () => {
        const sql = 'INSERT INTO public.';
        const items = await getCompletions(sql, sql.length, {
            getTables:                (schema) => schema === 'public' ? ['users', 'orders'] : [],
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),  'missing users after INSERT INTO public.');
        assert.ok(labels.includes('orders'), 'missing orders after INSERT INTO public.');
    });
});

suite('CompletionInsert — column list in parentheses', () => {

    test('suggests all non-generated columns when cursor is right after the table name', async () => {
        const sql = 'INSERT INTO users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',        'int',     'PRI', 'auto_increment'),
                makeColumn('email',     'varchar'),
                makeColumn('full_name', 'varchar', '',    'generated'),
            ],
        });
        assert.strictEqual(items.length, 1, 'expected exactly one snippet suggestion');
        const label = labelOf(items[0]);
        assert.ok(label.includes('id'),    'missing id in column list');
        assert.ok(label.includes('email'), 'missing email in column list');
        assert.ok(!label.includes('full_name'), 'generated column full_name should be excluded');
    });

    test('suggests individual columns inside parentheses, filtered by typed prefix', async () => {
        const sql = 'INSERT INTO users (id, em';
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
        assert.ok(labels.includes('email'), 'missing email for "em" filter');
        assert.ok(!labels.includes('age'),  'age should not match "em"');
    });

    test('excludes generated columns inside parentheses', async () => {
        const sql = 'INSERT INTO users (';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',        'int',     'PRI'),
                makeColumn('full_name', 'varchar', '', 'generated'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),         'missing id');
        assert.ok(!labels.includes('full_name'), 'generated column should not be suggested');
    });
});

suite('CompletionInsert — VALUES keyword and default value snippets', () => {

    test('suggests the VALUES keyword right after the closed column list', async () => {
        const sql = 'INSERT INTO users (id, email) ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('VALUES'), 'expected VALUES keyword suggestion');
    });

    test('suggests a default values-row snippet after "VALUES "', async () => {
        const sql = 'INSERT INTO users (id, email, created_at) VALUES ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',         'int',      'PRI', 'auto_increment'),
                makeColumn('email',      'varchar',  '',    '', null, 'NO'),
                makeColumn('created_at', 'datetime', '',    '', 'CURRENT_TIMESTAMP'),
            ],
        });
        assert.strictEqual(items.length, 1, 'expected exactly one values-row snippet');
        const snippet = insertTextOf(items[0]);
        assert.ok(snippet.includes('NULL'),              'auto_increment column should default to NULL');
        assert.ok(snippet.includes('CURRENT_TIMESTAMP'),  'column with CURRENT_TIMESTAMP default should keep it');
        assert.ok(snippet.includes('email'),              'column without a default should fall back to its own name');
    });

    test('fills nullable columns without a default with NULL', async () => {
        const sql = 'INSERT INTO users (nickname) VALUES ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('nickname', 'varchar', '', '', null, 'YES'),
            ],
        });
        const snippet = insertTextOf(items[0]);
        assert.ok(snippet.includes('NULL'), 'nullable column without default should default to NULL');
    });

    test('fills numeric columns without a default with 0', async () => {
        const sql = 'INSERT INTO users (age) VALUES ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('age', 'int', '', '', null, 'NO'),
            ],
        });
        const snippet = insertTextOf(items[0]);
        assert.ok(snippet.includes('0'), 'numeric not-null column without default should default to 0');
    });

    test('fills date columns without a default with a zero date placeholder', async () => {
        const sql = 'INSERT INTO users (birth_date) VALUES ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('birth_date', 'date', '', '', null, 'NO'),
            ],
        });
        const snippet = insertTextOf(items[0]);
        assert.ok(snippet.includes('0000-00-00'), 'date column without default should use zero-date placeholder');
    });

    test('fills enum columns with the first enum value', async () => {
        const sql = 'INSERT INTO users (status) VALUES ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                { ...makeColumn('status', 'enum', '', '', null, 'NO'), columnType: "enum('active','inactive')" },
            ],
        });
        const snippet = insertTextOf(items[0]);
        assert.ok(snippet.includes('active'), 'enum column should suggest the first enum value');
    });
});

suite('CompletionInsert — ON DUPLICATE KEY UPDATE', () => {

    test('suggests columns to update, with a "col = VALUES(col)" snippet', async () => {
        // regresja: `.trim()` ucinało spację po 'UPDATE ' gdy zapytanie kończyło dokument, więc REGEX_ON_DUPLICATE_CONTEXT nie łapał kontekstu
        const sql = "INSERT INTO users (id, email) VALUES (1, 'a@a.com') ON DUPLICATE KEY UPDATE ";
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI', 'auto_increment'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('email'), 'missing email in ON DUPLICATE KEY UPDATE');

        const emailItem = items.find(i => labelOf(i) === 'email')!;
        assert.ok(
            insertTextOf(emailItem).includes('VALUES('),
            'expected "email = VALUES(email)" style snippet',
        );
    });

    test('suggests filtered columns inside VALUES(...) in the UPDATE part', async () => {
        const sql = "INSERT INTO users (id, email) VALUES (1, 'a@a.com') ON DUPLICATE KEY UPDATE email = VALUES(em";
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI', 'auto_increment'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('email'), 'missing email inside VALUES(...) filter');
    });
});

suite('CompletionInsert — safety', () => {

    test('suggests nothing while inside an unterminated string literal', async () => {
        const sql = "INSERT INTO users (id) VALUES ('unterminated";
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id', 'int', 'PRI'),
            ],
        });
        assert.strictEqual(items.length, 0, 'expected no suggestions inside an open string literal');
    });
});
