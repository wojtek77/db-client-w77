import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    buildDeleteSql,
    buildDeleteStatementPrefix,
    pickDeleteGenerationOptions,
    resolveDeleteOptionGroupSelection,
} from '../sql/deleteSqlGenerator.js';

// prosty in-memory fake globalState (implementuje vscode.Memento), wystarczający do przetestowania zapamiętywania ostatniego wyboru opcji generowania DELETE
function makeFakeGlobalState(): vscode.Memento {
    const store = new Map<string, unknown>();
    return {
        get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
        update: async (key: string, value: unknown) => { store.set(key, value); },
        keys: () => [...store.keys()],
    } as vscode.Memento;
}

type FakeItem = vscode.QuickPickItem & { optionId?: string };

// fake QuickPick oparty o prawdziwe vscode.EventEmitter - odzwierciedla API używane przez pickDeleteGenerationOptions, bez uruchamiania prawdziwego UI
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

// minimalny kontekst tabeli używany przez buildDeleteSql - jedna kolumna PK (id)
const primaryKeys = [{ index: 0, name: 'id', field: undefined }];
const compositePrimaryKeys = [
    { index: 0, name: 'id', field: undefined },
    { index: 1, name: 'tenant', field: undefined },
];
const qualifiedTable = '`users`';
const rows = [
    [1, 'Alice'],
    [2, 'Bob'],
    [3, "O'Brien"],
];

suite('deleteSqlGenerator - buildDeleteStatementPrefix (składnia MariaDB/MySQL)', () => {
    test('bez żadnych opcji: "DELETE FROM"', () => {
        assert.strictEqual(buildDeleteStatementPrefix(new Set()), 'DELETE FROM');
    });

    test('LOW_PRIORITY musi być za DELETE, przed FROM', () => {
        assert.strictEqual(buildDeleteStatementPrefix(new Set(['lowPriority'])), 'DELETE LOW_PRIORITY FROM');
    });

    test('QUICK musi być za DELETE, przed FROM', () => {
        assert.strictEqual(buildDeleteStatementPrefix(new Set(['quick'])), 'DELETE QUICK FROM');
    });

    test('IGNORE musi być za DELETE, przed FROM', () => {
        assert.strictEqual(buildDeleteStatementPrefix(new Set(['ignore'])), 'DELETE IGNORE FROM');
    });

    test('LOW_PRIORITY + QUICK + IGNORE: w tej kolejności, wszystkie przed FROM', () => {
        assert.strictEqual(
            buildDeleteStatementPrefix(new Set(['ignore', 'quick', 'lowPriority'])),
            'DELETE LOW_PRIORITY QUICK IGNORE FROM'
        );
    });
});

suite('deleteSqlGenerator - buildDeleteSql (pełny generowany SQL)', () => {
    test('domyślnie (bez opcji): jeden statement, wszystkie wiersze w jednym WHERE ... IN (...)', () => {
        const sql = buildDeleteSql(rows, primaryKeys, qualifiedTable, new Set());

        assert.strictEqual(
            sql,
            "DELETE FROM `users`\nWHERE `id` IN (1, 2, 3);\n"
        );
    });

    test('IGNORE trafia do wygenerowanego prefiksu', () => {
        const sql = buildDeleteSql(rows, primaryKeys, qualifiedTable, new Set(['ignore']));
        assert.ok(sql.startsWith('DELETE IGNORE FROM `users`'));
    });

    test('złożony klucz główny: WHERE (pk1, pk2) IN ((...), (...))', () => {
        const compositeRows = [[1, 'acme'], [2, 'acme']];
        const sql = buildDeleteSql(compositeRows, compositePrimaryKeys, qualifiedTable, new Set());

        assert.ok(sql.includes('WHERE (`id`, `tenant`) IN ((1, \'acme\'), (2, \'acme\'));'));
    });

    test('One DELETE per row: osobny statement dla każdego wiersza', () => {
        const sql = buildDeleteSql(rows, primaryKeys, qualifiedTable, new Set(['oneRowPerStatement']));

        const statementCount = (sql.match(/DELETE FROM `users`/g) ?? []).length;
        assert.strictEqual(statementCount, 3);
        assert.ok(sql.includes('WHERE `id` IN (1);'));
        assert.ok(sql.includes('WHERE `id` IN (2);'));
        assert.ok(sql.includes("WHERE `id` IN (3);"));
    });

    test('Split into batches of N rows: dzieli na paczki, ostatnia paczka może być mniejsza (reszta z dzielenia)', () => {
        const sql = buildDeleteSql(rows, primaryKeys, qualifiedTable, new Set(['batchSize']), 2);

        const statementCount = (sql.match(/DELETE FROM `users`/g) ?? []).length;
        assert.strictEqual(statementCount, 2);
        assert.ok(sql.includes('WHERE `id` IN (1, 2);')); // pierwsza paczka: 2 wiersze
        assert.ok(sql.includes('WHERE `id` IN (3);')); // druga paczka: 1 wiersz (reszta)
    });

    test('batchSize bez podanej liczby (undefined) nie dzieli na paczki - fallback do jednego statementu', () => {
        const sql = buildDeleteSql(rows, primaryKeys, qualifiedTable, new Set(['batchSize']), undefined);

        const statementCount = (sql.match(/DELETE FROM `users`/g) ?? []).length;
        assert.strictEqual(statementCount, 1);
    });

    test('Wrap in transaction: owija CAŁOŚĆ (nie każdy statement osobno) w START TRANSACTION / COMMIT', () => {
        const sql = buildDeleteSql(rows, primaryKeys, qualifiedTable, new Set(['transaction', 'batchSize']), 2);

        assert.ok(sql.startsWith('START TRANSACTION;\n'));
        assert.ok(sql.trimEnd().endsWith('COMMIT;'));
        // dokładnie jedno wystąpienie START/COMMIT, mimo dwóch statementów wewnątrz
        assert.strictEqual((sql.match(/START TRANSACTION/g) ?? []).length, 1);
        assert.strictEqual((sql.match(/COMMIT/g) ?? []).length, 1);
    });
});

suite('deleteSqlGenerator - resolveDeleteOptionGroupSelection (wzajemna wykluczalność grupy "batching")', () => {
    test('zaznaczenie drugiej opcji z tej samej grupy odznacza poprzednią, zostaje nowo dodana', () => {
        const result = resolveDeleteOptionGroupSelection(
            new Set(['oneRowPerStatement', 'batchSize']),
            new Set(['oneRowPerStatement'])
        );

        assert.deepStrictEqual([...result], ['batchSize']);
    });

    test('opcja bez grupy (np. transaction, ignore, quick) nigdy nie jest usuwana', () => {
        const result = resolveDeleteOptionGroupSelection(
            new Set(['oneRowPerStatement', 'transaction', 'ignore', 'quick']),
            new Set(['oneRowPerStatement'])
        );

        assert.deepStrictEqual([...result].sort(), ['ignore', 'oneRowPerStatement', 'quick', 'transaction']);
    });

    test('odznaczenie opcji (bez konfliktu w grupie) nie jest ruszane', () => {
        const result = resolveDeleteOptionGroupSelection(new Set(), new Set(['oneRowPerStatement']));
        assert.deepStrictEqual([...result], []);
    });
});

suite('deleteSqlGenerator - pickDeleteGenerationOptions (QuickPick + input box)', () => {
    test('domyślnie (brak zapamiętanego wyboru) QuickPick startuje z niczym zaznaczonym', async () => {
        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickDeleteGenerationOptions(makeFakeGlobalState());
            assert.strictEqual(fake.quickPick.selectedItems.length, 0);

            fake.fireAccept();
            const result = await resultPromise;
            assert.deepStrictEqual([...result!.ids], []);
        });
    });

    test('ostatnio zapamiętany wybór jest wstępnie zaznaczony przy kolejnym otwarciu', async () => {
        const globalState = makeFakeGlobalState();
        await globalState.update('generateDeleteSql.selectedOptions', ['ignore', 'transaction']);

        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickDeleteGenerationOptions(globalState);
            const preSelectedIds = fake.quickPick.selectedItems.map((i: FakeItem) => i.optionId).sort();
            assert.deepStrictEqual(preSelectedIds, ['ignore', 'transaction']);

            fake.fireAccept();
            await resultPromise;
        });
    });

    test('anulowanie QuickPicka (Escape, bez accept) zwraca undefined', async () => {
        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickDeleteGenerationOptions(makeFakeGlobalState());
            fake.fireHide();

            const result = await resultPromise;
            assert.strictEqual(result, undefined);
            assert.strictEqual(fake.isDisposed(), true);
        });
    });

    test('regresja: batchSize + input box działa poprawnie, nawet gdy otwarcie input boxa odpala onDidHide quickpicka', async () => {
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
                const resultPromise = pickDeleteGenerationOptions(makeFakeGlobalState());
                fake.quickPick.selectedItems = [{ label: 'Split into batches of N rows', optionId: 'batchSize' }];
                fake.fireAccept();

                const result = await resultPromise;
                assert.notStrictEqual(result, undefined);
                assert.deepStrictEqual([...result!.ids], ['batchSize']);
                assert.strictEqual(result!.batchSize, 250);
            }
        );
    });

    test('anulowanie input boxa dla batchSize (Escape) nie przerywa całej operacji - po prostu odpada opcja batchSize', async () => {
        const fake = makeFakeQuickPick();
        await withMockedWindow(
            {
                createQuickPick: () => fake.quickPick,
                showInputBox: async () => undefined, // użytkownik nacisnął Escape w inputboxie
            },
            async () => {
                const resultPromise = pickDeleteGenerationOptions(makeFakeGlobalState());
                fake.quickPick.selectedItems = [
                    { label: 'IGNORE', optionId: 'ignore' },
                    { label: 'Split into batches of N rows', optionId: 'batchSize' },
                ];
                fake.fireAccept();

                const result = await resultPromise;
                assert.notStrictEqual(result, undefined);
                assert.deepStrictEqual([...result!.ids], ['ignore']);
                assert.strictEqual(result!.batchSize, undefined);
            }
        );
    });

    test('wybrany zestaw opcji (bez batchSize) jest zapamiętywany w globalState pod kolejne otwarcie', async () => {
        const globalState = makeFakeGlobalState();

        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickDeleteGenerationOptions(globalState);
            fake.quickPick.selectedItems = [{ label: 'QUICK', optionId: 'quick' }];
            fake.fireAccept();
            await resultPromise;
        });

        assert.deepStrictEqual(globalState.get('generateDeleteSql.selectedOptions'), ['quick']);
    });

    test('undefined zamiast globalState (brak _context) nie wywala się - po prostu nic nie jest zapamiętywane', async () => {
        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickDeleteGenerationOptions(undefined);
            assert.strictEqual(fake.quickPick.selectedItems.length, 0);

            fake.quickPick.selectedItems = [{ label: 'IGNORE', optionId: 'ignore' }];
            fake.fireAccept();

            const result = await resultPromise;
            assert.deepStrictEqual([...result!.ids], ['ignore']);
        });
    });
});
