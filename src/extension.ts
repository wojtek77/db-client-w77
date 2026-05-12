import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from './db/ConnectionManager';
import { executeQuery } from './db/query';
import { executeUpdate } from './db/update';
import { SqlUtil } from "./db/SqlUtil";
import { CnfLoader } from "./db/CnfLoader";

export async function activate(context: vscode.ExtensionContext) {
    console.log(new Date().toLocaleTimeString('pl-PL', { hour12: false }));

    let panel: vscode.WebviewPanel | undefined;

    const db = ConnectionManager.getInstance();
    const cnfOptions = await CnfLoader.getOptionsFromCnf('~/.db_configs/local-system.cnf');
    const connectionTime = await db.connect({
        ...cnfOptions,
        connectionLimit: 5,
        connectTimeout: 10000,
        acquireTimeout: 10000,
        supportBigNumbers: true,
        bigNumberStrings: false,
        insertIdAsNumber: true,
        bigIntAsNumber: true
    });

    const disposable = vscode.commands.registerCommand('mariadb-client.openEditor', async () => {

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

        let sql = `
                    select *
                    from student s
                    order by id
                    limit 400
                    `;
        sql = SqlUtil.appendLimit(sql.trim());

        const { rows, queryTime, success, errorMessage } = await executeQuery(sql);
        if (!success) {
            vscode.window.showErrorMessage(
                'Błąd zapytania SQL: ' + errorMessage
            );
            return;
        }

        console.log('=== SETTING EMPTY WEBVIEW ===');

        panel.webview.html = getWebviewContent(
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
    });

    context.subscriptions.push(disposable);
}

export async function deactivate() {

    await ConnectionManager.getInstance().disconnect();

    console.log('WYWOŁANIE FUNKCJI DEACTIVATE');
}

function getWebviewContent(
    webview: vscode.Webview,
    extensionPath: string,
    connTime: string,
    qTime: string
): string {
    
    const styleUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'panel',
                'assets',
                'styles.css'
            )
        )
    );
    
    const stateUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'panel',
                'assets',
                'state.js'
            )
        )
    );
    const tableRendererUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'panel',
                'assets',
                'tableRenderer.js'
            )
        )
    );
    const paginationUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'panel',
                'assets',
                'pagination.js'
            )
        )
    );
    const editorUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'panel',
                'assets',
                'editor.js'
            )
        )
    );
    const csvExportUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'panel',
                'assets',
                'csvExport.js'
            )
        )
    );
    const messageHandlerUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'panel',
                'assets',
                'messageHandler.js'
            )
        )
    );
    const appUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'panel',
                'assets',
                'app.js'
            )
        )
    );

    return `
<!DOCTYPE html>
<html>

<head>

<meta charset="UTF-8">

<link rel="stylesheet" href="${styleUri}">

</head>

<body>

<div class="toolbar">

    <div class="stats">
        🔌 ${connTime}ms | ⚡ ${qTime}ms
    </div>

    <button onclick="exportToCSV()">
        💾 Eksportuj CSV
    </button>

    <div class="pagination">

        <button onclick="firstPage()" id="firstBtn">
            ⏮️
        </button>

        <button onclick="prevPage()" id="prevBtn">
            ◀
        </button>

        <span class="page-info">
            Strona
            <span id="currentPage">1</span>
            z
            <span id="totalPages">1</span>
        </span>

        <button onclick="nextPage()" id="nextBtn">
            ▶
        </button>

        <button onclick="lastPage()" id="lastBtn">
            ⏭️
        </button>

    </div>

</div>

<div class="table-container">

    <table id="dataTable">

        <thead>
            <tr id="headerRow">
                <th>#</th>
            </tr>
        </thead>

        <tbody id="tableBody">
            <tr>
                <td>Ładowanie...</td>
            </tr>
        </tbody>

    </table>

</div>

<script src="${stateUri}"></script>
<script src="${tableRendererUri}"></script>
<script src="${paginationUri}"></script>
<script src="${editorUri}"></script>
<script src="${csvExportUri}"></script>
<script src="${messageHandlerUri}"></script>
<script src="${appUri}"></script>

</body>
</html>
`;
}
