import * as vscode from 'vscode';
import { SqlResultsProvider } from './panel/SqlResultsProvider.js';
import { RecentSqlFiles } from './recentFiles/RecentSqlFiles.js';
import { isExtensionRunning, startExtension, stopExtension } from './lifecycle/extensionLifecycle.js';
import { TableCompletionProvider } from './completion/TableCompletionProvider.js';
import { runSQLCommand } from './commands/runSqlCommand.js';
import { openRecentFilesCommand } from './commands/openRecentFilesCommand.js';
import { formatSqlCommand } from './commands/formatSqlCommand.js';
import { runSqlWholeFileCommand } from './commands/runSqlWholeFileCommand.js';
import { ConnectionColors } from './db/ConnectionColors.js';


// Sprawdza, czy jakakolwiek otwarta zakładka to plik SQL
// (Tabs API widzi WSZYSTKIE otwarte zakładki, nie tylko tę aktualnie
// wyświetlaną w danej grupie edytorów - dzięki temu przełączenie się
// na inną zakładkę bez zamykania SQL-a nie jest mylone z zamknięciem).
function hasOpenSqlTab(): boolean {
    return vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .some(tab => {
            if (!(tab.input instanceof vscode.TabInputText)) {
                return false;
            }
            const doc = vscode.workspace.textDocuments.find(
                d => d.uri.toString() === (tab.input as vscode.TabInputText).uri.toString()
            );
            return doc?.languageId === 'sql';
        });
}

async function syncExtensionState(context: vscode.ExtensionContext) {
    const sqlTabOpen = hasOpenSqlTab();

    // otwarto pierwszy SQL editor
    if (sqlTabOpen && !isExtensionRunning()) {
        await startExtension(context);
    }

    // zamknięto ostatni SQL editor
    if (!sqlTabOpen && isExtensionRunning()) {
        await stopExtension(true);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // wczytanie listy plików SQL z dysku
    RecentSqlFiles.getInstance(context).restore();
    
    // inicjalizacja kolorów połączeń
    ConnectionColors.initialize(context);

    await startExtension(context);

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => syncExtensionState(context))
    );

    // Zakładka może pojawić się w tabGroups zanim jej TextDocument
    // (a więc languageId) zdąży się w pełni załadować - np. przy otwieraniu
    // pliku przez "Go to File" / Quick Open. Dlatego dokładamy drugi,
    // niezależny trigger: onDidOpenTextDocument odpala się dopiero, gdy
    // dokument (i jego languageId) są już gotowe, więc "dogania" stan,
    // gdyby poprzedni event odpalił się za wcześnie.
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(() => syncExtensionState(context))
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

    // komendy
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
    context.subscriptions.push(runSQL, openRecentFiles, runSqlWholeFile, formatSQL);
}

export function deactivate() {
    if (isExtensionRunning()) {
        stopExtension(false);
    }
}
