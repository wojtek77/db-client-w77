import * as vscode from 'vscode';
import { getHtml } from './html';
import { executeQuery } from '../db/query';
import { ConnectionManager } from '../db/ConnectionManager';

// Przechowujemy wszystkie wyniki w pamięci rozszerzenia
let allRows: any[] = [];
let lastQueryTime = '0';
let lastConnTime = '0';
let lastSQL: string = '';
let lastTableName: string = '';
const ROWS_PER_PAGE = 200;

export async function registerPanelCommand(
    context: vscode.ExtensionContext,
    connectionTime: string,
    initialSql: string | null
): Promise<{ panel: vscode.WebviewPanel, executeQuery: (sql: string) => Promise<void> }> {
    
    const panel = vscode.window.createWebviewPanel(
        'dbResults',
        'Wyniki SQL',
        vscode.ViewColumn.Nine,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(context.extensionPath)]
        }
    );
    
    lastConnTime = connectionTime;

    // Funkcja wyodrębniająca nazwę tabeli z zapytania SELECT
    const extractTableName = (sql: string): string => {
        // Dopasowuje "FROM table_name" lub "FROM `table_name`" lub "FROM database.table_name"
        const match = sql.match(/from\s+[`"]?(\w+)[`"]?/i);
        if (match && match[1]) {
            return match[1];
        }
        
        // Jeśli nie znaleziono, spróbuj z kropką (database.table)
        const match2 = sql.match(/from\s+[`"]?\w+[`"]?\.([`"]?\w+[`"]?)/i);
        if (match2 && match2[1]) {
            return match2[1].replace(/[`"]/g, '');
        }
        
        return '';
    };

    // Funkcja wysyłająca konkretną stronę (200 wierszy)
    const sendPage = (pageNumber: number) => {
        const start = (pageNumber - 1) * ROWS_PER_PAGE;
        const end = start + ROWS_PER_PAGE;
        const pageRows = allRows.slice(start, end);
        const totalPages = Math.ceil(allRows.length / ROWS_PER_PAGE);
        
        panel.webview.postMessage({
            command: 'appendData',
            rows: pageRows,
            totalRows: allRows.length,
            isLast: (pageNumber === totalPages),
            currentPage: pageNumber,
            totalPages: totalPages
        });
    };

    // Funkcja aktualizująca dane w bazie
    const updateCellInDB = async (id: any, column: string, value: any) => {
        try {
            const db = ConnectionManager.getInstance();
            const conn = db.getConnection();
            
            if (!lastTableName) {
                vscode.window.showErrorMessage('Nie można określić nazwy tabeli z zapytania SQL');
                return;
            }
            
            // Sprawdź typ ID (może być string lub number)
            const idColumn = 'id'; // Zakładamy, że klucz główny to 'id'
            
            // Wykonaj UPDATE w bazie
            const updateSQL = `UPDATE ${lastTableName} SET ${column} = ? WHERE ${idColumn} = ?`;
            console.log(`Wykonuję: ${updateSQL}`, [value, id]);
            
            const result = await conn.query(updateSQL, [value, id]);
            
            console.log('Wynik update:', result);
            
            // Po udanym update, aktualizujemy również dane w pamięci rozszerzenia
            const rowIndex = allRows.findIndex(row => row[idColumn] === id || row.ID === id);
            if (rowIndex !== -1) {
                allRows[rowIndex][column] = value;
            }
            
            // Potwierdź update w WebView
            panel.webview.postMessage({
                command: 'updateConfirmed',
                id: id,
                column: column
            });
            
            vscode.window.showInformationMessage(`✅ Zaktualizowano ${column}=${value} dla ID ${id}`);
        } catch (err: any) {
            console.error('Błąd update:', err);
            vscode.window.showErrorMessage(`❌ Błąd aktualizacji: ${err.message}`);
        }
    };

    // Wykonanie zapytania i wysłanie pierwszej strony
    const executeAndSendFirstPage = async (sql: string) => {
        const { rows, queryTime, success, errorMessage } = await executeQuery(sql);
        
        if (!success) {
            panel.webview.postMessage({
                command: 'error',
                message: errorMessage
            });
            vscode.window.showErrorMessage(`Błąd zapytania: ${errorMessage}`);
            return;
        }

        allRows = rows;
        lastSQL = sql;
        lastTableName = extractTableName(sql);
        lastQueryTime = queryTime;
        
        console.log(`Wykonano zapytanie. Tabela: ${lastTableName}, Liczba wierszy: ${rows.length}`);

        // Aktualizacja HTML (czasy)
        const html = getHtml(panel.webview, context.extensionPath, lastConnTime, lastQueryTime);
        panel.webview.html = html;

        // Po załadowaniu WebView, wyślij pierwszą stronę
        setTimeout(() => {
            sendPage(1);
        }, 100);
    };

    // Obsługa wiadomości z WebView
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'loadPage') {
            sendPage(msg.page);
        }
        
        if (msg.command === 'updateCell') {
            console.log(`Otrzymano update: ID=${msg.id}, ${msg.column}=${msg.value}`);
            await updateCellInDB(msg.id, msg.column, msg.value);
        }
    });

    // Inicjalizacja
    if (initialSql && initialSql.trim() !== '') {
        await executeAndSendFirstPage(initialSql);
    } else {
        const emptyHtml = getHtml(panel.webview, context.extensionPath, lastConnTime, '0');
        panel.webview.html = emptyHtml;
    }

    return {
        panel: panel,
        executeQuery: async (sql: string) => {
            await executeAndSendFirstPage(sql);
        }
    };
}

export function showOrFocusPanel(panel: vscode.WebviewPanel) {
    try {
        panel.reveal(vscode.ViewColumn.Nine);
    } catch (error) {
        console.log('Nie można pokazać panelu:', error);
        // Panel jest prawdopodobnie zniszczony
    }
}
