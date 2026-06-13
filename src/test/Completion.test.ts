import * as assert from 'assert';
import * as vscode from 'vscode';
import { findCurrentQuery } from '../sql/findCurrentQuery';
import { findQueryTables } from '../sql/findQueryTables';
import { TableCompletionProvider } from '../completion/TableCompletionProvider';
import { TableColumn } from '../cache/tableColumnsCache';
import { ConnectionManager } from '../db/ConnectionManager';
import * as cacheModule from '../cache/tableColumnsCache';

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
        order: 1, type, isNullable: 'NO', defaultValue: null,
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

    // Podmiana ConnectionManager.getInstance — zachowaj oryginał
    const origGetInstance = ConnectionManager.getInstance.bind(ConnectionManager);
    (ConnectionManager as any).getInstance = () => ({
        getDb: async () => db,
    });

    // Podmiana getCachedColumnsBatch — zachowaj oryginał
    const origGetCached = cacheModule.getCachedColumnsBatch;
    (cacheModule as any).getCachedColumnsBatch = async () => columnsStub;

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
        (ConnectionManager as any).getInstance = origGetInstance;
        (cacheModule as any).getCachedColumnsBatch = origGetCached;
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

    test('zwraca null gdy kursor na pustej linii', () => {
        assert.strictEqual(findCurrentQuery('SELECT 1;\n\nSELECT 2;', 1), null);
    });

    test('zwraca całe zapytanie jednowierszowe', () => {
        const r = findCurrentQuery('SELECT * FROM users;', 0);
        assert.ok(r);
        assert.strictEqual(r!.sql, 'SELECT * FROM users;');
        assert.strictEqual(r!.startLine, 0);
        assert.strictEqual(r!.endLine, 0);
    });

    test('zwraca wielowierszowe zapytanie', () => {
        const r = findCurrentQuery('SELECT *\nFROM users\nWHERE id = 1;', 1);
        assert.ok(r);
        assert.strictEqual(r!.startLine, 0);
        assert.strictEqual(r!.endLine, 2);
        assert.ok(r!.sql.includes('FROM users'));
    });

    test('separuje zapytania rozdzielone średnikiem', () => {
        const sql = 'SELECT 1;\nSELECT 2;';
        assert.strictEqual(findCurrentQuery(sql, 0)!.sql, 'SELECT 1;');
        assert.strictEqual(findCurrentQuery(sql, 1)!.sql, 'SELECT 2;');
    });

    test('separuje zapytania rozdzielone pustą linią', () => {
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

    test('wykrywa tabelę po FROM', () => {
        const refs = findQueryTables('SELECT * FROM users', 'public', fakeDb);
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].table, 'users');
    });

    test('wykrywa tabele po JOIN', () => {
        const refs = findQueryTables(
            'SELECT * FROM orders JOIN users ON orders.user_id = users.id',
            'public', fakeDb,
        );
        const tables = refs.map(r => r.table);
        assert.ok(tables.includes('orders'), 'brak orders');
        assert.ok(tables.includes('users'),  'brak users');
    });

    test('obsługuje schema.table', () => {
        const refs = findQueryTables('SELECT * FROM mydb.accounts', 'public', fakeDb);
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].schema, 'mydb');
        assert.strictEqual(refs[0].table, 'accounts');
    });

    test('usuwa duplikaty tej samej tabeli', () => {
        const refs = findQueryTables(
            'SELECT * FROM users JOIN users ON users.id = users.id',
            'public', fakeDb,
        );
        assert.strictEqual(refs.length, 1);
    });

    test('zwraca [] gdy brak FROM/JOIN', () => {
        assert.strictEqual(
            findQueryTables('SELECT 1 + 1', 'public', fakeDb).length, 0,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TableCompletionProvider — podpowiedzi w SQL
// ─────────────────────────────────────────────────────────────────────────────

suite('TableCompletionProvider — podpowiedzi w SQL', () => {

    // ── FROM xxx → tabele i schematy ─────────────────────────────────────────

    test('podpowiada tabele po "FROM "', async () => {
        const sql = 'SELECT * FROM ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders', 'products'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),    'brak users');
        assert.ok(labels.includes('orders'),   'brak orders');
        assert.ok(labels.includes('products'), 'brak products');
    });

    test('podpowiada schematy po "FROM "', async () => {
        const sql = 'SELECT * FROM ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => '',
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => ['public', 'analytics'],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('public'),    'brak public');
        assert.ok(labels.includes('analytics'), 'brak analytics');
    });

    test('filtruje tabele do wpisanego prefiksu', async () => {
        const sql = 'SELECT * FROM us';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),   'brak users dla "us"');
        assert.ok(!labels.includes('orders'), 'orders nie pasuje do "us"');
    });

    // ── FROM schema. → tabele w schemacie ────────────────────────────────────

    test('podpowiada tabele po "FROM schema."', async () => {
        const sql = 'SELECT * FROM public.';
        const items = await getCompletions(sql, sql.length, {
            getTables:                (schema) => schema === 'public' ? ['users', 'orders'] : [],
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),  'brak users po FROM public.');
        assert.ok(labels.includes('orders'), 'brak orders po FROM public.');
    });

    // ── alias. → kolumny tabeli ───────────────────────────────────────────────

    test('podpowiada kolumny po aliasie (u.)', async () => {
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
        assert.ok(labels.includes('id'),         'brak id');
        assert.ok(labels.includes('email'),      'brak email');
        assert.ok(labels.includes('created_at'), 'brak created_at');
    });

    test('podpowiada kolumny po "schema.table."', async () => {
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
        assert.ok(labels.includes('id'),    'brak id po schema.table.');
        assert.ok(labels.includes('email'), 'brak email po schema.table.');
    });

    // ── SELECT <Ctrl+Space> → kolumny + funkcje SQL ───────────────────────────

    test('podpowiada kolumny i funkcje SQL w klauzuli SELECT', async () => {
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
        assert.ok(labels.includes('id'),    'brak id w SELECT');
        assert.ok(labels.includes('email'), 'brak email w SELECT');

        const hasFunctions = items.some(i => i.kind === vscode.CompletionItemKind.Function);
        assert.ok(hasFunctions, 'brak funkcji SQL w SELECT');
    });

    // ── JOIN → tabele i schematy ──────────────────────────────────────────────

    test('podpowiada tabele po "JOIN "', async () => {
        const sql = 'SELECT * FROM orders JOIN ';
        const items = await getCompletions(sql, sql.length, {
            getDatabase:              () => 'mydb',
            getDefaultDatabaseTables: () => ['users', 'orders', 'products'],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),    'brak users po JOIN');
        assert.ok(labels.includes('orders'),   'brak orders po JOIN');
        assert.ok(labels.includes('products'), 'brak products po JOIN');
    });

    test('podpowiada tabele po "JOIN schema."', async () => {
        const sql = 'SELECT * FROM orders JOIN public.';
        const items = await getCompletions(sql, sql.length, {
            getTables:                (schema) => schema === 'public' ? ['users', 'orders'] : [],
            getDefaultDatabaseTables: () => [],
            getSchemas:               () => [],
        });
        const labels = items.map(labelOf);
        assert.ok(labels.includes('users'),  'brak users po JOIN public.');
        assert.ok(labels.includes('orders'), 'brak orders po JOIN public.');
    });

    test('podpowiada kolumny po aliasie w JOIN (o.)', async () => {
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
        assert.ok(labels.includes('id'),      'brak id po aliasie w JOIN');
        assert.ok(labels.includes('user_id'), 'brak user_id po aliasie w JOIN');
        assert.ok(labels.includes('total'),   'brak total po aliasie w JOIN');
    });

    // ── WHERE → kolumny przez alias ───────────────────────────────────────────

    test('podpowiada kolumny po aliasie w WHERE (u.)', async () => {
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
        assert.ok(labels.includes('id'),    'brak id w WHERE');
        assert.ok(labels.includes('email'), 'brak email w WHERE');
        assert.ok(labels.includes('age'),   'brak age w WHERE');
    });

    test('podpowiada kolumny po pełnej nazwie w WHERE (users.)', async () => {
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
        assert.ok(labels.includes('id'),    'brak id po users. w WHERE');
        assert.ok(labels.includes('email'), 'brak email po users. w WHERE');
    });

    // ── GROUP BY → kolumny przez alias ────────────────────────────────────────

    test('podpowiada kolumny po aliasie w GROUP BY (u.)', async () => {
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
        assert.ok(labels.includes('id'),      'brak id w GROUP BY');
        assert.ok(labels.includes('country'), 'brak country w GROUP BY');
        assert.ok(labels.includes('age'),     'brak age w GROUP BY');
    });

    test('podpowiada kolumny po pełnej nazwie w GROUP BY (users.)', async () => {
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
        assert.ok(labels.includes('id'),      'brak id po users. w GROUP BY');
        assert.ok(labels.includes('country'), 'brak country po users. w GROUP BY');
    });

    // ── ORDER BY → kolumny przez alias ────────────────────────────────────────

    test('podpowiada kolumny po aliasie w ORDER BY (u.)', async () => {
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
        assert.ok(labels.includes('id'),         'brak id w ORDER BY');
        assert.ok(labels.includes('email'),      'brak email w ORDER BY');
        assert.ok(labels.includes('created_at'), 'brak created_at w ORDER BY');
    });

    test('podpowiada kolumny po pełnej nazwie w ORDER BY (users.)', async () => {
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
        assert.ok(labels.includes('id'),    'brak id po users. w ORDER BY');
        assert.ok(labels.includes('email'), 'brak email po users. w ORDER BY');
    });

    // ── Puste wyniki ──────────────────────────────────────────────────────────

    test('zwraca [] gdy kursor na pustej linii', async () => {
        const sql = 'SELECT * FROM users;\n\nSELECT 1;';
        // offset pola pustej linii (\n po pierwszym \n)
        const cursorOffset = 'SELECT * FROM users;\n'.length;
        const items = await getCompletions(sql, cursorOffset, {
            getDefaultDatabaseTables: () => ['users'],
            getSchemas:               () => [],
        });
        assert.strictEqual(items.length, 0, 'oczekiwano 0 podpowiedzi na pustej linii');
    });
});
