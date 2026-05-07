import * as vscode from 'vscode';
import * as mariadb from 'mariadb';
import * as fs from 'fs';
import * as path from 'path';
import * as ini from 'ini';
import * as os from 'os';

export async function activate(context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;

    const cnfOptions = await getOptionsFromCnf('~/.db_configs/local-system.cnf');
    const pool = mariadb.createPool({
        ...cnfOptions,
        connectionLimit: 5,
        connectTimeout: 10000,      // Czas na nawiązanie połączenia (ważne przy latencji)
        acquireTimeout: 10000,      // Czas na pobranie połączenia z puli
        // To jest kluczowe dla "Time Query": sterownik MariaDB w Node.js 
        // domyślnie parsuje liczby jako stringi, co jest wolniejsze. 
        // Pozwolenie mu na natywne typy przyśpiesza przetwarzanie 20k wierszy.
        supportBigNumbers: true,
        bigNumberStrings: false,
        // Ta opcja sprawia, że sterownik zwraca BigInt jako Number
        insertIdAsNumber: true,
        bigIntAsNumber: true 
    });
    
    const startConn = performance.now(); // START: Czas połączenia
    // MariaDB pool nie łączy się natychmiast, więc sprawdzimy to przy pierwszym zapytaniu
    const conn = await pool.getConnection();
    const endConn = performance.now();
    const connectionTime = (endConn - startConn).toFixed(2);

    let disposable = vscode.commands.registerCommand('mariadb-client.openEditor', async () => {
        panel = vscode.window.createWebviewPanel(
            'dbEditor', 'MariaDB Editor', vscode.ViewColumn.One, { enableScripts: true }
        );

        // 1. Pobierz dane
        // let rawSql = "select id, status from student where id = '0000033b-7e89-d3dc-1e39-55e9aded23c6'";
        let rawSql = "select id from student s limit 20000";
        // let rawSql = "select s.id, (select c.id from client c where c.id = s.client_id) client_id from student s where 1 limit 10000";
        // let rawSql = "select s.id, (select c.id from client c where c.id = s.client_id) client_id from student s where 1";
        const sql = sanitizeSql(rawSql); // dodanie zabezpiecznie LIMIT 200 jeśli brak LIMIT
        const startQuery = performance.now(); // START: Czas Select
        const rows = await conn.execute(sql);
        const endQuery = performance.now();
        const queryTime = (endQuery - startQuery).toFixed(2);
        conn.release(); // Zwolnij połączenie
        
        // Wyświetlenie informacji
        // vscode.window.showInformationMessage(
        //     `Połączono: ${connectionTime}ms | Select: ${queryTime}ms`
        // );

        // 1. Wysyłamy szkielet strony (bez danych)
        panel.webview.html = getWebviewContent(connectionTime, queryTime, rows.length);

        // 2. Wysyłamy dane jako JSON (to jest bardzo szybkie)
        panel.webview.postMessage({ command: 'setData', rows: rows });

        // 3. Nasłuchuj na zmiany z Webview
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'updateCell') {
                const { id, column, value } = message;
                try {
                    const startUpdate = performance.now();
                    // Zmieniamy na tabelę 'student'. 
                    // UUID musi być przekazane jako string, sterownik mariadb sam o to zadba przez '?'
                    await conn.execute(
                        `UPDATE student SET ${column} = ? WHERE id = ?`, 
                        [value, id]
                    );
                    const updateTime = (performance.now() - startUpdate).toFixed(2);
                    vscode.window.setStatusBarMessage(`Zaktualizowano studenta "${id}: ${column} = ${value}" (${updateTime}ms)`, 10000);
                } catch (err: any) {
                    vscode.window.showErrorMessage("Błąd zapisu SQL: " + err.message);
                } finally {
                    conn.release();
                }
            }
        }, undefined, context.subscriptions);
    });

    context.subscriptions.push(disposable);
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

    // Budujemy obiekt wynikowy dynamicznie
    const options: any = {};

    if (mergedClient.socket) options.socketPath = mergedClient.socket;
    if (mergedClient.host) options.host = mergedClient.host;
    if (mergedClient.user) options.user = mergedClient.user;
    if (mergedClient.password) options.password = mergedClient.password;
    if (mergedClient.database) options.database = mergedClient.database;
    if (mergedClient.port) options.port = parseInt(mergedClient.port);

    // Specyficzna obsługa booleanów (tylko jeśli istnieją w pliku)
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


// Funkcja pomocnicza do czytania "surowych" sekcji bez mapowania na finalny obiekt
async function getRawSections(filePath: string): Promise<any> {
    const absolutePath = filePath.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
    if (!fs.existsSync(absolutePath)) return null;
    const parsed = ini.parse(fs.readFileSync(absolutePath, 'utf-8'));
    return {
        client: parsed.client || {},
        mysql: parsed.mysql || {},
        mariadb: parsed.mariadb || {}
    };
}

function sanitizeSql(sql: string): string {
    const cleanSql = sql.trim();
    // Sprawdza czy zaczyna się od SELECT i czy NIE MA " limit " (ze spacją pośrodku)
    const needsLimit = /^select(?!.+\slimit\s)/is.test(cleanSql);
    if (needsLimit) {
        // Czyścimy ewentualny średnik i dopisujemy limit
        return cleanSql.replace(/;$/, "").trim() + " LIMIT 200";
    }
    return cleanSql;
}

function getWebviewContent(connTime: string, qTime: string, rowCount: number) {
    // Formatujemy liczbę (np. 20000 -> 20 000)
    const formattedCount = rowCount.toLocaleString();
    
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-size: 12px; padding: 0; margin: 0; }
                table { 
                    border-collapse: collapse; 
                    width: 1%; /* Tabela dopasuje się do treści */
                    min-width: 300px;
                    color: var(--vscode-editor-foreground); 
                    font-family: var(--vscode-editor-font-family);
                }
                th, td { 
                    border: 1px solid var(--vscode-panel-border); 
                    padding: 2px 6px; /* Bardzo małe odstępy (góra/dół lewo/prawo) */
                    text-align: left; 
                    white-space: nowrap; /* Tekst w jednej linii, kolumny będą wąskie */
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 400px; /* Maksymalna szerokość kolumny, żeby nie uciekła za ekran */
                }
                th {
                    background-color: var(--vscode-editor-background);
                    position: sticky; /* Nagłówek będzie widoczny przy przewijaniu */
                    top: 0;
                    z-index: 10;
                    border-bottom: 2px solid var(--vscode-panel-border);
                }
                .loading { color: orange; padding: 10px; font-weight: bold; }
                
                /* Pierwsza kolumna (numery wierszy) */
                td:first-child {
                    color: #888;
                    text-align: right;
                    padding-right: 8px;
                    background-color: var(--vscode-sideBar-background);
                    user-select: none;
                    width: 1%; /* Wymusza minimalną szerokość dla kolumny z numerami */
                    white-space: nowrap;
                }
                
                /* Efekt najechania dla lepszej czytelności małej tabeli */
                tr:hover { background-color: var(--vscode-list-hoverBackground); }
                
                /* Styl dla edytowanej komórki */
                td[contenteditable="true"]:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    background-color: var(--vscode-editor-background);
                }
            </style>
        </head>
        <body>
            <div id="stats" style="color: gray; font-size: 11px; padding: 5px;">
                Latency: ${connTime}ms | Query: ${qTime}ms
            </div>
            <div id="status" class="loading">Renderowanie ${formattedCount} wierszy...</div>
            
            <table id="myTable" style="display:none;">
                <thead><tr id="headerRow"></tr></thead>
                <tbody id="tableBody"></tbody>
            </table>

            <script>
                const vscode = acquireVsCodeApi();

                // SŁUCHACZ: Czeka na dane z VS Code
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'setData') {
                        renderTable(message.rows);
                    }
                });

                function renderTable(rows) {
                    if (!rows || rows.length === 0) {
                        document.getElementById('status').innerText = 'Brak danych do wyświetlenia.';
                        return;
                    }
                    
                    const headers = Object.keys(rows[0]);
                    const headerRow = document.getElementById('headerRow');
                    const tableBody = document.getElementById('tableBody');

                    // 1. Buduj nagłówki
                    headerRow.innerHTML = '<th></th>' + headers.map(h => '<th>' + h + '</th>').join('');

                    // 2. Buduj wiersze (używamy DocumentFragment dla wydajności)
                    const fragment = document.createDocumentFragment();
                    rows.forEach((row, index) => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = '<td>'+(index+1)+'</td>' + headers.map(h => 
                            '<td contenteditable="true" onblur="updateData(\\'' + row.id + '\\', \\'' + h + '\\', this.textContent)">' + 
                            (row[h] === null ? '' : row[h]) + 
                            '</td>'
                        ).join('');
                        fragment.appendChild(tr);
                    });

                    tableBody.appendChild(fragment);
                    document.getElementById('myTable').style.display = 'table';
                    document.getElementById('status').style.display = 'none';
                }

                function updateData(id, column, value) {
                    vscode.postMessage({ command: 'updateCell', id, column, value });
                }
            </script>
        </body>
        </html>`;
}
