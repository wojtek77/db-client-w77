import * as vscode from "vscode";
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';
import { findCurrentQuery } from "../sql/findCurrentQuery.js";

export async function runSQLCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Nie masz otwartego edytora z kodem SQL');
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
        vscode.window.showWarningMessage('Nie znaleziono zapytania SQL pod kursorem');
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
