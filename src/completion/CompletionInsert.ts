import * as vscode from 'vscode';
import { Connection } from "../db/Connection.js";
import { CompletionAbstract } from "./CompletionAbstract.js";
import { CompletionInterface } from './CompletionInterface.js';

// Wyrażenia regularne operujące na linePrefix (bieżąca linia przed kursorem)
const REGEX_INSERT_SCHEMA_TABLE = /\b(?:insert(?:\s+into)?|into)\s+(\w+)\.(\w*)$/i;
const REGEX_INSERT_OBJECT = /\b(?:insert(?:\s+into)?|into)\s+(\w*)$/i;

// Dopasowuje sytuację, gdzie po nazwie tabeli są wyłącznie białe znaki przed końcem linii/kursorem
const REGEX_ALL_COLUMNS_TRIGGER = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s+$/i;

// Wykrywa, czy kursor znajduje się wewnątrz bloku nawiasów definicji kolumn, np. "insert into agency (id, na|"
const REGEX_INSIDE_PARENTHESIS = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s*\(([^)]*)$/i;

// Bezpieczny wzorzec do przeszukania całego zapytania przed kursorem w celu znalezienia tabeli i nawiasu kolumn
const REGEX_EXTRACT_TABLE_AND_COLUMNS = /\b(?:insert(?:\s+into)?|into)\s+(?:(\w+)\.)?(\w+)\s*\(([^)]+)\)\s*$/i;

export class CompletionInsert extends CompletionAbstract implements CompletionInterface {

    public async complete(
        linePrefix: string,
        fullText: string,
        db: Connection,
        sqlBeforeCursor: string
    ): Promise<vscode.CompletionItem[]> {

        // Blokowanie podpowiedzi wewnątrz stringów tekstowych
        const quotesCount = (linePrefix.match(/'/g) || []).length;
        if (quotesCount % 2 !== 0) {
            return [];
        }

        const defaultSchema = db.getDatabase();

        // =========================================================================
        // 1. Podpowiadanie słowa kluczowego VALUES (również w nowej linii, np. "v|")
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
        // 2. Kursor stoi bezpośrednio PO słowie VALUES i spacji -> Podpowiadanie wartości row
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

                        for (const fieldName of targetFields) {
                            const dbCol = dbColumns.find(c => c.name.toLowerCase() === fieldName);

                            if (!dbCol) {
                                valueTokens.push("''");
                                continue;
                            }

                            const colExtra = String(dbCol.extra || '').toLowerCase();

                            // OCHRONA: Jeśli użytkownik ręcznie wpisał kolumnę wirtualną, podpowiadamy DEFAULT
                            if (colExtra.includes('generated')) {
                                valueTokens.push("DEFAULT");
                                continue;
                            }

                            // POPRAWKA: Jeśli kolumna ma właściwość auto_increment, podpowiadamy dla niej NULL
                            if (colExtra.includes('auto_increment')) {
                                valueTokens.push("NULL");
                                continue;
                            }

                            const dataType = (dbCol.type || '').toLowerCase();

                            // -----------------------------------------------------------------
                            // Strategia sprawdzania wartości domyślnej (defaultValue) z bazy
                            // -----------------------------------------------------------------
                            if (dbCol.defaultValue !== null && dbCol.defaultValue !== undefined && String(dbCol.defaultValue).toLowerCase() !== 'null') {
                                const rawDefault = String(dbCol.defaultValue);
                                const rawDefaultLower = rawDefault.toLowerCase();

                                // Sprawdzamy, czy wartość domyślna to funkcja wbudowana (np. current_timestamp(), now(), uuid())
                                const isSqlFunction = [
                                    'current_timestamp', 'now()', 'uuid()', 'current_date', 'current_time'
                                ].some(f => rawDefaultLower.includes(f));

                                if (isSqlFunction) {
                                    valueTokens.push(rawDefault); // wstawiamy jako bezpośrednie słowo/funkcję bez apostrofów
                                    continue;
                                }

                                // Oczyszczamy wartość z ewentualnych skrajnych apostrofów/cudzysłowów dodanych przez silnik bazy
                                const cleanDefault = rawDefault.replace(/^['"]|['"]$/g, '');

                                // Jeśli to typ liczbowy, wstawiamy bezpośrednio jako cyfrę
                                const numericTypes = ['int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint', 'float', 'double', 'decimal', 'numeric', 'bit'];
                                if (numericTypes.some(t => dataType.includes(t))) {
                                    valueTokens.push(cleanDefault);
                                } else {
                                    // Dla pozostałych typów zabezpieczamy znacznikiem "密"
                                    valueTokens.push(`密${cleanDefault}密`);
                                }
                                continue;
                            }

                            // A. Sprawdzanie, czy pole akceptuje NULL (gdy brak specyficznej wartości domyślnej)
                            const colNullableRaw = String(dbCol.isNullable).toLowerCase();
                            const isNullable = colNullableRaw === 'yes' || colNullableRaw === '1' || colNullableRaw === 'true';
                            
                            if (isNullable) {
                                valueTokens.push("NULL");
                                continue;
                            }

                            // B. Jeśli NOT NULL i brak wartości domyślnej -> sprawdzamy typ danych pod kątem sztywnych domyślnych
                            // Obsługa typu ENUM -> szukamy definicji w dedykowanym, nowym polu columnType
                            if (dataType.startsWith('enum')) {
                                const fullEnumDefinition = ((dbCol as any).columnType || dbCol.type || '');
                                const enumMatch = fullEnumDefinition.match(/['"]([^'"]+)['"]/);
                                
                                if (enumMatch && enumMatch[1]) {
                                    valueTokens.push(`密${enumMatch[1]}密`);
                                } else {
                                    valueTokens.push("''");
                                }
                                continue;
                            }

                            // Obsługa typów daty i czasu (DATE, DATETIME, TIMESTAMP)
                            if (dataType.startsWith('date') && !dataType.startsWith('datetime')) {
                                valueTokens.push("'0000-00-00'");
                                continue;
                            }
                            if (dataType.startsWith('datetime') || dataType.startsWith('timestamp')) {
                                valueTokens.push("'0000-00-00 00:00:00'");
                                continue;
                            }

                            // Obsługa typów liczbowych
                            const numericTypes = ['int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint', 'float', 'double', 'decimal', 'numeric', 'bit'];
                            if (numericTypes.some(t => dataType.includes(t))) {
                                valueTokens.push("0");
                                continue;
                            }

                            // -----------------------------------------------------------------
                            // POPRAWKA: Dynamiczne placeholdery tekstowe na bazie nazw kolumn
                            // zamiast pustego ciągu znaków '' podstawiamy `密[nazwa_kolumny]密`
                            // -----------------------------------------------------------------
                            valueTokens.push(`密[${dbCol.name}]密`);
                        }

                        if (valueTokens.length > 0) {
                            let snippetString = `(${valueTokens.join(', ')})`;
                            
                            // Bezpieczna zamiana znaczników tymczasowych na apostrofy SQL
                            snippetString = snippetString.replace(/密/g, "'");

                            const completionItem = new vscode.CompletionItem(snippetString, vscode.CompletionItemKind.Snippet);
                            
                            completionItem.detail = `Default values row`;
                            completionItem.documentation = new vscode.MarkdownString(`Insert matching default values row:\n\`\`\`sql\n${snippetString}\n\`\`\``);
                            completionItem.sortText = '00000_' + snippetString;

                            return [completionItem];
                        }
                    }
                }
            }
        }

        // =========================================================================
        // Sytuacja 3: Kursor wewnątrz nawiasów -> podpowiadanie POJEDYNCZYCH kolumn
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
                        // POPRAWKA: Filtrujemy i ukrywamy kolumny wirtualne (VIRTUAL / STORED GENERATED)
                        .filter(col => !String(col.extra || '').toLowerCase().includes('generated'))
                        .filter(col => !filter || col.name.toLowerCase().includes(filter))
                        .map(column => this.createColumnItem(tableName, column));
                }
            }
            return [];
        }

        // =========================================================================
        // Sytuacja 4: Same białe znaki po tabeli -> podpowiedź ZBIORCZA wszystkich pól
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
                    // POPRAWKA: Pobieramy nazwy, pomijając kolumny wirtualne (GENERATED)
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

        // =========================================================================
        // Sytuacja 5: Podpowiadanie nazw tabel i schematów (zaraz po INSERT INTO)
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