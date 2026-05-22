import * as vscode from 'vscode';
import { getHtml } from './html';
import { executeQuery } from '../db/query';
import { ConnectionManager } from '../db/ConnectionManager';
import * as path from 'path';
import * as os from 'os';
import { SqlFile } from '../db/SqlFile';

export class SqlResultsProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _connectionName: string = '';
    private _connectionTime: string = '0';
    private _extensionPath: string;
    private _allRows: any[][] = [];
    private _headers: string[] = [];
    private _lastQueryTime = '0';
    private _lastTableName = '';
    private _lastSQL = '';
    private _currentPage = 1;
    private readonly ROWS_PER_PAGE = 200;
    private _context?: vscode.ExtensionContext;
    private _resolveView?: (value: boolean) => void;

    constructor(context: vscode.ExtensionContext) {
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

    private extractTableName(sql: string): string {
        const match = sql.match(/from\s+[`"]?(\w+)[`"]?/i);
        if (match && match[1]) {
            return match[1];
        }
        const match2 = sql.match(/from\s+[`"]?\w+[`"]?\.([`"]?\w+[`"]?)/i);
        if (match2 && match2[1]) {
            return match2[1].replace(/[`"]/g, '');
        }
        return '';
    }

    private async updateCellInDB(rowIndex: number, columnIndex: number, value: any) {
        try {
            const db = await ConnectionManager.getInstance().getDb();
            const conn = db.getConnection();
            
            if (!this._lastTableName) {
                vscode.window.showErrorMessage('Nie można określić nazwy tabeli z zapytania SQL');
                return;
            }
            
            // Sprawdź czy rowIndex jest prawidłowy
            if (!this._allRows[rowIndex]) {
                console.error(`Nie znaleziono wiersza o indeksie ${rowIndex}`);
                vscode.window.showErrorMessage(`Nie znaleziono wiersza o indeksie ${rowIndex}`);
                return;
            }
            
            // Znajdź ID w pierwszej kolumnie
            const id = this._allRows[rowIndex][0];
            
            
            const columnName = this._headers[columnIndex];
            
            
            const updateSQL = `UPDATE ${this._lastTableName} SET ${columnName} = ? WHERE id = ?`;
            
            
            await conn.query(updateSQL, [value, id]);
            
            // Aktualizuj dane w pamięci
            this._allRows[rowIndex][columnIndex] = value;
            
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'updateConfirmed',
                    rowIndex: rowIndex,
                    columnIndex: columnIndex,
                    value: value
                });
            }
            
            vscode.window.showInformationMessage(`✅ Zaktualizowano ${columnName}=${value} dla ID ${id}`);
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

    public async executeQuery(sql: string) {
        console.log('executeQuery');
        
        // czasami widok może nie istnieć, np. przy pierwszym uruchomieniu SQL lub kiedy plik .sql został zamknięty
        if (!this._view) {
            // to tworzy this._view 
            this.show({ preserveFocus: true });
            
            // czekamy asynchronicznie, aż VS Code stworzy widok
            await this.waitForView();
            if (!this._view) {
                vscode.window.showErrorMessage("Nie udało się otworzyć okna wyników SQL.");
                return;
            }
            
            this.updateHtml();
        }
        
        const { rows, headers, queryTime, success, errorMessage } = await executeQuery(sql);
        
        if (!success) {
            // vscode.window.showErrorMessage(`Błąd zapytania: ${errorMessage}`);
            this._view.webview.postMessage({ command: 'error', message: errorMessage });
            return;
        }
        
        const db = await ConnectionManager.getInstance().getDb();
        
        // wysłanie info o tym że dane się łądują (spinner)
        this._view.webview.postMessage({ 
            command: 'loadingData'
        });
        
        this._allRows = rows;
        this._headers = headers;
        this._lastSQL = sql;
        this._lastTableName = this.extractTableName(sql);
        this._connectionName = db.getConnectionName();
        this._connectionTime = db.getConnectionTime();
        this._lastQueryTime = queryTime;
        this._currentPage = 1;
        
        this.sendPage(1);
    }

    private show(options?: { preserveFocus?: boolean }) {
        const preserveFocus = options?.preserveFocus ?? true;
        
        if (this._view) {
            // ! WAŻNE: W VS Code flaga 'preserveFocus' działa odwrotnie niż Twój stary wpis.
            // Przekazanie true oznacza: ZACHOWAJ FOKUS W EDYTORZE (nie kradnij go).
            this._view.show?.(preserveFocus); 
        } else {
            vscode.commands.executeCommand('sqlResultsView.focus', { preserveFocus: preserveFocus });
        }
    }
    
    private async changeConnection() {

        const connectionName = await SqlFile.getInstance().changeConnectionName();

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