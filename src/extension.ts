import * as vscode from 'vscode';
import { ConnectionManager } from './db/ConnectionManager';
import { CnfLoader } from "./db/CnfLoader";
import { SqlResultsProvider } from './panel/SqlResultsProvider';
import { getTableNames, getTableColumns, setGetCachedColumnsFunction } from './db/query';

let sqlResultsProvider: SqlResultsProvider | undefined = undefined;
let tableNames: string[] = [];

// Cache dla kolumn tabel - przechowuje pełne informacje o kolumnach
let tableColumnsCache: Map<string, any[]> = new Map();

// Funkcja formatująca typ kolumny z dodatkowymi informacjami
function formatColumnType(column: any): string {
    let typeDisplay = column.type.toUpperCase();
    
    // Dla VARCHAR i CHAR
    if ((column.type === 'varchar' || column.type === 'char') && column.characterMaximumLength) {
        typeDisplay = `${column.type.toUpperCase()}(${column.characterMaximumLength})`;
    }
    // Dla INT, BIGINT, SMALLINT, TINYINT
    else if (column.type === 'int' && column.numericPrecision) {
        typeDisplay = `INT(${column.numericPrecision})`;
    }
    else if (column.type === 'bigint' && column.numericPrecision) {
        typeDisplay = `BIGINT(${column.numericPrecision})`;
    }
    else if (column.type === 'smallint' && column.numericPrecision) {
        typeDisplay = `SMALLINT(${column.numericPrecision})`;
    }
    else if (column.type === 'tinyint' && column.numericPrecision) {
        typeDisplay = `TINYINT(${column.numericPrecision})`;
    }
    // Dla DECIMAL
    else if (column.type === 'decimal' && column.numericPrecision !== null) {
        if (column.numericScale && column.numericScale > 0) {
            typeDisplay = `DECIMAL(${column.numericPrecision}, ${column.numericScale})`;
        } else {
            typeDisplay = `DECIMAL(${column.numericPrecision})`;
        }
    }
    
    return typeDisplay;
}

// Funkcja do pobierania kolumn z cache lub z bazy (dla autouzupełniania)
export async function getCachedColumns(tableName: string): Promise<any[]> {
    if (tableColumnsCache.has(tableName)) {
        console.log(`Kolumny dla ${tableName} pobrane z cache`);
        return tableColumnsCache.get(tableName)!;
    }
    
    console.log(`Pobieranie kolumn dla ${tableName} z bazy...`);
    const columns = await getTableColumns(tableName);
    tableColumnsCache.set(tableName, columns);
    console.log(`Zapisano ${columns.length} kolumn dla ${tableName} w cache`);
    
    return columns;
}

// Funkcja dla parsera SQL (zwraca tylko nazwy kolumn jako string[])
export async function getCachedColumnsAsStrings(tableName: string): Promise<string[]> {
    const columns = await getCachedColumns(tableName);
    return columns.map((col: any) => col.name);
}

// Provider autouzupełniania
class TableCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        
        const linePrefix = document.lineAt(position).text.substr(0, position.character);
        
        // Sprawdź, czy piszemy "from " (podpowiadanie tabel)
        const fromMatch = linePrefix.match(/from\s+$/i);
        const afterFromMatch = linePrefix.match(/from\s+(\w*)$/i);
        
        // Sprawdź, czy piszemy alias z kropką (np. "s.")
        const aliasMatch = linePrefix.match(/(\w+)\.$/i);
        
        // Podpowiadanie nazw tabel po FROM
        if (fromMatch || afterFromMatch) {
            let filterText = '';
            if (afterFromMatch && afterFromMatch[1]) {
                filterText = afterFromMatch[1];
            }
            
            const completions = tableNames.map(tableName => {
                const item = new vscode.CompletionItem(tableName, vscode.CompletionItemKind.Class);
                item.insertText = tableName;
                item.detail = 'Tabela';
                item.documentation = `Nazwa tabeli: ${tableName}`;
                
                if (filterText && !tableName.toLowerCase().includes(filterText.toLowerCase())) {
                    return null;
                }
                
                return item;
            }).filter(item => item !== null) as vscode.CompletionItem[];
            
            return completions;
        }
        
        // Podpowiadanie nazw kolumn po aliasie z kropką (np. "s.")
        if (aliasMatch) {
            const alias = aliasMatch[1];
            
            const fullText = document.getText();
            const currentLine = document.lineAt(position.line).text;
            
            let tableName: string | null = null;
            
            const patterns = [
                new RegExp(`from\\s+(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i'),
                new RegExp(`join\\s+(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i'),
                new RegExp(`,\\s*(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i')
            ];
            
            for (const pattern of patterns) {
                const match = fullText.match(pattern);
                if (match && match[1]) {
                    tableName = match[1];
                    break;
                }
            }
            
            if (!tableName) {
                const inlinePattern = new RegExp(`join\\s+(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i');
                const inlineMatch = currentLine.match(inlinePattern);
                if (inlineMatch && inlineMatch[1]) {
                    tableName = inlineMatch[1];
                }
            }
            
            if (tableName) {
                const columns = await getCachedColumns(tableName);
                
                const completions = columns.map((column: any) => {
                    const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
                    item.insertText = column.name;
                    
                    const formattedType = formatColumnType(column);
                    
                    const details: string[] = [];
                    details.push(`${formattedType}`);
                    if (column.isNullable === 'YES') details.push('NULL');
                    else details.push('NOT NULL');
                    if (column.columnKey === 'PRI') details.push('🔑 PRIMARY KEY');
                    if (column.columnKey === 'UNI') details.push('🔗 UNIQUE');
                    if (column.extra === 'auto_increment') details.push('📈 AUTO_INCREMENT');
                    if (column.defaultValue !== null) details.push(`📌 DEFAULT: ${column.defaultValue}`);
                    
                    item.detail = `📊 ${formattedType} | ${details.slice(1).join(' | ')}`;
                    item.documentation = `${tableName}.${column.name}\n\n${details.join('\n')}`;
                    return item;
                });
                
                return completions;
            }
        }
        
        // Podpowiadanie kolumn gdy kursor jest między SELECT a FROM (bez aliasu)
        const selectSectionMatch = linePrefix.match(/select\s+(\w*)$/i);
        if (selectSectionMatch) {
            const fullText = document.getText();
            const fromTableMatch = fullText.match(/from\s+(\w+)\b/i);
            
            if (fromTableMatch && fromTableMatch[1]) {
                const tableName = fromTableMatch[1];
                const columns = await getCachedColumns(tableName);
                
                let filterText = selectSectionMatch[1] || '';
                
                const completions = columns
                    .filter((column: any) => {
                        if (!filterText) return true;
                        return column.name.toLowerCase().includes(filterText.toLowerCase());
                    })
                    .map((column: any) => {
                        const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
                        item.insertText = column.name;
                        
                        const formattedType = formatColumnType(column);
                        
                        const details: string[] = [];
                        details.push(`${formattedType}`);
                        if (column.isNullable === 'YES') details.push('NULL');
                        else details.push('NOT NULL');
                        if (column.columnKey === 'PRI') details.push('🔑 PRIMARY KEY');
                        if (column.columnKey === 'UNI') details.push('🔗 UNIQUE');
                        if (column.extra === 'auto_increment') details.push('📈 AUTO_INCREMENT');
                        if (column.defaultValue !== null) details.push(`📌 DEFAULT: ${column.defaultValue}`);
                        
                        item.detail = `📊 ${formattedType} | ${details.slice(1).join(' | ')}`;
                        item.documentation = `${tableName}.${column.name}\n\n${details.join('\n')}`;
                        return item;
                    });
                
                if (completions.length > 0) {
                    return completions;
                }
            }
        }
        
        return [];
    }
}

function findCurrentQuery(text: string, cursorOffset: number): string {
    const lines = text.split('\n');
    
    let lineNumber = 0;
    let charCount = 0;
    for (let i = 0; i < lines.length; i++) {
        if (cursorOffset <= charCount + lines[i].length + 1) {
            lineNumber = i;
            break;
        }
        charCount += lines[i].length + 1;
    }
    
    let startLine = lineNumber;
    for (let i = lineNumber; i >= 0; i--) {
        const trimmedLine = lines[i].trim();
        if (trimmedLine === '' || trimmedLine.endsWith(';')) {
            startLine = i + 1;
            break;
        }
        if (i === 0) startLine = 0;
    }
    
    let endLine = lineNumber;
    for (let i = lineNumber; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();
        if (trimmedLine === '') {
            endLine = i - 1;
            break;
        }
        if (trimmedLine.endsWith(';')) {
            endLine = i;
            break;
        }
        if (i === lines.length - 1) endLine = i;
    }
    
    let queryLines = lines.slice(startLine, endLine + 1);
    
    while (queryLines.length > 0 && queryLines[0].trim() === '') {
        queryLines.shift();
    }
    while (queryLines.length > 0 && queryLines[queryLines.length - 1].trim() === '') {
        queryLines.pop();
    }
    
    let query = queryLines.join('\n').trim();
    if (query.endsWith(';')) {
        query = query.slice(0, -1).trim();
    }
    
    return query;
}

export async function activate(context: vscode.ExtensionContext) {
    console.log(new Date().toLocaleTimeString('pl-PL', { hour12: false }));
    
    // ⭐ USTAW KONTEKST – zakładka stanie się widoczna
    await vscode.commands.executeCommand('setContext', 'dbClientActive', true);

    const db = ConnectionManager.getInstance();
    const cnfOptions = await CnfLoader.getOptionsFromCnf('~/.db_configs/local-system.cnf');
    
    const databaseName = cnfOptions.database || '';
    
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

    // Po połączeniu, pobierz nazwy tabel
    try {
        tableNames = await getTableNames(databaseName);
        console.log(`Załadowano ${tableNames.length} tabel do autouzupełniania`);
    } catch (err) {
        console.error('Nie udało się pobrać tabel:', err);
    }

    // ⭐ Ustaw callback dla parsera SQL
    setGetCachedColumnsFunction(getCachedColumnsAsStrings);

    // Utwórz provider dla panelu wyników
    sqlResultsProvider = new SqlResultsProvider(connectionTime.toString(), context.extensionPath, context);
    
    // Zarejestruj WebviewViewProvider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'sqlResultsView',
            sqlResultsProvider
        )
    );

    // Zarejestruj provider autouzupełniania dla plików .sql
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { scheme: 'file', language: 'sql', pattern: '**/*.sql' },
            new TableCompletionProvider(),
            ' ', '.'
        )
    );

    // Komenda do wykonania SQL
    const executeEditorSQL = vscode.commands.registerCommand('db-client.executeSQL', async () => {
        console.log('=== Komenda executeSQL wywołana ===');
        
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Nie masz otwartego edytora z kodem SQL');
            return;
        }
        
        const fileName = editor.document.fileName;
        if (!fileName.endsWith('.sql')) {
            vscode.window.showWarningMessage('Skrót Ctrl+Enter działa tylko dla plików .sql');
            return;
        }
        
        const fullText = editor.document.getText();
        const cursorPosition = editor.selection.active;
        const offset = editor.document.offsetAt(cursorPosition);
        
        let sql = findCurrentQuery(fullText, offset);
        
        if (!sql || sql.trim() === '') {
            vscode.window.showWarningMessage('Nie znaleziono zapytania SQL pod kursorem');
            return;
        }
        
        console.log('Wykonywane zapytanie:', sql);
        
        if (sqlResultsProvider) {
            await sqlResultsProvider.executeQuery(sql);
            sqlResultsProvider.show();
        }
    });

    // Komenda do ręcznego otwarcia panelu
    const openPanel = vscode.commands.registerCommand('db-client.openPanel', () => {
        vscode.commands.executeCommand('sqlResultsView.focus');
    });

    context.subscriptions.push(executeEditorSQL, openPanel);
}

export async function deactivate() {
    // ⭐ UKRYJ ZAKŁADKĘ
    await vscode.commands.executeCommand('setContext', 'dbClientActive', false);
    
    await ConnectionManager.getInstance().disconnect();
    console.log('WYWOŁANIE FUNKCJI DEACTIVATE');
}