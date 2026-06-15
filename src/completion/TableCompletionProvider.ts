import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager';
import { getCachedColumnsBatch, getTableRefKey, TableColumn, TableRef } from '../cache/tableColumnsCache';
import { formatColumnType } from './columnFormatter';
import { findCurrentQuery } from '../sql/findCurrentQuery';
import { findQueryTables } from '../sql/findQueryTables';
import { SQL_FUNCTIONS, SqlFunction } from './sqlFunctions';
import { Connection } from '../db/Connection';

const REGEX_SCHEMA_TABLE = /\b(?:from|join)\s+(\w+)\.(\w*)$/i;
const REGEX_FROM_OBJECT = /\b(?:from|join)\s+(\w*)$/i;
const REGEX_ALIAS_DOT = /([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)\.$/;
const REGEX_WORDS = /[a-zA-Z0-9_().]+/g;

export class TableCompletionProvider implements vscode.CompletionItemProvider {

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[]> {
        
        // Wykorzystujemy Promise.race ukryty pod logiką tokenu.
        // Jeśli użytkownik anuluje (np. pisząc dalej), natychmiast wychodzimy z metody.
        try {
            return await this.raceCancellation(
                this.executeProvideCompletionItems(document, position),
                token
            );
        } catch (err) {
            if (err instanceof vscode.CancellationError) {
                // VS Code anulował żądanie – zwracamy bezpiecznie pustą listę
                return [];
            }
            // Inne nieprzewidziane błędy krytyczne
            console.error('[TableCompletionProvider] Krytyczny błąd metody:', err);
            return [];
        }
    }

    /**
     * Pomocnicza metoda wiążąca asynchroniczne wykonanie z tokenem anulowania VS Code.
     */
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

    /**
     * Właściwa logika biznesowa podpowiadania składni (oczyszczona z if(token...))
     */
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
        
        /* HAVING */
        if (isInHavingClause) {
            const result: vscode.CompletionItem[] = [];
            const selectPart = selectIndex !== -1 && fromIndex !== -1
                ? sqlBeforeCursor.slice('select'.length, fromIndex)
                : '';
            const words = (selectPart.match(REGEX_WORDS) ?? [])
                .map(word => {
                    const i = word.lastIndexOf('.');
                    return i === -1 ? word : word.slice(i + 1);
                });
            for (const word of new Set(words)) {
                const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
                item.sortText = `5_${word}`;
                result.push(item);
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

                const columnsMap = await getCachedColumnsBatch([{ schema, table }]);
                const columns = columnsMap[getTableRefKey({ schema, table })] ?? [];

                return columns.map(column => this.createColumnItem(table, column));
            }

            const defaultSchema = db.getDatabase();
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

            const columnsMap = await getCachedColumnsBatch([tableRef]);
            const columns = columnsMap[getTableRefKey(tableRef)] ?? [];

            return columns.map(column => this.createColumnItem(tableRef!.table, column));
        }

        /* SELECT, WHERE, GROUP BY, ORDER BY <Ctrl+Space> */
        if (isInSelectClause || isInWhereClause || isInGroupClause || isInOrderClause) {
            const defaultSchema = db.getDatabase();
            const result: vscode.CompletionItem[] = [];

            const tableRefs = findQueryTables(fullText, defaultSchema, db);
            const columnsMap = await getCachedColumnsBatch(tableRefs);

            for (const tableRef of tableRefs) {
                const columns = columnsMap[getTableRefKey(tableRef)] ?? [];
                for (const column of columns) {
                    result.push(this.createColumnItem(tableRef.table, column));
                }
            }

            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }

            return result;
        }
        
        return [];
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
        item.sortText   = `0_${column.name}`;
        item.insertText = column.name;

        const formattedType = formatColumnType(column);
        const details: string[] = [formattedType];

        details.push(column.isNullable === 'YES' ? 'NULL' : 'NOT NULL');
        if (column.columnKey === 'PRI') { details.push('🔑 PRIMARY KEY'); }
        if (column.columnKey === 'UNI') { details.push('🔗 UNIQUE'); }
        if (column.extra === 'auto_increment') { details.push('📈 AUTO_INCREMENT'); }
        if (column.defaultValue !== null) { details.push(`📌 DEFAULT: ${column.defaultValue}`); }

        item.detail = `📊 ${formattedType} | ${details.slice(1).join(' | ')}`;
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
}
