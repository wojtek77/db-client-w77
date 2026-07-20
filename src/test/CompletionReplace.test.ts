import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCompletions, insertTextOf, labelOf, makeColumn } from './testHelpers.js';

// CompletionReplace — podpowiedzi dla zapytań REPLACE INTO (logika jak w CompletionInsert)

suite('CompletionReplace — table / schema suggestions', () => {

    test('suggests tables and schemas after "REPLACE INTO "', async () => {
        const sql = 'REPLACE INTO ';
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
        const sql = 'REPLACE INTO us';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),   'missing users for "us"');
        assert.ok(!labels.includes('orders'), 'orders should not match "us"');
    });

    test('suggests tables after "REPLACE INTO schema."', async () => {
        const sql = 'REPLACE INTO public.';
        const items = await getCompletions(sql, sql.length, {
            getTables:                (schema) => schema === 'public' ? ['users', 'orders'] : [],
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),  'missing users after REPLACE INTO public.');
        assert.ok(labels.includes('orders'), 'missing orders after REPLACE INTO public.');
    });
});

suite('CompletionReplace — column list in parentheses', () => {

    test('suggests all non-generated columns when cursor is right after the table name', async () => {
        const sql = 'REPLACE INTO users ';
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
        const sql = 'REPLACE INTO users (id, em';
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
});

suite('CompletionReplace — VALUES keyword and default value snippets', () => {

    test('suggests the VALUES keyword right after the closed column list', async () => {
        const sql = 'REPLACE INTO users (id, email) ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('VALUES'), 'expected VALUES keyword suggestion');
    });

    test('suggests a default values-row snippet after "VALUES "', async () => {
        const sql = 'REPLACE INTO users (id, email, created_at) VALUES ';
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
        assert.ok(snippet.includes('NULL'),             'auto_increment column should default to NULL');
        assert.ok(snippet.includes('CURRENT_TIMESTAMP'), 'column with CURRENT_TIMESTAMP default should keep it');
        assert.ok(snippet.includes('email'),             'column without a default should fall back to its own name');
    });
});

suite('CompletionReplace — safety', () => {

    test('suggests nothing while inside an unterminated string literal', async () => {
        const sql = "REPLACE INTO users (id) VALUES ('unterminated";
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
