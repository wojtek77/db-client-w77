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
        const rows = Array.from({ length: 20000 }, (_, i) => [i % 2 === 0 ? 'aaa' : 'ddd']);

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
        assert.ok(provider._filteredIndices.length > 0);
        assert.ok(provider._filteredIndices.every((idx: number) => provider._allRows[idx][0].includes('d')));
        assert.strictEqual(provider._filteredIndices.length, 10000);
    });

    test('clearing the active file cancels the running search', async () => {
        const provider = getProvider() as any;

        provider._headers = ['value'];
        const rows = Array.from({ length: 20000 }, () => ['aaaa']);
        provider._allRows = rows;
        provider._searchQuery = 'a';

        const search = provider.applySearchFilter();
        provider.clearActiveFile();

        const completed = await search;

        assert.strictEqual(completed, false);
        assert.strictEqual(provider._allRows.length, 0);
        assert.strictEqual(provider._filteredIndices, null);
        assert.strictEqual(provider._searchQuery, '');
    });
});

suite('SqlResultsProvider - applySort (cache per kolumna + leniwe getSortedPageKeys, patrz buildColumnSortCache/sortPaging.ts/multiColumnSortPaging.ts)', () => {

    // provider to singleton dzielony między testami (patrz getProvider) - _sortColumnCache zbudowany przez jeden test PRZEŻYWA do
    // następnego, więc każdy test musi zacząć od setAllRows(), które go czyści; inaczej test mógłby po cichu użyć cache'a
    // zbudowanego na zupełnie innych danych przez poprzedni test w tym samym pliku.
    // UWAGA: applySort czyta WEJŚCIE z _allRows (niezmienna, jedyna kolejność) i tylko upewnia się, że cache kolumny najważniejszego
    // kryterium jest zbudowany - patrz applySort/getSortedPageKeys w prawdziwym kodzie. Nie ma już pełnej, materializowanej permutacji -
    // displayOrder() niżej woła DOKŁADNIE ten sam leniwy mechanizm, którego realnie używa sendPage per strona, tylko z pageSize = cała tablica.
    function setAllRows(provider: any, rows: any[][]) {
        provider._allRows = rows;
        provider._sortColumnCache = new Map();
    }

    // aktualna kolejność wyświetlania jako indeksy do provider._allRows, policzona leniwo (patrz getSortedPageKeys) - brak kryteriów daje naturalną kolejność (samą _allRows), zero pracy
    function displayOrder(provider: any): number[] {
        return provider.getSortedPageKeys(0, provider._allRows.length);
    }

    function sortedRows(provider: any): any[][] {
        return displayOrder(provider).map((i) => provider._allRows[i]);
    }

    function sortedValues(provider: any, columnIndex: number): any[] {
        return sortedRows(provider).map((row) => row[columnIndex]);
    }

    test('pusta lista kryteriów -> kolejność wyświetlania to bezpośrednio niezmienna _allRows (naturalna, index-ascending)', async () => {
        const provider = getProvider() as any;

        provider._headers = ['value'];
        setAllRows(provider, [['a'], ['b'], ['c']]);
        provider._sortCriteria = [];
        provider._sortKinds = ['string'];

        await provider.applySort();

        assert.deepStrictEqual(displayOrder(provider), [0, 1, 2]);
    });

    test('jedno kryterium NUMBER rosnąco (radix na Float64) - w tym liczby ujemne i ułamkowe, żeby sprawdzić sztuczkę bitową ze znakiem', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setAllRows(provider, [[30], [-10.5], [20], [0], [-0.001]]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['number'];

        await provider.applySort();

        assert.deepStrictEqual(sortedValues(provider, 0), [-10.5, -0.001, 0, 20, 30]);
    });

    test('jedno kryterium NUMBER malejąco', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setAllRows(provider, [[30], [10], [20]]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        provider._sortKinds = ['number'];

        await provider.applySort();

        assert.deepStrictEqual(sortedValues(provider, 0), [30, 20, 10]);
    });

    test('jedno kryterium STRING malejąco - CELOWO zwykły porządek leksykograficzny bez naturalnego sortowania cyfr, więc "item10" < "item2" < "item9"', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setAllRows(provider, [['item2'], ['item10'], ['item9']]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        provider._sortKinds = ['string'];

        await provider.applySort();

        assert.deepStrictEqual(sortedValues(provider, 0), ['item9', 'item2', 'item10']);
    });

    test('jedno kryterium STRING - stringi identyczne na pierwszych 8 znakach (ta sama grupa remisowa po radixie, STRING_RADIX_PREFIX_CHARS=8), różniące się dopiero dalej -> pełne porównanie w fallbacku musi je poprawnie rozróżnić', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setAllRows(provider, [['12345678-zzz'], ['12345678-aaa'], ['12345678-mmm']]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['string'];

        await provider.applySort();

        assert.deepStrictEqual(
            sortedValues(provider, 0),
            ['12345678-aaa', '12345678-mmm', '12345678-zzz']
        );
    });

    test('NULL jak w natywnym SQL ORDER BY (najmniejsza możliwa wartość) - pierwszy przy ASC, ostatni przy DESC - dla kind=number', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setAllRows(provider, [[null], [5], [null], [1]]);
        provider._sortKinds = ['number'];

        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        await provider.applySort();
        assert.deepStrictEqual(sortedValues(provider, 0), [null, null, 1, 5]);

        // ta sama _allRows, druga strona cache'a (patrz getSortedPageKeys) - nie trzeba nic resetować między wywołaniami
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        await provider.applySort();
        assert.deepStrictEqual(sortedValues(provider, 0), [5, 1, null, null]);
    });

    test('jedno kryterium DATE kind=date rosnąco - DATETIME z ułamkiem sekundy, zwykły DATE i "zerowy" DATE MySQL (0000-00-00 -> traktowany jako najmniejsza wartość)', async () => {
        const provider = getProvider() as any;

        provider._headers = ['d'];
        setAllRows(provider, [
            ['2024-06-15 10:23:45'],
            ['2024-06-15 10:23:45.500'],
            ['2023-01-01'],
            ['0000-00-00'],
            ['2024-06-15 10:23:44'],
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['date'];

        await provider.applySort();

        assert.deepStrictEqual(sortedValues(provider, 0), [
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
        setAllRows(provider, [['12:00:00'], ['-05:30:00'], ['100:00:00'], ['00:00:00']]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        provider._sortKinds = ['date'];

        await provider.applySort();

        assert.deepStrictEqual(sortedValues(provider, 0), ['100:00:00', '12:00:00', '00:00:00', '-05:30:00']);
    });

    test('kind=date rozpoznaje "same rok" wiele wierszy z rzędu bez wpadania w wolną ścieżkę stringową - wystarczy że wynik jest poprawnie posortowany', async () => {
        const provider = getProvider() as any;

        provider._headers = ['d'];
        setAllRows(provider, [
            ['2024-01-01 00:00:03'],
            ['2024-01-01 00:00:01'],
            ['2024-01-01 00:00:02'],
        ]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['date'];

        await provider.applySort();

        assert.deepStrictEqual(sortedValues(provider, 0), [
            '2024-01-01 00:00:01',
            '2024-01-01 00:00:02',
            '2024-01-01 00:00:03',
        ]);
    });

    test('NULL jak wyżej, ale dla kind=date', async () => {
        const provider = getProvider() as any;

        provider._headers = ['d'];
        setAllRows(provider, [[null], ['2024-06-01'], [null], ['2023-01-01']]);
        provider._sortKinds = ['date'];

        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        await provider.applySort();
        assert.deepStrictEqual(sortedValues(provider, 0), [null, null, '2023-01-01', '2024-06-01']);

        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        await provider.applySort();
        assert.deepStrictEqual(sortedValues(provider, 0), ['2024-06-01', '2023-01-01', null, null]);
    });

    test('dwa kryteria z kind=date (Shift+klik, getMultiColumnPageKeys łączy dwie kolumny) - drugie rozstrzyga remisy pierwszego', async () => {
        const provider = getProvider() as any;

        provider._headers = ['category', 'created_at'];
        setAllRows(provider, [
            ['a', '2024-06-02'],
            ['a', '2024-06-01'],
            ['b', '2024-01-01'],
        ]);
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'asc' },
        ];
        provider._sortKinds = ['string', 'date'];

        await provider.applySort();

        assert.deepStrictEqual(sortedRows(provider), [
            ['a', '2024-06-01'],
            ['a', '2024-06-02'],
            ['b', '2024-01-01'],
        ]);
    });

    test('NULL jak wyżej, ale dla kind=string', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        setAllRows(provider, [[null], ['b'], [null], ['a']]);
        provider._sortKinds = ['string'];

        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        await provider.applySort();
        assert.deepStrictEqual(sortedValues(provider, 0), [null, null, 'a', 'b']);

        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        await provider.applySort();
        assert.deepStrictEqual(sortedValues(provider, 0), ['b', 'a', null, null]);
    });

    test('dwa kryteria (Shift+klik, getMultiColumnPageKeys łączy dwie kolumny) - drugie rozstrzyga remisy pierwszego (ORDER BY col0, col1)', async () => {
        const provider = getProvider() as any;

        provider._headers = ['dept', 'name'];
        setAllRows(provider, [
            ['sales', 'bob'],
            ['eng', 'zoe'],
            ['sales', 'alice'],
            ['eng', 'amy'],
        ]);
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'asc' },
        ];
        provider._sortKinds = ['string', 'string'];

        await provider.applySort();

        assert.deepStrictEqual(
            sortedRows(provider),
            [['eng', 'amy'], ['eng', 'zoe'], ['sales', 'alice'], ['sales', 'bob']]
        );
    });

    test('remis na wszystkich kryteriach naraz -> deterministyczny tie-break po indeksie rosnąco, bo _allRows jest ZAWSZE index-ascending (gwarancja strukturalna, nie ponowne sortowanie w applySort)', async () => {
        const provider = getProvider() as any;

        provider._headers = ['dept'];
        setAllRows(provider, [['sales'], ['sales'], ['sales']]);
        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        provider._sortKinds = ['string'];

        await provider.applySort();

        // wszystkie trzy wiersze remisują na jedynym kryterium ('sales' === 'sales') -> wynik to naturalna (index-ascending) kolejność
        assert.deepStrictEqual(displayOrder(provider), [0, 1, 2]);
    });

    test('DESC z duplikatami wartości NIE odwraca ich wzajemnej kolejności (standard SQL, zweryfikowany w phpMyAdmin) - regresja na wcześniejszą, świadomie inną konwencję', async () => {
        const provider = getProvider() as any;

        provider._headers = ['n'];
        // wartości: 10 (idx0,idx2 - duplikat), 20 (idx1,idx4 - duplikat), 5 (idx3, unikat)
        setAllRows(provider, [[10], [20], [10], [5], [20]]);
        provider._sortKinds = ['number'];

        provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
        await provider.applySort();
        // ASC: 5(idx3), 10(idx0,idx2 - rosnąco po indeksie), 20(idx1,idx4 - rosnąco po indeksie)
        assert.deepStrictEqual(displayOrder(provider), [3, 0, 2, 1, 4]);

        provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
        await provider.applySort();
        // DESC: odwraca się tylko kolejność GRUP wartości (20, potem 10, potem 5) - wewnątrz każdej grupy idx0/idx2 i idx1/idx4
        // zostają w tej samej (rosnącej po indeksie) kolejności co przy ASC, NIE zamieniają się miejscami
        assert.deepStrictEqual(displayOrder(provider), [1, 4, 0, 2, 3]);
    });

    test('sortowanie wielokolumnowe: colA DESC (zmieniane), colB ASC (NIE zmieniane) - colB nie może zostać przypadkiem odwrócone razem z colA', async () => {
        const provider = getProvider() as any;

        provider._headers = ['colA', 'colB'];
        setAllRows(provider, [
            ['x', 2],
            ['y', 1],
            ['x', 1],
            ['y', 2],
        ]);
        provider._sortKinds = ['string', 'number'];

        // ORDER BY colA ASC, colB ASC - punkt odniesienia
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'asc' },
        ];
        await provider.applySort();
        assert.deepStrictEqual(sortedRows(provider), [['x', 1], ['x', 2], ['y', 1], ['y', 2]]);

        // ORDER BY colA DESC, colB ASC - użytkownik zmienił TYLKO kierunek colA (Shift+klik), colB zostaje ASC
        // naiwne "odwróć całą tablicę ASC" dałoby błędnie [['y',2],['y',1],['x',2],['x',1]] - colB wyszłoby DESC, mimo że nikt go nie ruszał
        provider._sortCriteria = [
            { columnIndex: 0, direction: 'desc' },
            { columnIndex: 1, direction: 'asc' },
        ];
        await provider.applySort();
        assert.deepStrictEqual(sortedRows(provider), [['y', 1], ['y', 2], ['x', 1], ['x', 2]]);
    });

    // uwaga: dawny test "klucze NIECIĄGŁE (symulacja stanu po usunięciu części wierszy)" został usunięty - taki stan jest teraz
    // strukturalnie niemożliwy: _allRows to zawsze świeża, gęsta tablica 0..n-1 (usunięcie wiersza zawsze wymusza pełny re-run
    // zapytania, patrz deleteRowsInDB), więc buildColumnSortCache zawsze widzi gęsty zakres indeksów 0..n-1

    test('stres-test radix vs Array.sort jako źródło prawdy: 5000 losowych liczb (w tym ujemne, ułamkowe) i 5000 losowych stringów o różnej długości', async () => {
        const N = 5000;

        // --- NUMBER ---
        {
            const provider = getProvider() as any;
            provider._headers = ['n'];
            const rows = Array.from({ length: N }, () => [(Math.random() - 0.5) * 1_000_000]);
            setAllRows(provider, rows.slice());
            provider._sortCriteria = [{ columnIndex: 0, direction: 'asc' }];
            provider._sortKinds = ['number'];

            await provider.applySort();

            const expected = rows.slice().sort((a, b) => a[0] - b[0]).map((r) => r[0]);
            assert.deepStrictEqual(sortedValues(provider, 0), expected);
        }

        // --- STRING ---
        {
            const provider = getProvider() as any;
            provider._headers = ['s'];
            const randomString = () => Math.random().toString(36).slice(2, 2 + Math.ceil(Math.random() * 15));
            const rows = Array.from({ length: N }, () => [randomString()]);
            setAllRows(provider, rows.slice());
            provider._sortCriteria = [{ columnIndex: 0, direction: 'desc' }];
            provider._sortKinds = ['string'];

            await provider.applySort();

            const expected = rows.slice().sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)).map((r) => r[0]);
            assert.deepStrictEqual(sortedValues(provider, 0), expected);
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
        const meta = ['TINY', 'SHORT', 'INT', 'INT24', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR']
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
