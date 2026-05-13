import * as vscode from 'vscode';
import { executeQuery } from '../db/query';
import { executeUpdate } from '../db/update';
import { SqlUtil } from '../db/SqlUtil';
import { getHtml } from './html';

export function registerPanelCommand(
    context: vscode.ExtensionContext,
    connectionTime: string,
    sql: string
) {

    let panel: vscode.WebviewPanel | undefined;

    return vscode.commands.registerCommand(
        'mariadb-client.openEditor',

        async () => {

            console.log('=== OPEN EDITOR START ===');
            
            const commandStart = performance.now();
    
            panel = vscode.window.createWebviewPanel(
                'dbEditor',
                'MariaDB Editor',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    enableCommandUris: true,
                    retainContextWhenHidden: true
                }
            );
    
            console.log('Panel created');
    
            sql = SqlUtil.appendLimit(sql.trim());
    
            const { rows, queryTime, success, errorMessage } = await executeQuery(sql);
            if (!success) {
                vscode.window.showErrorMessage(
                    'Błąd zapytania SQL: ' + errorMessage
                );
                return;
            }
    
            console.log('=== SETTING EMPTY WEBVIEW ===');
    
            panel.webview.html = getHtml(
                panel.webview,
                context.extensionPath,
                connectionTime,
                queryTime
            );
    
            console.log('=== SENDING DATA IN CHUNKS ===');
    
            const CHUNK_SIZE = 200;
    
            void (async () => {
    
                for (
                    let i = 0;
                    i < rows.length;
                    i += CHUNK_SIZE
                ) {
    
                    const chunk =
                        rows.slice(i, i + CHUNK_SIZE);
    
                    panel?.webview.postMessage({
                        command: 'appendData',
                        rows: chunk,
                        isLast:
                            i + CHUNK_SIZE >= rows.length
                    });
    
                    await new Promise(resolve =>
                        setTimeout(resolve, 0)
                    );
                }
    
            })();
    
            const totalTime = (
                performance.now() - commandStart
            ).toFixed(2);
    
            console.log(`=== TOTAL TIME: ${totalTime}ms`);
    
            vscode.window.showInformationMessage(
                `⏱️ Total: ${totalTime}ms | Query: ${queryTime}ms`
            );
    
            const messageDisposable = panel.webview.onDidReceiveMessage(async (message) => {
    
                if (message.command === 'updateCell') {
                    
                    const { id, column, value } = message;
                    const { updateTime, success, errorMessage } = await executeUpdate(id, column, value);
                    if (success) {
                        vscode.window.setStatusBarMessage(
                            `Zaktualizowano (${updateTime}ms)`,
                            3000
                        );
    
                        panel?.webview.postMessage({
                            command: 'updateConfirmed',
                            id,
                            column,
                            value
                        });
                    } else {
                        vscode.window.showErrorMessage(
                            'Błąd zapisu SQL: ' + errorMessage
                        );
                    }
                }
            }, undefined, context.subscriptions);
            panel.onDidDispose(() => {
                messageDisposable.dispose();
                panel = undefined;
            });
        }
    );
}
