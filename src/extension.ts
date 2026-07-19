import * as vscode from 'vscode';
import { SqlResultsProvider } from './panel/SqlResultsProvider.js';
import { RecentSqlFiles } from './recentFiles/RecentSqlFiles.js';
import { checkFirstRunConfig, closeSqlFile, isExtensionRunning, safeStartExtension, startExtension, stopExtension } from './lifecycle/extensionLifecycle.js';
import { TableCompletionProvider } from './completion/TableCompletionProvider.js';
import { runSQLCommand } from './commands/runSqlCommand.js';
import { openRecentFilesCommand } from './commands/openRecentFilesCommand.js';
import { formatSqlCommand } from './commands/formatSqlCommand.js';
import { runSqlWholeFileCommand } from './commands/runSqlWholeFileCommand.js';
import { ConnectionColors } from './db/ConnectionColors.js';
import { ConnectionManager } from './db/ConnectionManager.js';
import {
    createConfigDirCommand,
    reloadConnectionsCommand,
    testConnectionCommand
} from './commands/connectionSetupCommands.js';


// Zwraca `fileName` (ten sam format kluczy, którego używa
// SqlResultsProvider._fileStates) każdej otwartej zakładki z plikiem SQL.
// (Tabs API widzi WSZYSTKIE otwarte zakładki, nie tylko tę aktualnie
// wyświetlaną w danej grupie edytorów - dzięki temu przełączenie się
// na inną zakładkę bez zamykania SQL-a nie jest mylone z zamknięciem).
//
// CELOWO nie korzystamy tu z `vscode.workspace.onDidCloseTextDocument` do
// wykrywania zamknięcia pliku (ani tutaj, ani nigdzie indziej) - ten event
// odpala się dopiero, gdy dokument nie jest już wyświetlany w ŻADNEJ
// zakładce/grupie edytorów, więc przy otwarciu tego samego pliku w kilku
// miejscach zamknięcie jednej zakładki go nie wywoła. Tabs API nie ma tego
// problemu - widzi zakładki wprost, więc to jedyne wiarygodne źródło prawdy
// o tym, co jest aktualnie otwarte (tak samo jak przy starcie/stopie
// rozszerzenia poniżej).
function getOpenSqlTabFiles(): Set<string> {
    const files = new Set<string>();

    for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) {
        if (!(tab.input instanceof vscode.TabInputText)) {
            continue;
        }
        const doc = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === (tab.input as vscode.TabInputText).uri.toString()
        );
        if (doc?.languageId === 'sql') {
            files.add(doc.fileName);
        }
    }

    return files;
}

// Pamięta, jakie pliki SQL były otwarte przy poprzednim przeliczeniu -
// potrzebne, żeby wykryć, które zakładki zniknęły (patrz handleTabsChanged).
let previousOpenSqlFiles = new Set<string>();

// Reaguje na zmiany zakładek - jedyne miejsce, które może wywołać stop.
// W typowym przepływie otwierania pliku dokument rejestruje się
// (onDidOpenTextDocument) ZANIM powstanie jego zakładka (ten event) -
// więc w chwili, gdy ten handler się odpala, dokument jest już
// zarejestrowany i getOpenSqlTabFiles() poprawnie go widzi. Nie potrzeba tu
// żadnego opóźnienia.
// Uruchamia rozszerzenie, a w razie błędu (np. brak katalogu konfiguracji
// przy pierwszym uruchomieniu) pokazuje przyjazny ekran zamiast surowego
// błędu aktywacji rozszerzenia.
async function handleTabsChanged(context: vscode.ExtensionContext) {
    const currentOpenSqlFiles = getOpenSqlTabFiles();
    const sqlTabOpen = currentOpenSqlFiles.size > 0;

    // pliki, które były otwarte przy poprzednim przeliczeniu, a teraz już nie
    // są w żadnej zakładce - ich zapisany stan wyników zapytań można wyczyścić.
    // Dotyczy to też przypadku, gdy zamykana jest ostatnia zakładka SQL (i za
    // chwilę wywołamy stopExtension) - to tylko szczególny przypadek zamknięcia
    // zakładki, więc powinien być obsłużony dokładnie tak samo jak każdy inny.
    for (const filePath of previousOpenSqlFiles) {
        if (!currentOpenSqlFiles.has(filePath)) {
            closeSqlFile(filePath);
        }
    }
    previousOpenSqlFiles = currentOpenSqlFiles;

    // otwarto pierwszy SQL editor
    if (sqlTabOpen && !isExtensionRunning()) {
        await safeStartExtension(context);
    }

    // zamknięto ostatni SQL editor
    if (!sqlTabOpen && isExtensionRunning()) {
        await stopExtension(true);
    }
}

// Reaguje na otwarcie dokumentu. W przeciwieństwie do handleTabsChanged,
// ten handler NIGDY nie wywołuje stopu - "dokument się otworzył" to zawsze
// jednoznacznie pozytywna informacja (coś przybyło, nic nie ubyło). Ufa
// bezpośrednio argumentowi `doc` z eventu zamiast przeliczać stan od nowa
// przez getOpenSqlTabFiles() - to celowe, bo przy typowym otwieraniu pliku ten
// event odpala się ZANIM jego zakładka zdąży się zarejestrować w tabGroups,
// więc getOpenSqlTabFiles() mógłby w tym momencie błędnie zwrócić puste i przez
// to wywołać niepotrzebny (a w praktyce realnie wykonywany) stop.
async function handleDocumentOpened(context: vscode.ExtensionContext, doc: vscode.TextDocument) {
    if (doc.languageId !== 'sql') {
        return;
    }

    if (!isExtensionRunning()) {
        await safeStartExtension(context);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // komendy - MUSZĄ być zarejestrowane PRZED jakimkolwiek wywołaniem
    const runSQL = vscode.commands.registerCommand('db-client.runSQL', async () => {
        await runSQLCommand(context);
    });
    const openRecentFiles = vscode.commands.registerCommand('db-client.openRecentFiles', async () => {
        await openRecentFilesCommand();
    });
    const runSqlWholeFile = vscode.commands.registerCommand('db-client.runSqlWholeFile', async () => {
        await runSqlWholeFileCommand(context);
    });
    const formatSQL = vscode.commands.registerCommand('db-client.formatSQL', async () => {
        await formatSqlCommand();
    });
    const createConfigDir = vscode.commands.registerCommand('db-client.createConfigDir', createConfigDirCommand);
    const reloadConnections = vscode.commands.registerCommand('db-client.reloadConnections', reloadConnectionsCommand);
    const testConnection = vscode.commands.registerCommand('db-client.testConnection', testConnectionCommand);
    context.subscriptions.push(
        runSQL, openRecentFiles, runSqlWholeFile, formatSQL,
        createConfigDir, reloadConnections, testConnection
    );

    // wczytanie listy plików SQL z dysku
    RecentSqlFiles.getInstance(context).restore();
    
    // inicjalizacja kolorów połączeń
    ConnectionColors.initialize(context);

    // Zapamiętanie stanu otwartych plików SQL PRZED ewentualnym startem -
    // handleTabsChanged (poniżej) porównuje się właśnie do tego stanu, więc
    // musi być zainicjalizowany zanim jakikolwiek event zdąży się odpalić.
    previousOpenSqlFiles = getOpenSqlTabFiles();

    // Start tylko, jeśli przy aktywacji jakiś plik SQL jest już otwarty
    // (np. VS Code przywrócił poprzednią sesję). W przeciwnym razie
    // rozszerzenie ma pozostać wyłączone i wystartować dopiero przez
    // handleTabsChanged/handleDocumentOpened.
    if (previousOpenSqlFiles.size > 0) {
        await safeStartExtension(context);
    }

    // Sprawdzenie braku konfiguracji (prompt o utworzeniu domyślnego
    // połączenia) - CELOWO tylko tutaj, raz na sesję VS Code, niezależnie
    // od tego czy jakiś plik .sql jest akurat otwarty. Dzięki temu
    // zamykanie/otwieranie plików .sql w trakcie sesji (co wielokrotnie
    // uruchamia/zatrzymuje samo rozszerzenie przez safeStartExtension) nie
    // odpala tego promptu ponownie.
    await checkFirstRunConfig();

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => handleTabsChanged(context))
    );

    // Zakładka może pojawić się w tabGroups zanim jej TextDocument
    // (a więc languageId) zdąży się w pełni załadować - np. przy otwieraniu
    // pliku przez "Go to File" / Quick Open. Dlatego dokładamy drugi,
    // niezależny trigger na start: onDidOpenTextDocument odpala się dopiero,
    // gdy dokument (i jego languageId) są już gotowe, więc "dogania" stan,
    // gdyby handleTabsChanged odpalił się za wcześnie.
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => handleDocumentOpened(context, doc))
    );
    
    SqlResultsProvider.initialize(context);
    const sqlResultsProvider = SqlResultsProvider.getInstance();
    
    // Zarejestruj WebviewViewProvider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'sqlResultsView',
            sqlResultsProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Zarejestruj provider autouzupełniania dla plików .sql
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: 'file', language: 'sql', pattern: '**/*.sql' },
            new TableCompletionProvider(),
            ' ', '.'
        )
    );
    
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document.languageId === 'sql') {
                sqlResultsProvider.showResultsForFile(editor.document.fileName);
            }
        })
    );
}

export function deactivate() {
    if (isExtensionRunning()) {
        stopExtension(false);
    }
}
