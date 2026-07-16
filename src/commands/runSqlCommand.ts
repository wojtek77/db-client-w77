import * as vscode from "vscode";
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';
import { findCurrentQuery } from "../sql/findCurrentQuery.js";
import { isExtensionRunning, safeStartExtension } from '../lifecycle/extensionLifecycle.js';

export async function runSQLCommand(context: vscode.ExtensionContext) {
    // Zabezpieczenie przed wyścigiem: jeśli plik .sql został otwarty i od razu
    // (Ctrl+Enter) uruchomiono zapytanie, handler startowy (onDidOpenTextDocument /
    // onDidChangeTabs) mógł jeszcze nie zdążyć ustawić kontekstu "dbClientActive"
    // na true. Bez tego kontekstu VS Code w ogóle nie utworzy webview (patrz
    // "when": "dbClientActive" w package.json), więc executeQuery() poniżej
    // kończyłoby się błędem "Failed to open the SQL results window.".
    // Dlatego tutaj jawnie czekamy na start, zamiast liczyć na to, że
    // zdążył się już wykonać w tle.
    if (!isExtensionRunning()) {
        await safeStartExtension(context);
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No open editor with SQL code');
        return;
    }
    
    // const fileName = editor.document.fileName;
    // if (!fileName.endsWith('.sql')) {
    //     vscode.window.showWarningMessage('Skrót Ctrl+Enter działa tylko dla plików .sql');
    //     return;
    // }
    
    const fullText = editor.document.getText();
    const currentLine = editor.selection.active.line; // Bezpośredni numer linii z VS Code

    let currentQuery = findCurrentQuery(fullText, currentLine);
    if (!currentQuery) {
        return;
    }
    const sql = currentQuery.sql;
    if (!sql || sql === '') {
        vscode.window.showWarningMessage('No SQL query found at cursor');
        return;
    }
    
    const sqlResultsProvider = SqlResultsProvider.getInstance();
    if (sqlResultsProvider) {
        await sqlResultsProvider.executeQuery(
            sql,
            editor.document.fileName
        );
    }
}
