import * as vscode from "vscode";
import { SqlResultsProvider } from '../panel/SqlResultsProvider';
import { findCurrentQuery } from "../sql/findCurrentQuery";

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

    let sql = findCurrentQuery(fullText, currentLine);
    
    if (!sql || sql.trim() === '') {
        vscode.window.showWarningMessage('Nie znaleziono zapytania SQL pod kursorem');
        return;
    }
    
    const sqlResultsProvider = SqlResultsProvider.getInstance();
    if (sqlResultsProvider) {
        await sqlResultsProvider.executeQuery(sql);
    }
}
