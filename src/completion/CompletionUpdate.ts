import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { CompletionInterface } from './CompletionInterface.js';
import { TableColumn, TableRef } from '../cache/TableColumnsCache.js';
import { findQueryTables } from '../sql/findQueryTables.js';

// uproszczone wyrażenia regularne dla sekcji tabel (operujące na linePrefix)
const REGEX_UPDATE_SCHEMA_TABLE = /\b([\w]+)\.([\w]*)$/i;
const REGEX_UPDATE_OBJECT = /\b([\w]*)$/i;

// wyrażenie do wykrywania, czy kursor stoi bezpośrednio po aliasie i kropce, np. `s.|` lub `c.|`
const REGEX_ALIAS_DOT = /([a-zA-Z0-9_]+)\.$/;

export class CompletionUpdate extends CompletionAbstract implements CompletionInterface {
    
    public async complete(
        linePrefix: string,
        fullText: string,
        db: Connection,
        sqlBeforeCursor: string
    ): Promise<vscode.CompletionItem[]> {

        // blokowanie podpowiedzi wewnątrz stringów tekstowych
        const quotesCount = (linePrefix.match(/'/g) || []).length;
        if (quotesCount % 2 !== 0) {
            return [];
        }

        const beforeCursorLower = sqlBeforeCursor.toLowerCase();
        const setIndex = beforeCursorLower.lastIndexOf('set');
        const whereIndex = beforeCursorLower.lastIndexOf('where');

        // określamy domyślny kontekst bazy danych
        const defaultSchema = db.getDatabase();

        // sprawdzamy, w której sekcji zapytania znajduje się kursor
        const isInSetClause = setIndex > -1 && (whereIndex === -1 || setIndex > whereIndex);
        const isInWhereClause = whereIndex > -1 && whereIndex > setIndex;
        const isAfterUpdate = beforeCursorLower.includes('update');
        const isInJoinOnClause = isAfterUpdate && !isInSetClause && !isInWhereClause && beforeCursorLower.lastIndexOf(' on ') > beforeCursorLower.lastIndexOf('join');

        // 1. Jeśli jesteśmy w kontekście kolumnowym (SET, WHERE lub JOIN ON)
        if (isInSetClause || isInWhereClause || isInJoinOnClause) {
            
            // budowanie pełnej listy tabel – A. pobieramy tabele z JOIN standardowym parserem (allTableRefs zawężone do zasięgu kursora)
            const allTableRefs = findQueryTables(fullText, defaultSchema ?? '', db, sqlBeforeCursor.length);

            // prefetch/cache-warming – batch wszystkich tabel, żeby zmiana zakresu kursora trafiała w cache; służy tylko do rozgrzania, nie do podpowiedzi
            const allTableRefsForPrefetch = findQueryTables(fullText, defaultSchema ?? '', db);
            
            // b. Multi-table UPDATE (Obsługa tabel po przecinku oraz tabeli głównej)
            const updateSetRegex = /\bupdate\s+([\s\S]*?)\s+set/i;
            const updateSetMatch = fullText.match(updateSetRegex);
            
            if (updateSetMatch && updateSetMatch[1]) {
                const tablesPart = updateSetMatch[1];
                
                // POPRAWKA: Globalne usuwanie wszystkich modyfikatorów (wielokrotne powtórzenia)
                const cleanTablesPart = tablesPart.replace(/\b(low_priority|ignore)\b/gi, '').trim();
                
                // rozbijamy tekst po przecinkach (np. "student s, client c")
                const tableTokens = cleanTablesPart.split(',');
                
                // lista słów zastrzeżonych, których na pewno nie chcemy traktować jako nazw tabel
                const forbiddenKeywords = new Set(['update', 'ignore', 'low_priority', 'set']);

                for (const token of tableTokens) {
                    const parts = token.trim().split(/\s+/);
                    if (parts.length > 0 && parts[0]) {
                        let table = parts[0];

                        // zabezpieczenie przed pustymi tokenami lub słowami kluczowymi
                        if (!table || forbiddenKeywords.has(table.toLowerCase())) {
                            continue;
                        }

                        let schema = '';
                        if (table.includes('.')) {
                            const dotParts = table.split('.');
                            schema = dotParts[0];
                            table = dotParts[1];
                        } else {
                            schema = defaultSchema || '';
                        }

                        if (!table) {
                            continue;
                        }

                        // dodajemy tabelę do obu list, jeśli jej tam nie ma – findQueryTables szuka tylko FROM/JOIN, samo UPDATE t1, t2 SET tam nie trafi
                        const exists = allTableRefs.some(
                            ref => ref.schema.toLowerCase() === schema.toLowerCase() && 
                                   ref.table.toLowerCase() === table.toLowerCase()
                        );
                        
                        if (!exists) {
                            allTableRefs.push({ schema, table });
                            allTableRefsForPrefetch.push({ schema, table });
                        }
                    }
                }
            }

            // PRZYPADEK 1A: Kursor stoi bezpośrednio po aliasie z kropką (np. `s.|`, `c.|`)
            const aliasMatch = linePrefix.match(REGEX_ALIAS_DOT);
            if (aliasMatch) {
                const alias = aliasMatch[1].toLowerCase();
                let matchedTableRef: TableRef | undefined;

                // szukamy w pełnym tekście zapytania, która tabela ma przypisany ten alias
                for (const ref of allTableRefs) {
                    const pattern = new RegExp(`\\b${ref.table}\\s+(?:as\\s+)?${alias}\\b`, 'i');
                    if (pattern.test(fullText)) {
                        matchedTableRef = ref;
                        break;
                    }
                }

                // fallback: jeśli nie wykryto aliasu w tekście, traktujemy tekst przed kropką jako nazwę tabeli
                if (!matchedTableRef) {
                    matchedTableRef = {
                        schema: defaultSchema || db.findSchemaByTable(alias) || '',
                        table: alias
                    };
                }

                // pobieramy kolumny batchem (rozgrzewając cache dla CAŁEGO zapytania)
                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(
                    allTableRefsForPrefetch.length > 0 ? allTableRefsForPrefetch : [matchedTableRef]
                );
                const cacheKey = this.tableColumnsService.getTableRefKey(matchedTableRef);
                const columns = columnsMap[cacheKey] ?? [];

                // zwracamy podpowiedzi kolumn dla tego aliasu
                return columns.map((column: TableColumn) => this.createColumnItem(matchedTableRef!.table, column));
            }

            // PRZYPADEK 1B: Kursor stoi w wolnym miejscu (np. `WHERE 0 and |`)
            const result: vscode.CompletionItem[] = [];

            // wyciągamy filtr
            const words = linePrefix.trim().split(/[\s,=+]+/);
            const lastWord = words[words.length - 1].toLowerCase();
            const filter = ['set', 'where', 'on', 'and', 'or'].includes(lastWord) ? '' : lastWord;

            // pobieramy kolumny (rozgrzewając cache dla całego zapytania), ale wyświetlamy tylko tabele w zasięgu widoczności kursora
            if (allTableRefs.length > 0) {
                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(allTableRefsForPrefetch);
                for (const ref of allTableRefs) {
                    const cacheKey = this.tableColumnsService.getTableRefKey(ref);
                    const columns = columnsMap[cacheKey] ?? [];
                    for (const column of columns) {
                        result.push(this.createColumnItem(ref.table, column));
                    }
                }
            }

            if (filter) {
                return result.filter(item => item.label.toString().toLowerCase().includes(filter));
            }

            return result;
        }

        // 2. Obsługa samej klauzuli UPDATE (Podpowiedzi TABEL i SCHEMATÓW przed klauzulą SET)
        
        // przypadek A: kursor po kropce struktury bazy (`UPDATE zak_system.|`) – tu kropka zawsze oznacza `schema.tabela`, nigdy alias kolumny
        if (linePrefix.includes('.')) {
            const schemaTableMatch = linePrefix.match(REGEX_UPDATE_SCHEMA_TABLE);
            if (schemaTableMatch) {
                const schema = schemaTableMatch[1];
                const filter = schemaTableMatch[2].toLowerCase();

                return db
                    .getTables(schema)
                    .filter(table => table.toLowerCase().includes(filter))
                    .map((table, index) => this.createTableItem(table, index));
            }
        }

        // przypadek B: Kursor bezpośrednio po modyfikatorze lub słowie UPDATE, np. `UPDATE |`
        const objectMatch = linePrefix.trimEnd().match(REGEX_UPDATE_OBJECT);
        if (objectMatch) {
            const words = linePrefix.trim().split(/\s+/);
            const lastWord = words[words.length - 1].toLowerCase();
            
            const keywords = ['update', 'ignore', 'low_priority', 'inner', 'join', 'left', 'on'];
            const filter = keywords.includes(lastWord) ? '' : lastWord;

            const result: vscode.CompletionItem[] = [];

            if (defaultSchema) {
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

        return [];
    }
}
