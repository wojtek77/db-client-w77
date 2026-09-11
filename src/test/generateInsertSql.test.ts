import * as assert from 'assert';
import * as vscode from 'vscode';
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';

// singleton - reużywamy tego samego wzorca co w SqlResultsProvider.test.ts, ale nadpisujemy _context ręcznie w każdym teście, bo tutaj zależy nam na kontrolowanym workspaceState
function getProvider(): SqlResultsProvider {
    const fakeContext = { extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext;
    return SqlResultsProvider.initialize(fakeContext);
}

// prosty in-memory fake workspaceState, wystarczający do przetestowania zapamiętywania ostatniego wyboru opcji generowania INSERT
function makeFakeWorkspaceState() {
    const store = new Map<string, unknown>();
    return {
        get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
        update: async (key: string, value: unknown) => { store.set(key, value); },
        keys: () => [...store.keys()],
    };
}

type FakeItem = vscode.QuickPickItem & { optionId?: string };

// fake QuickPick oparty o prawdziwe vscode.EventEmitter - odzwierciedla API używane przez pickInsertGenerationOptions, bez uruchamiania prawdziwego UI
function makeFakeQuickPick() {
    const onDidChangeSelectionEmitter = new vscode.EventEmitter<readonly FakeItem[]>();
    const onDidAcceptEmitter = new vscode.EventEmitter<void>();
    const onDidHideEmitter = new vscode.EventEmitter<void>();

    let items: readonly FakeItem[] = [];
    let selectedItems: readonly FakeItem[] = [];
    let disposed = false;

    const quickPick = {
        canSelectMany: false,
        title: '',
        placeholder: '',
        ignoreFocusOut: false,
        get items() { return items; },
        set items(value: readonly FakeItem[]) { items = value; },
        get selectedItems() { return selectedItems; },
        set selectedItems(value: readonly FakeItem[]) { selectedItems = value; },
        onDidChangeSelection: onDidChangeSelectionEmitter.event,
        onDidAccept: onDidAcceptEmitter.event,
        onDidHide: onDidHideEmitter.event,
        show: () => {},
        dispose: () => { disposed = true; },
    } as unknown as vscode.QuickPick<FakeItem>;

    return {
        quickPick,
        fireChangeSelection: (selection: readonly FakeItem[]) => onDidChangeSelectionEmitter.fire(selection),
        fireAccept: () => onDidAcceptEmitter.fire(),
        fireHide: () => onDidHideEmitter.fire(),
        isDisposed: () => disposed,
    };
}

// podmienia vscode.window.createQuickPick / showInputBox na czas jednego testu i gwarantowanie przywraca oryginały, nawet jeśli test rzuci wyjątkiem
async function withMockedWindow<T>(
    mocks: { createQuickPick?: () => vscode.QuickPick<any>; showInputBox?: (opts?: vscode.InputBoxOptions) => Thenable<string | undefined> },
    run: () => Promise<T>
): Promise<T> {
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const originalShowInputBox = vscode.window.showInputBox;

    if (mocks.createQuickPick) { (vscode.window as any).createQuickPick = mocks.createQuickPick; }
    if (mocks.showInputBox) { (vscode.window as any).showInputBox = mocks.showInputBox; }

    try {
        return await run();
    } finally {
        (vscode.window as any).createQuickPick = originalCreateQuickPick;
        (vscode.window as any).showInputBox = originalShowInputBox;
    }
}

// minimalny kontekst tabeli używany przez buildInsertSql - jedna kolumna PK (id) + jedna zwykła (name)
const columns = [
    { index: 0, name: 'id', field: undefined },
    { index: 1, name: 'name', field: undefined },
];
const primaryKeys = [{ index: 0, name: 'id', field: undefined }];
const qualifiedTable = '`users`';
const rows = [
    [1, 'Alice'],
    [2, 'Bob'],
    [3, "O'Brien"],
];

suite('SqlResultsProvider - buildInsertStatementPrefix (składnia MariaDB/MySQL)', () => {
    test('bez żadnych opcji: "INSERT INTO"', () => {
        const provider = getProvider() as any;
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set()), 'INSERT INTO');
    });

    test('IGNORE musi być za INSERT, przed INTO', () => {
        const provider = getProvider() as any;
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['ignore'])), 'INSERT IGNORE INTO');
    });

    test('LOW_PRIORITY/HIGH_PRIORITY/DELAYED też muszą być za INSERT, przed INTO (nie za INTO)', () => {
        const provider = getProvider() as any;
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['lowPriority'])), 'INSERT LOW_PRIORITY INTO');
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['highPriority'])), 'INSERT HIGH_PRIORITY INTO');
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['delayed'])), 'INSERT DELAYED INTO');
    });

    test('priority modifier + IGNORE: priority idzie przed IGNORE', () => {
        const provider = getProvider() as any;
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['lowPriority', 'ignore'])), 'INSERT LOW_PRIORITY IGNORE INTO');
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['highPriority', 'ignore'])), 'INSERT HIGH_PRIORITY IGNORE INTO');
    });

    test('replaceInto: "REPLACE INTO", bez modyfikatorów', () => {
        const provider = getProvider() as any;
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['replaceInto'])), 'REPLACE INTO');
    });

    test('replaceInto + lowPriority: REPLACE obsługuje LOW_PRIORITY/DELAYED', () => {
        const provider = getProvider() as any;
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['replaceInto', 'lowPriority'])), 'REPLACE LOW_PRIORITY INTO');
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['replaceInto', 'delayed'])), 'REPLACE DELAYED INTO');
    });

    test('replaceInto + highPriority + ignore: oba są niedozwolone dla REPLACE, więc muszą zniknąć', () => {
        const provider = getProvider() as any;
        assert.strictEqual(provider.buildInsertStatementPrefix(new Set(['replaceInto', 'highPriority', 'ignore'])), 'REPLACE INTO');
    });
});

suite('SqlResultsProvider - buildInsertSql (pełny generowany SQL)', () => {
    test('domyślnie (bez opcji): jeden statement, wszystkie wiersze w jednym VALUES', () => {
        const provider = getProvider() as any;
        const sql = provider.buildInsertSql(rows, columns, primaryKeys, qualifiedTable, new Set());

        assert.strictEqual(
            sql,
            "INSERT INTO `users` (`id`, `name`)\nVALUES\n(1, 'Alice'),\n(2, 'Bob'),\n(3, 'O''Brien');\n"
        );
    });

    test('IGNORE trafia do wygenerowanego prefiksu', () => {
        const provider = getProvider() as any;
        const sql = provider.buildInsertSql(rows, columns, primaryKeys, qualifiedTable, new Set(['ignore']));

        assert.ok(sql.startsWith('INSERT IGNORE INTO `users`'));
    });

    test('ON DUPLICATE KEY UPDATE aktualizuje kolumny spoza klucza głównego, pomijając PK', () => {
        const provider = getProvider() as any;
        const sql = provider.buildInsertSql(rows, columns, primaryKeys, qualifiedTable, new Set(['onDuplicateKeyUpdate']));

        assert.ok(sql.includes('ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)'));
        assert.ok(!sql.includes('`id` = VALUES(`id`)'));
    });

    test('REPLACE INTO ignoruje ON DUPLICATE KEY UPDATE (statement i tak nadpisuje cały wiersz)', () => {
        const provider = getProvider() as any;
        const sql = provider.buildInsertSql(rows, columns, primaryKeys, qualifiedTable, new Set(['replaceInto', 'onDuplicateKeyUpdate']));

        assert.ok(sql.startsWith('REPLACE INTO `users`'));
        assert.ok(!sql.includes('ON DUPLICATE KEY UPDATE'));
    });

    test('One INSERT per row: tyle statementów ile wierszy, każdy z jednym VALUES', () => {
        const provider = getProvider() as any;
        const sql = provider.buildInsertSql(rows, columns, primaryKeys, qualifiedTable, new Set(['oneRowPerStatement']));

        const statementCount = (sql.match(/INSERT INTO/g) ?? []).length;
        assert.strictEqual(statementCount, 3);
        assert.ok(sql.includes("VALUES\n(1, 'Alice');"));
        assert.ok(sql.includes("VALUES\n(2, 'Bob');"));
        assert.ok(sql.includes("VALUES\n(3, 'O''Brien');"));
    });

    test('Split into batches of N rows: dzieli na paczki, ostatnia paczka może być mniejsza (reszta z dzielenia)', () => {
        const provider = getProvider() as any;
        const sql = provider.buildInsertSql(rows, columns, primaryKeys, qualifiedTable, new Set(['batchSize']), 2);

        const statementCount = (sql.match(/INSERT INTO/g) ?? []).length;
        assert.strictEqual(statementCount, 2);
        assert.ok(sql.includes("(1, 'Alice'),\n(2, 'Bob');")); // pierwsza paczka: 2 wiersze
        assert.ok(sql.includes("VALUES\n(3, 'O''Brien');")); // druga paczka: 1 wiersz (reszta)
    });

    test('batchSize bez podanej liczby (undefined) nie dzieli na paczki - fallback do jednego statementu', () => {
        const provider = getProvider() as any;
        const sql = provider.buildInsertSql(rows, columns, primaryKeys, qualifiedTable, new Set(['batchSize']), undefined);

        const statementCount = (sql.match(/INSERT INTO/g) ?? []).length;
        assert.strictEqual(statementCount, 1);
    });

    test('Wrap in transaction: owija CAŁOŚĆ (nie każdy statement osobno) w START TRANSACTION / COMMIT', () => {
        const provider = getProvider() as any;
        const sql = provider.buildInsertSql(rows, columns, primaryKeys, qualifiedTable, new Set(['transaction', 'batchSize']), 2);

        assert.ok(sql.startsWith('START TRANSACTION;\n'));
        assert.ok(sql.trimEnd().endsWith('COMMIT;'));
        // dokładnie jedno wystąpienie START/COMMIT, mimo dwóch statementów wewnątrz
        assert.strictEqual((sql.match(/START TRANSACTION/g) ?? []).length, 1);
        assert.strictEqual((sql.match(/COMMIT/g) ?? []).length, 1);
    });
});

suite('SqlResultsProvider - resolveInsertOptionGroupSelection (wzajemna wykluczalność grup)', () => {
    test('zaznaczenie drugiej opcji z tej samej grupy odznacza poprzednią, zostaje nowo dodana', () => {
        const provider = getProvider() as any;
        const result = provider.resolveInsertOptionGroupSelection(
            new Set(['lowPriority', 'highPriority']),
            new Set(['lowPriority'])
        );

        assert.deepStrictEqual([...result], ['highPriority']);
    });

    test('opcje z różnych grup nie wpływają na siebie nawzajem', () => {
        const provider = getProvider() as any;
        const result = provider.resolveInsertOptionGroupSelection(
            new Set(['ignore', 'lowPriority']),
            new Set()
        );

        assert.deepStrictEqual([...result].sort(), ['ignore', 'lowPriority']);
    });

    test('opcja bez grupy (np. transaction) nigdy nie jest usuwana', () => {
        const provider = getProvider() as any;
        const result = provider.resolveInsertOptionGroupSelection(
            new Set(['lowPriority', 'transaction']),
            new Set(['lowPriority'])
        );

        assert.deepStrictEqual([...result].sort(), ['lowPriority', 'transaction']);
    });

    test('odznaczenie opcji (bez konfliktu w grupie) nie jest ruszane', () => {
        const provider = getProvider() as any;
        const result = provider.resolveInsertOptionGroupSelection(new Set(), new Set(['lowPriority']));

        assert.deepStrictEqual([...result], []);
    });

    test('oneRowPerStatement i batchSize (grupa "batching") wykluczają się nawzajem', () => {
        const provider = getProvider() as any;
        const result = provider.resolveInsertOptionGroupSelection(
            new Set(['oneRowPerStatement', 'batchSize']),
            new Set(['oneRowPerStatement'])
        );

        assert.deepStrictEqual([...result], ['batchSize']);
    });
});

suite('SqlResultsProvider - pickInsertGenerationOptions (QuickPick + input box)', () => {
    test('domyślnie (brak zapamiętanego wyboru) QuickPick startuje z niczym zaznaczonym', async () => {
        const provider = getProvider() as any;
        provider._context = { workspaceState: makeFakeWorkspaceState() };

        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = provider.pickInsertGenerationOptions();
            assert.strictEqual(fake.quickPick.selectedItems.length, 0);

            fake.fireAccept();
            const result = await resultPromise;
            assert.deepStrictEqual([...result.ids], []);
        });
    });

    test('ostatnio zapamiętany wybór jest wstępnie zaznaczony przy kolejnym otwarciu', async () => {
        const provider = getProvider() as any;
        const workspaceState = makeFakeWorkspaceState();
        await workspaceState.update('generateInsertSql.selectedOptions', ['ignore', 'transaction']);
        provider._context = { workspaceState };

        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = provider.pickInsertGenerationOptions();
            const preSelectedIds = fake.quickPick.selectedItems.map((i: FakeItem) => i.optionId).sort();
            assert.deepStrictEqual(preSelectedIds, ['ignore', 'transaction']);

            fake.fireAccept();
            await resultPromise;
        });
    });

    test('anulowanie QuickPicka (Escape, bez accept) zwraca undefined', async () => {
        const provider = getProvider() as any;
        provider._context = { workspaceState: makeFakeWorkspaceState() };

        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = provider.pickInsertGenerationOptions();
            fake.fireHide();

            const result = await resultPromise;
            assert.strictEqual(result, undefined);
            assert.strictEqual(fake.isDisposed(), true);
        });
    });

    test('regresja: batchSize + input box działa poprawnie, nawet gdy otwarcie input boxa odpala onDidHide quickpicka', async () => {
        // to jest dokładnie bug, który wcześniej powodował, że "Split into batches" nic nie robiło - onDidHide (efekt uboczny
        // otwarcia inputboxa) wygrywał wyścig z resolve() z onDidAccept i cała operacja cicho kończyła się jako "anulowana"
        const provider = getProvider() as any;
        provider._context = { workspaceState: makeFakeWorkspaceState() };

        const fake = makeFakeQuickPick();
        await withMockedWindow(
            {
                createQuickPick: () => fake.quickPick,
                showInputBox: async () => {
                    fake.fireHide(); // symulujemy realne zachowanie VS Code: pokazanie inputboxa chowa bieżący quickpick
                    return '250';
                },
            },
            async () => {
                const resultPromise = provider.pickInsertGenerationOptions();
                fake.quickPick.selectedItems = [{ label: 'Split into batches of N rows', optionId: 'batchSize' }];
                fake.fireAccept();

                const result = await resultPromise;
                assert.notStrictEqual(result, undefined);
                assert.deepStrictEqual([...result.ids], ['batchSize']);
                assert.strictEqual(result.batchSize, 250);
            }
        );
    });

    test('anulowanie input boxa dla batchSize (Escape) nie przerywa całej operacji - po prostu odpada opcja batchSize', async () => {
        const provider = getProvider() as any;
        provider._context = { workspaceState: makeFakeWorkspaceState() };

        const fake = makeFakeQuickPick();
        await withMockedWindow(
            {
                createQuickPick: () => fake.quickPick,
                showInputBox: async () => undefined, // użytkownik nacisnął Escape w inputboxie
            },
            async () => {
                const resultPromise = provider.pickInsertGenerationOptions();
                fake.quickPick.selectedItems = [
                    { label: 'IGNORE', optionId: 'ignore' },
                    { label: 'Split into batches of N rows', optionId: 'batchSize' },
                ];
                fake.fireAccept();

                const result = await resultPromise;
                assert.notStrictEqual(result, undefined);
                assert.deepStrictEqual([...result.ids], ['ignore']);
                assert.strictEqual(result.batchSize, undefined);
            }
        );
    });

    test('wybrany zestaw opcji (bez batchSize) jest zapamiętywany w workspaceState pod kolejne otwarcie', async () => {
        const provider = getProvider() as any;
        const workspaceState = makeFakeWorkspaceState();
        provider._context = { workspaceState };

        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = provider.pickInsertGenerationOptions();
            fake.quickPick.selectedItems = [{ label: 'REPLACE INTO', optionId: 'replaceInto' }];
            fake.fireAccept();
            await resultPromise;
        });

        assert.deepStrictEqual(workspaceState.get('generateInsertSql.selectedOptions'), ['replaceInto']);
    });
});
