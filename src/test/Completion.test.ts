import * as assert from 'assert';
import { findCurrentQuery } from '../sql/findCurrentQuery';
import { findQueryTables } from '../sql/findQueryTables';
import { TableCompletionProvider } from '../completion/TableCompletionProvider';
import { TableColumn, TableRef } from '../cache/tableColumnsCache';

/* ABY URUCHOMIĆ TESTY: npm test */

// ─── Mocki zależności VS Code i bazy danych ───────────────────────────────────

// Stub dla ConnectionManager i getCachedColumnsBatch
// pozwala testować logikę providera bez prawdziwego połączenia z DB.

type CompletionItemKind = number;

const CompletionItemKindMap: Record<string, CompletionItemKind> = {
    Struct:    6,
    Module:    9,
    Field:     5,
    Function: 3,
};

class FakeCompletionItem {
    label:         string;
    kind:          CompletionItemKind;
    insertText:    any;
    detail:        string  = '';
    sortText:      string  = '';
    filterText?:   string;
    documentation: any;

    constructor(label: string, kind: CompletionItemKind) {
        this.label = label;
        this.kind  = kind;
    }
}

class FakeSnippetString {
    constructor(public value: string) {}
}

class FakeMarkdownString {
    constructor(public value: string) {}
}

class FakePosition {
    constructor(
        public line:      number,
        public character: number
    ) {}
}

class FakeTextLine {
    constructor(public text: string) {}
}

class FakeCancellationToken {
    isCancellationRequested = false;
}

function makeFakeDocument(lines: string[], cursorLine: number): any {
    return {
        getText: () => lines.join('\n'),
        lineAt:  (pos: { line: number } | number) => {
            const lineIndex = typeof pos === 'number' ? pos : pos.line;
            return new FakeTextLine(lines[lineIndex] ?? '');
        },
        offsetAt: (pos: { line: number; character: number }) => {
            let offset = 0;
            for (let i = 0; i < pos.line; i++) {
                offset += lines[i].length + 1; // +1 za '\n'
            }
            return offset + pos.character;
        },
    };
}

// Nadpisanie modułów VS Code i bazy przez monkey-patching w czasie testu
const vscode = {
    CompletionItem:      FakeCompletionItem,
    CompletionItemKind:  CompletionItemKindMap,
    SnippetString:       FakeSnippetString,
    MarkdownString:      FakeMarkdownString,
    Position:            FakePosition,
};

// Przykładowe kolumny do testów
function makeColumn(name: string, type: string, key = ''): TableColumn {
    return {
        schema:                 'public',
        table:                  'users',
        name,
        order:                  1,
        type,
        isNullable:             'NO',
        defaultValue:           null,
        columnKey:              key,
        extra:                  '',
        characterMaximumLength: null,
        numericPrecision:       null,
        numericScale:           null,
    };
}

// ─── Pomocnik: uruchamia provideCompletionItems z minimalnym środowiskiem ─────

async function getCompletions(
    lines:      string[],
    cursorLine: number,
    cursorChar: number,
    dbStub: {
        getTables?:              (schema: string) => string[];
        getDefaultDatabaseTables?: () => string[];
        getSchemas?:             () => string[];
        getDatabase?:            () => string;
        findSchemaByTable?:      (table: string) => string | null;
        getConnectionName?:      () => string;
    },
    columnsStub: Record<string, TableColumn[]> = {},
): Promise<FakeCompletionItem[]> {

    // Monkey-patch modułów wymaganych przez provider
    const Module = require('module');
    const originalLoad = Module._load;

    Module._load = function (request: string, ...args: any[]) {
        if (request === 'vscode') {
            return vscode;
        }
        return originalLoad.apply(this, [request, ...args]);
    };

    // Zamień getCachedColumnsBatch na stub
    const cacheModule = require('../cache/tableColumnsCache');
    const origGetCached = cacheModule.getCachedColumnsBatch;
    cacheModule.getCachedColumnsBatch = async () => columnsStub;

    // Zamień ConnectionManager na stub
    const connModule = require('../db/ConnectionManager');
    const origGetInstance = connModule.ConnectionManager.getInstance;
    connModule.ConnectionManager.getInstance = () => ({
        getDb: async () => ({
            getTables:               dbStub.getTables              ?? (() => []),
            getDefaultDatabaseTables: dbStub.getDefaultDatabaseTables ?? (() => []),
            getSchemas:              dbStub.getSchemas             ?? (() => []),
            getDatabase:             dbStub.getDatabase            ?? (() => ''),
            findSchemaByTable:       dbStub.findSchemaByTable      ?? (() => null),
            getConnectionName:       dbStub.getConnectionName      ?? (() => 'test'),
        }),
    });

    try {
        const { TableCompletionProvider: Provider } =
            require('../completion/TableCompletionProvider');

        const provider = new Provider();
        const document = makeFakeDocument(lines, cursorLine);
        const position = new FakePosition(cursorLine, cursorChar);
        const token    = new FakeCancellationToken();

        const items = await provider.provideCompletionItems(
            document,
            position,
            token,
        );

        return (items ?? []) as FakeCompletionItem[];
    } finally {
        Module._load = originalLoad;
        cacheModule.getCachedColumnsBatch = origGetCached;
        connModule.ConnectionManager.getInstance = origGetInstance;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Testy: findCurrentQuery
// ─────────────────────────────────────────────────────────────────────────────

suite('findCurrentQuery', () => {

    test('zwraca null gdy kursor na pustej linii', () => {
        const result = findCurrentQuery('SELECT 1;\n\nSELECT 2;', 1);
        assert.strictEqual(result, null);
    });

    test('zwraca całe zapytanie jednowierszowe', () => {
        const result = findCurrentQuery('SELECT * FROM users;', 0);
        assert.ok(result);
        assert.strictEqual(result!.sql, 'SELECT * FROM users;');
        assert.strictEqual(result!.startLine, 0);
        assert.strictEqual(result!.endLine, 0);
    });

    test('zwraca wielowierszowe zapytanie', () => {
        const sql = 'SELECT *\nFROM users\nWHERE id = 1;';
        const result = findCurrentQuery(sql, 1);
        assert.ok(result);
        assert.strictEqual(result!.startLine, 0);
        assert.strictEqual(result!.endLine, 2);
        assert.ok(result!.sql.includes('FROM users'));
    });

    test('separuje zapytania rozdzielone średnikiem', () => {
        const sql = 'SELECT 1;\nSELECT 2;';
        const r1 = findCurrentQuery(sql, 0);
        const r2 = findCurrentQuery(sql, 1);
        assert.strictEqual(r1!.sql, 'SELECT 1;');
        assert.strictEqual(r2!.sql, 'SELECT 2;');
    });

    test('separuje zapytania rozdzielone pustą linią', () => {
        const sql = 'SELECT 1\n\nSELECT 2';
        const r1 = findCurrentQuery(sql, 0);
        const r2 = findCurrentQuery(sql, 2);
        assert.strictEqual(r1!.sql, 'SELECT 1');
        assert.strictEqual(r2!.sql, 'SELECT 2');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Testy: findQueryTables
// ─────────────────────────────────────────────────────────────────────────────

suite('findQueryTables', () => {

    const fakeDb: any = {
        findSchemaByTable: () => null,
    };

    test('wykrywa tabelę po FROM', () => {
        const refs = findQueryTables('SELECT * FROM users', 'public', fakeDb);
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].table, 'users');
    });

    test('wykrywa tabelę po JOIN', () => {
        const refs = findQueryTables(
            'SELECT * FROM orders JOIN users ON orders.user_id = users.id',
            'public',
            fakeDb,
        );
        const tables = refs.map(r => r.table);
        assert.ok(tables.includes('orders'));
        assert.ok(tables.includes('users'));
    });

    test('obsługuje schemat explicite (schema.table)', () => {
        const refs = findQueryTables(
            'SELECT * FROM mydb.accounts',
            'public',
            fakeDb,
        );
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].schema, 'mydb');
        assert.strictEqual(refs[0].table, 'accounts');
    });

    test('usuwa duplikaty tej samej tabeli', () => {
        const refs = findQueryTables(
            'SELECT * FROM users JOIN users ON users.id = users.id',
            'public',
            fakeDb,
        );
        assert.strictEqual(refs.length, 1);
    });

    test('zwraca pustą tablicę gdy brak FROM/JOIN', () => {
        const refs = findQueryTables('SELECT 1 + 1', 'public', fakeDb);
        assert.strictEqual(refs.length, 0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Testy: TableCompletionProvider — podpowiedzi w SQL
// ─────────────────────────────────────────────────────────────────────────────

suite('TableCompletionProvider — podpowiedzi w SQL', () => {

    // ── FROM xxx → podpowiedzi tabel i schematów ──────────────────────────────

    test('podpowiada tabele po "FROM "', async () => {
        const line  = 'SELECT * FROM ';
        const items = await getCompletions(
            [line],
            0,
            line.length,
            {
                getDatabase:              () => 'mydb',
                getDefaultDatabaseTables: () => ['users', 'orders', 'products'],
                getSchemas:               () => [],
            },
        );

        const labels = items.map(i => i.label);
        assert.ok(labels.includes('users'),    'Brak "users" w podpowiedziach');
        assert.ok(labels.includes('orders'),   'Brak "orders" w podpowiedziach');
        assert.ok(labels.includes('products'), 'Brak "products" w podpowiedziach');
    });

    test('podpowiada schematy po "FROM "', async () => {
        const line  = 'SELECT * FROM ';
        const items = await getCompletions(
            [line],
            0,
            line.length,
            {
                getDatabase:              () => '',
                getDefaultDatabaseTables: () => [],
                getSchemas:               () => ['public', 'analytics'],
            },
        );

        const labels = items.map(i => i.label);
        assert.ok(labels.includes('public'),    'Brak schematu "public"');
        assert.ok(labels.includes('analytics'), 'Brak schematu "analytics"');
    });

    test('filtruje tabele pasujące do wpisanego prefiksu', async () => {
        const line  = 'SELECT * FROM us';
        const items = await getCompletions(
            [line],
            0,
            line.length,
            {
                getDatabase:              () => 'mydb',
                getDefaultDatabaseTables: () => ['users', 'orders'],
                getSchemas:               () => [],
            },
        );

        const labels = items.map(i => i.label);
        assert.ok(labels.includes('users'),         'Brak "users" dla prefiksu "us"');
        assert.ok(!labels.includes('orders'),       '"orders" nie powinno pasować do "us"');
    });

    // ── FROM schema. → podpowiedzi tabel w schemacie ─────────────────────────

    test('podpowiada tabele po "FROM schema."', async () => {
        const line  = 'SELECT * FROM public.';
        const items = await getCompletions(
            [line],
            0,
            line.length,
            {
                getTables: (schema) =>
                    schema === 'public' ? ['users', 'orders'] : [],
                getDefaultDatabaseTables: () => [],
                getSchemas: () => [],
            },
        );

        const labels = items.map(i => i.label);
        assert.ok(labels.includes('users'),  'Brak "users" po "FROM public."');
        assert.ok(labels.includes('orders'), 'Brak "orders" po "FROM public."');
    });

    // ── alias. → podpowiedzi kolumn ───────────────────────────────────────────

    test('podpowiada kolumny po aliasie (u.)', async () => {
        const lines  = ['SELECT u. FROM users u'];
        const line   = lines[0];
        const cursor = line.indexOf('u.') + 2;  // zaraz po kropce

        const colMap = {
            'public.users': [
                makeColumn('id',         'int',     'PRI'),
                makeColumn('email',      'varchar'),
                makeColumn('created_at', 'datetime'),
            ],
        };

        const items = await getCompletions(
            lines,
            0,
            cursor,
            {
                getDatabase:         () => 'public',
                findSchemaByTable:   () => 'public',
                getDefaultDatabaseTables: () => [],
                getSchemas:          () => [],
            },
            colMap,
        );

        const labels = items.map(i => i.label);
        assert.ok(labels.includes('id'),         'Brak kolumny "id"');
        assert.ok(labels.includes('email'),      'Brak kolumny "email"');
        assert.ok(labels.includes('created_at'), 'Brak kolumny "created_at"');
    });

    test('podpowiada kolumny po "schema.table."', async () => {
        const lines  = ['SELECT public.users.'];
        const cursor = lines[0].length;

        const colMap = {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        };

        const items = await getCompletions(
            lines,
            0,
            cursor,
            {
                getDatabase:              () => 'public',
                getDefaultDatabaseTables: () => [],
                getSchemas:               () => [],
            },
            colMap,
        );

        const labels = items.map(i => i.label);
        assert.ok(labels.includes('id'),    'Brak "id" po "schema.table."');
        assert.ok(labels.includes('email'), 'Brak "email" po "schema.table."');
    });

    // ── SELECT <Ctrl+Space> → kolumny + funkcje SQL ───────────────────────────

    test('podpowiada kolumny i funkcje SQL w klauzuli SELECT', async () => {
        const lines  = ['SELECT  FROM users u'];
        const cursor = 'SELECT '.length;  // po SELECT, przed FROM

        const colMap = {
            'public.users': [
                makeColumn('id',    'int', 'PRI'),
                makeColumn('email', 'varchar'),
            ],
        };

        const items = await getCompletions(
            lines,
            0,
            cursor,
            {
                getDatabase:              () => 'public',
                findSchemaByTable:        () => 'public',
                getDefaultDatabaseTables: () => [],
                getSchemas:               () => [],
            },
            colMap,
        );

        const labels = items.map(i => i.label);

        // Kolumny
        assert.ok(labels.includes('id'),    'Brak kolumny "id" w SELECT');
        assert.ok(labels.includes('email'), 'Brak kolumny "email" w SELECT');

        // Funkcje SQL (COUNT, SUM itp.)
        const hasFunctions = items.some(
            i => i.kind === CompletionItemKindMap.Function
        );
        assert.ok(hasFunctions, 'Brak funkcji SQL w podpowiedziach SELECT');
    });

    // ── Puste wyniki gdy kursor poza zapytaniem ───────────────────────────────

    test('zwraca puste podpowiedzi gdy kursor na pustej linii', async () => {
        const items = await getCompletions(
            ['SELECT * FROM users;', '', 'SELECT 1;'],
            1,   // pusta linia
            0,
            { getDefaultDatabaseTables: () => ['users'], getSchemas: () => [] },
        );

        assert.strictEqual(
            items.length,
            0,
            'Oczekiwano 0 podpowiedzi na pustej linii',
        );
    });
});
