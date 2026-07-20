import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { CompletionInterface } from './CompletionInterface.js';

// wyrażenia regularne operujące na linePrefix (bieżąca linia przed kursorem)
const REGEX_INSERT_SCHEMA_TABLE = /\b(?:insert(?:\s+into)?|into)\s+(\w+)\.(\w*)$/i;
const REGEX_INSERT_OBJECT = /\b(?:insert(?:\s+into)?|into)\s+(\w*)$/i;

// dopasowuje sytuację, gdzie po nazwie tabeli są wyłącznie białe znaki przed końcem linii/kursorem
const REGEX_ALL_COLUMNS_TRIGGER = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s+$/i;

// wykrywa, czy kursor znajduje się wewnątrz bloku nawiasów definicji kolumn, np. "insert into agency (id, na|"
const REGEX_INSIDE_PARENTHESIS = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s*\(([^)]*)$/i;

// bezpieczny wzorzec do przeszukania całego zapytania przed kursem w celu znalezienia tabeli i nawiasu kolumn
const REGEX_EXTRACT_TABLE_AND_COLUMNS = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s*\(([^)]+)\)\s*$/i;

// NOWE: Wykrywanie kontekstu ON DUPLICATE KEY UPDATE i wyciąganie z niego końcówki
const REGEX_ON_DUPLICATE_CONTEXT = /\bon\s+duplicate\s+key\s+update\s+([\s\S]*)$/i;
const REGEX_GLOBAL_TABLE_EXTRACT = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\b/i;
const REGEX_INSIDE_VALUES_FUNCTION = /\bvalues\s*\(\s*(\w*)$/i;

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

                            const colExtra = String(dbCol.extra || '').toLowerCase();

                            if (colExtra.includes('generated')) {
                                valueTokens.push(`\${${tabIndex++}:DEFAULT}`);
                                continue;
                            }

                            if (colExtra.includes('auto_increment')) {
                                valueTokens.push(`\${${tabIndex++}:NULL}`);
                                continue;
                            }

                            const dataType = (dbCol.type || '').toLowerCase();

                            if (dbCol.defaultValue !== null && dbCol.defaultValue !== undefined && String(dbCol.defaultValue).toLowerCase() !== 'null') {
                                const rawDefault = String(dbCol.defaultValue);
                                const rawDefaultLower = rawDefault.toLowerCase();

                                const isSqlFunction = [
                                    'current_timestamp', 'now()', 'uuid()', 'current_date', 'current_time'
                                ].some(f => rawDefaultLower.includes(f));

                                if (isSqlFunction) {
                                    valueTokens.push(`\${${tabIndex++}:${rawDefault}}`);
                                    continue;
                                }

                                const cleanDefault = rawDefault.replace(/^['"]|['"]$/g, '');

                                const numericTypes = ['int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint', 'float', 'double', 'decimal', 'numeric', 'bit'];
                                if (numericTypes.some(t => dataType.includes(t))) {
                                    valueTokens.push(`\${${tabIndex++}:${cleanDefault}}`);
                                } else {
                                    valueTokens.push(`'\${${tabIndex++}:${cleanDefault}}'`);
                                }
                                continue;
                            }

                            const colNullableRaw = String(dbCol.isNullable).toLowerCase();
                            const isNullable = colNullableRaw === 'yes' || colNullableRaw === '1' || colNullableRaw === 'true';
                            
                            if (isNullable) {
                                valueTokens.push(`\${${tabIndex++}:NULL}`);
                                continue;
                            }

                            if (dataType.startsWith('enum')) {
                                const fullEnumDefinition = ((dbCol as any).columnType || dbCol.type || '');
                                const enumMatch = fullEnumDefinition.match(/['"]([^'"]+)['"]/);
                                
                                if (enumMatch && enumMatch[1]) {
                                    valueTokens.push(`'\${${tabIndex++}:${enumMatch[1]}}'`);
                                } else {
                                    valueTokens.push(`'\${${tabIndex++}}'`);
                                }
                                continue;
                            }

                            if (dataType.startsWith('date') && !dataType.startsWith('datetime')) {
                                valueTokens.push(`'\${${tabIndex++}:0000-00-00}'`);
                                continue;
                            }
                            if (dataType.startsWith('datetime') || dataType.startsWith('timestamp')) {
                                valueTokens.push(`'\${${tabIndex++}:0000-00-00 00:00:00}'`);
                                continue;
                            }

                            const numericTypes = ['int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint', 'float', 'double', 'decimal', 'numeric', 'bit'];
                            if (numericTypes.some(t => dataType.includes(t))) {
                                valueTokens.push(`\${${tabIndex++}:0}`);
                                continue;
                            }

                            valueTokens.push(`'\${${tabIndex++}:[${dbCol.name}]}'`);
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

                    return [completionItem];
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
