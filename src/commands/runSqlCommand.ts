import * as vscode from "vscode";
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';
import { findCurrentQuery } from "../sql/findCurrentQuery.js";
import { isExtensionRunning, safeStartExtension } from '../lifecycle/extensionLifecycle.js';

export async function runSQLCommand(context: vscode.ExtensionContext) {
    // zabezpieczenie przed wyścigiem: handler startowy mógł nie zdążyć ustawić 'dbClientActive' przed Ctrl+Enter, więc jawnie czekamy na start
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
