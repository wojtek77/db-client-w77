import * as vscode from 'vscode';
import { getHtml } from './html';
import { executeQuery } from '../db/query';
import { ConnectionManager } from '../db/ConnectionManager';
import * as path from 'path';
import * as os from 'os';
import { RecentSqlFiles } from '../recentFiles/RecentSqlFiles';
import { getCachedColumns } from '../cache/tableColumnsCache';

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
    private _connectionName: string = '';
    private _connectionTime: string = '0';
    private _extensionPath: string;
    private _allRows: any[][] = [];
    private _headers: string[] = [];
    private _lastQueryTime = '0';
    private _meta: any[] = [];
    private _lastSQL = '';
    private _currentPage = 1;
    private readonly ROWS_PER_PAGE = 200;
    private _context?: vscode.ExtensionContext;
    private _resolveView?: (value: boolean) => void;
    private _currentSqlFile = '';

    private constructor(context: vscode.ExtensionContext) {
        console.log('construct');
        this._extensionPath = context.extensionPath;
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
            localResourceRoots: [vscode.Uri.file(this._extensionPath)]
        };

        // Sygnał, że widok został zainicjalizowany
        if (this._resolveView) {
            this._resolveView(true);
            this._resolveView = undefined;
        }

        // this.updateHtml();
        
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
        });
    }

    private updateHtml() {
        if (!this._view) throw new Error("brak webview");
        
        if (!this._view.webview.html) {
            const html = getHtml(
                this._view.webview,
                this._extensionPath
            );
            this._view.webview.html = html;
            console.log('jest ustawiany od nowa HTML');
        }
    }

    private sendPage(pageNumber: number) {
        if (!this._view) return;
        
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
            const conn = db.getConnection();

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

            const tableColumns = await getCachedColumns(tableName);

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
                UPDATE \`${tableName}\`
                SET \`${columnName}\` = ?
                WHERE ${whereParts.join(' AND ')}
            `;

            // obsługa NULL (można wpisywać tak: null, NULL)
            if (typeof value === 'string' && value.trim().toUpperCase() === 'NULL') {
                value = null;
            }
            
            await conn.query(updateSQL, [value, ...whereValues]);

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
        if (this._view) return true;
        
        return new Promise(resolve => {
            this._resolveView = resolve;
            // Timeout dla bezpieczeństwa
            setTimeout(() => resolve(!!this._view), 5000);
        });
    }

    public async executeQuery(sql: string, sqlFile: string) {
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
        
        // wysłanie info o tym że dane się łądują (blur)
        this._view.webview.postMessage({ 
            command: 'loadingDB'
        });
        
        const { rows, headers, meta, queryTime, success, errorMessage } = await executeQuery(sql);
        
        if (!success) {
            // vscode.window.showErrorMessage(`Błąd zapytania: ${errorMessage}`);
            this._view.webview.postMessage({ command: 'error', message: errorMessage });
            return;
        }
        
        const db = await ConnectionManager.getInstance().getDb();
        
        this._allRows = rows;
        this._headers = headers;
        this._lastSQL = sql;
        this._meta = meta;
        this._connectionName = db.getConnectionName();
        this._connectionTime = db.getConnectionTime();
        this._lastQueryTime = queryTime;
        this._currentPage = 1;
        
        // wysłanie info o tym że dane się łądują (blur)
        this._view.webview.postMessage({ 
            command: 'loadingWebview'
        });
        
        this.sendPage(1);
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

        if (this._view) {
            this._view.webview.postMessage({
                command: 'appendData',
                rows: [],
                headers: [],
                totalRows: this._allRows.length,
                currentPage: this._currentPage,
                connectionName: this._connectionName,
                connectionTime: this._connectionTime,
                queryTime: this._lastQueryTime
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
            // Generuj CSV
            const csvLines: string[] = [headers.join(',')];

            for (const row of rows) {
                const line = row.map(cell => {
                    const cellStr = String(cell ?? '');
                    return (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) 
                        ? `"${cellStr.replace(/"/g, '""')}"` 
                        : cellStr;
                }).join(',');
                csvLines.push(line);
            }
            const csv = csvLines.join('\n') + '\n';
            
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const fileName = `export_${timestamp}.csv`;
            
            // Pobierz ostatnio używany katalog lub użyj pulpitu
            let lastPath = this.getLastExportPath('csv');
            const defaultDir = lastPath ? path.dirname(lastPath) : path.join(os.homedir(), 'Desktop');
            const defaultUri = vscode.Uri.file(path.join(defaultDir, fileName));
            
            const uri = await vscode.window.showSaveDialog({
                defaultUri: defaultUri,
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
            // Generuj TXT (format tabelaryczny)
            const txtLines: string[] = [];
            
            // Oblicz szerokości kolumn
            const colWidths: number[] = [];
            for (let i = 0; i < headers.length; i++) {
                let maxWidth = headers[i].length;
                for (const row of rows) {
                    const cellStr = String(row[i] === null || row[i] === undefined ? '' : row[i]);
                    if (cellStr.length > maxWidth) maxWidth = cellStr.length;
                }
                colWidths.push(Math.min(maxWidth, 50));
            }
            
            // Linia oddzielająca
            const separator = '+-' + colWidths.map(w => '-'.repeat(w)).join('-+-') + '-+';
            
            txtLines.push(separator);
            txtLines.push('| ' + headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ') + ' |');
            txtLines.push(separator);
            
            // Dane
            for (const row of rows) {
                let rowStr = '| ';
                for (let i = 0; i < headers.length; i++) {
                    let cellStr = String(row[i] ?? '');
                    if (cellStr.length > colWidths[i]) {
                        cellStr = cellStr.substring(0, colWidths[i] - 3) + '...';
                    }
                    rowStr += cellStr.padEnd(colWidths[i]) + ' | ';
                }
                txtLines.push(rowStr);
            }
            txtLines.push(separator);
            txtLines.push(`Liczba wierszy: ${rows.length}`);
            const txt = txtLines.join('\n') + '\n';
            
            // Zapamiętanie katalogu
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const fileName = `export_${timestamp}.txt`;
            
            let lastPath = this.getLastExportPath('txt');
            const defaultDir = lastPath ? path.dirname(lastPath) : path.join(os.homedir(), 'Desktop');
            const defaultUri = vscode.Uri.file(path.join(defaultDir, fileName));
            
            const uri = await vscode.window.showSaveDialog({
                defaultUri: defaultUri,
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