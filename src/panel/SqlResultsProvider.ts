import * as vscode from 'vscode';
import { getHtml } from './html';
import { executeQuery } from '../db/query';
import { ConnectionManager } from '../db/ConnectionManager';

export class SqlResultsProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _connectionTime: string;
    private _extensionPath: string;
    private _allRows: any[][] = [];
    private _headers: string[] = [];
    private _lastQueryTime = '0';
    private _lastTableName = '';
    private _lastSQL = '';
    private _currentPage = 1;
    private readonly ROWS_PER_PAGE = 200;
    private _context?: vscode.ExtensionContext;

    constructor(connectionTime: string, extensionPath: string, context: vscode.ExtensionContext) {
        this._connectionTime = connectionTime;
        this._extensionPath = extensionPath;
        this._context = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(this._extensionPath)]
        };

        this.updateHtml();
        
        // ⭐ REWELACYJNE ZABEZPIECZENIE:
        webviewView.onDidDispose(() => {
            console.log('Czyszczenie zniszczonej referencji Webview');
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
            
            if (msg.command === 'exportCSV') {
                await this.exportToCSV(msg.rows, msg.headers);
            }
            
            if (msg.command === 'exportTXT') {
                await this.exportToTXT(msg.rows, msg.headers);
            }
        });
    }

    private updateHtml() {
        if (!this._view) return;
        
        const html = getHtml(
            this._view.webview,
            this._extensionPath,
            this._connectionTime,
            this._lastQueryTime
        );
        this._view.webview.html = html;
    }

    private sendPage(pageNumber: number) {
        if (!this._view) return;
        
        const start = (pageNumber - 1) * this.ROWS_PER_PAGE;
        const end = start + this.ROWS_PER_PAGE;
        const pageRows = this._allRows.slice(start, end);
        const totalPages = Math.ceil(this._allRows.length / this.ROWS_PER_PAGE);
        
        console.log('Sending headers to webview:', this._headers);  // ⭐ DODAJ
        
        this._view.webview.postMessage({
            command: 'appendData',
            rows: pageRows,
            headers: this._headers,
            totalRows: this._allRows.length,
            isLast: (pageNumber === totalPages),
            currentPage: pageNumber,
            totalPages: totalPages
        });
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
        console.log('=== updateCellInDB ===');
        console.log('rowIndex:', rowIndex);
        console.log('columnIndex:', columnIndex);
        console.log('value:', value);
        console.log('this._allRows length:', this._allRows.length);
        console.log('this._allRows[rowIndex]:', this._allRows[rowIndex]);
        
        try {
            const db = ConnectionManager.getInstance();
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
            console.log('id:', id);
            
            const columnName = this._headers[columnIndex];
            console.log('columnName:', columnName);
            
            const updateSQL = `UPDATE ${this._lastTableName} SET ${columnName} = ? WHERE id = ?`;
            console.log(`Wykonuję: ${updateSQL}`, [value, id]);
            
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

    public async executeQuery(sql: string) {
        const { rows, headers, queryTime, success, errorMessage } = await executeQuery(sql);
        
        // ⭐ BEZPIECZNIK BŁĘDÓW: Jeśli widok jest zniszczony, nie próbuj wysyłać wiadomości o błędzie
        if (!success) {
            vscode.window.showErrorMessage(`Błąd zapytania: ${errorMessage}`);
            if (this._view) { // To bezpieczne sprawdzenie zapobiegnie crashowi
                this._view.webview.postMessage({ command: 'error', message: errorMessage });
            }
            return;
        }

        this._allRows = rows;
        this._headers = headers;
        this._lastSQL = sql;
        this._lastTableName = this.extractTableName(sql);
        this._lastQueryTime = queryTime;
        this._currentPage = 1;
        
        console.log(`Wykonano zapytanie. Nagłówki: ${headers.join(', ')}, Liczba wierszy: ${rows.length}`);

        // ⭐ KLUCZOWY BEZPIECZNIK POŁĄCZENIA:
        // Jeśli użytkownik zamknął plik i otworzył go ponownie, 'this._view' będzie undefined (dzięki krokowi 1).
        // Wtedy wywołujemy show(), co zmusi VS Code do ponownego odpalenia 'resolveWebviewView' i stworzenia nowego okna.
        if (!this._view) {
            this.show({ preserveFocus: true });
        }
        
        this.updateHtml();
        
        setTimeout(() => {
            if (this._view) { // Dodatkowe upewnienie się przed wysłaniem paczki
                this.sendPage(1);
            }
        }, 100);
    }

    public show(options?: { preserveFocus?: boolean }) {
        const preserveFocus = options?.preserveFocus ?? true;
        
        if (this._view) {
            // ! WAŻNE: W VS Code flaga 'preserveFocus' działa odwrotnie niż Twój stary wpis.
            // Przekazanie true oznacza: ZACHOWAJ FOKUS W EDYTORZE (nie kradnij go).
            this._view.show?.(preserveFocus); 
        } else {
            vscode.commands.executeCommand('sqlResultsView.focus', { preserveFocus: preserveFocus });
        }
    }
    
    private async exportToCSV(rows: any[][], headers: string[]) {
        try {
            // Generuj CSV
            let csv = headers.join(',') + '\n';
            
            for (const row of rows) {
                const line = row.map(cell => {
                    if (cell === null || cell === undefined) return '';
                    let cellStr = String(cell);
                    if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
                        cellStr = '"' + cellStr.replace(/"/g, '""') + '"';
                    }
                    return cellStr;
                }).join(',');
                csv += line + '\n';
            }
            
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const fileName = `export_${timestamp}.csv`;
            
            // Pobierz ostatnio używany katalog lub użyj pulpitu
            let lastPath = this.getLastExportPath('csv');
            let defaultUri: vscode.Uri;
            
            if (lastPath) {
                // Użyj ostatniego katalogu
                const lastDir = require('path').dirname(lastPath);
                defaultUri = vscode.Uri.file(require('path').join(lastDir, fileName));
            } else {
                // Domyślnie pulpit
                const os = require('os');
                const path = require('path');
                defaultUri = vscode.Uri.file(path.join(os.homedir(), 'Desktop', fileName));
            }
            
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
    
    private async exportToTXT(rows: any[][], headers: string[]) {
        try {
            // Generuj TXT (format tabelaryczny)
            let txt = '';
            
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
            
            // Nagłówki
            txt += separator + '\n';
            txt += '| ';
            for (let i = 0; i < headers.length; i++) {
                txt += headers[i].padEnd(colWidths[i]) + ' | ';
            }
            txt += '\n' + separator + '\n';
            
            // Dane
            for (const row of rows) {
                txt += '| ';
                for (let i = 0; i < headers.length; i++) {
                    let cellStr = String(row[i] === null || row[i] === undefined ? '' : row[i]);
                    if (cellStr.length > colWidths[i]) {
                        cellStr = cellStr.substring(0, colWidths[i] - 3) + '...';
                    }
                    txt += cellStr.padEnd(colWidths[i]) + ' | ';
                }
                txt += '\n';
            }
            txt += separator + '\n';
            txt += `Liczba wierszy: ${rows.length}\n`;
            
            // Zapamiętanie katalogu
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const fileName = `export_${timestamp}.txt`;
            
            let lastPath = this.getLastExportPath('txt');
            let defaultUri: vscode.Uri;
            
            if (lastPath) {
                const path = require('path');
                const lastDir = path.dirname(lastPath);
                defaultUri = vscode.Uri.file(path.join(lastDir, fileName));
            } else {
                const os = require('os');
                const path = require('path');
                defaultUri = vscode.Uri.file(path.join(os.homedir(), 'Desktop', fileName));
            }
            
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