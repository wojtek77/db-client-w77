import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { TableColumn, TableColumnsCache, TableRef } from '../cache/TableColumnsCache.js';
import { formatColumnType } from './columnFormatter.js';
import { findCurrentQuery } from '../sql/findCurrentQuery.js';
import { findQueryTables } from '../sql/findQueryTables.js';
import { SQL_FUNCTIONS, SqlFunction } from './sqlFunctions.js';
import { Connection } from '../db/Connection.js';

const REGEX_SCHEMA_TABLE = /\b(?:from|join)\s+(\w+)\.(\w*)$/i;
const REGEX_FROM_OBJECT = /\b(?:from|join)\s+(\w*)$/i;
const REGEX_ALIAS_DOT = /([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)\.$/;

export class TableCompletionProvider implements vscode.CompletionItemProvider {
    
    private tableColumnsService;
    
    public constructor() {
        this.tableColumnsService = TableColumnsCache.getInstance();
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[]> {
        
        try {
            return await this.raceCancellation(
                this.executeProvideCompletionItems(document, position),
                token
            );
        } catch (err) {
            if (err instanceof vscode.CancellationError) {
                return [];
            }
            console.error('[TableCompletionProvider] Krytyczny błąd metody:', err);
            return [];
        }
    }

    private raceCancellation<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (token.isCancellationRequested) {
                return reject(new vscode.CancellationError());
            }
            const disposable = token.onCancellationRequested(() => {
                disposable.dispose();
                reject(new vscode.CancellationError());
            });
            promise.then(
                res => { disposable.dispose(); resolve(res); },
                err => { disposable.dispose(); reject(err); }
            );
        });
    }

    private async executeProvideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.CompletionItem[]> {

        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const currentQuery = findCurrentQuery(document.getText(), position.line);

        if (!currentQuery) {
            return [];
        }

        const fullText = currentQuery.sql;

        let db: Connection;
        try {
            db = await ConnectionManager.getInstance().getDb();
        } catch (err) {
            console.error('[TableCompletionProvider] Błąd połączenia z bazą:', err);
            return [];
        }
        
        const queryStartOffset = document.offsetAt(new vscode.Position(currentQuery.startLine, 0));
        const queryOffset = document.offsetAt(position) - queryStartOffset;
        const sqlBeforeCursor = fullText.substring(0, queryOffset);
        const beforeCursor = sqlBeforeCursor.toLowerCase();
        
        const selectIndex = beforeCursor.lastIndexOf('select');
        const fromIndex = beforeCursor.lastIndexOf('from');
        const whereIndex   = beforeCursor.lastIndexOf('where');
        const groupIndex = beforeCursor.lastIndexOf('group by');
        const havingIndex = beforeCursor.lastIndexOf('having');
        const orderIndex = beforeCursor.lastIndexOf('order by');
        const limitIndex = beforeCursor.lastIndexOf('limit');
        
        const clauses = [
            { name: 'select', index: selectIndex },
            { name: 'from',   index: fromIndex },
            { name: 'where',  index: whereIndex },
            { name: 'group',  index: groupIndex },
            { name: 'having', index: havingIndex },
            { name: 'order',  index: orderIndex },
            { name: 'limit',  index: limitIndex },
        ];
        
        const currentClause = clauses
            .filter(c => c.index !== -1)
            .sort((a, b) => b.index - a.index)[0]?.name;
        
        const isInSelectClause = currentClause === 'select';
        const isInWhereClause  = currentClause === 'where';
        const isInGroupClause  = currentClause === 'group';
        const isInHavingClause = currentClause === 'having';
        const isInOrderClause  = currentClause === 'order';
        const isInLimitClause  = currentClause === 'limit';
        
        /* LIMIT */
        if (isInLimitClause) {
            return [
                new vscode.CompletionItem('1', vscode.CompletionItemKind.Value),
                new vscode.CompletionItem('10', vscode.CompletionItemKind.Value),
                new vscode.CompletionItem('100', vscode.CompletionItemKind.Value)
            ];
        }
        
        const defaultSchema = db.getDatabase();

        /* HAVING */
        if (isInHavingClause) {
            const result: vscode.CompletionItem[] = [];

            // Sprawdzamy czy kursor jest wewnątrz nawiasów funkcji, np. GROUP_CONCAT(|)
            // Jeśli tak, pomijamy analizę SELECT i od razu serwujemy kolumny z tabel zapytania
            if (this.isCursorInsideFunctionCall(sqlBeforeCursor, havingIndex)) {
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db);
                return result;
            }

            // Wyciągamy fragment SELECT...FROM z tego samego poziomu zagnieżdżenia
            const selectPart = this.extractSelectPartAtCursorLevel(sqlBeforeCursor);
            const candidates = this.extractHavingCandidates(selectPart);

            let shouldLoadAllTables = false;
            const specificAliasesToLoad = new Set<string>();

            for (const word of candidates) {
                if (word === '*') {
                    shouldLoadAllTables = true;
                } else if (word.endsWith('.*')) {
                    const alias = word.split('.')[0];
                    if (alias) {
                        specificAliasesToLoad.add(alias.toLowerCase());
                    }
                } else {
                    const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
                    item.sortText = `5_${word}`;
                    result.push(item);
                }
            }

            // Wspólna metoda: Ładujemy kolumny z tabel na podstawie gwiazdek
            if (shouldLoadAllTables) {
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db);
            } else if (specificAliasesToLoad.size > 0) {
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, specificAliasesToLoad);
            }

            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }
            return result;
        }

        /* FROM schema. / JOIN schema. */
        const schemaTableMatch = linePrefix.match(REGEX_SCHEMA_TABLE);
        if (schemaTableMatch) {
            const schema = schemaTableMatch[1];
            const filter = schemaTableMatch[2].toLowerCase();

            return db
                .getTables(schema)
                .filter(table => table.toLowerCase().includes(filter))
                .map((table, index) => this.createTableItem(table, index));
        }

        /* FROM xxx / JOIN xxx */
        const objectMatch = linePrefix.match(REGEX_FROM_OBJECT);
        if (objectMatch) {
            const filter = objectMatch[1].toLowerCase();
            const result: vscode.CompletionItem[] = [];

            if (db.getDatabase()) {
                let tableOrder = 0;
                for (const table of db.getDefaultDatabaseTables()) {
                    if (filter && !table.toLowerCase().includes(filter)) {
                        continue;
                    }
                    result.push(this.createTableItem(table, tableOrder++));
                }
            }

            const schemas = db.getSchemas();
            schemas.forEach((schema, index) => {
                if (filter && !schema.toLowerCase().includes(filter)) {
                    return;
                }
                result.push(this.createSchemaItem(schema, index));
            });

            return result;
        }

        /* Alias lub pełna nazwa tabeli (np. s. lub public.contacts.) */
        const aliasMatch = linePrefix.match(REGEX_ALIAS_DOT);
        if (aliasMatch) {
            const alias = aliasMatch[1];
            const parts = alias.split('.');

            if (parts.length === 2) {
                const schema = parts[0];
                const table  = parts[1];

                if (!schema || !table) {
                    return [];
                }

                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([{ schema, table }]);
                const columns = columnsMap[this.tableColumnsService.getTableRefKey({ schema, table })] ?? [];

                return columns.map(column => this.createColumnItem(table, column));
            }

            let tableRef: TableRef | null = null;

            const patterns = [
                new RegExp(`from\\s+(?:(\\w+)\\s*\\.\\s*)?(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i'),
                new RegExp(`join\\s+(?:(\\w+)\\s*\\.\\s*)?(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i'),
                new RegExp(`,\\s*(?:(\\w+)\\s*\\.\\s*)?(\\w+)\\s+(?:as\\s+)?${alias}\\b`, 'i')
            ];

            for (const pattern of patterns) {
                const match = fullText.match(pattern);
                if (!match) {
                    continue;
                }
                tableRef = {
                    schema: match[1] || defaultSchema || db.findSchemaByTable(match[2]) || '',
                    table: match[2]
                };
                break;
            }

            if (!tableRef) {
                tableRef = {
                    schema: defaultSchema || db.findSchemaByTable(alias) || '',
                    table: alias
                };
            }

            const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([tableRef]);
            const columns = columnsMap[this.tableColumnsService.getTableRefKey(tableRef)] ?? [];

            return columns.map(column => this.createColumnItem(tableRef!.table, column));
        }

        /* SELECT, WHERE, GROUP BY, ORDER BY <Ctrl+Space> */
        if (isInSelectClause || isInWhereClause || isInGroupClause || isInOrderClause) {
            const result: vscode.CompletionItem[] = [];

            // Wspólna metoda: Ładujemy wszystkie kolumny dla klauzul strukturalnych
            await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db);

            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }

            return result;
        }
        
        return [];
    }

    /**
     * Wspólna metoda wyciągająca tabele z zapytania, pobierająca ich kolumny z cache
     * oraz uzupełniająca przekazaną listę wynikową (opcjonalnie filtrując po aliasach).
     */
    private async addColumnsFromQueryTables(
        resultList: vscode.CompletionItem[],
        fullText: string,
        defaultSchema: string | undefined,
        db: Connection,
        allowedAliases?: Set<string>
    ): Promise<void> {
        // Dodano operator ?? '', aby zamienić undefined na pusty string
        const tableRefs = findQueryTables(fullText, defaultSchema ?? '', db);
        const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(tableRefs);

        for (const tableRef of tableRefs) {
            if (allowedAliases) {
                const patterns = [
                    new RegExp(`from\\s+(?:(\\w+)\\s*\\.\\s*)?${tableRef.table}\\s+(?:as\\s+)?([a-zA-Z0-9_]+)\\b`, 'i'),
                    new RegExp(`join\\s+(?:(\\w+)\\s*\\.\\s*)?${tableRef.table}\\s+(?:as\\s+)?([a-zA-Z0-9_]+)\\b`, 'i'),
                    new RegExp(`,\\s*(?:(\\w+)\\s*\\.\\s*)?${tableRef.table}\\s+(?:as\\s+)?([a-zA-Z0-9_]+)\\b`, 'i')
                ];

                let currentAlias = tableRef.table.toLowerCase();
                for (const pattern of patterns) {
                    const aliasMatch = fullText.match(pattern);
                    if (aliasMatch && aliasMatch[2]) {
                        currentAlias = aliasMatch[2].toLowerCase();
                        break;
                    }
                }

                if (!allowedAliases.has(currentAlias)) {
                    continue;
                }
            }

            const columns = columnsMap[this.tableColumnsService.getTableRefKey(tableRef)] ?? [];
            for (const column of columns) {
                resultList.push(this.createColumnItem(tableRef.table, column));
            }
        }
    }

    private createTableItem(tableName: string, order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(tableName, vscode.CompletionItemKind.Struct);
        item.insertText = tableName;
        item.detail     = 'Table';
        item.sortText = `0_${order.toString().padStart(5, '0')}`;
        return item;
    }

    private createSchemaItem(schema: string, order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
        item.insertText = schema;
        item.detail     = 'Schema';
        item.sortText = `1_${order.toString().padStart(5, '0')}`;
        return item;
    }

    private createColumnItem(tableName: string, column: TableColumn): vscode.CompletionItem {
        const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
        item.sortText   = `0_${tableName}_${column.name}`;
        item.insertText = column.name;

        const formattedType = formatColumnType(column);
        const details: string[] = [formattedType];

        details.push(column.isNullable === 'YES' ? 'NULL' : 'NOT NULL');
        if (column.columnKey === 'PRI') { details.push('🔑 PRIMARY KEY'); }
        if (column.columnKey === 'UNI') { details.push('🔗 UNIQUE'); }
        if (column.extra === 'auto_increment') { details.push('📈 AUTO_INCREMENT'); }
        if (column.defaultValue !== null) { details.push(`📌 DEFAULT: ${column.defaultValue}`); }

        item.detail = `${tableName} 📊 ${formattedType} | ${details.slice(1).join(' | ')}`;
        item.documentation = `${tableName}.${column.name}\n\n${details.join('\n')}`;

        return item;
    }

    private createFunctionItem(fn: SqlFunction): vscode.CompletionItem {
        const item = new vscode.CompletionItem(`${fn.signature}`, vscode.CompletionItemKind.Function);
        item.filterText = fn.name;
        item.insertText = new vscode.SnippetString(fn.snippet);
        item.documentation = new vscode.MarkdownString(fn.documentation);
        item.sortText = `9_${fn.name}`;
        return item;
    }
    
    /**
     * Sprawdza czy kursor znajduje się wewnątrz nawiasów funkcji w obrębie danej klauzuli.
     * Przykład: "HAVING GROUP_CONCAT(|)" lub "HAVING COUNT(|)" → zwraca true.
     * Działa poprzez liczenie nawiasów od początku klauzuli do kursora:
     * jeśli głębokość > 0, kursor jest wewnątrz wywołania funkcji.
     */
    private isCursorInsideFunctionCall(sqlBeforeCursor: string, clauseIndex: number): boolean {
        if (clauseIndex === -1) { return false; }
        const fromClause = sqlBeforeCursor.slice(clauseIndex);
        let depth = 0;
        let inString = false;
        let stringChar = '';
        for (const ch of fromClause) {
            if (inString) {
                if (ch === stringChar) { inString = false; }
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') {
                inString = true;
                stringChar = ch;
            } else if (ch === '(') {
                depth++;
            } else if (ch === ')') {
                depth--;
            }
        }
        return depth > 0;
    }

    private flattenSubqueries(sql: string): string {
        const pass = sql.replace(/\([^()]*\)/g, match => ' '.repeat(match.length));
        return pass === sql ? sql : this.flattenSubqueries(pass);
    }

    private extractSelectPartAtCursorLevel(sqlBeforeCursor: string): string {
        const cursorDepth = this.depthAtEnd(sqlBeforeCursor);
        let depth = 0;
        let blockStart = 0;

        for (let i = 0; i < sqlBeforeCursor.length; i++) {
            const ch = sqlBeforeCursor[i];
            if (ch === '(') {
                depth++;
                if (depth === cursorDepth) {
                    blockStart = i + 1;
                }
            } else if (ch === ')') {
                depth--;
            }
        }

        const block = sqlBeforeCursor.slice(blockStart);
        const flat = this.flattenSubqueries(block);

        const selectRegex = /\bselect\b/gi;
        let lastSelectEnd = -1;
        let m: RegExpExecArray | null;
        while ((m = selectRegex.exec(flat)) !== null) {
            lastSelectEnd = m.index + m[0].length;
        }
        if (lastSelectEnd === -1) { return ''; }

        const fromRegex = /\bfrom\b/gi;
        fromRegex.lastIndex = lastSelectEnd;
        const fromResult = fromRegex.exec(flat);
        if (!fromResult) { return ''; }

        return block.slice(lastSelectEnd, fromResult.index);
    }

    private depthAtEnd(sql: string): number {
        let d = 0;
        for (const ch of sql) {
            if (ch === '(') { d++; }
            else if (ch === ')') { d--; }
        }
        return d;
    }

    private extractHavingCandidates(selectPart: string): string[] {
        const entries: string[] = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < selectPart.length; i++) {
            const ch = selectPart[i];
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; }
            else if (ch === ',' && depth === 0) {
                entries.push(selectPart.slice(start, i));
                start = i + 1;
            }
        }
        entries.push(selectPart.slice(start));

        const result: string[] = [];

        for (const entry of entries) {
            const rtrimmed = entry.trimEnd();
            if (!rtrimmed) { continue; }
            
            if (rtrimmed.endsWith(')')) {
                const e1 = rtrimmed.trimStart();
                if (e1.startsWith('(')) {
                    result.push(e1);
                    continue;
                }
            }

            const e1 = rtrimmed.trimStart();
            if (e1.endsWith('.*')) {
                result.push(e1);
                continue;
            }

            const parts = rtrimmed.split(/[ .]/);
            const last = parts[parts.length - 1].trimStart();
            if (last) { result.push(last); }
        }

        return [...new Set(result)];
    }
}
