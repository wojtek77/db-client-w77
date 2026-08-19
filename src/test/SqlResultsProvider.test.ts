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
