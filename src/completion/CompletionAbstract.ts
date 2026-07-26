import * as vscode from 'vscode';
import { Connection } from '../db/Connection.js';
import { findQueryTables, computeParenStack } from '../sql/findQueryTables.js';
import { findCteDefinitions } from '../sql/findCteDefinitions.js';
import { findDerivedTables } from '../sql/findDerivedTables.js';
import { extractSelectPartAtCursorLevel as extractSelectPartAtCursorLevelPure, extractHavingCandidates as extractHavingCandidatesPure } from '../sql/selectListCandidates.js';
import { TableColumn, TableColumnsCache } from '../cache/TableColumnsCache.js';
import { TableIndexesCache, TableIndexType } from '../cache/TableIndexesCache.js';
import { formatColumnType } from './columnFormatter.js';
import { SqlFunction } from './sqlFunctions.js';

export abstract class CompletionAbstract {
    
    protected tableColumnsService;
    // opcjonalny - potrzebny tylko tam, gdzie faktycznie podpowiadamy index hinty (na razie CompletionSelect)
    protected tableIndexesService?: TableIndexesCache;
    
    public constructor(tableColumnsService: TableColumnsCache, tableIndexesService?: TableIndexesCache) {
        this.tableColumnsService = tableColumnsService;
        this.tableIndexesService = tableIndexesService;
    }
    
    /**
     * Wspólna metoda wyciągająca tabele z zapytania, pobierająca ich kolumny z cache
     * oraz uzupełniająca przekazaną listę wynikową (opcjonalnie filtrując po aliasach).
     *
     * `sqlBeforeCursor` służy do ograniczenia tabel POKAZYWANYCH JAKO PODPOWIEDZI do
     * zasięgu widoczności kursora — tabele z "obcych" podzapytań (np. z innej gałęzi
     * WHERE ... IN (...) niż ta, w której aktualnie edytujemy) nie powinny podpowiadać
     * swoich kolumn w głównym zapytaniu. Zob. findQueryTables.ts.
     *
     * Sam batch pobierający kolumny z cache/bazy celowo NIE jest ograniczany zasięgiem —
     * pobieramy jednym zapytaniem kolumny wszystkich tabel z CAŁEGO tekstu zapytania
     * (rozgrzewając cache), a dopiero z tego wyniku wybieramy tylko te tabele, które są
     * w zasięgu kursora. Dzięki temu, gdy użytkownik przesunie kursor do innego zakresu
     * (np. do wnętrza podzapytania), kolumny tamtej tabeli są już w cache i nie trzeba
     * wysyłać kolejnego zapytania do bazy — tak jak to działało przed wprowadzeniem
     * ograniczenia zasięgiem.
     */
    protected async addColumnsFromQueryTables(
        resultList: vscode.CompletionItem[],
        fullText: string,
        defaultSchema: string | undefined,
        db: Connection,
        sqlBeforeCursor: string,
        allowedAliases?: Set<string>
    ): Promise<void> {
        // CTE nie istnieją w katalogu bazy - wyłączamy je z zapytania do prawdziwych tabel, ich kolumny dodajemy osobno z definicji
        const cteByName = new Map(findCteDefinitions(fullText).map(cte => [cte.name.toLowerCase(), cte]));

        // zasięg widoczności — tylko te tabele trafią do listy podpowiedzi
        const scopedTableRefs = findQueryTables(fullText, defaultSchema ?? '', db, sqlBeforeCursor.length);

        // prefetch/cache-warming – jeden batch obejmujący wszystkie tabele w tekście, niezależnie od zasięgu (patrz komentarz metody)
        const allTableRefsForPrefetch = findQueryTables(fullText, defaultSchema ?? '', db)
            .filter(tableRef => !cteByName.has(tableRef.table.toLowerCase()));
        const columnsMap = await this.tableColumnsService.getCachedColumnsBatch(allTableRefsForPrefetch);

        for (const tableRef of scopedTableRefs) {
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

            const cte = cteByName.get(tableRef.table.toLowerCase());
            if (cte) {
                for (const columnName of cte.columns) {
                    resultList.push(this.createInferredColumnItem(tableRef.table, columnName, 'CTE'));
                }
                continue;
            }

            const columns = columnsMap[this.tableColumnsService.getTableRefKey(tableRef)] ?? [];
            for (const column of columns) {
                resultList.push(this.createColumnItem(tableRef.table, column));
            }
        }

        // podzapytania w FROM z aliasem (derived tables) - findQueryTables ich nie widzi (nie są zwykłą "tabela", tylko "(SELECT ...)"), więc dokładamy je osobno
        for (const derivedTable of findDerivedTables(fullText)) {
            if (allowedAliases && !allowedAliases.has(derivedTable.alias.toLowerCase())) {
                continue;
            }
            for (const columnName of derivedTable.columns) {
                resultList.push(this.createInferredColumnItem(derivedTable.alias, columnName, 'derived table'));
            }
        }
    }

    protected createTableItem(tableName: string, order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(tableName, vscode.CompletionItemKind.Struct);
        item.insertText = tableName;
        item.detail     = 'Table';
        item.sortText = `0_${order.toString().padStart(5, '0')}`;
        return item;
    }

    protected createSchemaItem(schema: string, order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
        item.insertText = schema;
        item.detail     = 'Schema';
        item.sortText = `1_${order.toString().padStart(5, '0')}`;
        return item;
    }

    protected createColumnItem(tableName: string, column: TableColumn): vscode.CompletionItem {
        const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
        item.sortText   = `0_${tableName}0_${column.name}`;
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

    // kolumna wywnioskowana z listy SELECT (CTE albo derived table), a nie z katalogu bazy - typ więc nieznany
    protected createInferredColumnItem(sourceName: string, columnName: string, sourceKind: 'CTE' | 'derived table'): vscode.CompletionItem {
        const item = new vscode.CompletionItem(columnName, vscode.CompletionItemKind.Field);
        item.sortText   = `0_${sourceName}0_${columnName}`;
        item.insertText = columnName;
        item.detail = `${sourceName} 📊 ${sourceKind}`;
        item.documentation = `${sourceName}.${columnName}\n\nKolumna ${sourceKind} - typ nieznany (wywnioskowana z listy SELECT, a nie z katalogu bazy)`;
        return item;
    }

    // element podpowiedzi dla słowa kluczowego SQL (np. modyfikatory SELECT: DISTINCT, ALL...) - sortText '2_' ląduje po kolumnach ('0_'), przed funkcjami ('9_')
    protected createKeywordItem(keyword: string, order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
        item.insertText = keyword;
        item.detail     = 'SQL Keyword';
        item.sortText   = `2_${order.toString().padStart(5, '0')}`;
        return item;
    }

    // słowo kluczowe index hintu (USE INDEX / FORCE INDEX / IGNORE INDEX) - wstawiane jako snippet z nawiasem,
    // żeby od razu po wybraniu otworzyć listę nazw indeksów tej tabeli
    protected createIndexHintKeywordItem(keyword: string, order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
        item.insertText = new vscode.SnippetString(`${keyword} ($1)$0`);
        item.detail     = 'Index hint';
        item.sortText   = `2_${order.toString().padStart(5, '0')}`;
        return item;
    }

    // nazwa realnego indeksu tabeli (do wstawienia wewnątrz USE/FORCE/IGNORE INDEX (...))
    protected createIndexNameItem(tableName: string, indexName: string, type: TableIndexType, columns: string[], order: number): vscode.CompletionItem {
        const item = new vscode.CompletionItem(indexName, vscode.CompletionItemKind.Reference);
        item.insertText = indexName;
        // etykieta typu: klucz główny, indeks jednoznaczny albo zwykły indeks
        const typeLabel =
            type === 'primary' ? '🔑 PRIMARY KEY' :
            type === 'unique' ? 'UNIQUE INDEX' :
            'INDEX';
        item.detail     = `${tableName} · ${typeLabel} (${columns.join(', ')})`;
        item.sortText   = `0_${order.toString().padStart(5, '0')}`;
        return item;
    }

    protected createFunctionItem(fn: SqlFunction): vscode.CompletionItem {
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
    protected isCursorInsideFunctionCall(sqlBeforeCursor: string, clauseIndex: number): boolean {
        if (clauseIndex === -1) { return false; }
        const fromClause = sqlBeforeCursor.slice(clauseIndex);
        return computeParenStack(fromClause, fromClause.length).length > 0;
    }

    protected extractSelectPartAtCursorLevel(sqlBeforeCursor: string): string {
        return extractSelectPartAtCursorLevelPure(sqlBeforeCursor);
    }

    protected extractHavingCandidates(selectPart: string): string[] {
        return extractHavingCandidatesPure(selectPart);
    }

    // buduje token snippetu z wartością domyślną dla kolumny wg jej typu/atrybutów - współdzielone przez CompletionInsert i CompletionReplace (VALUES(...) oraz SET col = val)
    protected buildDefaultValueToken(dbCol: TableColumn, tabIndex: number): string {
        const colExtra = String(dbCol.extra || '').toLowerCase();

        if (colExtra.includes('generated')) {
            return `\${${tabIndex}:DEFAULT}`;
        }
        if (colExtra.includes('auto_increment')) {
            return `\${${tabIndex}:NULL}`;
        }

        const dataType = (dbCol.type || '').toLowerCase();

        if (dbCol.defaultValue !== null && dbCol.defaultValue !== undefined && String(dbCol.defaultValue).toLowerCase() !== 'null') {
            const rawDefault = String(dbCol.defaultValue);
            const rawDefaultLower = rawDefault.toLowerCase();

            const isSqlFunction = [
                'current_timestamp', 'now()', 'uuid()', 'current_date', 'current_time'
            ].some(f => rawDefaultLower.includes(f));

            if (isSqlFunction) {
                return `\${${tabIndex}:${rawDefault}}`;
            }

            const cleanDefault = rawDefault.replace(/^['"]|['"]$/g, '');

            const numericTypesForDefault = ['int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint', 'float', 'double', 'decimal', 'numeric', 'bit'];
            if (numericTypesForDefault.some(t => dataType.includes(t))) {
                return `\${${tabIndex}:${cleanDefault}}`;
            }
            return `'\${${tabIndex}:${cleanDefault}}'`;
        }

        const colNullableRaw = String(dbCol.isNullable).toLowerCase();
        const isNullable = colNullableRaw === 'yes' || colNullableRaw === '1' || colNullableRaw === 'true';

        if (isNullable) {
            return `\${${tabIndex}:NULL}`;
        }

        if (dataType.startsWith('enum')) {
            const fullEnumDefinition = ((dbCol as any).columnType || dbCol.type || '');
            const enumMatch = fullEnumDefinition.match(/['"]([^'"]+)['"]/);

            if (enumMatch && enumMatch[1]) {
                return `'\${${tabIndex}:${enumMatch[1]}}'`;
            }
            return `'\${${tabIndex}}'`;
        }

        if (dataType.startsWith('date') && !dataType.startsWith('datetime')) {
            return `'\${${tabIndex}:0000-00-00}'`;
        }
        if (dataType.startsWith('datetime') || dataType.startsWith('timestamp')) {
            return `'\${${tabIndex}:0000-00-00 00:00:00}'`;
        }

        const numericTypes = ['int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint', 'float', 'double', 'decimal', 'numeric', 'bit'];
        if (numericTypes.some(t => dataType.includes(t))) {
            return `\${${tabIndex}:0}`;
        }

        return `'\${${tabIndex}:[${dbCol.name}]}'`;
    }
}