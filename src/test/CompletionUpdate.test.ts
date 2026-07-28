import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCompletions, labelOf, makeColumn, makeIndex } from './testHelpers.js';

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

    // regresja: 'right'/'outer'/'cross'/'straight_join' brakowały w liście słów kluczowych resetujących filtr
    test('resets the filter (does not treat as text) after RIGHT keyword', async () => {
        const sql = 'UPDATE orders o RIGHT ';
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

suite('CompletionUpdate — LOW_PRIORITY / IGNORE modifiers', () => {

    test('suggests both modifiers and tables together right after "UPDATE "', async () => {
        const sql = 'UPDATE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('LOW_PRIORITY'), 'missing LOW_PRIORITY right after UPDATE');
        assert.ok(keywordLabels.includes('IGNORE'),       'missing IGNORE right after UPDATE');
        assert.ok(items.map(labelOf).includes('users'),  'table suggestion should still be offered alongside modifiers');
    });

    test('filters modifiers by the word being typed', async () => {
        const sql = 'UPDATE LOW_PRI';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('LOW_PRIORITY'), 'missing LOW_PRIORITY for filter "low_pri"');
        assert.ok(!keywordLabels.includes('IGNORE'),      'IGNORE should not match filter "low_pri"');
    });

    test('does not re-suggest a modifier already present, but keeps offering the independent one', async () => {
        const sql = 'UPDATE LOW_PRIORITY ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(!keywordLabels.includes('LOW_PRIORITY'), 'LOW_PRIORITY should not be suggested twice');
        assert.ok(keywordLabels.includes('IGNORE'),        'IGNORE should still be offered, it is independent of LOW_PRIORITY');
    });

    test('stops suggesting modifiers once both are used', async () => {
        const sql = 'UPDATE LOW_PRIORITY IGNORE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.strictEqual(keywordLabels.length, 0, 'no more modifiers should be offered once both are already used');
        assert.ok(items.map(labelOf).includes('users'), 'table suggestion should still work after both modifiers');
    });

    test('stops suggesting UPDATE modifiers once a table name has been typed', async () => {
        // regresja: po nazwie tabeli w tym miejscu poprawnie pojawiają się teraz index hinty (USE/FORCE/IGNORE INDEX,
        // patrz suite "index hints"), więc nie sprawdzamy już braku WSZYSTKICH podpowiedzi typu Keyword, tylko brak
        // konkretnie modyfikatorów LOW_PRIORITY / IGNORE
        const sql = 'UPDATE users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(!keywordLabels.includes('LOW_PRIORITY'), 'LOW_PRIORITY should not be offered once the table name is already typed');
        assert.ok(!keywordLabels.includes('IGNORE'),       'IGNORE should not be offered once the table name is already typed');
    });

    test('does not leak modifier suggestions into the JOIN section of a multi-table UPDATE', async () => {
        const sql = 'UPDATE users u JOIN ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.strictEqual(keywordLabels.length, 0, 'modifiers should never be suggested after JOIN, only right after UPDATE');
        assert.ok(items.map(labelOf).includes('orders'), 'table suggestion should still work after JOIN');
    });

    // regresja: kursor na nowej linii przed samym wcięciem, z dalszą treścią zapytania PO kursorze (np. już wpisane "IGNORE student" + "SET" w kolejnych liniach) -
    // \b na początku REGEX_UPDATE_OBJECT nie dopasowywał pustego stringa (bo linePrefix to samo wcięcie), więc cały blok "przypadek B" był pomijany
    test('suggests modifiers and tables when the cursor is on a new line with only indentation before it', async () => {
        const sql = 'UPDATE\n    IGNORE student\n    SET';
        const cursorOffset = 'UPDATE\n    '.length; // tuż przed "IGNORE"
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['student'],
            getSchemas:               () => [],
        });
        const keywordLabels = items.filter(i => i.kind === vscode.CompletionItemKind.Keyword).map(labelOf);
        assert.ok(keywordLabels.includes('IGNORE'), 'missing IGNORE when cursor is on a new indented line right after UPDATE');
        assert.ok(items.map(labelOf).includes('student'), 'missing student table when cursor is on a new indented line right after UPDATE');
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

    // regresja: updateSetRegex wymagał obecności SET, więc bez SET tabela główna nie trafiała do allTableRefs
    test('suggests columns of the main table alias in JOIN...ON, before SET is typed', async () => {
        const sql = 'UPDATE orders o JOIN users u ON o.';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.orders': [
                makeColumn('id',      'int'),
                makeColumn('user_id', 'int'),
            ],
            'public.users': [
                makeColumn('id', 'int'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),      'missing id from main table alias before SET');
        assert.ok(labels.includes('user_id'), 'missing user_id from main table alias before SET');
    });

    // to samo co wyżej, ale ze schematem w nazwie tabeli głównej (schema.table alias)
    test('suggests columns of the main table alias (with schema) in JOIN...ON, before SET is typed', async () => {
        const sql = 'UPDATE zam_system.zamowienia z JOIN zam_system.klienci k ON z.';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'zam_system',
        }, {
            'zam_system.zamowienia': [
                makeColumn('id',         'int'),
                makeColumn('klient_id',  'int'),
            ],
            'zam_system.klienci': [
                makeColumn('id', 'int'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),        'missing id from zamowienia before SET');
        assert.ok(labels.includes('klient_id'), 'missing klient_id from zamowienia before SET');
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

    // regresja: stare `lastIndexOf('set')` łapało się na "set" wewnątrz kolumny "reset_password", mylącej to z SET
    test('does not misdetect WHERE as SET when a column name contains "set" as a substring (reset_password)', async () => {
        const sql = "UPDATE users SET a = 1 WHERE reset_password = '' AND ";
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        }, {
            'public.users': [
                makeColumn('id',              'int', 'PRI'),
                makeColumn('reset_password',  'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'), 'expected column suggestions in WHERE despite "reset_password" containing "set"');
    });
});

// regresja: REGEX_ALIAS_DOT łapał tylko kursor tuż po kropce (`c.|`), a nie po wpisanej już nazwie kolumny (`c.id|`)
suite('CompletionUpdate — alias dot with a partially/fully typed column name', () => {

    test('suggests columns after alias + full column name in JOIN...ON (c.id)', async () => {
        const sql = 'UPDATE student s INNER JOIN client c ON c.id';
        const items = await getCompletions(sql, sql.length, { getDatabase: () => 'public' }, {
            'public.student': [makeColumn('client_id', 'int')],
            'public.client':  [makeColumn('id', 'int', 'PRI'), makeColumn('agency_id', 'int')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),        'missing id after "c.id" in JOIN...ON');
        assert.ok(labels.includes('agency_id'), 'missing agency_id after "c.id" in JOIN...ON');
    });

    test('filters columns after alias + partial column name in JOIN...ON (c.ag)', async () => {
        const sql = 'UPDATE student s INNER JOIN client c ON c.ag';
        const items = await getCompletions(sql, sql.length, { getDatabase: () => 'public' }, {
            'public.student': [makeColumn('client_id', 'int')],
            'public.client':  [makeColumn('id', 'int', 'PRI'), makeColumn('agency_id', 'int')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('agency_id'), 'missing agency_id for "c.ag" filter');
        assert.ok(!labels.includes('id'),       'id should not match "c.ag" filter');
    });

    test('suggests columns after alias + full column name in SET (u.em)', async () => {
        const sql = 'UPDATE users u SET u.em';
        const items = await getCompletions(sql, sql.length, { getDatabase: () => 'public' }, {
            'public.users': [makeColumn('id', 'int', 'PRI'), makeColumn('email', 'varchar')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('email'), 'missing email for "u.em" filter in SET');
        assert.ok(!labels.includes('id'),   'id should not match "u.em" filter in SET');
    });

    test('suggests columns after alias + full column name in WHERE (u.id)', async () => {
        const sql = 'UPDATE users u SET u.email = 1 WHERE u.id';
        const items = await getCompletions(sql, sql.length, { getDatabase: () => 'public' }, {
            'public.users': [makeColumn('id', 'int', 'PRI'), makeColumn('email', 'varchar')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id after "u.id" in WHERE');
        assert.ok(!labels.includes('email'), 'email should not match "u.id" filter in WHERE');
    });
});

suite('CompletionUpdate — index hints (USE/FORCE/IGNORE INDEX)', () => {

    test('suggests USE/FORCE/IGNORE INDEX right after the table name, before SET', async () => {
        const sql = 'UPDATE users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('USE INDEX'),    'missing USE INDEX');
        assert.ok(labels.includes('FORCE INDEX'),  'missing FORCE INDEX');
        assert.ok(labels.includes('IGNORE INDEX'), 'missing IGNORE INDEX');
    });

    test('suggests USE/FORCE/IGNORE INDEX right after the table alias, before SET', async () => {
        const sql = 'UPDATE users u ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('USE INDEX'),    'missing USE INDEX after alias');
        assert.ok(labels.includes('FORCE INDEX'),  'missing FORCE INDEX after alias');
        assert.ok(labels.includes('IGNORE INDEX'), 'missing IGNORE INDEX after alias');
    });

    test('suggests USE/FORCE/IGNORE INDEX after LOW_PRIORITY/IGNORE modifiers and the table name', async () => {
        const sql = 'UPDATE LOW_PRIORITY IGNORE users ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('USE INDEX'),   'missing USE INDEX after modifiers + table name');
        assert.ok(labels.includes('FORCE INDEX'), 'missing FORCE INDEX after modifiers + table name');
    });

    test('filters index hint keywords to the typed prefix', async () => {
        const sql = 'UPDATE users FOR';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('FORCE INDEX'),   'missing FORCE INDEX for "FOR"');
        assert.ok(!labels.includes('USE INDEX'),    'USE INDEX should not match "FOR"');
        assert.ok(!labels.includes('IGNORE INDEX'), 'IGNORE INDEX should not match "FOR"');
    });

    test('suggests real index names inside USE INDEX (...)', async () => {
        const sql = 'UPDATE users USE INDEX (';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:       () => 'public',
            findSchemaByTable: () => 'public',
        }, {}, undefined, {
            'public.users': [
                makeIndex('PRIMARY'),
                makeIndex('idx_email'),
                makeIndex('idx_created_at'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('PRIMARY'),        'missing PRIMARY index');
        assert.ok(labels.includes('idx_email'),      'missing idx_email');
        assert.ok(labels.includes('idx_created_at'), 'missing idx_created_at');
    });

    test('filters index names to the typed prefix inside FORCE INDEX (...)', async () => {
        const sql = 'UPDATE users u FORCE INDEX (idx_e';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:       () => 'public',
            findSchemaByTable: () => 'public',
        }, {}, undefined, {
            'public.users': [
                makeIndex('idx_email'),
                makeIndex('idx_created_at'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('idx_email'),       'missing idx_email for "idx_e"');
        assert.ok(!labels.includes('idx_created_at'), 'idx_created_at should not match "idx_e"');
    });

    // w MySQL index hint dotyczy KAŻDEJ tabeli osobno w table_references, więc w multi-table UPDATE po przecinku też jest poprawny składniowo (np. "UPDATE client c, student s USE INDEX (...) SET ...")
    test('suggests index hints after the second table in a comma-separated multi-table UPDATE', async () => {
        const sql = 'UPDATE client c, student s ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('USE INDEX'),    'USE INDEX should be suggested after the second comma-separated table');
        assert.ok(labels.includes('FORCE INDEX'),  'FORCE INDEX should be suggested after the second comma-separated table');
        assert.ok(labels.includes('IGNORE INDEX'), 'IGNORE INDEX should be suggested after the second comma-separated table');
    });

    test('suggests real index names inside USE INDEX (...) after a comma-separated table', async () => {
        const sql = 'UPDATE client c, student s USE INDEX (';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:       () => 'public',
            findSchemaByTable: () => 'public',
        }, {}, undefined, {
            'public.student': [makeIndex('idx_name')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('idx_name'), 'missing idx_name for the second comma-separated table (student)');
    });

    // regresja: REGEX_UPDATE_INDEX_HINT_KEYWORD mógł się cofnąć i błędnie potraktować sam modyfikator IGNORE
    // jako nazwę tabeli, gdy żadna tabela nie została jeszcze wpisana
    test('does not treat a bare IGNORE/LOW_PRIORITY modifier as a table name', async () => {
        const sql = 'UPDATE LOW_PRIORITY IGNORE ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(!labels.includes('USE INDEX'),   'USE INDEX should not be suggested when only modifiers are typed, no table yet');
        assert.ok(!labels.includes('FORCE INDEX'), 'FORCE INDEX should not be suggested when only modifiers are typed, no table yet');
    });

    // tak samo jak w SELECT, table_references w klauzuli FROM/JOIN pozwala na index hint dla każdej złączonej tabeli z osobna
    test('suggests index hints after a JOIN-ed table in a multi-table UPDATE', async () => {
        const sql = 'UPDATE aaa s JOIN bbb c ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('USE INDEX'),    'USE INDEX should be suggested right after a JOIN-ed table');
        assert.ok(labels.includes('FORCE INDEX'),  'FORCE INDEX should be suggested right after a JOIN-ed table');
        assert.ok(labels.includes('IGNORE INDEX'), 'IGNORE INDEX should be suggested right after a JOIN-ed table');
    });

    test('suggests real index names inside FORCE INDEX (...) after a JOIN-ed table', async () => {
        const sql = 'UPDATE aaa s JOIN bbb c FORCE INDEX (';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:       () => 'public',
            findSchemaByTable: () => 'public',
        }, {}, undefined, {
            'public.bbb': [makeIndex('idx_bbb')],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('idx_bbb'), 'missing idx_bbb for the JOIN-ed table (bbb)');
    });

    test('does not suggest index hints while still inside the ON condition of a JOIN', async () => {
        const sql = 'UPDATE orders o JOIN users u ON o.user_id = u.id SET ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase: () => 'public',
        });
        const labels = items.map(labelOf);
        assert.ok(!labels.includes('USE INDEX'),   'USE INDEX should not be suggested once past SET');
        assert.ok(!labels.includes('FORCE INDEX'), 'FORCE INDEX should not be suggested once past SET');
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
