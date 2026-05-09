import * as vscode from 'vscode';
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
                        select id, status
                        from student s
                        order by id
                        limit 1
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
    connTime: string,
    qTime: string
): string {

    return `
<!DOCTYPE html>
<html>

<head>

<meta charset="UTF-8">

<style>

body {
    font-size: 12px;
    padding: 10px;
    background: var(--vscode-editor-background);
    margin: 0;
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.toolbar {
    padding: 8px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    gap: 10px;
    align-items: center;
    flex-shrink: 0;
}

.stats {
    color: gray;
    font-size: 11px;
    flex: 1;
}

.pagination {
    display: flex;
    gap: 5px;
    align-items: center;
}

.table-container {
    flex: 1;
    overflow: auto;
    margin-top: 10px;
}

table {
    border-collapse: collapse;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    width: 100%;
}

th,
td {
    border: 1px solid var(--vscode-panel-border);
    padding: 4px 8px;
    text-align: left;
    white-space: nowrap;
}

th {
    background-color: var(--vscode-editor-background);
    position: sticky;
    top: 0;
    z-index: 10;
    font-weight: bold;
}

td:first-child {
    background-color: var(--vscode-sideBar-background);
    color: #888;
    text-align: right;
    font-weight: bold;
}

tr:hover td {
    background-color: var(--vscode-list-hoverBackground);
}

button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 4px 12px;
    cursor: pointer;
    border-radius: 2px;
    font-size: 11px;
}

button:hover {
    background: var(--vscode-button-hoverBackground);
}

button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.page-info {
    font-size: 11px;
    margin: 0 10px;
}

select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 4px;
    border-radius: 2px;
    font-size: 11px;
}

.updated-cell {
    background: #90EE90 !important;
}

</style>

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

<script>

const vscode = acquireVsCodeApi();

let allData = [];

let headers = [];

const ROWS_PER_PAGE = 200;

let totalPages = 1;

let currentPage = 1;

window.addEventListener('message', event => {

    const msg = event.data;

    if (msg.command === 'appendData') {

        const start = performance.now();

        allData.push(...msg.rows);

        if (headers.length === 0 && allData.length) {

            headers = Object.keys(allData[0]);

            renderHeaders();
        }

        totalPages = Math.ceil(
            allData.length / ROWS_PER_PAGE
        );

        document.getElementById(
            'totalPages'
        ).textContent = totalPages;

        // render tylko pierwszego chunk
        if (currentPage === 1) {
            renderPage();
        }

        const end = performance.now();

        console.log(
            'Chunk loaded:',
            msg.rows.length,
            'rows in',
            (end - start).toFixed(2),
            'ms'
        );

        if (msg.isLast) {

            console.log(
                'ALL DATA LOADED:',
                allData.length
            );
        }
    }

    if (msg.command === 'updateConfirmed') {

        const cells = document.querySelectorAll(
            '[data-id="' + msg.id + '"][data-column="' + msg.column + '"]'
        );

        cells.forEach(cell => {

            cell.classList.add('updated-cell');

            setTimeout(() => {

                cell.classList.remove('updated-cell');

            }, 500);
        });
    }
});

function renderHeaders() {

    const headerRow =
        document.getElementById('headerRow');

    headerRow.innerHTML = '<th>#</th>';

    for (const header of headers) {

        const th =
            document.createElement('th');

        th.textContent = header;

        headerRow.appendChild(th);
    }
}

function renderPage() {

    const start =
        (currentPage - 1) * ROWS_PER_PAGE;

    const end =
        Math.min(
            start + ROWS_PER_PAGE,
            allData.length
        );

    const pageRows =
        allData.slice(start, end);

    const tbody =
        document.getElementById('tableBody');

    const startRender = performance.now();

    tbody.innerHTML = '';

    const fragment =
        document.createDocumentFragment();

    for (let i = 0; i < pageRows.length; i++) {

        const row = pageRows[i];

        const rowNum = start + i + 1;

        const tr = document.createElement('tr');

        const rowCell =
            document.createElement('td');

        rowCell.style.fontWeight = 'bold';

        rowCell.textContent = String(rowNum);

        tr.appendChild(rowCell);

        for (const header of headers) {

            const td =
                document.createElement('td');
            
            const value = row[header];

            td.dataset.value =
                value === null || value === undefined
                    ? ''
                    : String(value);

            td.dataset.id =
                row.id !== undefined && row.id !== null
                    ? String(row.id)
                    : '';

            td.dataset.column = header;

            td.textContent =
                value === null || value === undefined
                    ? ''
                    : String(value);

            tr.appendChild(td);
        }

        fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);

    document.getElementById(
        'currentPage'
    ).textContent = currentPage;

    document.getElementById(
        'prevBtn'
    ).disabled = currentPage === 1;

    document.getElementById(
        'firstBtn'
    ).disabled = currentPage === 1;

    document.getElementById(
        'nextBtn'
    ).disabled = currentPage === totalPages;

    document.getElementById(
        'lastBtn'
    ).disabled = currentPage === totalPages;

    const endRender = performance.now();

    console.log(
        'Render:',
        (endRender - startRender).toFixed(2),
        'ms'
    );
}

const rowsLayer =
    document.getElementById('tableBody');

rowsLayer.addEventListener('dblclick', e => {

    const target = e.target;

    if (!(target instanceof HTMLElement)) {
        return;
    }

    const cell = target.closest('td');

    if (!cell.dataset.column) {
        return;
    }

    if (cell.querySelector('input')) {
        return;
    }

    const oldValue =
        cell.dataset.value || '';

    const input =
        document.createElement('input');

    input.value = oldValue;

    input.style.width = '100%';
    input.style.border = 'none';
    input.style.padding = '0';
    input.style.margin = '0';
    input.style.background = 'transparent';
    input.style.color = 'inherit';
    input.style.font = 'inherit';

    cell.innerHTML = '';

    cell.appendChild(input);

    input.focus();

    input.select();

    function save() {

        const newValue = input.value;

        cell.dataset.value = newValue;

        cell.textContent = newValue;

        vscode.postMessage({
            command: 'updateCell',
            id: cell.dataset.id,
            column: cell.dataset.column,
            value: newValue
        });
    }

    input.addEventListener('blur', save);

    input.addEventListener('keydown', ev => {

        if (ev.key === 'Enter') {
            input.blur();
        }

        if (ev.key === 'Escape') {

            input.removeEventListener('blur', save);

            input.blur();

            cell.dataset.value = oldValue;

            cell.textContent = oldValue;
        }
    });
});

function nextPage() {

    if (currentPage < totalPages) {

        currentPage++;

        renderPage();
    }
}

function prevPage() {

    if (currentPage > 1) {

        currentPage--;

        renderPage();
    }
}

function firstPage() {

    currentPage = 1;

    renderPage();
}

function lastPage() {

    currentPage = totalPages;

    renderPage();
}

function exportToCSV() {

    let csv = headers.join(',') + '\\n';

    for (const row of allData) {

        const line = headers.map(h => {

            let cell = row[h] || '';

            if (
                typeof cell === 'string' &&
                (
                    cell.includes(',') ||
                    cell.includes('"') ||
                    cell.includes('\\n')
                )
            ) {

                cell =
                    '"' +
                    cell.replace(/"/g, '""') +
                    '"';
            }

            return cell;

        }).join(',');

        csv += line + '\\n';
    }

    const blob = new Blob(
        [csv],
        {
            type: 'text/csv;charset=utf-8;'
        }
    );

    const url =
        URL.createObjectURL(blob);

    const a =
        document.createElement('a');

    a.href = url;

    a.download =
        'export_' +
        new Date()
            .toISOString()
            .slice(0,19)
            .replace(/:/g, '-') +
        '.csv';

    document.body.appendChild(a);

    a.click();

    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}

</script>

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