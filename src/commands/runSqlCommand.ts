import * as vscode from "vscode";
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';
import { findCurrentQuery } from "../sql/findCurrentQuery.js";
import { isExtensionRunning, safeStartExtension } from '../lifecycle/extensionLifecycle.js';

export async function runSQLCommand() {
    // zabezpieczenie przed wyścigiem: handler startowy mógł nie zdążyć ustawić 'dbClientActive' przed Ctrl+Enter, więc jawnie czekamy na start
    if (!isExtensionRunning()) {
        await safeStartExtension();
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
    
    const sqlResultsProvider = SqlResultsProvider.getInstance();
    if (!sqlResultsProvider) {
        return;
    }

    // jest zaznaczenie - wykonaj dokładnie zaznaczony tekst tą samą ścieżką co run whole file (findAllQueries + transakcja w executeQueryWholeFile)
    if (!editor.selection.isEmpty) {
        const selectedText = editor.document.getText(editor.selection);
        await sqlResultsProvider.executeQuery(
            selectedText,
            editor.document.fileName,
            true
        );
        return;
    }

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

    await sqlResultsProvider.executeQuery(
        sql,
        editor.document.fileName
    );
}
