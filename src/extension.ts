import * as vscode from 'vscode';
import { SqlResultsProvider } from './panel/SqlResultsProvider';
import { RecentSqlFiles } from './recentFiles/RecentSqlFiles';
import { isExtensionRunning, startExtension, stopExtension } from './lifecycle/extensionLifecycle';
import { TableCompletionProvider } from './completion/TableCompletionProvider';
import { runSQLCommand } from './commands/runSqlCommand';
import { openRecentFilesCommand } from './commands/openRecentFilesCommand';
import { formatSqlCommand } from './commands/formatSqlCommand';
import { ConnectionColors } from './db/ConnectionColors';


let previousSqlEditors = 0;
let stopTimeout: NodeJS.Timeout | undefined;


export async function activate(context: vscode.ExtensionContext) {
    console.log(new Date().toLocaleTimeString('pl-PL', { hour12: false }));
    
    // wczytanie listy plików SQL z dysku
    RecentSqlFiles.getInstance(context).restore();
    
    // inicjalizacja kolorów połączeń
    ConnectionColors.initialize(context);
    
    previousSqlEditors = vscode.window.visibleTextEditors.filter(
        e => e.document.languageId === 'sql'
    ).length;

    // if (previousSqlEditors > 0) {
        await startExtension(context);
    // }

    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(async (editors) => {

        const currentSqlEditors = editors.filter(e =>
            e.document.languageId === 'sql'
        ).length;

        // anuluj pending STOP
        if (stopTimeout) {
            clearTimeout(stopTimeout);
            stopTimeout = undefined;
        }

        // otwarto pierwszy SQL editor
        if (previousSqlEditors === 0 && currentSqlEditors > 0) {

            console.log('First SQL editor opened');

            if (!isExtensionRunning()) {
                await startExtension(context);
            }
        }

        // zamknięto ostatni SQL editor
        if (previousSqlEditors > 0 && currentSqlEditors === 0) {

                stopTimeout = setTimeout(() => {

                    const stillNoEditors =
                        vscode.window.visibleTextEditors.filter(
                            e => e.document.languageId === 'sql'
                        ).length === 0;

                    if (stillNoEditors) {

                        console.log('All SQL editors closed');

                        if (isExtensionRunning()) {
                            stopExtension(true);
                        }
                    }

                }, 150);
            }

            previousSqlEditors = currentSqlEditors;
        })
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
    const formatSQL = vscode.commands.registerCommand('db-client.formatSQL', async () => {
        await formatSqlCommand();
    });
    context.subscriptions.push(runSQL, openRecentFiles, formatSQL);
}

export function deactivate() {
    if (isExtensionRunning()) {
        stopExtension(false);
    }
}
