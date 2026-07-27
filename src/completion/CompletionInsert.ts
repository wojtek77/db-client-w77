import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { CompletionInterface } from './CompletionInterface.js';
import { tokenize } from '../sql/tokenizer.js';

// modyfikatory INSERT [LOW_PRIORITY|DELAYED|HIGH_PRIORITY] [IGNORE] [INTO] tbl_name - pierwsza trójka wzajemnie się wyklucza, IGNORE jest od nich niezależny
const INSERT_PRIORITY_MODIFIERS = ['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY'];
const INSERT_MODIFIERS = [...INSERT_PRIORITY_MODIFIERS, 'IGNORE'];

// wspólny fragment źródłowy regexów poniżej - dopuszcza opcjonalne modyfikatory (i/lub IGNORE, i/lub INTO) między słowem INSERT a nazwą tabeli
const INSERT_PREFIX_SRC = '(?:insert(?:\\s+(?:low_priority|delayed|high_priority))?(?:\\s+ignore)?(?:\\s+into)?|into)';

// wyrażenia regularne operujące na linePrefix (bieżąca linia przed kursorem)
const REGEX_INSERT_SCHEMA_TABLE = new RegExp(`\\b${INSERT_PREFIX_SRC}\\s+(\\w+)\\.(\\w*)$`, 'i');
const REGEX_INSERT_OBJECT = new RegExp(`\\b${INSERT_PREFIX_SRC}\\s+(\\w*)$`, 'i');

// dopasowuje sytuację, gdzie po nazwie tabeli są wyłącznie białe znaki przed końcem linii/kursorem
const REGEX_ALL_COLUMNS_TRIGGER = new RegExp(`\\b${INSERT_PREFIX_SRC}\\s+(?:(\\w+)\\.)?(\\w+)\\s+$`, 'i');

// wykrywa, czy kursor znajduje się wewnątrz bloku nawiasów definicji kolumn, np. "insert into agency (id, na|"
const REGEX_INSIDE_PARENTHESIS = new RegExp(`\\b${INSERT_PREFIX_SRC}\\s+(?:(\\w+)\\.)?(\\w+)\\s*\\(([^)]*)$`, 'i');

// bezpieczny wzorzec do przeszukania całego zapytania przed kursem w celu znalezienia tabeli i nawiasu kolumn
const REGEX_EXTRACT_TABLE_AND_COLUMNS = new RegExp(`\\b${INSERT_PREFIX_SRC}\\s+(?:(\\w+)\\.)?(\\w+)\\s*\\(([^)]+)\\)\\s*$`, 'i');

// NOWE: Wykrywanie kontekstu ON DUPLICATE KEY UPDATE i wyciąganie z niego końcówki
const REGEX_ON_DUPLICATE_CONTEXT = /\bon\s+duplicate\s+key\s+update\s+([\s\S]*)$/i;
const REGEX_GLOBAL_TABLE_EXTRACT = new RegExp(`\\b${INSERT_PREFIX_SRC}\\s+(?:(\\w+)\\.)?(\\w+)\\b`, 'i');
const REGEX_INSIDE_VALUES_FUNCTION = /\bvalues\s*\(\s*(\w*)$/i;

// NOWE: wykrywanie alternatywnej składni "INSERT INTO tbl SET col1 = val1, col2 = val2" (bez listy kolumn i VALUES)
const REGEX_SET_CONTEXT = /\bset\s+([\s\S]*)$/i;

interface InsertModifierContext {
    // modyfikatory już wpisane wcześniej w tym samym INSERT (np. po "INSERT LOW_PRIORITY " -> {'LOW_PRIORITY'}) - nie proponujemy ich ponownie
    used: Set<string>;
    // fragment aktualnie pisanego słowa (np. "INSERT LOW_PRI|" -> "low_pri") - do przefiltrowania podpowiedzi
    filter: string;
}

// sprawdza, czy kursor jest w "strefie modyfikatorów" INSERT (między INSERT a nazwą tabeli); null gdy pojawiło się już INTO albo nazwa tabeli
function getInsertModifierContext(sqlBeforeCursor: string): InsertModifierContext | null {
    const tokens = tokenize(sqlBeforeCursor);
    const used = new Set<string>();
    let filter = '';

    // pomijamy tokens[0], to samo słowo INSERT
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'comment') { continue; }
        if (t.type !== 'word') { return null; }

        // ostatni token dotykający końca fragmentu to właśnie pisane słowo, a nie ukończony modyfikator
        const isBeingTyped = i === tokens.length - 1 && t.start + t.value.length === sqlBeforeCursor.length;
        if (isBeingTyped) { filter = t.value.toLowerCase(); break; }

        const upper = t.value.toUpperCase();
        if (upper === 'INTO') { return null; }
        if (!INSERT_MODIFIERS.includes(upper)) { return null; }
        used.add(upper);
    }

    return { used, filter };
}

export class CompletionInsert extends CompletionAbstract implements CompletionInterface {

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

        const defaultSchema = db.getDatabase();

        // NOWE: obsługa sekcji ON DUPLICATE KEY UPDATE
        const duplicateMatch = sqlBeforeCursor.match(REGEX_ON_DUPLICATE_CONTEXT);
        if (duplicateMatch) {
            // przeszukujemy cały tekst przed kursem, aby znaleźć tabelę docelową INSERT
            const tableMatch = sqlBeforeCursor.match(REGEX_GLOBAL_TABLE_EXTRACT);
            if (tableMatch) {
                const matchedSchema = tableMatch[1];
                const tableName = tableMatch[2];
                const schema = matchedSchema || defaultSchema || '';

                if (schema && tableName) {
                    const tableRef = { schema, table: tableName };
                    const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([tableRef]);
                    const cacheKey = this.tableColumnsService.getTableRefKey(tableRef);
                    const columns = columnsMap[cacheKey] || [];

                    if (columns.length > 0) {
                        // sprawdzamy czy kursor znajduje się wewnątrz funkcji VALUES(...) np. "VALUES(|"
                        const valuesFuncMatch = linePrefix.match(REGEX_INSIDE_VALUES_FUNCTION);
                        
                        if (valuesFuncMatch) {
                            // sytuacja: ON DUPLICATE KEY UPDATE id = VALUES(|)
                            const filter = valuesFuncMatch[1].toLowerCase();
                            return columns
                                .filter(col => !String(col.extra || '').toLowerCase().includes('generated'))
                                .filter(col => !filter || col.name.toLowerCase().includes(filter))
                                .map(column => this.createColumnItem(tableName, column));
                        } else {
                            // sytuacja: ON DUPLICATE KEY UPDATE |
                            const lastWordMatch = linePrefix.match(/(\w+)$/);
                            const filter = lastWordMatch ? lastWordMatch[1].toLowerCase() : '';

                            return columns
                                .filter(col => !String(col.extra || '').toLowerCase().includes('generated'))
                                .filter(col => !filter || col.name.toLowerCase().includes(filter))
                                .map(column => {
                                    const item = this.createColumnItem(tableName, column);
                                    // sugerujemy od razu pełną konstrukcję jako snippet 'column = VALUES(column)', chyba że użytkownik wpisał już znak równości
                                    if (!linePrefix.trim().endsWith('=')) {
                                        item.insertText = new vscode.SnippetString(`${column.name} = VALUES(\${1:${column.name}})`);
                                        item.detail = `Update column with VALUES()`;
                                    }
                                    return item;
                                });
                        }
                    }
                }
            }
        }

        // NOWE: obsługa alternatywnej składni INSERT INTO tbl SET col1 = val1, col2 = val2 (MySQL/MariaDB dopuszcza SET zamiast (columns) VALUES (...))
        const setMatch = sqlBeforeCursor.match(REGEX_SET_CONTEXT);
        if (setMatch) {
            const tableMatch = sqlBeforeCursor.match(REGEX_GLOBAL_TABLE_EXTRACT);
            if (tableMatch) {
                const matchedSchema = tableMatch[1];
                const tableName = tableMatch[2];
                const schema = matchedSchema || defaultSchema || '';

                if (schema && tableName) {
                    const tableRef = { schema, table: tableName };
                    const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([tableRef]);
                    const cacheKey = this.tableColumnsService.getTableRefKey(tableRef);
                    const columns = columnsMap[cacheKey] || [];

                    if (columns.length > 0) {
                        const lastWordMatch = linePrefix.match(/(\w+)$/);
                        const filter = lastWordMatch ? lastWordMatch[1].toLowerCase() : '';

                        return columns
                            .filter(col => !String(col.extra || '').toLowerCase().includes('generated'))
                            .filter(col => !filter || col.name.toLowerCase().includes(filter))
                            .map(column => {
                                const item = this.createColumnItem(tableName, column);
                                // sugerujemy od razu pełną konstrukcję jako snippet 'column = wartość_domyślna', chyba że użytkownik wpisał już znak równości
                                if (!linePrefix.trim().endsWith('=')) {
                                    item.insertText = new vscode.SnippetString(`${column.name} = ${this.buildDefaultValueToken(column, 1)}`);
                                    item.detail = `Set column value`;
                                }
                                return item;
                            });
                    }
                }
            }
        }

        // 1. podpowiadanie słowa kluczowego VALUES (również w nowej linii, np. 'v|')
        const lastWordMatch = linePrefix.match(/(\w+)$/);
        const lastWord = lastWordMatch ? lastWordMatch[1].toLowerCase() : '';
        
        if (lastWord === '' || 'values'.startsWith(lastWord)) {
            const sqlToAnalyze = lastWord 
                ? sqlBeforeCursor.substring(0, sqlBeforeCursor.length - lastWord.length)
                : sqlBeforeCursor;

            const normalizedSql = sqlToAnalyze.replace(/[\r\n]+/g, ' ').trimEnd();
            
            if (REGEX_EXTRACT_TABLE_AND_COLUMNS.test(normalizedSql)) {
                const item = new vscode.CompletionItem('VALUES', vscode.CompletionItemKind.Keyword);
                item.detail = 'SQL Keyword';
                item.sortText = '00000_VALUES'; 
                return [item];
            }
        }

        // 2. kursor stoi bezpośrednio po słowie VALUES i spacji -> podpowiadanie wartości row
        if (/\bvalues\s+$/i.test(linePrefix)) {
            const sqlToAnalyze = sqlBeforeCursor.substring(0, sqlBeforeCursor.length - (linePrefix.length - linePrefix.toLowerCase().lastIndexOf('values')));
            const normalizedSql = sqlToAnalyze.replace(/[\r\n]+/g, ' ').trimEnd();
            const structMatch = normalizedSql.match(REGEX_EXTRACT_TABLE_AND_COLUMNS);

            if (structMatch) {
                const matchedSchema = structMatch[1];
                const tableName = structMatch[2];
                const columnsInParenthesis = structMatch[3];

                const schema = matchedSchema || defaultSchema || '';

                if (schema && tableName && columnsInParenthesis.trim()) {
                    const tableRef = { schema, table: tableName };
                    
                    const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([tableRef]);
                    const cacheKey = this.tableColumnsService.getTableRefKey(tableRef);
                    const dbColumns = columnsMap[cacheKey] || [];

                    if (dbColumns.length > 0) {
                        const targetFields = columnsInParenthesis
                            .split(',')
                            .map(field => field.trim().toLowerCase());

                        const valueTokens: string[] = [];
                        let tabIndex = 1;

                        for (const fieldName of targetFields) {
                            const dbCol = dbColumns.find(c => c.name.toLowerCase() === fieldName);

                            if (!dbCol) {
                                valueTokens.push(`'\${${tabIndex++}}'`);
                                continue;
                            }

                            valueTokens.push(this.buildDefaultValueToken(dbCol, tabIndex++));
                        }

                        if (valueTokens.length > 0) {
                            const snippetString = `(${valueTokens.join(', ')})`;
                            const completionItem = new vscode.CompletionItem(snippetString, vscode.CompletionItemKind.Snippet);
                            completionItem.insertText = new vscode.SnippetString(snippetString);
                            completionItem.detail = `Default values row (Snippet)`;
                            
                            const previewString = snippetString.replace(/\$\{\d+:?([^}]*)\}/g, '$1');
                            completionItem.documentation = new vscode.MarkdownString(`Insert matching default values row with Tab Stops:\n\`\`\`sql\n${previewString}\n\`\`\``);
                            completionItem.sortText = '00000_' + previewString;

                            return [completionItem];
                        }
                    }
                }
            }
        }

        // sytuacja 3: kursor wewnątrz nawiasów -> podpowiadanie pojedynczych kolumn
        const insideMatch = linePrefix.match(REGEX_INSIDE_PARENTHESIS);
        if (insideMatch) {
            const matchedSchema = insideMatch[1];
            const tableName = insideMatch[2];
            const currentContent = insideMatch[3];

            const schema = matchedSchema || defaultSchema || '';

            if (schema && tableName) {
                const tableRef = { schema, table: tableName };
                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([tableRef]);
                const cacheKey = this.tableColumnsService.getTableRefKey(tableRef);
                const columns = columnsMap[cacheKey] || [];

                if (columns.length > 0) {
                    const parts = currentContent.split(',');
                    const filter = parts[parts.length - 1].trim().toLowerCase();

                    return columns
                        .filter(col => !String(col.extra || '').toLowerCase().includes('generated'))
                        .filter(col => !filter || col.name.toLowerCase().includes(filter))
                        .map(column => this.createColumnItem(tableName, column));
                }
            }
            return [];
        }

        // sytuacja 4: same białe znaki po tabeli -> podpowiedź zbiorcza wszystkich pól
        const allColumnsMatch = linePrefix.match(REGEX_ALL_COLUMNS_TRIGGER);
        if (allColumnsMatch) {
            const matchedSchema = allColumnsMatch[1];
            const tableName = allColumnsMatch[2];

            const schema = matchedSchema || defaultSchema || '';

            if (schema && tableName) {
                const tableRef = { schema, table: tableName };
                const columnsMap = await this.tableColumnsService.getCachedColumnsBatch([tableRef]);
                const cacheKey = this.tableColumnsService.getTableRefKey(tableRef);
                const columns = columnsMap[cacheKey] || [];

                if (columns.length > 0) {
                    const columnNames = columns
                        .filter(col => !String(col.extra || '').toLowerCase().includes('generated'))
                        .map(col => col.name)
                        .join(', ');
                        
                    const snippetString = `(${columnNames})`;
                    const completionItem = new vscode.CompletionItem(snippetString, vscode.CompletionItemKind.Snippet);
                    completionItem.detail = `All columns of table ${tableName}`;
                    completionItem.documentation = new vscode.MarkdownString(`Insert column list:\n\`\`\`sql\n${snippetString}\n\`\`\``);
                    completionItem.sortText = '00000_' + snippetString;

                    // NOWE: alternatywna składnia SET obok listy kolumn - użytkownik może wybrać jedną z dwóch form INSERT
                    const setKeywordItem = new vscode.CompletionItem('SET', vscode.CompletionItemKind.Keyword);
                    setKeywordItem.detail = 'SQL Keyword (alternative INSERT ... SET syntax)';
                    setKeywordItem.sortText = '00001_SET';

                    return [completionItem, setKeywordItem];
                }
            }
        }

        // sytuacja 5: podpowiadanie nazw tabel i schematów (zaraz po INSERT INTO)
        const schemaTableMatch = linePrefix.match(REGEX_INSERT_SCHEMA_TABLE);
        if (schemaTableMatch) {
            const schema = schemaTableMatch[1];
            const filter = schemaTableMatch[2].toLowerCase();

            return db
                .getTables(schema)
                .filter(table => table.toLowerCase().includes(filter))
                .map((table, index) => this.createTableItem(table, index));
        }

        const objectMatch = linePrefix.match(REGEX_INSERT_OBJECT);
        if (objectMatch) {
            const filter = objectMatch[1].toLowerCase();
            const result: vscode.CompletionItem[] = [];

            // modyfikatory INSERT (LOW_PRIORITY, DELAYED, HIGH_PRIORITY, IGNORE) - tylko dopóki nie pojawiła się jeszcze nazwa tabeli
            const modifierContext = getInsertModifierContext(sqlBeforeCursor);
            if (modifierContext) {
                const hasPriorityModifier = INSERT_PRIORITY_MODIFIERS.some(m => modifierContext.used.has(m));
                let order = 0;
                for (const modifier of INSERT_MODIFIERS) {
                    if (modifierContext.used.has(modifier)) { continue; }
                    if (hasPriorityModifier && INSERT_PRIORITY_MODIFIERS.includes(modifier)) { continue; }
                    if (modifierContext.filter && !modifier.toLowerCase().startsWith(modifierContext.filter)) { continue; }
                    result.push(this.createKeywordItem(modifier, order++));
                }
            }

            if (defaultSchema && defaultSchema.trim() !== '') {
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
