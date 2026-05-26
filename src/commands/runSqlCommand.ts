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
    const cursorPosition = editor.selection.active;
    const offset = editor.document.offsetAt(cursorPosition);
    
    let sql = findCurrentQuery(fullText, offset);
    
    if (!sql || sql.trim() === '') {
        vscode.window.showWarningMessage('Nie znaleziono zapytania SQL pod kursorem');
        return;
    }
    
    const sqlResultsProvider = SqlResultsProvider.getInstance();
    if (sqlResultsProvider) {
        await sqlResultsProvider.executeQuery(sql);
    }
}
