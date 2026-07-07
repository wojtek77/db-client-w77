import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { SQL_FUNCTIONS } from './sqlFunctions.js';
import { TableColumn, TableRef } from '../cache/TableColumnsCache.js';
import { findQueryTables } from '../sql/findQueryTables.js';
import { CompletionInterface } from './CompletionInterface.js';

const REGEX_SCHEMA_TABLE = /\b(?:from|join)\s+(\w+)\.(\w*)$/i;
const REGEX_FROM_OBJECT = /\b(?:from|join)\s+(\w*)$/i;
// Uwaga: grupa 2 (\w*) obsługuje przypadek, gdy po `alias.` jest już częściowo
// wpisana nazwa kolumny, np. `l.date_ent|`. Bez tego regex dopasowywał się tylko
// gdy kursor stał bezpośrednio po kropce (`l.|`), a przy dalszym pisaniu tracił
// kontekst aliasu i wpadał w ogólną gałąź zwracającą kolumny ze WSZYSTKICH tabel
// zapytania (patrz addColumnsFromQueryTables) — stąd np. `l.date_entered` mogło
// pokazywać podpowiedzi tej kolumny również z innych tabel w zapytaniu.
const REGEX_ALIAS_DOT = /([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)\.(\w*)$/;

export class CompletionSelect extends CompletionAbstract implements CompletionInterface {
    
    public async complete(
        linePrefix: string,
        fullText: string,
        db: Connection,
        sqlBeforeCursor: string
    ): Promise<vscode.CompletionItem[]> {
        
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
        
        let maxClause = null;
        for (const c of clauses) {
            if (c.index !== -1 && (maxClause === null || c.index > maxClause.index)) {
                maxClause = c;
            }
        }
        const currentClause = maxClause?.name;
        
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
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor);
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
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor);
            } else if (specificAliasesToLoad.size > 0) {
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor, specificAliasesToLoad);
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

        /* Alias lub pełna nazwa tabeli (np. s. lub public.contacts.), opcjonalnie
           z już częściowo wpisaną nazwą kolumny (np. s.na lub public.contacts.na) */
        const aliasMatch = linePrefix.match(REGEX_ALIAS_DOT);
        if (aliasMatch) {
            const alias = aliasMatch[1];
            const columnFilter = aliasMatch[2].toLowerCase();
            const parts = alias.split('.');

            if (parts.length === 2) {
                const schema = parts[0];
                const table  = parts[1];

                if (!schema || !table) {
                    return [];
                }

                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([{ schema, table }]);
                const columns = columnsMap[this.tableColumnsService.getTableRefKey({ schema, table })] ?? [];

                return columns
                    .filter((column: TableColumn) => !columnFilter || column.name.toLowerCase().includes(columnFilter))
                    .map((column: TableColumn) => this.createColumnItem(table, column));
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

            // Pre-fetch kolumn dla wszystkich tabel w zapytaniu (w tym JOIN-ów) — wypełnia cache jednym
            // batchem. Celowo BEZ ograniczenia zasięgiem (cursorOffset) — sugestia i tak buduje się
            // wyłącznie z jednego konkretnego `tableRef` ustalonego wyżej, więc scoping nic by tu nie
            // poprawił, a jedynie zmniejszyłby ten batch i wymusił dodatkowe zapytania do bazy przy
            // późniejszym przejściu kursora do innego zakresu (np. wnętrza podzapytania).
            const allTableRefs = findQueryTables(fullText, defaultSchema ?? '', db);
            const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(
                allTableRefs.length > 0 ? allTableRefs : [tableRef]
            );
            const columns = columnsMap[this.tableColumnsService.getTableRefKey(tableRef)] ?? [];

            return columns
                .filter((column: TableColumn) => !columnFilter || column.name.toLowerCase().includes(columnFilter))
                .map((column: TableColumn) => this.createColumnItem(tableRef!.table, column));
        }

        /* SELECT, WHERE, GROUP BY, ORDER BY <Ctrl+Space> */
        if (isInSelectClause || isInWhereClause || isInGroupClause || isInOrderClause) {
            const result: vscode.CompletionItem[] = [];

            // Wspólna metoda: Ładujemy wszystkie kolumny dla klauzul strukturalnych
            await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor);

            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }

            return result;
        }
        
        return [];
    }
}
