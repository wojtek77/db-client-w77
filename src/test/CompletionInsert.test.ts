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

suite('CompletionInsert — SET syntax (alternative to (columns) VALUES (...))', () => {

    test('suggests "column = value" snippets right after SET, excluding generated columns', async () => {
        const sql = 'INSERT INTO users SET ';
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
        const sql = 'INSERT INTO users SET em';
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
        const sql = "INSERT INTO users SET email = 'a@a.com', ";
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
        const sql = 'INSERT INTO users SET status = ';
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
        const sql = 'INSERT INTO public.users SET ';
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

suite('CompletionInsert — LOW_PRIORITY / DELAYED / HIGH_PRIORITY / IGNORE modifiers', () => {

    test('suggests modifiers and tables together right after "INSERT "', async () => {
        const sql = 'INSERT ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('LOW_PRIORITY'),  'missing LOW_PRIORITY right after INSERT');
        assert.ok(keywordLabels.includes('DELAYED'),       'missing DELAYED right after INSERT');
        assert.ok(keywordLabels.includes('HIGH_PRIORITY'), 'missing HIGH_PRIORITY right after INSERT');
        assert.ok(keywordLabels.includes('IGNORE'),        'missing IGNORE right after INSERT');
        assert.ok(items.map(labelOf).includes('users'),    'table suggestion should still be offered alongside modifiers');
    });

    test('filters modifiers by the word being typed', async () => {
        const sql = 'INSERT LOW_PRI';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('LOW_PRIORITY'), 'missing LOW_PRIORITY for filter "low_pri"');
        assert.ok(!keywordLabels.includes('DELAYED'),     'DELAYED should not match filter "low_pri"');
        assert.ok(!keywordLabels.includes('IGNORE'),      'IGNORE should not match filter "low_pri"');
    });

    test('does not re-suggest a modifier already present, and hides the other priority modifiers', async () => {
        const sql = 'INSERT LOW_PRIORITY ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(!keywordLabels.includes('LOW_PRIORITY'),  'LOW_PRIORITY should not be suggested twice');
        assert.ok(!keywordLabels.includes('DELAYED'),       'DELAYED is mutually exclusive with LOW_PRIORITY');
        assert.ok(!keywordLabels.includes('HIGH_PRIORITY'), 'HIGH_PRIORITY is mutually exclusive with LOW_PRIORITY');
        assert.ok(keywordLabels.includes('IGNORE'),         'IGNORE should still be offered, it is independent of the priority modifiers');
    });

    test('stops suggesting modifiers once INTO has been typed', async () => {
        const sql = 'INSERT LOW_PRIORITY IGNORE INTO ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.strictEqual(keywordLabels.length, 0, 'no more modifiers should be offered after INTO');
        assert.ok(items.map(labelOf).includes('users'), 'table suggestion should still work after modifiers + INTO');
    });

    test('stops suggesting modifiers once a table name has been typed', async () => {
        const sql = 'INSERT users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [makeColumn('id', 'int', 'PRI')],
        });
        // uwaga: "SET" jest tu legalną, wcześniejszą podpowiedzią (alternatywna składnia INSERT ... SET) - sprawdzamy tylko brak naszych czterech modyfikatorów
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        for (const modifier of ['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE']) {
            assert.ok(!keywordLabels.includes(modifier), `${modifier} should not be offered once the table name is already typed`);
        }
    });

    test('still suggests table/schema names for "INSERT IGNORE INTO " despite the modifiers in between', async () => {
        const sql = 'INSERT IGNORE INTO ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => ['analytics'],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),     'missing users after INSERT IGNORE INTO');
        assert.ok(labels.includes('orders'),    'missing orders after INSERT IGNORE INTO');
        assert.ok(labels.includes('analytics'), 'missing analytics schema after INSERT IGNORE INTO');
    });

    test('still resolves the all-columns snippet for "INSERT LOW_PRIORITY INTO users " despite the modifier', async () => {
        const sql = 'INSERT LOW_PRIORITY INTO users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI', 'auto_increment'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.some(label => label.startsWith('(') && label.includes('email')), 'missing all-columns snippet after modifier + INTO');
    });

    test('still resolves individual columns inside parentheses for "INSERT DELAYED INTO users (id, em" despite the modifier', async () => {
        const sql = 'INSERT DELAYED INTO users (id, em';
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

    test('modifier keyword carries documentation', async () => {
        const sql = 'INSERT ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const ignoreItem = items.find(i => i.kind === vscode.CompletionItemKind.Keyword && labelOf(i) === 'IGNORE');
        assert.ok(ignoreItem, 'missing IGNORE keyword item');
        assert.ok(ignoreItem!.documentation, 'IGNORE keyword item should carry documentation');
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
