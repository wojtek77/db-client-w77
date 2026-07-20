import * as vscode from 'vscode';
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';
import { isExtensionRunning, safeStartExtension } from '../lifecycle/extensionLifecycle.js';

export async function runSqlWholeFileCommand(context: vscode.ExtensionContext) {
    // patrz komentarz w runSqlCommand.ts – to samo zabezpieczenie przed wyścigiem z ustawieniem kontekstu 'dbClientActive'
    if (!isExtensionRunning()) {
        await safeStartExtension(context);
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No open editor with SQL code');
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
