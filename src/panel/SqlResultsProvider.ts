import * as vscode from 'vscode';
import { getHtml } from './html.js';
import { executeQuery, executeQueryWholeFile } from '../db/query.js';
import { ConnectionManager } from '../db/ConnectionManager.js';
import * as path from 'path';
import * as os from 'os';
import { RecentSqlFiles } from '../recentFiles/RecentSqlFiles.js';
import { ConnectionColors } from '../db/ConnectionColors.js';
import { TableColumnsCache } from '../cache/TableColumnsCache.js';

interface FileResultState {
    rows: any[][];
    headers: string[];
    sql: string;
    meta: any[];
    connectionName: string;
    connectionTime: number;
    queryTime: number;
    connectionColor: string | null;
}

export class SqlResultsProvider implements vscode.WebviewViewProvider {
    private static instance: SqlResultsProvider;
    
    static initialize(
        context: vscode.ExtensionContext
    ) {
        if (!SqlResultsProvider.instance) {
            SqlResultsProvider.instance =
                new SqlResultsProvider(context);
        }

        return SqlResultsProvider.instance;
    }

    static getInstance() {
        if (!SqlResultsProvider.instance) {
            throw new Error(
                "SqlResultsProvider not initialized"
            );
        }

        return SqlResultsProvider.instance;
    }
    
    
    private _view?: vscode.WebviewView;
    
    private _fileStates = new Map<string, FileResultState>();
    
    private _connectionName: string = '';
    private _connectionTime: number = 0;
    private _connectionColor: string | null = null;
    private _extensionUri: vscode.Uri;
    private _allRows: any[][] = [];
    private _headers: string[] = [];
    private _lastQueryTime = 0;
    private _meta: any[] = [];
    private _lastSQL = '';
    private _currentPage = 1;
    private _infoMessage = '';
    private _flashMessage = '';
    private _errorMessage = '';
    private readonly ROWS_PER_PAGE = 200;
    private _context?: vscode.ExtensionContext;
    private _resolveView?: (value: boolean) => void;
    private _currentSqlFile = '';
    private _queryRunning = false;

    private constructor(context: vscode.ExtensionContext) {
        console.log('construct');
        this._extensionUri = context.extensionUri;
        this._context = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        console.log('start resolveWebviewView');
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        // Sygnał, że widok został zainicjalizowany
        if (this._resolveView) {
            this._resolveView(true);
            this._resolveView = undefined;
        }

        this.updateHtml();
        
        // ⭐ REWELACYJNE ZABEZPIECZENIE:
        webviewView.onDidDispose(() => {
            
            this._view = undefined; // Dzięki temu program wie, że stary widok już nie istnieje!
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'loadPage') {
                this._currentPage = msg.page;
                this.sendPage(msg.page);
            }
            
            if (msg.command === 'updateCell') {
                await this.updateCellInDB(msg.rowIndex, msg.columnIndex, msg.value);
            }
            
            if (msg.command === 'changeConnection') {
                await this.changeConnection();
            }
            
            if (msg.command === 'openRecentFiles') {
                await this.openRecentFiles();
            }
            
            if (msg.command === 'exportCSV') {
                await this.exportToCSV();
            }
            
            if (msg.command === 'exportTXT') {
                await this.exportToTXT();
            }
            
            if (msg.command === 'cancelQuery') {
                await this.cancelCurrentQuery();
            }
            
            if (msg.command === 'pickConnectionColor') {
                await this.pickConnectionColor();
            }
        });
    }
    
    public isQueryRunning(): boolean {
        return this._queryRunning;
    }
    
    private async cancelCurrentQuery() {
        try {
            const db =
                await ConnectionManager
                    .getInstance()
                    .getDb();

            await db.cancelCurrentQuery();

            // vscode.window.showInformationMessage(
            //     'SQL query cancelled'
            // );
        } catch (err: any) {
            vscode.window.showErrorMessage(
                err.message
            );
        }
    }

    private updateHtml() {
        if (!this._view) {throw new Error("brak webview");}
        
        if (!this._view.webview.html) {
            const html = getHtml(
                this._view.webview,
                this._extensionUri
            );
            this._view.webview.html = html;
            console.log('jest ustawiany od nowa HTML');
        }
    }

    private sendPage(pageNumber: number) {
        if (!this._view) {return;}
        
        const start = (pageNumber - 1) * this.ROWS_PER_PAGE;
        const end = start + this.ROWS_PER_PAGE;
        const pageRows = this._allRows.slice(start, end);
        const totalPages = Math.ceil(this._allRows.length / this.ROWS_PER_PAGE);
        console.log('sendPage', start, end);
        
        // 1. Konwertujemy wiersze na string JSON
        const rowsJsonString = JSON.stringify(pageRows);
        // 2. Zamieniamy na binarny Uint8Array
        const encoder = new TextEncoder();
        const rowsBuffer = encoder.encode(rowsJsonString); // Zwraca Uint8Array
        
        console.time("⏱️ Całkowity czas Backend");
        setImmediate(() => {
            // 3. Wysyłamy
            this._view?.webview.postMessage({
                command: 'appendData',
                sqlFile: this._currentSqlFile,
                rows: rowsBuffer, // VS Code automatycznie obsłuży to jako transfer binarny
                headers: this._headers,
                totalRows: this._allRows.length,
                isLast: (pageNumber === totalPages),
                currentPage: pageNumber,
                totalPages: totalPages,
                connectionName: this._connectionName,
                connectionTime: this._connectionTime,
                queryTime: this._lastQueryTime,
                connectionColor: this._connectionColor,
                infoMessage: this._infoMessage,
                flashMessage: this._flashMessage,
                errorMessage: this._errorMessage,
                isEncoded: true,
                sentAt: Date.now() // znacznik czasu w ms
            });
        });
        console.timeEnd("⏱️ Całkowity czas Backend");


        // console.time("⏱️ Całkowity czas Backend");
        // this._view.webview.postMessage({
        //     command: 'appendData',
        //     rows: pageRows,
        //     headers: this._headers,
        //     totalRows: this._allRows.length,
        //     isLast: (pageNumber === totalPages),
        //     currentPage: pageNumber,
        //     totalPages: totalPages,
        //     connectionName: this._connectionName,
        //     connectionTime: this._connectionTime,
        //     queryTime: this._lastQueryTime,
        //     sentAt: Date.now()
        // });
        // console.timeEnd("⏱️ Całkowity czas Backend");
    }

    private async updateCellInDB(rowIndex: number, columnIndex: number, value: any) {
        try {
            const db = await ConnectionManager.getInstance().getDb();

            const row = this._allRows[rowIndex];

            if (!row) {
                vscode.window.showErrorMessage(`Nie znaleziono wiersza ${rowIndex}`);
                return;
            }

            const field = this._meta[columnIndex];

            if (!field) {
                vscode.window.showErrorMessage(`Nie znaleziono metadanych kolumny ${columnIndex}`);
                return;
            }

            const tableName = field.orgTable?.();
            const columnName = field.orgName?.();

            if (!tableName || !columnName) {
                vscode.window.showErrorMessage('Nie można określić źródłowej tabeli lub kolumny');
                return;
            }
            
            // console.log();
            // console.log(Object.getPrototypeOf(field));
            // console.table(field);

            const schema = field.schema?.();
            if (!schema) {
                vscode.window.showErrorMessage(`Nie można określić schema dla tabeli ${tableName}`);
                return;
            }
            
            const tableColumnsService = TableColumnsCache.getInstance();
            const columnsMap = await tableColumnsService.getCachedColumnsBatch([{schema, table: tableName}]);
            const tableColumns = columnsMap[tableColumnsService.getTableRefKey({schema, table: tableName})] ?? [];

            const primaryKeys = tableColumns.filter((c: any) => c.columnKey === 'PRI');

            if (primaryKeys.length === 0) {
                vscode.window.showErrorMessage(`Tabela ${tableName} nie posiada PRIMARY KEY`);
                return;
            }

            const whereParts: string[] = [];
            const whereValues: any[] = [];

            for (const pk of primaryKeys) {
                const pkIndex = this._meta.findIndex((m: any) => {
                    return (
                        m.orgTable?.() === tableName &&
                        m.orgName?.() === pk.name
                    );
                });

                if (pkIndex === -1) {
                    vscode.window.showErrorMessage(
                        `Brak PRIMARY KEY '${pk.name}' w wynikach SELECT`
                    );
                    return;
                }

                whereParts.push(`\`${pk.name}\` = ?`);
                whereValues.push(row[pkIndex]);
            }

            const updateSQL = `
                UPDATE \`${schema}\`.\`${tableName}\`
                SET \`${columnName}\` = ?
                WHERE ${whereParts.join(' AND ')}
            `;

            // obsługa NULL (można wpisywać tak: null, NULL)
            if (typeof value === 'string' && value.trim().toUpperCase() === 'NULL') {
                value = null;
            }
            
            await db.query(updateSQL, [value, ...whereValues]);

            this._allRows[rowIndex][columnIndex] = value;

            if (this._view) {
                this._view.webview.postMessage({
                    command: 'updateConfirmed',
                    rowIndex,
                    columnIndex,
                    value
                });
            }

            vscode.window.showInformationMessage(
                `✅ Zaktualizowano ${tableName}.${columnName}`
            );
        } catch (err: any) {
            console.error('Błąd update:', err);
            vscode.window.showErrorMessage(`❌ Błąd aktualizacji: ${err.message}`);
        }
    }
    
    private async waitForView(): Promise<boolean> {
        if (this._view) {return true;}
        
        return new Promise(resolve => {
            this._resolveView = resolve;
            // Timeout dla bezpieczeństwa
            setTimeout(() => resolve(!!this._view), 5000);
        });
    }

    public async executeQuery(sql: string, sqlFile: string, wholeFile = false) {
        console.log('executeQuery');
        this._currentSqlFile = sqlFile;
        
        // czasami widok może nie istnieć, np. przy pierwszym uruchomieniu SQL lub kiedy plik .sql został zamknięty
        if (!this._view) {
            // to tworzy this._view 
            await this.show({ preserveFocus: true });
            
            // czekamy asynchronicznie, aż VS Code stworzy widok
            await this.waitForView();
            if (!this._view) {
                vscode.window.showErrorMessage("Nie udało się otworzyć okna wyników SQL.");
                return;
            }
            
            this.updateHtml();
        } else { // rozwiązuje brak przełączenia na zakładkę SQL, jeśli wcześniej było przełączone np. na zakładkę "terminal"
            await this.show({ preserveFocus: true });
        }
        
        // dzięki temu jeśli nie jest przypisane połączenie do pliku SQL nie wystaruje webview
        const db = await ConnectionManager.getInstance().getDb();
        
        this._queryRunning = true;
        this._view.webview.postMessage({
            command: 'queryStarted',
            startedAt: Date.now()
        });
        
        let rows, headers: string[], meta, queryTime, success, errorMessage, infoMessage, flashMessage;
        if (wholeFile) {
            ({ rows, headers, meta, queryTime, success, errorMessage, infoMessage, flashMessage } = await executeQueryWholeFile(db, sql));
        } else {
            ({ rows, headers, meta, queryTime, success, errorMessage } = await executeQuery(db, sql));
        }
        
        this._queryRunning = false;
        this._view?.webview.postMessage({
            command: 'queryFinished'
        });
        
        if (!success) {
            // headers = [];
            // rows = [];
        }
        
        this._allRows = rows;
        this._headers = headers;
        this._lastSQL = sql;
        this._meta = meta;
        this._connectionName = db.getConnectionName();
        this._connectionTime = db.getConnectionTime();
        this._lastQueryTime = queryTime;
        this._connectionColor = ConnectionColors.getInstance().getColor(this._connectionName);
        this._currentPage = 1;
        this._infoMessage = infoMessage ?? '';
        this._flashMessage = flashMessage ?? '';
        this._errorMessage = errorMessage ?? '';
        
        this._fileStates.set(sqlFile, {
            rows: this._allRows,
            headers: this._headers,
            sql: this._lastSQL,
            meta: this._meta,
            connectionName: this._connectionName,
            connectionTime: this._connectionTime,
            queryTime: this._lastQueryTime,
            connectionColor: this._connectionColor,
        });
        
        // wysłanie info o tym że dane się łądują (blur)
        this._view.webview.postMessage({ 
            command: 'loadingWebview'
        });
        
        this.sendPage(1);
    }
    
    public showResultsForFile(sqlFile: string) {
        if (!this._view) {
            return;
        }
        
        const state = this._fileStates.get(sqlFile);
        if (!state) {
            this._view.webview.postMessage({
                command: 'showEmpty',
                sentAt: Date.now() // znacznik czasu w ms
            });
            return;
        }

        this._currentSqlFile = sqlFile;
        this._allRows = state.rows;
        this._headers = state.headers;
        this._meta = state.meta;
        this._lastQueryTime = state.queryTime;
        this._connectionName = state.connectionName;
        this._connectionTime = state.connectionTime;
        this._connectionColor = state.connectionColor ?? null;

        this._view.webview.postMessage({
            command: 'showResultsForFile',
            sqlFile: sqlFile,
            connectionColor: this._connectionColor,
            sentAt: Date.now() // znacznik czasu w ms
        });
    }

    private async show(options?: { preserveFocus?: boolean }) {
        const preserveFocus = options?.preserveFocus ?? true;
        
        if (this._view) {
            // ! WAŻNE: W VS Code flaga 'preserveFocus' działa odwrotnie niż Twój stary wpis.
            // Przekazanie true oznacza: ZACHOWAJ FOKUS W EDYTORZE (nie kradnij go).
            this._view.show?.(preserveFocus); 
        } else {
            await vscode.commands.executeCommand('sqlResultsView.focus', { preserveFocus: preserveFocus });
        }
    }
    
    private async changeConnection() {

        const connectionName = await RecentSqlFiles.getInstance().changeConnectionName();

        // utworzenia nowego połączenia z bozą aby uzyskać czas łaczenia
        const db = await ConnectionManager.getInstance().getDb();

        this._connectionName = connectionName;
        this._connectionTime = db.getConnectionTime();
        this._connectionColor = ConnectionColors.getInstance().getColor(this._connectionName);

        if (this._view) {
            this._view.webview.postMessage({
                command: 'changeConnection',
                connectionName: this._connectionName,
                connectionTime: this._connectionTime,
                connectionColor: this._connectionColor,
            });
        }
    }
    
    private async pickConnectionColor() {
        if (!this._connectionName) {
            return;
        }

        const newColor = await ConnectionColors.getInstance().pickColor(this._connectionName);

        if (newColor === undefined) {
            return; // anulowano
        }

        this._connectionColor = newColor;

        // Zaktualizuj kolor we wszystkich zapisanych stanach dla tego połączenia
        for (const [file, state] of this._fileStates.entries()) {
            if (state.connectionName === this._connectionName) {
                state.connectionColor = newColor;
            }
        }

        if (this._view) {
            this._view.webview.postMessage({
                command: 'changeConnection',
                connectionName: this._connectionName,
                connectionTime: this._connectionTime,
                connectionColor: this._connectionColor,
            });
        }
    }
    
    private async openRecentFiles() {

        await RecentSqlFiles.getInstance().openRecentFiles();
    }
    
    private async exportToCSV() {
        try {
            const rows = this._allRows;
            const headers = this._headers;

            if (rows.length === 0) {
                vscode.window.showWarningMessage('Brak danych do eksportu.');
                return;
            }

            const escapeCell = (value: unknown): string => {
                const str = value === null || value === undefined ? '' : String(value);
                return str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')
                    ? `"${str.replace(/"/g, '""')}"`
                    : str;
            };

            const parts: string[] = [];
            parts.push(headers.map(escapeCell).join(','));

            for (const row of rows) {
                parts.push(row.map(escapeCell).join(','));
            }

            const csv = parts.join('\n') + '\n';

            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const fileName = `export_${timestamp}.csv`;

            const lastPath = this.getLastExportPath('csv');
            const defaultDir = lastPath ? path.dirname(lastPath) : path.join(os.homedir(), 'Desktop');
            const defaultUri = vscode.Uri.file(path.join(defaultDir, fileName));

            const uri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'CSV files': ['csv'] }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
                this.setLastExportPath(uri.fsPath, 'csv');
                vscode.window.showInformationMessage(`✅ Eksportowano ${rows.length} wierszy do ${uri.fsPath}`);
            }
        } catch (err: any) {
            console.error('Błąd eksportu:', err);
            vscode.window.showErrorMessage(`❌ Błąd eksportu: ${err.message}`);
        }
    }
    
    private async exportToTXT() {
        try {
            const rows = this._allRows;
            const headers = this._headers;

            if (rows.length === 0) {
                vscode.window.showWarningMessage('Brak danych do eksportu.');
                return;
            }

            const escapeCell = (value: unknown): string =>
                value === null || value === undefined ? '' : String(value);

            // Szerokości kolumn — max z nagłówka i danych, ograniczone do 50
            const colWidths = headers.map((h, i) => {
                let max = h.length;
                for (const row of rows) {
                    const len = escapeCell(row[i]).length;
                    if (len > max) {max = len;}
                }
                return Math.min(max, 50);
            });

            const separator = '+-' + colWidths.map(w => '-'.repeat(w)).join('-+-') + '-+';
            const headerRow = '| ' + headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ') + ' |';

            const parts: string[] = [separator, headerRow, separator];

            for (const row of rows) {
                let line = '| ';
                for (let i = 0; i < headers.length; i++) {
                    let cell = escapeCell(row[i]);
                    if (cell.length > colWidths[i]) {
                        cell = cell.substring(0, colWidths[i] - 3) + '...';
                    }
                    line += cell.padEnd(colWidths[i]) + ' | ';
                }
                parts.push(line);
            }

            parts.push(separator);
            parts.push(`Row count: ${rows.length}`);

            const txt = parts.join('\n') + '\n';

            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const fileName = `export_${timestamp}.txt`;

            const lastPath = this.getLastExportPath('txt');
            const defaultDir = lastPath ? path.dirname(lastPath) : path.join(os.homedir(), 'Desktop');
            const defaultUri = vscode.Uri.file(path.join(defaultDir, fileName));

            const uri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'Text files': ['txt'] }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(txt, 'utf8'));
                this.setLastExportPath(uri.fsPath, 'txt');
                vscode.window.showInformationMessage(`✅ Eksportowano ${rows.length} wierszy do ${uri.fsPath}`);
            }
        } catch (err: any) {
            console.error('Błąd eksportu TXT:', err);
            vscode.window.showErrorMessage(`❌ Błąd eksportu TXT: ${err.message}`);
        }
    }
    
    private getLastExportPath(extension: string): string | undefined {
        return this._context?.globalState.get<string>(`lastExportPath_${extension}`);
    }

    private setLastExportPath(path: string, extension: string) {
        this._context?.globalState.update(`lastExportPath_${extension}`, path);
    }
}