import * as assert from 'assert';
import * as vscode from 'vscode';
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';

// minimalny fake WebviewView - wystarczający do przetestowania hasOpenPanel/isFocusSqlTab bez uruchamiania prawdziwego panelu
function makeFakeWebviewView(initialVisible: boolean) {
    let visible = initialVisible;
    const onDidChangeVisibilityEmitter = new vscode.EventEmitter<void>();
    const onDidDisposeEmitter = new vscode.EventEmitter<void>();
    const onDidReceiveMessageEmitter = new vscode.EventEmitter<any>();

    const webview = {
        options: {},
        html: '',
        cspSource: 'fake-csp',
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: onDidReceiveMessageEmitter.event,
        postMessage: async () => true,
    } as unknown as vscode.Webview;

    const view = {
        viewType: 'test.sqlResults',
        webview,
        get visible() { return visible; },
        onDidChangeVisibility: onDidChangeVisibilityEmitter.event,
        onDidDispose: onDidDisposeEmitter.event,
        show: () => {},
    } as unknown as vscode.WebviewView;

    return {
        view,
        // symuluje przełączenie zakładki w panelu (SQL <-> Terminal) - odpowiada onDidChangeVisibility w prawdziwym vscode
        setVisible: (v: boolean) => { visible = v; onDidChangeVisibilityEmitter.fire(); },
        // symuluje realne zniszczenie widoku (np. odznaczenie w menu kontekstowym), nie zwykłe przełączenie zakładki
        disposeView: () => onDidDisposeEmitter.fire(),
    };
}

function getProvider(): SqlResultsProvider {
    const fakeContext = { extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext;
    return SqlResultsProvider.initialize(fakeContext);
}

suite('SqlResultsProvider - stan panelu (hasOpenPanel / isFocusSqlTab)', () => {

    test('domyślnie hasOpenPanel to false, dopóki panel nie został pokazany', () => {
        // uwaga: ten test musi wykonać się jako pierwszy w suicie - SqlResultsProvider to singleton dzielony między testami w tym pliku
        const provider = getProvider();
        assert.strictEqual(provider.hasOpenPanel, false);
    });

    test('gdy widok jest widoczny (zakładka "SQL" aktywna), isFocusSqlTab() zwraca true', () => {
        const provider = getProvider();
        const fake = makeFakeWebviewView(true);
        provider.resolveWebviewView(fake.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

        assert.strictEqual(provider.isFocusSqlTab(), true);
    });

    test('przełączenie zakładki panelu na "Terminal" (visible -> false) ustawia hasOpenPanel na null, a nie na false', () => {
        // to jest właśnie zachowanie dodane, żeby odróżnić "user jest na zakładce Terminal" od "panel faktycznie zamknięty"
        const provider = getProvider();
        const fake = makeFakeWebviewView(true);
        provider.resolveWebviewView(fake.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

        fake.setVisible(false);

        assert.strictEqual(provider.hasOpenPanel, null);
        assert.strictEqual(provider.isFocusSqlTab(), false);
    });

    test('powrót na zakładkę "SQL" (visible -> true) ustawia hasOpenPanel z powrotem na true', () => {
        const provider = getProvider();
        const fake = makeFakeWebviewView(true);
        provider.resolveWebviewView(fake.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

        fake.setVisible(false);
        fake.setVisible(true);

        assert.strictEqual(provider.hasOpenPanel, true);
        assert.strictEqual(provider.isFocusSqlTab(), true);
    });

    test('przy hasOpenPanel === null warunek zamykania panelu (hasOpenPanel && isFocusSqlTab()) jest fałszywy', () => {
        // dokładnie ten warunek jest używany w extension.ts i extensionLifecycle.ts do decydowania, czy zamknąć panel
        const provider = getProvider();
        const fake = makeFakeWebviewView(true);
        provider.resolveWebviewView(fake.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

        fake.setVisible(false);

        assert.strictEqual(Boolean(provider.hasOpenPanel && provider.isFocusSqlTab()), false);
    });

    test('znana luka: rzeczywiste zniszczenie widoku (onDidDispose) nie resetuje hasOpenPanel na false', () => {
        // udokumentowanie obecnego stanu, nie oczekiwanego zachowania docelowego - jeśli user zamknie cały panel
        // (a nie tylko przełączy zakładkę), hasOpenPanel zostaje true/null zamiast wrócić do false
        const provider = getProvider();
        const fake = makeFakeWebviewView(true);
        provider.resolveWebviewView(fake.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        // wymuszamy hasOpenPanel = true niezależnie od stanu z poprzednich testów, żeby ten test nie zależał od kolejności
        fake.setVisible(true);
        assert.strictEqual(provider.hasOpenPanel, true);

        fake.disposeView();

        assert.strictEqual(provider.hasOpenPanel, true);
    });
});

suite('SqlResultsProvider - large result search cancellation', () => {
    test('new search cancels the previous search and stale results do not overwrite the new results', async () => {
        const provider = getProvider() as any;

        // 20k rekordów gwarantuje oddanie sterowania event loop po pierwszych 10k rekordów
        const rows = Array.from({ length: 20000 }, (_, i) => ({
            key: i,
            data: [i % 2 === 0 ? 'aaa' : 'ddd']
        }));

        provider._headers = ['value'];
        provider._allRows = rows;

        provider._searchQuery = 'a';
        const firstSearch = provider.applySearchFilter();

        // pierwsze wyszukiwanie oddaje sterowanie po 10k rekordów, a nowa fraza je unieważnia
        provider._searchQuery = 'd';
        const secondSearch = provider.applySearchFilter();

        const [firstCompleted, secondCompleted] = await Promise.all([
            firstSearch,
            secondSearch,
        ]);

        assert.strictEqual(firstCompleted, false, 'pierwsze wyszukiwanie powinno zostać anulowane');
        assert.strictEqual(secondCompleted, true, 'drugie wyszukiwanie powinno zostać ukończone');
        assert.ok(provider._filteredEntries.length > 0);
        assert.ok(provider._filteredEntries.every((entry: any) => entry.data[0].includes('d')));
        assert.strictEqual(provider._filteredEntries.length, 10000);
    });

    test('clearing the active file cancels the running search', async () => {
        const provider = getProvider() as any;

        provider._headers = ['value'];
        provider._allRows = Array.from({ length: 20000 }, (_, i) => ({
            key: i,
            data: ['aaaa']
        }));
        provider._searchQuery = 'a';

        const search = provider.applySearchFilter();
        provider.clearActiveFile();

        const completed = await search;

        assert.strictEqual(completed, false);
        assert.strictEqual(provider._allRows.length, 0);
        assert.strictEqual(provider._filteredEntries, null);
        assert.strictEqual(provider._searchQuery, '');
    });
});

suite('SqlResultsProvider - applySort (sortowanie wielokolumnowe)', () => {

    test('pusta lista kryteriów -> naturalna kolejność z zapytania SQL (rosnąco po key), niezależnie od bieżącej kolejności _allRows', () => {
        const provider = getProvider() as any;

        provider._headers = ['value'];
        provider._allRows = [
            { key: 2, data: ['c'] },
            { key: 0, data: ['a'] },
            { key: 1, data: ['b'] },
        ];
        provider._sortCriteria = [];

        provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.key), [0, 1, 2]);
    });

    test('jedno kryterium, sortowanie liczbowe rosnąco', () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        provider._allRows = [
            { key: 0, data: [30] },
            { key: 1, data: [10] },
            { key: 2, data: [20] },
        ];
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];

        provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [10, 20, 30]);
    });

    test('jedno kryterium, sortowanie tekstowe malejąco z naturalnym porządkiem cyfr ("10" po "9", nie przed)', () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        provider._allRows = [
            { key: 0, data: ['item2'] },
            { key: 1, data: ['item10'] },
            { key: 2, data: ['item9'] },
        ];
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];

        provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), ['item10', 'item9', 'item2']);
    });

    test('NULL zawsze na końcu, niezależnie od kierunku sortowania (tak jak w Excelu)', () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        provider._allRows = [
            { key: 0, data: [null] },
            { key: 1, data: [5] },
            { key: 2, data: [null] },
            { key: 3, data: [1] },
        ];

        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider.applySort();
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [1, 5, null, null]);

        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        provider.applySort();
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [5, 1, null, null]);
    });

    test('dwa kryteria - drugie rozstrzyga remisy pierwszego (ORDER BY col0, col1)', () => {
        const provider = getProvider() as any;

        provider._headers = ['dept', 'name'];
        provider._allRows = [
            { key: 0, data: ['sales', 'bob'] },
            { key: 1, data: ['eng', 'zoe'] },
            { key: 2, data: ['sales', 'alice'] },
            { key: 3, data: ['eng', 'amy'] },
        ];
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'asc' },
        ];

        provider.applySort();

        assert.deepStrictEqual(
            provider._allRows.map((r: any) => r.data),
            [['eng', 'amy'], ['eng', 'zoe'], ['sales', 'alice'], ['sales', 'bob']]
        );
    });

    test('remis na wszystkich kryteriach naraz -> deterministyczny tie-break po key rosnąco (nie "cokolwiek było w _allRows przed sortowaniem")', () => {
        const provider = getProvider() as any;

        provider._headers = ['dept'];
        provider._allRows = [
            { key: 2, data: ['sales'] },
            { key: 0, data: ['sales'] },
            { key: 1, data: ['sales'] },
        ];
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];

        provider.applySort();

        // wszystkie trzy wiersze remisują na jedynym kryterium ('sales' === 'sales') -> applySort jawnie
        // tie-breakuje po key rosnąco (patrz ostatni `return a.key - b.key` w applySort), więc wynik to [0,1,2],
        // NIE oryginalna kolejność [2,0,1] sprzed wywołania - to świadomy wybór, nie efekt uboczny stabilności Array.sort
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.key), [0, 1, 2]);
    });
});

suite('SqlResultsProvider - toggleSort (budowanie listy kryteriów z kliknięć)', () => {

    test('zwykły klik na nieposortowanej kolumnie -> jedno kryterium asc', () => {
        const provider = getProvider() as any;
        provider._sortCriteria = [];

        provider.toggleSort(0, false);

        assert.deepStrictEqual(provider._sortCriteria, [{ columnIndex: 0, direction: 'asc' }]);
    });

    test('cykl zwykłych kliknięć na TEJ SAMEJ, jedynej posortowanej kolumnie: asc -> desc -> brak', () => {
        const provider = getProvider() as any;
        provider._sortCriteria = [];

        provider.toggleSort(0, false);
        assert.deepStrictEqual(provider._sortCriteria, [{ columnIndex: 0, direction: 'asc' }]);

        provider.toggleSort(0, false);
        assert.deepStrictEqual(provider._sortCriteria, [{ columnIndex: 0, direction: 'desc' }]);

        provider.toggleSort(0, false);
        assert.deepStrictEqual(provider._sortCriteria, []);
    });

    test('zwykły klik na INNEJ kolumnie niż aktualnie posortowana czyści resztę i zaczyna od nowa (nie kontynuuje cyklu tamtej kolumny)', () => {
        const provider = getProvider() as any;
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];

        provider.toggleSort(1, false);

        assert.deepStrictEqual(provider._sortCriteria, [{ columnIndex: 1, direction: 'asc' }]);
    });

    test('zwykły klik gdy aktywne jest WIELE kryteriów zawsze resetuje do jednego nowego kryterium, nawet jeśli klika się w kolumnę już obecną na liście', () => {
        const provider = getProvider() as any;
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'desc' },
        ];

        provider.toggleSort(1, false);

        assert.deepStrictEqual(provider._sortCriteria, [{ columnIndex: 1, direction: 'asc' }]);
    });

    test('Shift+klik na nowej kolumnie dokłada ją na końcu listy priorytetów, nie ruszając istniejących kryteriów', () => {
        const provider = getProvider() as any;
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];

        provider.toggleSort(1, true);

        assert.deepStrictEqual(provider._sortCriteria, [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'asc' },
        ]);
    });

    test('Shift+klik cyklu na kolumnie już obecnej na liście: asc -> desc -> usunięcie z listy (reszta kryteriów zostaje)', () => {
        const provider = getProvider() as any;
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'asc' },
        ];

        provider.toggleSort(1, true);
        assert.deepStrictEqual(provider._sortCriteria, [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'desc' },
        ]);

        provider.toggleSort(1, true);
        assert.deepStrictEqual(provider._sortCriteria, [{ columnIndex: 0, direction: 'asc' }]);
    });

    test('usunięcie kryterium spośród trzech zachowuje kolejność (priorytet) pozostałych', () => {
        const provider = getProvider() as any;
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'desc' },
            { columnIndex: 2, direction: 'asc' },
        ];

        // kolumna 1 jest już 'desc' -> kolejny Shift+klik ją usuwa
        provider.toggleSort(1, true);

        assert.deepStrictEqual(provider._sortCriteria, [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 2, direction: 'asc' },
        ]);
    });
});
