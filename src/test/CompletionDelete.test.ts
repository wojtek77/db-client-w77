import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCompletions, labelOf, makeColumn, makeIndex } from './testHelpers.js';

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

    // regresja: 'right'/'outer'/'cross'/'straight_join' brakowały w FORBIDDEN_KEYWORDS
    test('resets the filter (does not treat as text) after RIGHT keyword', async () => {
        const sql = 'DELETE FROM orders o RIGHT ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'clients'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),   'missing users after RIGHT (should not be filtered by "right")');
        assert.ok(labels.includes('clients'), 'missing clients after RIGHT (should not be filtered by "right")');
    });
});

suite('CompletionDelete — LOW_PRIORITY / QUICK / IGNORE modifiers', () => {

    test('suggests all three modifiers and tables together right after "DELETE "', async () => {
        const sql = 'DELETE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('LOW_PRIORITY'), 'missing LOW_PRIORITY right after DELETE');
        assert.ok(keywordLabels.includes('QUICK'),        'missing QUICK right after DELETE');
        assert.ok(keywordLabels.includes('IGNORE'),       'missing IGNORE right after DELETE');
        assert.ok(items.map(labelOf).includes('users'),  'table suggestion should still be offered alongside modifiers');
    });

    test('filters modifiers by the word being typed', async () => {
        const sql = 'DELETE LOW_PRI';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('LOW_PRIORITY'), 'missing LOW_PRIORITY for filter "low_pri"');
        assert.ok(!keywordLabels.includes('QUICK'),       'QUICK should not match filter "low_pri"');
        assert.ok(!keywordLabels.includes('IGNORE'),      'IGNORE should not match filter "low_pri"');
    });

    test('does not re-suggest a modifier already present, but keeps offering the independent ones', async () => {
        const sql = 'DELETE LOW_PRIORITY ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(!keywordLabels.includes('LOW_PRIORITY'), 'LOW_PRIORITY should not be suggested twice');
        assert.ok(keywordLabels.includes('QUICK'),         'QUICK should still be offered, it is independent of LOW_PRIORITY');
        assert.ok(keywordLabels.includes('IGNORE'),        'IGNORE should still be offered, it is independent of LOW_PRIORITY');
    });

    test('stops suggesting modifiers once FROM has been typed', async () => {
        const sql = 'DELETE LOW_PRIORITY QUICK IGNORE FROM ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.strictEqual(keywordLabels.length, 0, 'no more modifiers should be offered after FROM');
        assert.ok(items.map(labelOf).includes('users'), 'table suggestion should still work after modifiers + FROM');
    });

    // regresja analogiczna do CompletionUpdate: kursor na nowej linii przed samym wcięciem, z dalszą treścią zapytania PO kursorze
    test('suggests modifiers and tables when the cursor is on a new line with only indentation before it', async () => {
        const sql = 'DELETE\n    IGNORE\n    FROM users';
        const cursorOffset = 'DELETE\n    '.length; // tuż przed "IGNORE"
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('IGNORE'), 'missing IGNORE when cursor is on a new indented line right after DELETE');
        assert.ok(items.map(labelOf).includes('users'), 'missing users table when cursor is on a new indented line right after DELETE');
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

    // regresja: stare `lastIndexOf('from')` łapało się na "from" wewnątrz kolumny "from_date", mylącej to z FROM
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

// regresja: REGEX_ALIAS_DOT łapał tylko kursor tuż po kropce (`c.|`), a nie po wpisanej już nazwie kolumny (`c.id|`)
suite('CompletionDelete — alias dot with a partially/fully typed column name', () => {

    test('suggests columns after alias + full column name in JOIN...ON (c.id)', async () => {
        const sql = 'DELETE s FROM student s JOIN client c ON c.id';
        const items = await getCompletions(sql, sql.length, { getDatabase: () => 'public' }, {
            'public.student': [makeColumn('client_id', 'int')],
            'public.client':  [makeColumn('id', 'int', 'PRI'), makeColumn('agency_id', 'int')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),        'missing id after "c.id" in JOIN...ON');
        assert.ok(labels.includes('agency_id'), 'missing agency_id after "c.id" in JOIN...ON');
    });

    test('filters columns after alias + partial column name in JOIN...ON (c.ag)', async () => {
        const sql = 'DELETE s FROM student s JOIN client c ON c.ag';
        const items = await getCompletions(sql, sql.length, { getDatabase: () => 'public' }, {
            'public.student': [makeColumn('client_id', 'int')],
            'public.client':  [makeColumn('id', 'int', 'PRI'), makeColumn('agency_id', 'int')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('agency_id'), 'missing agency_id for "c.ag" filter');
        assert.ok(!labels.includes('id'),       'id should not match "c.ag" filter');
    });

    test('suggests columns after alias + full column name in WHERE (u.id)', async () => {
        const sql = 'DELETE FROM users u WHERE u.id';
        const items = await getCompletions(sql, sql.length, { getDatabase: () => 'public' }, {
            'public.users': [makeColumn('id', 'int', 'PRI'), makeColumn('email', 'varchar')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id after "u.id" in WHERE');
        assert.ok(!labels.includes('email'), 'email should not match "u.id" filter in WHERE');
    });
});

suite('CompletionDelete — index hints (USE/FORCE/IGNORE INDEX)', () => {

    // single-table DELETE ("DELETE FROM tbl ...") nie wspiera index hintów w MySQL - to błąd składni, więc podpowiedzi nie mogą się tu pojawić
    test('does not suggest index hints in a single-table DELETE (DELETE FROM tbl)', async () => {
        const sql = 'DELETE FROM users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(!labels.includes('USE INDEX'),    'USE INDEX should not be suggested in a single-table DELETE');
        assert.ok(!labels.includes('FORCE INDEX'),  'FORCE INDEX should not be suggested in a single-table DELETE');
        assert.ok(!labels.includes('IGNORE INDEX'), 'IGNORE INDEX should not be suggested in a single-table DELETE');
    });

    test('does not suggest index hints in a single-table DELETE with modifiers', async () => {
        const sql = 'DELETE LOW_PRIORITY QUICK FROM users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(!labels.includes('USE INDEX'), 'USE INDEX should not be suggested in a single-table DELETE, even with modifiers');
    });

    // wielotabelowy DELETE ("DELETE o FROM orders o ...") WSPIERA index hinty w MySQL, bo klauzula FROM ma tam identyczną gramatykę table_references co w SELECT
    test('suggests USE/FORCE/IGNORE INDEX right after the table name in a multi-table DELETE', async () => {
        const sql = 'DELETE o FROM orders o ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('USE INDEX'),    'missing USE INDEX in a multi-table DELETE');
        assert.ok(labels.includes('FORCE INDEX'),  'missing FORCE INDEX in a multi-table DELETE');
        assert.ok(labels.includes('IGNORE INDEX'), 'missing IGNORE INDEX in a multi-table DELETE');
    });

    test('filters index hint keywords to the typed prefix in a multi-table DELETE', async () => {
        const sql = 'DELETE o FROM orders o FOR';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('FORCE INDEX'),   'missing FORCE INDEX for "FOR"');
        assert.ok(!labels.includes('USE INDEX'),    'USE INDEX should not match "FOR"');
        assert.ok(!labels.includes('IGNORE INDEX'), 'IGNORE INDEX should not match "FOR"');
    });

    test('suggests USE/FORCE/IGNORE INDEX after a JOIN-ed table in a multi-table DELETE', async () => {
        const sql = 'DELETE o FROM orders o INNER JOIN users u ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('USE INDEX'),   'missing USE INDEX after a JOIN-ed table');
        assert.ok(labels.includes('FORCE INDEX'), 'missing FORCE INDEX after a JOIN-ed table');
    });

    test('suggests USE/FORCE/IGNORE INDEX after a comma-separated table in a multi-table DELETE', async () => {
        const sql = 'DELETE client, student FROM client c, student s ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('USE INDEX'),   'missing USE INDEX after a comma-separated table');
        assert.ok(labels.includes('FORCE INDEX'), 'missing FORCE INDEX after a comma-separated table');
    });

    test('suggests real index names inside USE INDEX (...) in a multi-table DELETE', async () => {
        const sql = 'DELETE o FROM orders o USE INDEX (';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:       () => 'public',
            findSchemaByTable: () => 'public',
        }, {}, undefined, {
            'public.orders': [
                makeIndex('PRIMARY'),
                makeIndex('idx_created_at'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('PRIMARY'),        'missing PRIMARY index');
        assert.ok(labels.includes('idx_created_at'), 'missing idx_created_at');
    });

    test('suggests real index names inside FORCE INDEX (...) after a JOIN-ed table in DELETE', async () => {
        const sql = 'DELETE o FROM orders o INNER JOIN users u FORCE INDEX (';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:       () => 'public',
            findSchemaByTable: () => 'public',
        }, {}, undefined, {
            'public.users': [makeIndex('idx_email')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('idx_email'), 'missing idx_email for the JOIN-ed table (users)');
    });

    test('does not suggest index hints inside USE INDEX (...) for a single-table DELETE', async () => {
        // to nie powinno się nigdy pojawić w edytorze (składniowo niepoprawne), ale sprawdzamy, że isMultiTableDelete blokuje to poprawnie
        const sql = 'DELETE FROM orders USE INDEX (';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:       () => 'public',
            findSchemaByTable: () => 'public',
        }, {}, undefined, {
            'public.orders': [makeIndex('idx_x')],
        });
        const labels = items.map(labelOf);
        assert.ok(!labels.includes('idx_x'), 'index names should not be suggested in a single-table DELETE');
    });

    // regresja: gdy kilka tabel ma własny "USE INDEX (...)" naraz, wcześniejsze łączenie regexów przez ?? zawsze
    // wygrywało dopasowanie dla PIERWSZEJ tabeli, nawet gdy kursor był w nawiasie kolejnej, dalszej tabeli
    test('resolves the correct table when multiple comma-separated tables each have their own index hint', async () => {
        const sql = 'DELETE aaa, bbb\nFROM aaa USE INDEX (), bbb USE INDEX (';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:       () => 'public',
            findSchemaByTable: () => 'public',
        }, {}, undefined, {
            'public.aaa': [makeIndex('idx_aaa')],
            'public.bbb': [makeIndex('idx_bbb')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('idx_bbb'), 'missing idx_bbb - cursor is inside the second table\'s parens');
        assert.ok(!labels.includes('idx_aaa'), 'idx_aaa should not be suggested - cursor is not inside its parens');
    });

    test('does not suggest index hints once past WHERE in a multi-table DELETE', async () => {
        const sql = 'DELETE o FROM orders o WHERE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(!labels.includes('USE INDEX'),   'USE INDEX should not be suggested once past WHERE');
        assert.ok(!labels.includes('FORCE INDEX'), 'FORCE INDEX should not be suggested once past WHERE');
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
