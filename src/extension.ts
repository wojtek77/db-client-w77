import * as vscode from 'vscode';
import * as path from 'path';
import * as mariadb from 'mariadb';
import * as fs from 'fs';
import * as ini from 'ini';
import * as os from 'os';

let pool: mariadb.Pool;
let conn: mariadb.PoolConnection;

export async function activate(context: vscode.ExtensionContext) {
    console.log(new Date().toLocaleTimeString('pl-PL', { hour12: false }));

    let panel: vscode.WebviewPanel | undefined;

    const cnfOptions = await getOptionsFromCnf('~/.db_configs/local-system.cnf');
    pool = mariadb.createPool({
        ...cnfOptions,
        connectionLimit: 5,
        connectTimeout: 10000,
        acquireTimeout: 10000,
        supportBigNumbers: true,
        bigNumberStrings: false,
        insertIdAsNumber: true,
        bigIntAsNumber: true
    });
    const startConn = performance.now();
    conn = await pool.getConnection();
    conn.on('error', err => {
        console.error('MariaDB connection error:', err);
    });
    const endConn = performance.now();
    const connectionTime = (endConn - startConn).toFixed(2);
    console.log('Connection time:', connectionTime, 'ms');

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

        let rawSql = `
                        select *
                        from student s
                        order by id
                        limit 400
                    `;

        const sql = sanitizeSql(rawSql);

        let rows: any[] = [];
        let queryTime = '0';
        try {
            console.log('=== STARTING QUERY ===');

            const startQuery = performance.now();
            rows = await conn.query(sql);
            // to działa identycznie jak to co powyżej
            // rows = await conn.query({ sql, metaAsArray: false });
            const endQuery = performance.now();

            queryTime = (
                endQuery - startQuery
            ).toFixed(2);

            console.log(
                `=== QUERY TIME: ${queryTime}ms, ROWS: ${rows.length}`
            );
        } catch (err: any) {
            console.error(err);

            vscode.window.showErrorMessage(
                'Błąd zapytania SQL: ' + err.message
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

                try {

                    const startUpdate = performance.now();
                    await conn.execute(
                        `UPDATE student SET \`${column}\` = ? WHERE id = ?`,
                        [value, id]
                    );
                    const updateTime = (
                        performance.now() - startUpdate
                    ).toFixed(2);
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

                } catch (err: any) {

                    vscode.window.showErrorMessage(
                        'Błąd zapisu SQL: ' + err.message
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

    try {
        if (conn) await conn.end();
    } catch (err) {
        console.error('Błąd conn.end():', err);
    }

    try {
        if (pool) await pool.end();
    } catch (err) {
        console.error('Błąd pool.end():', err);
    }

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
                'webview',
                'media',
                'styles.css'
            )
        )
    );
    
    const stateUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'webview',
                'media',
                'state.js'
            )
        )
    );
    const tableRendererUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'webview',
                'media',
                'tableRenderer.js'
            )
        )
    );
    const paginationUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'webview',
                'media',
                'pagination.js'
            )
        )
    );
    const editorUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'webview',
                'media',
                'editor.js'
            )
        )
    );
    const csvExportUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'webview',
                'media',
                'csvExport.js'
            )
        )
    );
    const messageHandlerUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'webview',
                'media',
                'messageHandler.js'
            )
        )
    );
    const appUri = webview.asWebviewUri(
        vscode.Uri.file(
            path.join(
                extensionPath,
                'src',
                'webview',
                'media',
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

async function getOptionsFromCnf(filePath: string): Promise<any> {
    const absolutePath = filePath.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);

    if (!fs.existsSync(absolutePath)) return null;

    const fileContent = fs.readFileSync(absolutePath, 'utf-8');
    const lines = fileContent.split(/\r?\n/);

    let rawConfig: any = { client: {}, mysql: {}, mariadb: {} };

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('!include ')) {
            const includePath = trimmed.replace('!include ', '').trim();

            const includedRaw = await getRawSections(includePath);

            if (includedRaw) {
                rawConfig.client = { ...rawConfig.client, ...includedRaw.client };
                rawConfig.mysql = { ...rawConfig.mysql, ...includedRaw.mysql };
                rawConfig.mariadb = { ...rawConfig.mariadb, ...includedRaw.mariadb };
            }
        }
    }

    const parsedIni = ini.parse(fileContent);

    const mergedClient = {
        ...rawConfig.mysql,
        ...rawConfig.mariadb,
        ...rawConfig.client,
        ...(parsedIni.mysql || {}),
        ...(parsedIni.mariadb || {}),
        ...(parsedIni.client || {})
    };

    const options: any = {};

    if (mergedClient.socket) options.socketPath = mergedClient.socket;
    if (mergedClient.host) options.host = mergedClient.host;
    if (mergedClient.user) options.user = mergedClient.user;
    if (mergedClient.password) options.password = mergedClient.password;
    if (mergedClient.database) options.database = mergedClient.database;
    if (mergedClient.port) options.port = parseInt(mergedClient.port);

    if (mergedClient.hasOwnProperty('skip-ssl')) {
        options.ssl = !(mergedClient['skip-ssl'] === true || mergedClient['skip-ssl'] === 'true');
    }

    if (mergedClient.hasOwnProperty('compress')) {
        options.compress = (mergedClient.compress === true || mergedClient.compress === 'true');
    }

    if (mergedClient.hasOwnProperty('reconnect')) {
        options.reconnect = (mergedClient.reconnect === true || mergedClient.reconnect === 'true');
    }

    return options;
}

async function getRawSections(filePath: string): Promise<any> {

    const absolutePath =
        filePath.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);

    if (!fs.existsSync(absolutePath)) {
        return null;
    }

    const parsed = ini.parse(
        fs.readFileSync(absolutePath, 'utf-8')
    );

    return {
        client: parsed.client || {},
        mysql: parsed.mysql || {},
        mariadb: parsed.mariadb || {}
    };
}

function sanitizeSql(sql: string): string {

    const cleanSql = sql.trim();

    const needsLimit =
        /^select(?!.+\slimit\s)/is.test(cleanSql);

    if (needsLimit) {

        return cleanSql
            .replace(/;$/, '')
            .trim() + ' LIMIT 200';
    }

    return cleanSql;
}