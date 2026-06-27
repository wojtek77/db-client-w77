import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { CompletionInterface } from './CompletionInterface.js';
import { formatColumnType } from './columnFormatter.js';

const REGEX_INSERT_SCHEMA_TABLE = /\b(?:insert(?:\s+into)?|into)\s+(\w+)\.(\w*)$/i;
const REGEX_INSERT_OBJECT = /\b(?:insert(?:\s+into)?|into)\s+(\w*)$/i;
const REGEX_ALL_COLUMNS_TRIGGER = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s+$/i;
const REGEX_INSIDE_PARENTHESIS = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s*\(([^)]*)$/i;
const REGEX_EXTRACT_TABLE_AND_COLUMNS = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s*\(([^)]+)\)\s*$/i;

// Szukamy frazy VALUES i otwartego nawiasu, ignorując ewentualne białe znaki po drodze
const REGEX_VALUES_CONTEXT = /\bvalues\s*\(([^)]*)$/i;

export class CompletionInsert extends CompletionAbstract implements CompletionInterface {

    public async complete(
        linePrefix: string,
        fullText: string,
        db: Connection,
        sqlBeforeCursor: string
    ): Promise<vscode.CompletionItem[]> {

        const defaultSchema = db.getDatabase();

        // =========================================================================
        // Inteligentna podpowiedź kolumny na podstawie pozycji kursora w VALUES
        // =========================================================================
        const singleLineSqlBeforeCursor = sqlBeforeCursor.replace(/[\r\n]+/g, ' ');
        const valuesContextMatch = singleLineSqlBeforeCursor.match(REGEX_VALUES_CONTEXT);

        if (valuesContextMatch) {
            const rawValuesContent = valuesContextMatch[1];
            
            // 1. Wyciągamy dokładnie to słowo/wartość, na której końcu stoi obecnie kursor (np. "NULL", "'2026-01-01'", "0")
            const tokenMatch = rawValuesContent.match(/(?:null|'\[[^\]]*\]'|'[^']*'|"[^"]*"|\d+)\s*$/i);
            const currentTokenText = tokenMatch ? tokenMatch[0].trim() : '';

            // 2. Oczyszczamy tekst przed kursorem z tego tokenu, aby prawidłowo obliczyć indeks (liczbę przecinków)
            let currentValuesContent = rawValuesContent;
            if (currentTokenText) {
                currentValuesContent = currentValuesContent.substring(0, currentValuesContent.length - currentTokenText.length);
            }

            // Liczymy ile przecinków znajduje się przed naszą wartością
            const valueIndex = (currentValuesContent.match(/,/g) || []).length;

            const valuesKeywordIndex = sqlBeforeCursor.toLowerCase().lastIndexOf('values');
            if (valuesKeywordIndex !== -1) {
                const sqlBeforeValues = sqlBeforeCursor.substring(0, valuesKeywordIndex);
                const normalizedSql = sqlBeforeValues.replace(/[\r\n]+/g, ' ').trimEnd();
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

                        const targetFields = columnsInParenthesis
                            .split(',')
                            .map(field => field.trim().toLowerCase());

                        if (valueIndex < targetFields.length) {
                            const currentFieldName = targetFields[valueIndex];
                            const dbCol = dbColumns.find(c => c.name.toLowerCase() === currentFieldName);

                            if (dbCol) {
                                const label = `👉 Column: ${dbCol.name}`;
                                const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Text);
                                
                                const formattedType = formatColumnType(dbCol);
                                
                                item.detail = `${tableName}.${dbCol.name} (${valueIndex + 1})`;
                                item.documentation = new vscode.MarkdownString(
                                    `You are on the value for column:\n\n` +
                                    `• **Name:** \`${dbCol.name}\`\n` +
                                    `• **Data type:** \`${formattedType}\`\n` +
                                    `• **Allows NULL:** \`${dbCol.isNullable}\`\n` +
                                    `• **Default value:** \`${dbCol.defaultValue ?? 'none'}\``
                                );
                                
                                // Obliczamy dokładną pozycję w dokumencie
                                const currentLineNumber = sqlBeforeCursor.split('\n').length - 1;
                                const cursorCharacter = linePrefix.length;
                                
                                if (currentTokenText) {
                                    // Jeśli kursor stoi na końcu słowa (np. NULL), to Range musi obejmować to słowo,
                                    // a filterText MUSI być taki sam jak to słowo, żeby VS Code go nie ukrył.
                                    const startCharacter = Math.max(0, cursorCharacter - currentTokenText.length);
                                    item.range = new vscode.Range(
                                        new vscode.Position(currentLineNumber, startCharacter),
                                        new vscode.Position(currentLineNumber, cursorCharacter)
                                    );
                                    item.insertText = currentTokenText;
                                    item.filterText = currentTokenText; // Wymusza dopasowanie w silniku VS Code
                                } else {
                                    // Jeśli kursor stoi w pustym miejscu (np. zaraz po przecinku)
                                    const activePosition = new vscode.Position(currentLineNumber, cursorCharacter);
                                    item.range = new vscode.Range(activePosition, activePosition);
                                    item.insertText = '';
                                }
                                
                                item.preselect = true;
                                item.sortText = '00000_CURRENT_FIELD_INFO';

                                return [item];
                            }
                        }
                    }
                }
            }
        }

        // Blokowanie podpowiedzi wewnątrz stringów tekstowych dla pozostałych akcji
        if (!valuesContextMatch) {
            const quotesCount = (linePrefix.match(/'/g) || []).length;
            if (quotesCount % 2 !== 0) {
                return [];
            }
        }

        // =========================================================================
        // 1. Podpowiadanie słowa kluczowego VALUES
        // =========================================================================
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

        // =========================================================================
        // 2. Kursor stoi bezpośrednio PO słowie VALUES i spacji -> Snippet wiersza
        // =========================================================================
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

        // =========================================================================
        // Sytuacja 3: Kursor wewnątrz nawiasów kolumn
        // =========================================================================
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

        // =========================================================================
        // Sytuacja 4: Zbiorcza lista kolumn
        // =========================================================================
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
                    completionItem.insertText = new vscode.SnippetString(snippetString);
                    completionItem.detail = `All columns of table ${tableName}`;
                    completionItem.documentation = new vscode.MarkdownString(`Insert column list:\n\`\`\`sql\n${snippetString}\n\`\`\``);
                    
                    completionItem.sortText = '00000_' + snippetString;

                    return [completionItem];
                }
            }
        }

        // =========================================================================
        // Sytuacja 5: Podpowiadanie tabel/schematów
        // =========================================================================
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