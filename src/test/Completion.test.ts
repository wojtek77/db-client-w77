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

suite('TableCompletionProvider — HAVING', () => {

    // ── prosta kolumna ────────────────────────────────────────────────────────

    test('HAVING: podpowiada prostą kolumnę z SELECT', async () => {
        const sql = 'SELECT agency_id FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('agency_id'), 'brak agency_id w HAVING');
    });

    test('HAVING: podpowiada kolumnę z prefiksem tabeli (t.col → col)', async () => {
        const sql = 'SELECT t.agency_id FROM client t HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('agency_id'), 'brak agency_id (z prefiksem t.) w HAVING');
        assert.ok(!labels.includes('t'),        '"t" nie powinno być podpowiedziane');
    });

    // ── alias jawny (AS) ──────────────────────────────────────────────────────

    test('HAVING: podpowiada alias AS dla prostej kolumny', async () => {
        const sql = 'SELECT agency_id AS aid FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aid'),        'brak aliasu "aid" w HAVING');
        assert.ok(!labels.includes('agency_id'), '"agency_id" nie powinno być (jest alias)');
    });

    test('HAVING: podpowiada alias AS dla wyrażenia z funkcją', async () => {
        const sql = 'SELECT sum(id) AS total FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('total'), 'brak aliasu "total" w HAVING');
        assert.ok(!labels.includes('sum'),  '"sum" nie powinno być podpowiedziane');
        assert.ok(!labels.includes('id'),   '"id" nie powinno być podpowiedziane');
    });

    // ── alias niejawny (bez AS) ───────────────────────────────────────────────

    test('HAVING: podpowiada alias niejawny (bez AS)', async () => {
        const sql = 'SELECT agency_id aid FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aid'),        'brak aliasu niejawnego "aid" w HAVING');
        assert.ok(!labels.includes('agency_id'), '"agency_id" nie powinno być (jest alias niejawny)');
    });

    // ── wyrażenie z funkcją bez aliasu ────────────────────────────────────────

    test('HAVING: podpowiada wyrażenie ABS(number) bez aliasu', async () => {
        const sql = 'SELECT ABS(number) FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('ABS(number)'), 'brak "ABS(number)" w HAVING');
    });

    test('HAVING: podpowiada wyrażenie sum(id) bez aliasu', async () => {
        const sql = 'SELECT sum(id) FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('sum(id)'), 'brak "sum(id)" w HAVING');
    });

    // ── wiele kolumn ──────────────────────────────────────────────────────────

    test('HAVING: podpowiada wszystkie pozycje z listy SELECT', async () => {
        const sql = 'SELECT aaa, bbb, ccc FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aaa'), 'brak aaa');
        assert.ok(labels.includes('bbb'), 'brak bbb');
        assert.ok(labels.includes('ccc'), 'brak ccc');
    });

    test('HAVING: mieszanka kolumn, aliasów i funkcji', async () => {
        const sql = 'SELECT aaa, ABS(number), sum(id) AS xx, t.col FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('aaa'),         'brak aaa');
        assert.ok(labels.includes('ABS(number)'), 'brak ABS(number)');
        assert.ok(labels.includes('xx'),          'brak aliasu xx');
        assert.ok(labels.includes('col'),         'brak col (z t.col)');
        assert.ok(!labels.includes('sum'),        '"sum" nie powinno być');
        assert.ok(!labels.includes('id'),         '"id" nie powinno być');
        assert.ok(!labels.includes('t'),          '"t" nie powinno być');
    });

    // ── podzapytanie w SELECT ─────────────────────────────────────────────────

    test('HAVING zewnętrzne: podpowiada alias podzapytania', async () => {
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
        assert.ok(labels.includes('aaa'), 'brak aaa w zewnętrznym HAVING');
        assert.ok(labels.includes('bbb'), 'brak aliasu bbb w zewnętrznym HAVING');
    });

    test('HAVING wewnętrzne: podpowiada tylko kolumny wewnętrznego SELECT', async () => {
        const sql = [
            'SELECT',
            '    aaa,',
            '    (',
            '        SELECT bbb FROM student HAVING ',
        ].join('\n');
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('bbb'),  'brak bbb w wewnętrznym HAVING');
        assert.ok(!labels.includes('aaa'), '"aaa" nie powinno być w wewnętrznym HAVING');
    });

    // ── funkcje SQL ───────────────────────────────────────────────────────────

    test('HAVING: zawiera funkcje SQL w podpowiedziach', async () => {
        const sql = 'SELECT count(*) FROM client HAVING ';
        const items = await getCompletions(sql, sql.length);
        const hasFunctions = items.some(i => i.kind === vscode.CompletionItemKind.Function);
        assert.ok(hasFunctions, 'brak funkcji SQL w HAVING');
    });

    // ── LIMIT nie podpowiada ──────────────────────────────────────────────────

    test('LIMIT: podpowiada tylko wartości liczbowe', async () => {
        const sql = 'SELECT aaa FROM client HAVING x > 0 LIMIT ';
        const items = await getCompletions(sql, sql.length);
        const labels = items.map(labelOf);
        assert.ok(labels.includes('1'),   'brak wartości 1 w LIMIT');
        assert.ok(labels.includes('10'),  'brak wartości 10 w LIMIT');
        assert.ok(labels.includes('100'), 'brak wartości 100 w LIMIT');
        assert.ok(!labels.includes('aaa'), '"aaa" nie powinno być w LIMIT');
    });
});
