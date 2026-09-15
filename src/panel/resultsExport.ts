// eksport bieżących wyników grida do pliku (CSV/TXT) oraz zapis wygenerowanego SQL (INSERT/UPDATE/DELETE) - wydzielone z SqlResultsProvider.ts,
// bo to samodzielna funkcjonalność "zapisz to na dysk", niezależna od stanu grida (paginacji/sortowania/wyszukiwania)
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

function escapeCsvCell(value: unknown): string {
    const str = value === null || value === undefined ? '' : String(value);
    return str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
}

export function buildCsv(headers: string[], rows: any[][]): string {
    const parts: string[] = [];
    parts.push(headers.map(escapeCsvCell).join(','));

    for (const row of rows) {
        parts.push(row.map(escapeCsvCell).join(','));
    }

    return parts.join('\n') + '\n';
}

function escapeTxtCell(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
}

export function buildTxt(headers: string[], rows: any[][]): string {
    // szerokości kolumn — max z nagłówka i danych, ograniczone do 50
    const colWidths = headers.map((h, i) => {
        let max = h.length;
        for (const row of rows) {
            const len = escapeTxtCell(row[i]).length;
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
            let cell = escapeTxtCell(row[i]);
            if (cell.length > colWidths[i]) {
                cell = cell.substring(0, colWidths[i] - 3) + '...';
            }
            line += cell.padEnd(colWidths[i]) + ' | ';
        }
        parts.push(line);
    }

    parts.push(separator);
    parts.push(`Row count: ${rows.length}`);

    return parts.join('\n') + '\n';
}

function getLastExportPath(context: vscode.ExtensionContext | undefined, extension: string): string | undefined {
    return context?.globalState.get<string>(`lastExportPath_${extension}`);
}

function setLastExportPath(context: vscode.ExtensionContext | undefined, filePath: string, extension: string): void {
    context?.globalState.update(`lastExportPath_${extension}`, filePath);
}

// wspólny zapis z zapamiętaną ścieżką (katalog z poprzedniego eksportu tego samego rozszerzenia, domyślnie Desktop) - zwraca uri zapisanego pliku albo undefined, gdy użytkownik anulował dialog
async function saveTextWithRememberedPath(
    context: vscode.ExtensionContext | undefined,
    content: string,
    extension: string,
    filterLabel: string,
    fileNamePrefix: string
): Promise<vscode.Uri | undefined> {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const fileName = `${fileNamePrefix}_${timestamp}.${extension}`;

    const lastPath = getLastExportPath(context, extension);
    const defaultDir = lastPath ? path.dirname(lastPath) : path.join(os.homedir(), 'Desktop');
    const defaultUri = vscode.Uri.file(path.join(defaultDir, fileName));

    const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { [filterLabel]: [extension] }
    });

    if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        setLastExportPath(context, uri.fsPath, extension);
    }

    return uri;
}

export async function exportRowsToCsv(context: vscode.ExtensionContext | undefined, headers: string[], rows: any[][]): Promise<void> {
    try {
        if (rows.length === 0) {
            vscode.window.showWarningMessage('No data to export.');
            return;
        }

        const csv = buildCsv(headers, rows);
        const uri = await saveTextWithRememberedPath(context, csv, 'csv', 'CSV files', 'export');

        if (uri) {
            vscode.window.showInformationMessage(`✅ Exported ${rows.length} rows to ${uri.fsPath}`);
        }
    } catch (err: any) {
        console.error('Export error:', err);
        vscode.window.showErrorMessage(`❌ Export error: ${err.message}`);
    }
}

export async function exportRowsToTxt(context: vscode.ExtensionContext | undefined, headers: string[], rows: any[][]): Promise<void> {
    try {
        if (rows.length === 0) {
            vscode.window.showWarningMessage('No data to export.');
            return;
        }

        const txt = buildTxt(headers, rows);
        const uri = await saveTextWithRememberedPath(context, txt, 'txt', 'Text files', 'export');

        if (uri) {
            vscode.window.showInformationMessage(`✅ Exported ${rows.length} rows to ${uri.fsPath}`);
        }
    } catch (err: any) {
        console.error('TXT export error:', err);
        vscode.window.showErrorMessage(`❌ TXT export error: ${err.message}`);
    }
}

/** Kopiuje wygenerowany SQL (INSERT/UPDATE/DELETE) do schowka i - opcjonalnie - zapisuje na dysk (ten sam mechanizm co exportRowsToCsv/Txt). */
export async function saveAndCopyGeneratedSql(context: vscode.ExtensionContext | undefined, sql: string, kind: 'insert' | 'update' | 'delete'): Promise<void> {
    await vscode.env.clipboard.writeText(sql);

    const uri = await saveTextWithRememberedPath(context, sql, 'sql', 'SQL files', kind);

    if (uri) {
        vscode.window.showInformationMessage(`✅ ${kind.toUpperCase()} SQL saved to ${uri.fsPath} (also copied to clipboard)`);
    } else {
        vscode.window.showInformationMessage(`✅ ${kind.toUpperCase()} SQL copied to clipboard`);
    }
}
