import * as vscode from 'vscode';
import { SqlResultsProvider } from './panel/SqlResultsProvider.js';
import { RecentSqlFiles } from './recentFiles/RecentSqlFiles.js';
import { checkFirstRunConfig, closeSqlFile, isExtensionRunning, safeStartExtension, stopExtension } from './lifecycle/extensionLifecycle.js';
import { TableCompletionProvider } from './completion/TableCompletionProvider.js';
import { runSQLCommand } from './commands/runSqlCommand.js';
import { openRecentFilesCommand } from './commands/openRecentFilesCommand.js';
import { formatSqlCommand } from './commands/formatSqlCommand.js';
import { runSqlWholeFileCommand } from './commands/runSqlWholeFileCommand.js';
import { ConnectionColors } from './db/ConnectionColors.js';
import {
    createConfigDirCommand,
    reloadConnectionsCommand,
    testConnectionCommand
} from './commands/connectionSetupCommands.js';


// zwraca fileName każdej otwartej zakładki SQL (Tabs API widzi wszystkie zakładki, nie tylko aktualnie wyświetlaną)
// celowo bez onDidCloseTextDocument – odpala się dopiero gdy dokument zniknie ze wszystkich zakładek naraz
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

// pamięta, jakie pliki SQL były otwarte przy poprzednim przeliczeniu – potrzebne do wykrycia zniknięcia zakładek (patrz handleTabsChanged)
let previousOpenSqlFiles = new Set<string>();

// reaguje na zmiany zakładek – jedyne miejsce, które może wywołać stop; dokument rejestruje się przed powstaniem zakładki, więc bez opóźnienia
// uruchamia rozszerzenie, a w razie błędu (np. brak katalogu konfiguracji) pokazuje przyjazny ekran zamiast surowego błędu aktywacji
async function handleTabsChanged() {
    const currentOpenSqlFiles = getOpenSqlTabFiles();
    const sqlTabOpen = currentOpenSqlFiles.size > 0;

    // pliki, które zniknęły ze wszystkich zakładek – ich zapisany stan wyników można wyczyścić (dotyczy też zamknięcia ostatniej zakładki SQL)
    for (const filePath of previousOpenSqlFiles) {
        if (!currentOpenSqlFiles.has(filePath)) {
            closeSqlFile(filePath);
        }
    }
    previousOpenSqlFiles = currentOpenSqlFiles;

    // otwarto pierwszy SQL editor
    if (sqlTabOpen && !isExtensionRunning()) {
        await safeStartExtension();
    }

    // zamknięto ostatni SQL editor
    if (!sqlTabOpen && isExtensionRunning()) {
        await stopExtension(true);
    }
}

// reaguje na otwarcie dokumentu, nigdy nie wywołuje stopu – ufa argumentowi `doc`, bo zakładka mogłaby jeszcze nie być zarejestrowana w tabGroups
async function handleDocumentOpened(doc: vscode.TextDocument) {
    if (doc.languageId !== 'sql') {
        return;
    }

    if (!isExtensionRunning()) {
        await safeStartExtension();
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // komendy - MUSZĄ być zarejestrowane PRZED jakimkolwiek wywołaniem
    const runSQL = vscode.commands.registerCommand('db-client.runSQL', async () => {
        await runSQLCommand();
    });
    const openRecentFiles = vscode.commands.registerCommand('db-client.openRecentFiles', async () => {
        await openRecentFilesCommand();
    });
    const runSqlWholeFile = vscode.commands.registerCommand('db-client.runSqlWholeFile', async () => {
        await runSqlWholeFileCommand();
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

    // zapamiętanie stanu plików SQL przed ewentualnym startem – handleTabsChanged porównuje się do tego stanu, musi być gotowe zanim odpali się event
    previousOpenSqlFiles = getOpenSqlTabFiles();

    // start tylko gdy przy aktywacji jakiś plik SQL jest już otwarty, inaczej rozszerzenie startuje dopiero przez handleTabsChanged/handleDocumentOpened
    if (previousOpenSqlFiles.size > 0) {
        await safeStartExtension();
    }

    // sprawdzenie braku konfiguracji (prompt o połączeniu) celowo tylko tutaj, raz na sesję VS Code, żeby otwieranie/zamykanie plików .sql go nie powtarzało
    await checkFirstRunConfig();

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => handleTabsChanged())
    );

    // zakładka może pojawić się w tabGroups zanim languageId się załaduje, więc onDidOpenTextDocument to drugi trigger na wypadek zbyt wczesnego eventu
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => handleDocumentOpened(doc))
    );
    
    SqlResultsProvider.initialize(context);
    const sqlResultsProvider = SqlResultsProvider.getInstance();
    
    // zarejestruj WebviewViewProvider
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

    // zarejestruj provider autouzupełniania dla plików .sql
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: 'file', language: 'sql', pattern: '**/*.sql' },
            new TableCompletionProvider(),
            ' ', '.'
        )
    );
    
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (!editor) {
                // editor === undefined: fokus poszedł gdzie indziej (np. w sam panel albo w Terminal) - celowo ignorujemy, żeby nie zamykać panelu spod klikającego w niego usera; przypadek "zamknięto ostatnią zakładkę SQL" i tak obsługuje stopExtension w extensionLifecycle.ts
                return;
            }
            if (editor.document.languageId === 'sql' && sqlResultsProvider.hasResultsForFile(editor.document.fileName)) {
                // panel wracamy tylko dla plików, na których wcześniej faktycznie odpalono SQL
                sqlResultsProvider.showResultsForFile(editor.document.fileName);
                if (sqlResultsProvider.hasOpenPanel !== null) {
                    // hasOpenPanel === null oznacza, że w panelu aktywna jest zakładka "Terminal" - wtedy nie podbijamy z powrotem zakładki "SQL"
                    await sqlResultsProvider.show({ preserveFocus: true });
                    sqlResultsProvider.hasOpenPanel = true;
                }
            } else {
                sqlResultsProvider.clearActiveFile();
                // zamknięcie panelu
                if (sqlResultsProvider.hasOpenPanel && sqlResultsProvider.isFocusSqlTab()) {
                    await vscode.commands.executeCommand('workbench.action.closePanel');
                    sqlResultsProvider.hasOpenPanel = false;
                }
            }
        })
    );
}

export function deactivate() {
    if (isExtensionRunning()) {
        stopExtension(false);
    }
}
