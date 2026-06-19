import * as vscode from 'vscode';
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';

export async function runSqlWholeFileCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Nie masz otwartego edytora z kodem SQL');
        return;
    }

    const fullText = editor.document.getText();
    const sqlResultsProvider = SqlResultsProvider.getInstance();
    if (sqlResultsProvider) {
        await sqlResultsProvider.executeQuery(
            fullText,
            editor.document.fileName,
            true
        );
    }
}
