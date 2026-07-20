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
async function handleTabsChanged(context: vscode.ExtensionContext) {
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
        await safeStartExtension(context);
    }

    // zamknięto ostatni SQL editor
    if (!sqlTabOpen && isExtensionRunning()) {
        await stopExtension(true);
    }
}

// reaguje na otwarcie dokumentu, nigdy nie wywołuje stopu – ufa argumentowi `doc`, bo zakładka mogłaby jeszcze nie być zarejestrowana w tabGroups
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

    // zapamiętanie stanu plików SQL przed ewentualnym startem – handleTabsChanged porównuje się do tego stanu, musi być gotowe zanim odpali się event
    previousOpenSqlFiles = getOpenSqlTabFiles();

    // start tylko gdy przy aktywacji jakiś plik SQL jest już otwarty, inaczej rozszerzenie startuje dopiero przez handleTabsChanged/handleDocumentOpened
    if (previousOpenSqlFiles.size > 0) {
        await safeStartExtension(context);
    }

    // sprawdzenie braku konfiguracji (prompt o połączeniu) celowo tylko tutaj, raz na sesję VS Code, żeby otwieranie/zamykanie plików .sql go nie powtarzało
    await checkFirstRunConfig();

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => handleTabsChanged(context))
    );

    // zakładka może pojawić się w tabGroups zanim languageId się załaduje, więc onDidOpenTextDocument to drugi trigger na wypadek zbyt wczesnego eventu
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => handleDocumentOpened(context, doc))
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
