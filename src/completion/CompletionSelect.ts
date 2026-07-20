import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { SQL_FUNCTIONS } from './sqlFunctions.js';
import { TableColumn, TableRef } from '../cache/TableColumnsCache.js';
import { findQueryTables } from '../sql/findQueryTables.js';
import { CompletionInterface } from './CompletionInterface.js';
import { tokenize, computeDepths, currentDepth, Token } from '../sql/tokenizer.js';

const REGEX_SCHEMA_TABLE = /\b(?:from|join)\s+(\w+)\.(\w*)$/i;
const REGEX_FROM_OBJECT = /\b(?:from|join)\s+(\w*)$/i;
// grupa 2 (\\w*) obsługuje częściowo wpisaną nazwę kolumny po `alias.` (np. `l.date_ent|`) – bez niej kontekst aliasu gubił się przy dalszym pisaniu
const REGEX_ALIAS_DOT = /([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)\.(\w*)$/;

export type SelectClauseName = 'select' | 'from' | 'where' | 'group' | 'having' | 'order' | 'limit';

export interface DetectedClause {
    name: SelectClauseName;
    // offset słowa rozpoczynającego klauzulę w oryginalnym sqlBeforeCursor - potrzebne tylko do przekazania do isCursorInsideFunctionCall
    start: number;
}

// pojedyncze słowo -> nazwa klauzuli; GROUP/ORDER wymagają jeszcze sprawdzenia kolejnego tokena ('BY'), patrz niżej
const CLAUSE_WORD: Partial<Record<string, SelectClauseName>> = {
    SELECT: 'select',
    FROM: 'from',
    WHERE: 'where',
    HAVING: 'having',
    LIMIT: 'limit',
};

// wykrywa, w której klauzuli zapytania SELECT znajduje się kursor (koniec sqlBeforeCursor)
// liczy się z zagnieżdżeniem w nawiasach (podzapytania, wywołania funkcji) - szukamy klauzul tylko na głębokości, na której faktycznie stoi kursor,
// a nie zawsze na najwyższym poziomie, bo inaczej HAVING/SELECT wewnątrz "FROM (SELECT ... )" myliłoby się z klauzulami zapytania zewnętrznego
// dzięki tokenizacji słowo kluczowe wewnątrz stringa/komentarza albo będące częścią dłuższego identyfikatora (np. "transform_flag" zawiera "from")
// nie jest już mylnie brane za granicę klauzuli - to był realny błąd poprzedniej wersji opartej na indexOf na surowym tekście
export function detectCurrentClause(sqlBeforeCursor: string): DetectedClause | undefined {
    const tokens = tokenize(sqlBeforeCursor);
    const depths = computeDepths(tokens);
    const targetDepth = currentDepth(tokens);

    let found: DetectedClause | undefined;
    for (let i = 0; i < tokens.length; i++) {
        if (depths[i] !== targetDepth) { continue; }
        const t = tokens[i];
        if (t.type !== 'word') { continue; }
        const upper = t.value.toUpperCase();
        const next: Token | undefined = tokens[i + 1];
        const nextUpper = next?.type === 'word' ? next.value.toUpperCase() : undefined;

        if (upper === 'GROUP' && nextUpper === 'BY') { found = { name: 'group', start: t.start }; continue; }
        if (upper === 'ORDER' && nextUpper === 'BY') { found = { name: 'order', start: t.start }; continue; }

        const simple = CLAUSE_WORD[upper];
        if (simple) { found = { name: simple, start: t.start }; }
    }
    return found;
}

export class CompletionSelect extends CompletionAbstract implements CompletionInterface {
    
    public async complete(
        linePrefix: string,
        fullText: string,
        db: Connection,
        sqlBeforeCursor: string
    ): Promise<vscode.CompletionItem[]> {
        
        const detectedClause = detectCurrentClause(sqlBeforeCursor);
        const currentClause = detectedClause?.name;
        // offset klauzuli HAVING w sqlBeforeCursor - potrzebny tylko do isCursorInsideFunctionCall (metoda dziedziczona z CompletionAbstract, na razie działa na tekście, nie na tokenach)
        const havingIndex = currentClause === 'having' ? detectedClause!.start : -1;
        
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

            // sprawdzamy czy kursor jest wewnątrz nawiasów funkcji (np. GROUP_CONCAT(|)) – jeśli tak, pomijamy SELECT i serwujemy kolumny z tabel zapytania
            if (this.isCursorInsideFunctionCall(sqlBeforeCursor, havingIndex)) {
                await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor);
                return result;
            }

            // wyciągamy fragment SELECT...FROM z tego samego poziomu zagnieżdżenia
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

            // wspólna metoda: Ładujemy kolumny z tabel na podstawie gwiazdek
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

            // pre-fetch kolumn dla wszystkich tabel jednym batchem, celowo bez scopingu po cursorOffset – sugestia i tak buduje się z jednego `tableRef`
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

            // wspólna metoda: Ładujemy wszystkie kolumny dla klauzul strukturalnych
            await this.addColumnsFromQueryTables(result, fullText, defaultSchema, db, sqlBeforeCursor);

            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }

            return result;
        }
        
        return [];
    }
}
