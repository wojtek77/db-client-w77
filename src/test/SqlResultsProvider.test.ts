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

suite('SqlResultsProvider - applySort (cache per kolumna + composeSortOrder, patrz buildColumnSortCache/composeSortOrder)', () => {

    // provider to singleton dzielony między testami (patrz getProvider) - _sortColumnCache zbudowany przez jeden test PRZEŻYWA do
    // następnego, więc każdy test musi zacząć od setNaturalOrder(), które go czyści; inaczej test mógłby po cichu użyć cache'a
    // zbudowanego na zupełnie innych danych przez poprzedni test w tym samym pliku.
    // UWAGA: applySort czyta WEJŚCIE z _naturalOrderRows (nie z _allRows - to jest teraz tylko WYJŚCIE, patrz applySort), a końcowe
    // odwzorowanie key -> RowEntry czyta z _naturalOrderRowsByKey, więc trzeba je przeliczyć (rebuildNaturalOrderRowsByKey) po każdej
    // zmianie _naturalOrderRows - dokładnie tak, jak robi to executeQuery/showResultsForFile/deleteRowsInDB w prawdziwym kodzie.
    function setNaturalOrder(provider: any, rows: any[]) {
        provider._naturalOrderRows = rows;
        provider.rebuildNaturalOrderRowsByKey();
        provider._sortColumnCache = new Map();
    }

    test('pusta lista kryteriów -> naturalna kolejność z zapytania SQL (rosnąco po key), niezależnie od bieżącej kolejności _allRows', async () => {
        const provider = getProvider() as any;

        provider._headers = ['value'];
        // _allRows celowo w INNEJ kolejności niż _naturalOrderRows - applySort z pustymi kryteriami ma zignorować bieżące _allRows
        // i wrócić do _naturalOrderRows (key-ascending), zgodnie z tym, co ustaliliśmy: _allRows to tylko WYJŚCIE, nigdy źródło prawdy
        provider._allRows = [
            { key: 2, data: ['c'] },
            { key: 1, data: ['b'] },
            { key: 0, data: ['a'] },
        ];
        setNaturalOrder(provider, [
            { key: 0, data: ['a'] },
            { key: 1, data: ['b'] },
            { key: 2, data: ['c'] },
        ]);
        provider._sortCriteria = [];
        provider._sortKinds = ['string'];

        await provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.key), [0, 1, 2]);
    });

    test('jedno kryterium NUMBER rosnąco (radix na Float64) - w tym liczby ujemne i ułamkowe, żeby sprawdzić sztuczkę bitową ze znakiem', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setNaturalOrder(provider, [
            { key: 0, data: [30] },
            { key: 1, data: [-10.5] },
            { key: 2, data: [20] },
            { key: 3, data: [0] },
            { key: 4, data: [-0.001] },
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['number'];

        await provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [-10.5, -0.001, 0, 20, 30]);
    });

    test('jedno kryterium NUMBER malejąco', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setNaturalOrder(provider, [
            { key: 0, data: [30] },
            { key: 1, data: [10] },
            { key: 2, data: [20] },
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        provider._sortKinds = ['number'];

        await provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [30, 20, 10]);
    });

    test('jedno kryterium STRING malejąco - CELOWO zwykły porządek leksykograficzny bez naturalnego sortowania cyfr, więc "item10" < "item2" < "item9"', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setNaturalOrder(provider, [
            { key: 0, data: ['item2'] },
            { key: 1, data: ['item10'] },
            { key: 2, data: ['item9'] },
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        provider._sortKinds = ['string'];

        await provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), ['item9', 'item2', 'item10']);
    });

    test('jedno kryterium STRING - stringi identyczne na pierwszych 8 znakach (ta sama grupa remisowa po radixie, STRING_RADIX_PREFIX_CHARS=8), różniące się dopiero dalej -> pełne porównanie w fallbacku musi je poprawnie rozróżnić', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setNaturalOrder(provider, [
            { key: 0, data: ['12345678-zzz'] },
            { key: 1, data: ['12345678-aaa'] },
            { key: 2, data: ['12345678-mmm'] },
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['string'];

        await provider.applySort();

        assert.deepStrictEqual(
            provider._allRows.map((r: any) => r.data[0]),
            ['12345678-aaa', '12345678-mmm', '12345678-zzz']
        );
    });

    test('NULL jak w natywnym SQL ORDER BY (najmniejsza możliwa wartość) - pierwszy przy ASC, ostatni przy DESC - dla kind=number', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setNaturalOrder(provider, [
            { key: 0, data: [null] },
            { key: 1, data: [5] },
            { key: 2, data: [null] },
            { key: 3, data: [1] },
        ]);
        provider._sortKinds = ['number'];

        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        await provider.applySort();
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [null, null, 1, 5]);

        // ten sam _naturalOrderRows, druga strona cache'a (patrz composeSortOrder) - nie trzeba nic resetować między wywołaniami
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        await provider.applySort();
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [5, 1, null, null]);
    });

    test('jedno kryterium DATE kind=date rosnąco - DATETIME z ułamkiem sekundy, zwykły DATE i "zerowy" DATE MySQL (0000-00-00 -> traktowany jako najmniejsza wartość)', async () => {
        const provider = getProvider() as any;

        provider._headers = ['d'];
        setNaturalOrder(provider, [
            { key: 0, data: ['2024-06-15 10:23:45'] },
            { key: 1, data: ['2024-06-15 10:23:45.500'] },
            { key: 2, data: ['2023-01-01'] },
            { key: 3, data: ['0000-00-00'] },
            { key: 4, data: ['2024-06-15 10:23:44'] },
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['date'];

        await provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [
            '0000-00-00',
            '2023-01-01',
            '2024-06-15 10:23:44',
            '2024-06-15 10:23:45',
            '2024-06-15 10:23:45.500',
        ]);
    });

    test('jedno kryterium TIME kind=date malejąco - wartości ujemne i powyżej 24h dozwolone przez MariaDB/MySQL (zakres -838:59:59..838:59:59)', async () => {
        const provider = getProvider() as any;

        provider._headers = ['t'];
        setNaturalOrder(provider, [
            { key: 0, data: ['12:00:00'] },
            { key: 1, data: ['-05:30:00'] },
            { key: 2, data: ['100:00:00'] },
            { key: 3, data: ['00:00:00'] },
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        provider._sortKinds = ['date'];

        await provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), ['100:00:00', '12:00:00', '00:00:00', '-05:30:00']);
    });

    test('kind=date rozpoznaje "same rok" wiele wierszy z rzędu bez wpadania w wolną ścieżkę stringową - wystarczy że wynik jest poprawnie posortowany', async () => {
        const provider = getProvider() as any;

        provider._headers = ['d'];
        setNaturalOrder(provider, [
            { key: 0, data: ['2024-01-01 00:00:03'] },
            { key: 1, data: ['2024-01-01 00:00:01'] },
            { key: 2, data: ['2024-01-01 00:00:02'] },
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['date'];

        await provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [
            '2024-01-01 00:00:01',
            '2024-01-01 00:00:02',
            '2024-01-01 00:00:03',
        ]);
    });

    test('NULL jak wyżej, ale dla kind=date', async () => {
        const provider = getProvider() as any;

        provider._headers = ['d'];
        setNaturalOrder(provider, [
            { key: 0, data: [null] },
            { key: 1, data: ['2024-06-01'] },
            { key: 2, data: [null] },
            { key: 3, data: ['2023-01-01'] },
        ]);
        provider._sortKinds = ['date'];

        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        await provider.applySort();
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [null, null, '2023-01-01', '2024-06-01']);

        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        await provider.applySort();
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), ['2024-06-01', '2023-01-01', null, null]);
    });

    test('dwa kryteria z kind=date (Shift+klik, composeSortOrder łączy dwie kolumny) - drugie rozstrzyga remisy pierwszego', async () => {
        const provider = getProvider() as any;

        provider._headers = ['category', 'created_at'];
        setNaturalOrder(provider, [
            { key: 0, data: ['a', '2024-06-02'] },
            { key: 1, data: ['a', '2024-06-01'] },
            { key: 2, data: ['b', '2024-01-01'] },
        ]);
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'asc' },
        ];
        provider._sortKinds = ['string', 'date'];

        await provider.applySort();

        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data), [
            ['a', '2024-06-01'],
            ['a', '2024-06-02'],
            ['b', '2024-01-01'],
        ]);
    });

    test('NULL jak wyżej, ale dla kind=string', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setNaturalOrder(provider, [
            { key: 0, data: [null] },
            { key: 1, data: ['b'] },
            { key: 2, data: [null] },
            { key: 3, data: ['a'] },
        ]);
        provider._sortKinds = ['string'];

        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        await provider.applySort();
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), [null, null, 'a', 'b']);

        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        await provider.applySort();
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), ['b', 'a', null, null]);
    });

    test('dwa kryteria (Shift+klik, composeSortOrder łączy dwie kolumny) - drugie rozstrzyga remisy pierwszego (ORDER BY col0, col1)', async () => {
        const provider = getProvider() as any;

        provider._headers = ['dept', 'name'];
        setNaturalOrder(provider, [
            { key: 0, data: ['sales', 'bob'] },
            { key: 1, data: ['eng', 'zoe'] },
            { key: 2, data: ['sales', 'alice'] },
            { key: 3, data: ['eng', 'amy'] },
        ]);
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'asc' },
        ];
        provider._sortKinds = ['string', 'string'];

        await provider.applySort();

        assert.deepStrictEqual(
            provider._allRows.map((r: any) => r.data),
            [['eng', 'amy'], ['eng', 'zoe'], ['sales', 'alice'], ['sales', 'bob']]
        );
    });

    test('remis na wszystkich kryteriach naraz -> deterministyczny tie-break po key rosnąco, bo _naturalOrderRows jest ZAWSZE key-ascending (gwarancja strukturalna, nie ponowne sortowanie w applySort)', async () => {
        const provider = getProvider() as any;

        provider._headers = ['dept'];
        // UWAGA: w przeciwieństwie do starej wersji tego testu, _naturalOrderRows MUSI tu być podane w kolejności key-ascending -
        // to jest inwariant, na którym opiera się buildColumnSortCache (patrz komentarz przy tej metodzie) i który w prawdziwym
        // kodzie jest gwarantowany przez konstrukcję (executeQuery nadaje klucze sekwencyjnie w kolejności wierszy z zapytania).
        // Determinizm tie-breaku nie pochodzi już z jawnego sortowania po key WEWNĄTRZ applySort (jak w starym radixSortSingleColumn),
        // tylko z tego, że _naturalOrderRows z definicji nigdy nie jest "poprzestawiane" - patrz cała nasza wcześniejsza dyskusja
        setNaturalOrder(provider, [
            { key: 0, data: ['sales'] },
            { key: 1, data: ['sales'] },
            { key: 2, data: ['sales'] },
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['string'];

        await provider.applySort();

        // wszystkie trzy wiersze remisują na jedynym kryterium ('sales' === 'sales') -> wynik to naturalna (key-ascending) kolejność
        assert.deepStrictEqual(provider._allRows.map((r: any) => r.key), [0, 1, 2]);
    });

    test('stres-test radix vs Array.sort jako źródło prawdy: 5000 losowych liczb (w tym ujemne, ułamkowe) i 5000 losowych stringów o różnej długości', async () => {
        const N = 5000;

        // --- NUMBER ---
        {
            const provider = getProvider() as any;
            provider._headers = ['n'];
            const rows = Array.from({ length: N }, (_, i) => ({ key: i, data: [(Math.random() - 0.5) * 1_000_000] }));
            setNaturalOrder(provider, rows.slice());
            provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
            provider._sortKinds = ['number'];

            await provider.applySort();

            const expected = rows.slice().sort((a, b) => a.data[0] - b.data[0]).map((r) => r.data[0]);
            assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), expected);
        }

        // --- STRING ---
        {
            const provider = getProvider() as any;
            provider._headers = ['s'];
            const randomString = () => Math.random().toString(36).slice(2, 2 + Math.ceil(Math.random() * 15));
            const rows = Array.from({ length: N }, (_, i) => ({ key: i, data: [randomString()] }));
            setNaturalOrder(provider, rows.slice());
            provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
            provider._sortKinds = ['string'];

            await provider.applySort();

            const expected = rows.slice().sort((a, b) => (a.data[0] < b.data[0] ? 1 : a.data[0] > b.data[0] ? -1 : 0)).map((r) => r.data[0]);
            assert.deepStrictEqual(provider._allRows.map((r: any) => r.data[0]), expected);
        }
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

suite('SqlResultsProvider - computeSortKinds (mapowanie field.type z meta na NUMBER/STRING)', () => {

    test('typy numeryczne z NUMERIC_SORT_TYPE_NAMES -> number', () => {
        const provider = getProvider() as any;
        const meta = ['TINY', 'SHORT', 'LONG', 'INT24', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR']
            .map((type) => ({ type }));

        assert.deepStrictEqual(provider.computeSortKinds(meta), meta.map(() => 'number'));
    });

    test('CHAR/VARCHAR (raportowane przez driver jako VAR_STRING/STRING) i pozostałe typy -> string', () => {
        const provider = getProvider() as any;
        const meta = ['VARCHAR', 'VAR_STRING', 'STRING', 'JSON', 'ENUM', 'SET', 'BLOB']
            .map((type) => ({ type }));

        assert.deepStrictEqual(provider.computeSortKinds(meta), meta.map(() => 'string'));
    });

    test('DATE/DATETIME/TIMESTAMP/TIME z DATE_SORT_TYPE_NAMES -> date', () => {
        const provider = getProvider() as any;
        const meta = ['DATE', 'DATETIME', 'TIMESTAMP', 'TIME'].map((type) => ({ type }));

        assert.deepStrictEqual(provider.computeSortKinds(meta), meta.map(() => 'date'));
    });

    test('BIGINT konkretnie -> number (nie "LONGLONG" - to nieprawidłowa nazwa typu dla tego drivera, prawdziwa nazwa to BIGINT)', () => {
        const provider = getProvider() as any;
        assert.deepStrictEqual(provider.computeSortKinds([{ type: 'BIGINT' }]), ['number']);
        assert.deepStrictEqual(provider.computeSortKinds([{ type: 'LONGLONG' }]), ['string']);
    });

    test('typ zapisany małymi literami też jest rozpoznawany (String().toUpperCase())', () => {
        const provider = getProvider() as any;
        assert.deepStrictEqual(provider.computeSortKinds([{ type: 'bigint' }]), ['number']);
    });

    test('brakujące/puste field.type nie wysypuje się, domyślnie string', () => {
        const provider = getProvider() as any;
        assert.deepStrictEqual(provider.computeSortKinds([{}, { type: null }]), ['string', 'string']);
    });
});
