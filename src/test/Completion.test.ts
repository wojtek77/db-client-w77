import * as assert from 'assert';
import * as vscode from 'vscode';
import { findCurrentQuery } from '../sql/findCurrentQuery.js';
import { findQueryTables } from '../sql/findQueryTables.js';
import { TableCompletionProvider } from '../completion/TableCompletionProvider.js';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { TableColumn, TableColumnsCache, TableRef } from '../cache/TableColumnsCache.js';

// ─── Typy pomocnicze ──────────────────────────────────────────────────────────

type FakeDb = {
    getTables:               (schema: string) => string[];
    getDefaultDatabaseTables: () => string[];
    getSchemas:              () => string[];
    getDatabase:             () => string;
    findSchemaByTable:       (table: string) => string | null;
    getConnectionName:       () => string;
};

// ─── Pomocniki ────────────────────────────────────────────────────────────────

function makeColumn(name: string, type: string, key = ''): TableColumn {
    return {
        schema: 'public', table: 'users', name,
        order: 1, type, columnType: type, isNullable: 'NO', defaultValue: null,
        columnKey: key, extra: '', characterMaximumLength: null,
        numericPrecision: null, numericScale: null,
    };
}

function makeFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
    return {
        getTables:               overrides.getTables               ?? (() => []),
        getDefaultDatabaseTables: overrides.getDefaultDatabaseTables ?? (() => []),
        getSchemas:              overrides.getSchemas              ?? (() => []),
        getDatabase:             overrides.getDatabase             ?? (() => ''),
        findSchemaByTable:       overrides.findSchemaByTable       ?? (() => null),
        getConnectionName:       overrides.getConnectionName       ?? (() => 'test'),
    };
}

/**
 * Uruchamia TableCompletionProvider z podmienionym ConnectionManager
 * i getCachedColumnsBatch, bez potrzeby biblioteki do mockowania.
 */
async function getCompletions(
    content:      string,
    cursorOffset: number,
    dbOverrides:  Partial<FakeDb> = {},
    columnsStub:  Record<string, TableColumn[]> = {},
): Promise<vscode.CompletionItem[]> {

    const db = makeFakeDb(dbOverrides);

    // 1. Podmiana ConnectionManager.getInstance — zachowaj oryginał
    const origConnectionGetInstance = ConnectionManager.getInstance.bind(ConnectionManager);
    (ConnectionManager as any).getInstance = () => ({
        getDb: async () => db,
    });

    // 2. Podmiana metody w instancji TableColumnsService — zachowaj oryginał
    const columnsServiceInstance = TableColumnsCache.getInstance();
    const origGetCachedColumnsBatch = columnsServiceInstance.getCachedColumnsBatch.bind(columnsServiceInstance);
    
    // Nadpisujemy metodę na instancji, aby zwracała dane testowe (stub)
    columnsServiceInstance.getCachedColumnsBatch = async () => columnsStub;

    try {
        const document = await vscode.workspace.openTextDocument({
            language: 'sql',
            content,
        });
        const position = document.positionAt(cursorOffset);
        const provider = new TableCompletionProvider();
        const token    = new vscode.CancellationTokenSource().token;

        const result = await provider.provideCompletionItems(
            document, position, token,
        );
        return result ?? [];

    } finally {
        // 3. Przywrócenie oryginalnych zachowań w bloku finally
        (ConnectionManager as any).getInstance = origConnectionGetInstance;
        columnsServiceInstance.getCachedColumnsBatch = origGetCachedColumnsBatch;
    }
}

/** Wyciąga string z label, który może być string lub CompletionItemLabel. */
function labelOf(item: vscode.CompletionItem): string {
    return typeof item.label === 'string' ? item.label : item.label.label;
}

// ─────────────────────────────────────────────────────────────────────────────
// findCurrentQuery — czyste testy jednostkowe
// ─────────────────────────────────────────────────────────────────────────────

suite('findCurrentQuery', () => {

    test('returns null when cursor is on an empty line', () => {
        assert.strictEqual(findCurrentQuery('SELECT 1;\n\nSELECT 2;', 1), null);
    });

    test('returns entire single-line query', () => {
        const r = findCurrentQuery('SELECT * FROM users;', 0);
        assert.ok(r);
        assert.strictEqual(r!.sql, 'SELECT * FROM users;');
        assert.strictEqual(r!.startLine, 0);
        assert.strictEqual(r!.endLine, 0);
    });

    test('returns multi-line query', () => {
        const r = findCurrentQuery('SELECT *\nFROM users\nWHERE id = 1;', 1);
        assert.ok(r);
        assert.strictEqual(r!.startLine, 0);
        assert.strictEqual(r!.endLine, 2);
        assert.ok(r!.sql.includes('FROM users'));
    });

    test('separates queries delimited by a semicolon', () => {
        const sql = 'SELECT 1;\nSELECT 2;';
        assert.strictEqual(findCurrentQuery(sql, 0)!.sql, 'SELECT 1;');
        assert.strictEqual(findCurrentQuery(sql, 1)!.sql, 'SELECT 2;');
    });

    test('separates queries delimited by an empty line', () => {
        const sql = 'SELECT 1\n\nSELECT 2';
        assert.strictEqual(findCurrentQuery(sql, 0)!.sql, 'SELECT 1');
        assert.strictEqual(findCurrentQuery(sql, 2)!.sql, 'SELECT 2');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// findQueryTables — czyste testy jednostkowe
// ─────────────────────────────────────────────────────────────────────────────

suite('findQueryTables', () => {

    const fakeDb: any = { findSchemaByTable: () => null };

    test('detects table after FROM', () => {
        const refs = findQueryTables('SELECT * FROM users', 'public', fakeDb);
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].table, 'users');
    });

    test('detects tables after JOIN', () => {
        const refs = findQueryTables(
            'SELECT * FROM orders JOIN users ON orders.user_id = users.id',
            'public', fakeDb,
        );
        const tables = refs.map(r => r.table);
        assert.ok(tables.includes('orders'), 'missing orders');
        assert.ok(tables.includes('users'),  'missing users');
    });

    test('handles schema.table', () => {
        const refs = findQueryTables('SELECT * FROM mydb.accounts', 'public', fakeDb);
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].schema, 'mydb');
        assert.strictEqual(refs[0].table, 'accounts');
    });

    test('removes duplicates of the same table', () => {
        const refs = findQueryTables(
            'SELECT * FROM users JOIN users ON users.id = users.id',
            'public', fakeDb,
        );
        assert.strictEqual(refs.length, 1);
    });

    test('returns [] when there is no FROM/JOIN', () => {
        assert.strictEqual(
            findQueryTables('SELECT 1 + 1', 'public', fakeDb).length, 0,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TableCompletionProvider — podpowiedzi w SQL
// ─────────────────────────────────────────────────────────────────────────────

suite('TableCompletionProvider — suggestions in SQL', () => {

    // ── FROM xxx → tabele i schematy ─────────────────────────────────────────

    test('suggests tables after "FROM "', async () => {
        const sql = 'SELECT * FROM ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders', 'products'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),    'missing users');
        assert.ok(labels.includes('orders'),   'missing orders');
        assert.ok(labels.includes('products'), 'missing products');
    });

    test('suggests schemas after "FROM "', async () => {
        const sql = 'SELECT * FROM ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => '',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => ['public', 'analytics'],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('public'),    'missing public');
        assert.ok(labels.includes('analytics'), 'missing analytics');
    });

    test('filters tables to the typed prefix', async () => {
        const sql = 'SELECT * FROM us';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),   'missing users for "us"');
        assert.ok(!labels.includes('orders'), 'orders should not match "us"');
    });

    // ── FROM schema. → tabele w schemacie ────────────────────────────────────

    test('suggests tables after "FROM schema."', async () => {
        const sql = 'SELECT * FROM public.';
        const items = await getCompletions(sql, sql.length, {
            getTables:                (schema) => schema === 'public' ? ['users', 'orders'] : [],
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),  'missing users after FROM public.');
        assert.ok(labels.includes('orders'), 'missing orders after FROM public.');
    });

    // ── alias. → kolumny tabeli ───────────────────────────────────────────────

    test('suggests columns after alias (u.)', async () => {
        const sql = 'SELECT u. FROM users u';
        const cursorOffset = sql.indexOf('u.') + 2;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.users': [
                makeColumn('id',         'int',      'PRI'),
                makeColumn('email',      'varchar'),
                makeColumn('created_at', 'datetime'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),         'missing id');
        assert.ok(labels.includes('email'),      'missing email');
        assert.ok(labels.includes('created_at'), 'missing created_at');
    });

    test('suggests columns after "schema.table."', async () => {
        const sql = 'SELECT public.users.';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id after schema.table.');
        assert.ok(labels.includes('email'), 'missing email after schema.table.');
    });

    // ── SELECT <Ctrl+Space> → kolumny + funkcje SQL ───────────────────────────

    test('suggests columns and SQL functions in the SELECT clause', async () => {
        const sql = 'SELECT  FROM users u';
        const cursorOffset = 'SELECT '.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id in SELECT');
        assert.ok(labels.includes('email'), 'missing email in SELECT');

        const hasFunctions = items.some(i => i.kind === vscode.CompletionItemKind.Function);
        assert.ok(hasFunctions, 'missing SQL functions in SELECT');
    });

    // ── JOIN → tabele i schematy ──────────────────────────────────────────────

    test('suggests tables after "JOIN "', async () => {
        const sql = 'SELECT * FROM orders JOIN ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders', 'products'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),    'missing users after JOIN');
        assert.ok(labels.includes('orders'),   'missing orders after JOIN');
        assert.ok(labels.includes('products'), 'missing products after JOIN');
    });

    test('suggests tables after "JOIN schema."', async () => {
        const sql = 'SELECT * FROM orders JOIN public.';
        const items = await getCompletions(sql, sql.length, {
            getTables:                (schema) => schema === 'public' ? ['users', 'orders'] : [],
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),  'missing users after JOIN public.');
        assert.ok(labels.includes('orders'), 'missing orders after JOIN public.');
    });

    test('suggests columns after alias in JOIN (o.)', async () => {
        const sql = 'SELECT o. FROM orders o JOIN users u ON o.user_id = u.id';
        const cursorOffset = sql.indexOf('o.') + 2;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.orders': [
                makeColumn('id',      'int', 'PRI'),
                makeColumn('user_id', 'int'),
                makeColumn('total',   'decimal'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),      'missing id after alias in JOIN');
        assert.ok(labels.includes('user_id'), 'missing user_id after alias in JOIN');
        assert.ok(labels.includes('total'),   'missing total after alias in JOIN');
    });

    // ── WHERE → kolumny przez alias ───────────────────────────────────────────

    test('suggests columns after alias in WHERE (u.)', async () => {
        const sql = 'SELECT * FROM users u WHERE u.';
        const cursorOffset = sql.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
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

    test('suggests columns after full name in WHERE (users.)', async () => {
        const sql = 'SELECT * FROM users WHERE users.';
        const cursorOffset = sql.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id after users. in WHERE');
        assert.ok(labels.includes('email'), 'missing email after users. in WHERE');
    });

    // ── GROUP BY → kolumny przez alias ────────────────────────────────────────

    test('suggests columns after alias in GROUP BY (u.)', async () => {
        const sql = 'SELECT u.country, COUNT(*) FROM users u GROUP BY u.';
        const cursorOffset = sql.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.users': [
                makeColumn('id',      'int', 'PRI'),
                makeColumn('country', 'varchar'),
                makeColumn('age',     'int'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),      'missing id in GROUP BY');
        assert.ok(labels.includes('country'), 'missing country in GROUP BY');
        assert.ok(labels.includes('age'),     'missing age in GROUP BY');
    });

    test('suggests columns after full name in GROUP BY (users.)', async () => {
        const sql = 'SELECT country, COUNT(*) FROM users GROUP BY users.';
        const cursorOffset = sql.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.users': [
                makeColumn('id',      'int', 'PRI'),
                makeColumn('country', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),      'missing id after users. in GROUP BY');
        assert.ok(labels.includes('country'), 'missing country after users. in GROUP BY');
    });

    // ── ORDER BY → kolumny przez alias ────────────────────────────────────────

    test('suggests columns after alias in ORDER BY (u.)', async () => {
        const sql = 'SELECT * FROM users u ORDER BY u.';
        const cursorOffset = sql.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.users': [
                makeColumn('id',         'int', 'PRI'),
                makeColumn('email',      'varchar'),
                makeColumn('created_at', 'datetime'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),         'missing id in ORDER BY');
        assert.ok(labels.includes('email'),      'missing email in ORDER BY');
        assert.ok(labels.includes('created_at'), 'missing created_at in ORDER BY');
    });

    test('suggests columns after full name in ORDER BY (users.)', async () => {
        const sql = 'SELECT * FROM users ORDER BY users.';
        const cursorOffset = sql.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDatabase:              () => 'public',
            findSchemaByTable:        () => 'public',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        }, {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('id'),    'missing id after users. in ORDER BY');
        assert.ok(labels.includes('email'), 'missing email after users. in ORDER BY');
    });

    // ── Puste wyniki ──────────────────────────────────────────────────────────

    test('returns [] when cursor is on an empty line', async () => {
        const sql = 'SELECT * FROM users;\n\nSELECT 1;';
        // offset pola pustej linii (\n po pierwszym \n)
        const cursorOffset = 'SELECT * FROM users;\n'.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        assert.strictEqual(items.length, 0, 'expected 0 suggestions on an empty line');
    });
});

suite('TableCompletionProvider — HAVING', () => {

    // ── prosta kolumna ────────────────────────────────────────────────────────

    test('HAVING: suggests a simple column from SELECT', async () => {
        const sql = 'SELECT agency_id FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('agency_id'), 'missing agency_id in HAVING');
    });

    test('HAVING: suggests a column with table prefix (t.col → col)', async () => {
        const sql = 'SELECT t.agency_id FROM client t HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('agency_id'), 'missing agency_id (with t. prefix) in HAVING');
        assert.ok(!labels.includes('t'),        '"t" should not be suggested');
    });

    // ── alias jawny (AS) ──────────────────────────────────────────────────────

    test('HAVING: suggests AS alias for a simple column', async () => {
        const sql = 'SELECT agency_id AS aid FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aid'),        'missing alias "aid" in HAVING');
        assert.ok(!labels.includes('agency_id'), '"agency_id" should not appear (it is an alias)');
    });

    test('HAVING: suggests AS alias for a function expression', async () => {
        const sql = 'SELECT sum(id) AS total FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('total'), 'missing alias "total" in HAVING');
        assert.ok(!labels.includes('sum'),  '"sum" should not be suggested');
        assert.ok(!labels.includes('id'),   '"id" should not be suggested');
    });

    // ── alias niejawny (bez AS) ───────────────────────────────────────────────

    test('HAVING: suggests implicit alias (without AS)', async () => {
        const sql = 'SELECT agency_id aid FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aid'),        'missing implicit alias "aid" in HAVING');
        assert.ok(!labels.includes('agency_id'), '"agency_id" should not appear (it is an implicit alias)');
    });

    // ── wyrażenie z funkcją bez aliasu ────────────────────────────────────────

    test('HAVING: suggests expression ABS(number) without alias', async () => {
        const sql = 'SELECT ABS(number) FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('ABS(number)'), 'missing "ABS(number)" in HAVING');
    });

    test('HAVING: suggests expression sum(id) without alias', async () => {
        const sql = 'SELECT sum(id) FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('sum(id)'), 'missing "sum(id)" in HAVING');
    });

    // ── wiele kolumn ──────────────────────────────────────────────────────────

    test('HAVING: suggests all items from the SELECT list', async () => {
        const sql = 'SELECT aaa, bbb, ccc FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aaa'), 'missing aaa');
        assert.ok(labels.includes('bbb'), 'missing bbb');
        assert.ok(labels.includes('ccc'), 'missing ccc');
    });

    test('HAVING: mix of columns, aliases and functions', async () => {
        const sql = 'SELECT aaa, ABS(number), sum(id) AS xx, t.col FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aaa'),         'missing aaa');
        assert.ok(labels.includes('ABS(number)'), 'missing ABS(number)');
        assert.ok(labels.includes('xx'),          'missing alias xx');
        assert.ok(labels.includes('col'),         'missing col (from t.col)');
        assert.ok(!labels.includes('sum'),        '"sum" should not appear');
        assert.ok(!labels.includes('id'),         '"id" should not appear');
        assert.ok(!labels.includes('t'),          '"t" should not appear');
    });

    // ── podzapytanie w SELECT ─────────────────────────────────────────────────

    test('Outer HAVING: suggests subquery alias', async () => {
        const sql = [
            'SELECT',
            '    aaa,',
            '    (',
            '        SELECT bbb FROM student HAVING x LIMIT 2',
            '    ) AS bbb',
            'FROM client',
            'HAVING ',
        ].join('\n');
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aaa'), 'missing aaa in outer HAVING');
        assert.ok(labels.includes('bbb'), 'missing alias bbb in outer HAVING');
    });

    test('Inner HAVING: suggests only columns from the inner SELECT', async () => {
        const sql = [
            'SELECT',
            '    aaa,',
            '    (',
            '        SELECT bbb FROM student HAVING ',
        ].join('\n');
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('bbb'),  'missing bbb in inner HAVING');
        assert.ok(!labels.includes('aaa'), '"aaa" should not appear in inner HAVING');
    });

    // ── funkcje SQL ───────────────────────────────────────────────────────────

    test('HAVING: includes SQL functions in suggestions', async () => {
        const sql = 'SELECT count(*) FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const hasFunctions = items.some(i => i.kind === vscode.CompletionItemKind.Function);
        assert.ok(hasFunctions, 'missing SQL functions in HAVING');
    });

    // ── LIMIT nie podpowiada ──────────────────────────────────────────────────

    test('LIMIT: suggests only numeric values', async () => {
        const sql = 'SELECT aaa FROM client HAVING x > 0 LIMIT ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('1'),   'missing value 1 in LIMIT');
        assert.ok(labels.includes('10'),  'missing value 10 in LIMIT');
        assert.ok(labels.includes('100'), 'missing value 100 in LIMIT');
        assert.ok(!labels.includes('aaa'), '"aaa" should not appear in LIMIT');
    });
});
