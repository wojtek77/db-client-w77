import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    buildUpdateSql,
    buildUpdateStatementPrefix,
    getDroppedUpdateOptions,
    pickUpdateGenerationOptions,
    resolveUpdateOptionGroupSelection,
} from '../sql/updateSqlGenerator.js';

// prosty in-memory fake globalState (implementuje vscode.Memento), wystarczający do przetestowania zapamiętywania ostatniego wyboru opcji generowania UPDATE
function makeFakeGlobalState(): vscode.Memento {
    const store = new Map<string, unknown>();
    return {
        get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
        update: async (key: string, value: unknown) => { store.set(key, value); },
        keys: () => [...store.keys()],
    } as vscode.Memento;
}

type FakeItem = vscode.QuickPickItem & { optionId?: string };

// fake QuickPick oparty o prawdziwe vscode.EventEmitter - odzwierciedla API używane przez pickUpdateGenerationOptions, bez uruchamiania prawdziwego UI
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

// minimalny kontekst tabeli używany przez buildUpdateSql - jedna kolumna PK (id) + jedna zwykła (name)
const columns = [
    { index: 0, name: 'id', field: undefined },
    { index: 1, name: 'name', field: undefined },
];
const primaryKeys = [{ index: 0, name: 'id', field: undefined }];
const compositePrimaryKeys = [
    { index: 0, name: 'id', field: undefined },
    { index: 2, name: 'tenant', field: undefined },
];
const qualifiedTable = '`users`';
const rows = [
    [1, 'Alice'],
    [2, 'Bob'],
    [3, "O'Brien"],
];

suite('updateSqlGenerator - buildUpdateStatementPrefix (składnia MariaDB/MySQL)', () => {
    test('bez żadnych opcji: "UPDATE"', () => {
        assert.strictEqual(buildUpdateStatementPrefix(new Set()), 'UPDATE');
    });

    test('IGNORE musi być za UPDATE, przed nazwą tabeli', () => {
        assert.strictEqual(buildUpdateStatementPrefix(new Set(['ignore'])), 'UPDATE IGNORE');
    });

    test('LOW_PRIORITY musi być za UPDATE, przed nazwą tabeli', () => {
        assert.strictEqual(buildUpdateStatementPrefix(new Set(['lowPriority'])), 'UPDATE LOW_PRIORITY');
    });

    test('LOW_PRIORITY + IGNORE: LOW_PRIORITY idzie przed IGNORE', () => {
        assert.strictEqual(buildUpdateStatementPrefix(new Set(['lowPriority', 'ignore'])), 'UPDATE LOW_PRIORITY IGNORE');
    });
});

suite('updateSqlGenerator - getDroppedUpdateOptions (ostrzeżenie o cicho gubionych opcjach)', () => {
    test('pojedynczy PK: nic nie jest gubione, niezależnie od opcji', () => {
        assert.deepStrictEqual(getDroppedUpdateOptions(new Set(['caseWhenSingleStatement', 'batchSize']), primaryKeys), []);
    });

    test('złożony PK + caseWhenSingleStatement: zgłasza opcję jako pominiętą', () => {
        const dropped = getDroppedUpdateOptions(new Set(['caseWhenSingleStatement']), compositePrimaryKeys);
        assert.strictEqual(dropped.length, 1);
        assert.strictEqual(dropped[0].id, 'caseWhenSingleStatement');
    });

    test('złożony PK + batchSize: zgłasza opcję jako pominiętą', () => {
        const dropped = getDroppedUpdateOptions(new Set(['batchSize']), compositePrimaryKeys);
        assert.strictEqual(dropped.length, 1);
        assert.strictEqual(dropped[0].id, 'batchSize');
    });

    test('złożony PK bez żadnej z tych opcji: nic do zgubienia', () => {
        assert.deepStrictEqual(getDroppedUpdateOptions(new Set(['ignore', 'transaction']), compositePrimaryKeys), []);
    });
});

suite('updateSqlGenerator - buildUpdateSql (pełny generowany SQL)', () => {
    test('domyślnie (bez opcji): jeden UPDATE na wiersz', () => {
        const sql = buildUpdateSql(rows, columns, primaryKeys, qualifiedTable, new Set());

        const statementCount = (sql.match(/UPDATE `users`/g) ?? []).length;
        assert.strictEqual(statementCount, 3);
        assert.ok(sql.includes("UPDATE `users`\nSET `name` = 'Alice'\nWHERE `id` = 1;"));
        assert.ok(sql.includes("SET `name` = 'O''Brien'\nWHERE `id` = 3;"));
    });

    test('IGNORE trafia do wygenerowanego prefiksu', () => {
        const sql = buildUpdateSql(rows, columns, primaryKeys, qualifiedTable, new Set(['ignore']));
        assert.ok(sql.startsWith('UPDATE IGNORE `users`'));
    });

    test('Combine into single UPDATE using CASE WHEN: jeden statement dla wszystkich wierszy', () => {
        const sql = buildUpdateSql(rows, columns, primaryKeys, qualifiedTable, new Set(['caseWhenSingleStatement']));

        const statementCount = (sql.match(/UPDATE `users`/g) ?? []).length;
        assert.strictEqual(statementCount, 1);
        assert.ok(sql.includes('SET `name` = CASE `id`'));
        assert.ok(sql.includes("WHEN 1 THEN 'Alice'"));
        assert.ok(sql.includes("WHEN 3 THEN 'O''Brien'"));
        assert.ok(sql.includes('WHERE `id` IN (1, 2, 3);'));
    });

    test('złożony PK + caseWhenSingleStatement: opcja jest cicho ignorowana, wraca jeden UPDATE na wiersz', () => {
        const compositeRows = [[1, 'Alice', 'acme'], [2, 'Bob', 'acme']];
        const compositeColumns = [
            { index: 0, name: 'id', field: undefined },
            { index: 1, name: 'name', field: undefined },
            { index: 2, name: 'tenant', field: undefined },
        ];

        const sql = buildUpdateSql(compositeRows, compositeColumns, compositePrimaryKeys, qualifiedTable, new Set(['caseWhenSingleStatement']));

        assert.ok(!sql.includes('CASE'));
        const statementCount = (sql.match(/UPDATE `users`/g) ?? []).length;
        assert.strictEqual(statementCount, 2);
        assert.ok(sql.includes('WHERE `id` = 1 AND `tenant` = \'acme\';'));
    });

    test('Split into batches of N rows: dzieli na paczki CASE WHEN, ostatnia paczka może być mniejsza (reszta z dzielenia)', () => {
        const sql = buildUpdateSql(rows, columns, primaryKeys, qualifiedTable, new Set(['batchSize']), 2);

        const statementCount = (sql.match(/UPDATE `users`/g) ?? []).length;
        assert.strictEqual(statementCount, 2);
        assert.ok(sql.includes('WHERE `id` IN (1, 2);')); // pierwsza paczka: 2 wiersze
        assert.ok(sql.includes('WHERE `id` IN (3);')); // druga paczka: 1 wiersz (reszta)
    });

    test('batchSize bez podanej liczby (undefined) nie dzieli na paczki - fallback do jednego UPDATE na wiersz', () => {
        const sql = buildUpdateSql(rows, columns, primaryKeys, qualifiedTable, new Set(['batchSize']), undefined);

        const statementCount = (sql.match(/UPDATE `users`/g) ?? []).length;
        assert.strictEqual(statementCount, 3);
    });

    test('Wrap in transaction: owija CAŁOŚĆ (nie każdy statement osobno) w START TRANSACTION / COMMIT', () => {
        const sql = buildUpdateSql(rows, columns, primaryKeys, qualifiedTable, new Set(['transaction', 'batchSize']), 2);

        assert.ok(sql.startsWith('START TRANSACTION;\n'));
        assert.ok(sql.trimEnd().endsWith('COMMIT;'));
        // dokładnie jedno wystąpienie START/COMMIT, mimo dwóch statementów wewnątrz
        assert.strictEqual((sql.match(/START TRANSACTION/g) ?? []).length, 1);
        assert.strictEqual((sql.match(/COMMIT/g) ?? []).length, 1);
    });
});

suite('updateSqlGenerator - resolveUpdateOptionGroupSelection (wzajemna wykluczalność grupy "batching")', () => {
    test('zaznaczenie drugiej opcji z tej samej grupy odznacza poprzednią, zostaje nowo dodana', () => {
        const result = resolveUpdateOptionGroupSelection(
            new Set(['caseWhenSingleStatement', 'batchSize']),
            new Set(['caseWhenSingleStatement'])
        );

        assert.deepStrictEqual([...result], ['batchSize']);
    });

    test('opcja bez grupy (np. transaction, ignore) nigdy nie jest usuwana', () => {
        const result = resolveUpdateOptionGroupSelection(
            new Set(['caseWhenSingleStatement', 'transaction', 'ignore']),
            new Set(['caseWhenSingleStatement'])
        );

        assert.deepStrictEqual([...result].sort(), ['caseWhenSingleStatement', 'ignore', 'transaction']);
    });

    test('odznaczenie opcji (bez konfliktu w grupie) nie jest ruszane', () => {
        const result = resolveUpdateOptionGroupSelection(new Set(), new Set(['caseWhenSingleStatement']));
        assert.deepStrictEqual([...result], []);
    });
});

suite('updateSqlGenerator - pickUpdateGenerationOptions (QuickPick + input box)', () => {
    test('domyślnie (brak zapamiętanego wyboru) QuickPick startuje z niczym zaznaczonym', async () => {
        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickUpdateGenerationOptions(makeFakeGlobalState());
            assert.strictEqual(fake.quickPick.selectedItems.length, 0);

            fake.fireAccept();
            const result = await resultPromise;
            assert.deepStrictEqual([...result!.ids], []);
        });
    });

    test('ostatnio zapamiętany wybór jest wstępnie zaznaczony przy kolejnym otwarciu', async () => {
        const globalState = makeFakeGlobalState();
        await globalState.update('generateUpdateSql.selectedOptions', ['ignore', 'transaction']);

        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickUpdateGenerationOptions(globalState);
            const preSelectedIds = fake.quickPick.selectedItems.map((i: FakeItem) => i.optionId).sort();
            assert.deepStrictEqual(preSelectedIds, ['ignore', 'transaction']);

            fake.fireAccept();
            await resultPromise;
        });
    });

    test('anulowanie QuickPicka (Escape, bez accept) zwraca undefined', async () => {
        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickUpdateGenerationOptions(makeFakeGlobalState());
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
                const resultPromise = pickUpdateGenerationOptions(makeFakeGlobalState());
                fake.quickPick.selectedItems = [{ label: 'Split into batches of N rows (CASE WHEN)', optionId: 'batchSize' }];
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
                const resultPromise = pickUpdateGenerationOptions(makeFakeGlobalState());
                fake.quickPick.selectedItems = [
                    { label: 'IGNORE', optionId: 'ignore' },
                    { label: 'Split into batches of N rows (CASE WHEN)', optionId: 'batchSize' },
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
            const resultPromise = pickUpdateGenerationOptions(globalState);
            fake.quickPick.selectedItems = [{ label: 'LOW_PRIORITY', optionId: 'lowPriority' }];
            fake.fireAccept();
            await resultPromise;
        });

        assert.deepStrictEqual(globalState.get('generateUpdateSql.selectedOptions'), ['lowPriority']);
    });

    test('undefined zamiast globalState (brak _context) nie wywala się - po prostu nic nie jest zapamiętywane', async () => {
        const fake = makeFakeQuickPick();
        await withMockedWindow({ createQuickPick: () => fake.quickPick }, async () => {
            const resultPromise = pickUpdateGenerationOptions(undefined);
            assert.strictEqual(fake.quickPick.selectedItems.length, 0);

            fake.quickPick.selectedItems = [{ label: 'IGNORE', optionId: 'ignore' }];
            fake.fireAccept();

            const result = await resultPromise;
            assert.deepStrictEqual([...result!.ids], ['ignore']);
        });
    });
});
