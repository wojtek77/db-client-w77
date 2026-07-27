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
        assert.strictEqual(items.length, 2, 'expected the column-list snippet plus the SET keyword');
        const snippetItem = items.find(item => labelOf(item).startsWith('('));
        assert.ok(snippetItem, 'missing column-list snippet');
        const label = labelOf(snippetItem!);
        assert.ok(label.includes('id'),    'missing id in column list');
        assert.ok(label.includes('email'), 'missing email in column list');
        assert.ok(!label.includes('full_name'), 'generated column full_name should be excluded');

        const setItem = items.find(item => labelOf(item) === 'SET');
        assert.ok(setItem, 'missing SET keyword suggestion');
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

suite('CompletionReplace — SET syntax (alternative to (columns) VALUES (...))', () => {

    test('suggests "column = value" snippets right after SET, excluding generated columns', async () => {
        const sql = 'REPLACE INTO users SET ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',        'int',     'PRI', 'auto_increment'),
                makeColumn('email',     'varchar'),
                makeColumn('full_name', 'varchar', '',    'generated'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id in SET column suggestions');
        assert.ok(labels.includes('email'), 'missing email in SET column suggestions');
        assert.ok(!labels.includes('full_name'), 'generated column full_name should be excluded from SET');

        const idItem = items.find(i => labelOf(i) === 'id')!;
        assert.ok(insertTextOf(idItem).startsWith('id = '), 'expected "id = " snippet prefix');
        assert.ok(insertTextOf(idItem).includes('NULL'), 'auto_increment column should default to NULL');
    });

    test('filters SET column suggestions by the typed prefix', async () => {
        const sql = 'REPLACE INTO users SET em';
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

    test('suggests a second column after a comma, keeping the "column = value" snippet', async () => {
        const sql = "REPLACE INTO users SET email = 'a@a.com', ";
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('email',      'varchar'),
                makeColumn('created_at', 'datetime', '', '', 'CURRENT_TIMESTAMP'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('created_at'), 'missing created_at as second SET column');

        const createdAtItem = items.find(i => labelOf(i) === 'created_at')!;
        assert.ok(insertTextOf(createdAtItem).includes('CURRENT_TIMESTAMP'), 'column with CURRENT_TIMESTAMP default should keep it');
    });

    test('does not override insertText with a snippet once the cursor is right after "="', async () => {
        const sql = 'REPLACE INTO users SET status = ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('status', 'varchar'),
            ],
        });
        const statusItem = items.find(i => labelOf(i) === 'status')!;
        assert.ok(statusItem, 'missing status column suggestion');
        assert.strictEqual(insertTextOf(statusItem), 'status', 'expected plain column name insertText, no "column = value" snippet, once "=" was already typed');
    });

    test('works with a schema-qualified table name', async () => {
        const sql = 'REPLACE INTO public.users SET ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'analytics',
        }, {
            'public.users': [
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('email'), 'missing email for schema-qualified table in SET clause');
    });
});

suite('CompletionReplace — LOW_PRIORITY / DELAYED modifiers', () => {

    test('suggests both modifiers and tables together right after "REPLACE "', async () => {
        const sql = 'REPLACE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('LOW_PRIORITY'), 'missing LOW_PRIORITY right after REPLACE');
        assert.ok(keywordLabels.includes('DELAYED'),      'missing DELAYED right after REPLACE');
        assert.ok(items.map(labelOf).includes('users'),  'table suggestion should still be offered alongside modifiers');
    });

    test('filters modifiers by the word being typed', async () => {
        const sql = 'REPLACE LOW_PRI';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('LOW_PRIORITY'), 'missing LOW_PRIORITY for filter "low_pri"');
        assert.ok(!keywordLabels.includes('DELAYED'),     'DELAYED should not match filter "low_pri"');
    });

    test('hides both modifiers once one of them was already typed, since they are mutually exclusive', async () => {
        const sql = 'REPLACE LOW_PRIORITY ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(!keywordLabels.includes('LOW_PRIORITY'), 'LOW_PRIORITY should not be suggested twice');
        assert.ok(!keywordLabels.includes('DELAYED'),      'DELAYED is mutually exclusive with LOW_PRIORITY');
    });

    test('stops suggesting modifiers once INTO has been typed', async () => {
        const sql = 'REPLACE LOW_PRIORITY INTO ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.strictEqual(keywordLabels.length, 0, 'no more modifiers should be offered after INTO');
        assert.ok(items.map(labelOf).includes('users'), 'table suggestion should still work after modifier + INTO');
    });

    test('stops suggesting modifiers once a table name has been typed', async () => {
        const sql = 'REPLACE users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [makeColumn('id', 'int', 'PRI')],
        });
        // uwaga: "SET" jest tu legalną, wcześniejszą podpowiedzią (alternatywna składnia REPLACE ... SET) - sprawdzamy tylko brak naszych modyfikatorów
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        for (const modifier of ['LOW_PRIORITY', 'DELAYED']) {
            assert.ok(!keywordLabels.includes(modifier), `${modifier} should not be offered once the table name is already typed`);
        }
    });

    test('still resolves individual columns inside parentheses for "REPLACE DELAYED INTO users (id, em" despite the modifier', async () => {
        const sql = 'REPLACE DELAYED INTO users (id, em';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('email'), 'missing email suggestion inside parentheses after modifier + INTO');
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
