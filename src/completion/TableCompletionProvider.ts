import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager';
import { getCachedColumnsBatch, getTableRefKey, TableColumn, TableRef } from '../cache/tableColumnsCache';
import { formatColumnType } from './columnFormatter';
import { findCurrentQuery } from '../sql/findCurrentQuery';
import { findQueryTables } from '../sql/findQueryTables';
import { SQL_FUNCTIONS, SqlFunction } from './sqlFunctions';
import { Connection } from '../db/Connection';

const REGEX_SCHEMA_TABLE =
    /\b(?:from|join)\s+(\w+)\.(\w*)$/i;

const REGEX_FROM_OBJECT =
    /\b(?:from|join)\s+(\w*)$/i;

// FIX #4: Doprecyzowany regex — dopasowuje tylko identyfikatory
// bez zagnieżdżonych kropek w samym aliasie, co eliminuje
// fałszywe dopasowania dla a.b.c.
const REGEX_ALIAS_DOT =
    /([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)\.$/;

export class TableCompletionProvider
    implements vscode.CompletionItemProvider {

    // FIX #7: Obsługa CancellationToken — przerywamy przetwarzanie,
    // gdy VS Code anuluje żądanie (np. użytkownik pisze dalej).
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[]> {

        const linePrefix =
            document
                .lineAt(position)
                .text
                .substring(0, position.character);

        const currentQuery =
            findCurrentQuery(
                document.getText(),
                position.line
            );

        if (!currentQuery) {
            return [];
        }

        const fullText = currentQuery.sql;

        // FIX #3: Jedno wspólne pobranie połączenia z obsługą błędów.
        // FIX #5: getDb() wywoływane raz — wynik reużywany we wszystkich
        // sekcjach zamiast wielokrotnego await w każdej gałęzi.
        let db: Connection;
        try {
            db = await ConnectionManager
                .getInstance()
                .getDb();
        } catch (err) {
            console.error('[TableCompletionProvider] Błąd połączenia z bazą:', err);
            return [];
        }

        if (token.isCancellationRequested) {
            return [];
        }

        /*
            FROM schema.
            JOIN schema.
        */
        const schemaTableMatch =
            linePrefix.match(REGEX_SCHEMA_TABLE);

        if (schemaTableMatch) {

            const schema = schemaTableMatch[1];

            // FIX #8: schemaTableMatch[2] pochodzi z grupy (\w*),
            // więc nigdy nie jest undefined — usunięto zbędne ?. i ?? ''.
            const filter = schemaTableMatch[2].toLowerCase();

            return db
                .getTables(schema)
                .filter(table =>
                    table.toLowerCase().includes(filter)
                )
                .map((table, index) =>
                    this.createTableItem(table, index)
                );
        }

        if (token.isCancellationRequested) {
            return [];
        }

        /*
            FROM xxx
            JOIN xxx

            Zwracamy:
            - schematy
            - tabele domyślnej bazy
        */
        const objectMatch =
            linePrefix.match(REGEX_FROM_OBJECT);

        if (objectMatch) {

            const filter = objectMatch[1].toLowerCase();

            const result: vscode.CompletionItem[] = [];

            if (db.getDatabase()) {

                let tableOrder = 0;

                for (const table of db.getDefaultDatabaseTables()) {

                    if (filter && !table.toLowerCase().includes(filter)) {
                        continue;
                    }

                    result.push(
                        this.createTableItem(table, tableOrder++)
                    );
                }
            }

            // FIX #2: Usunięto duplikację — schematy dodawane raz,
            // niezależnie od tego czy baza domyślna jest ustawiona.
            const schemas = db.getSchemas();

            schemas.forEach((schema, index) => {

                if (filter && !schema.toLowerCase().includes(filter)) {
                    return;
                }

                result.push(
                    this.createSchemaItem(schema, index)
                );
            });

            return result;
        }

        if (token.isCancellationRequested) {
            return [];
        }

        /*
            Alias lub pełna nazwa tabeli.
            Przykład:

            select s.
            select contacts.
            select public.contacts.
        */
        const aliasMatch =
            linePrefix.match(REGEX_ALIAS_DOT);

        if (aliasMatch) {

            const alias = aliasMatch[1];

            // FIX #4: parts.length może być tylko 1 lub 2 dzięki
            // nowemu regexowi — obsługa a.b.c. jest teraz wykluczona.
            const parts = alias.split('.');

            if (parts.length === 2) {

                const schema = parts[0];
                const table  = parts[1];

                // FIX #9: Walidacja przed użyciem
                if (!schema || !table) {
                    return [];
                }

                // Obsługa pełnej nazwy schema.table — pobieramy
                // tylko kolumny tej jednej tabeli.
                const columnsMap =
                    await getCachedColumnsBatch([{ schema, table }]);

                const columns =
                    columnsMap[getTableRefKey({ schema, table })] ?? [];

                return columns.map(
                    column => this.createColumnItem(table, column)
                );
            }

            if (token.isCancellationRequested) {
                return [];
            }

            const defaultSchema = db.getDatabase();

            let tableRef: TableRef | null = null;

            const patterns = [
                new RegExp(
                    `from\\s+(?:(\\w+)\\s*\\.\\s*)?(\\w+)\\s+(?:as\\s+)?${alias}\\b`,
                    'i'
                ),
                new RegExp(
                    `join\\s+(?:(\\w+)\\s*\\.\\s*)?(\\w+)\\s+(?:as\\s+)?${alias}\\b`,
                    'i'
                ),
                new RegExp(
                    `,\\s*(?:(\\w+)\\s*\\.\\s*)?(\\w+)\\s+(?:as\\s+)?${alias}\\b`,
                    'i'
                )
            ];

            for (const pattern of patterns) {

                const match = fullText.match(pattern);

                if (!match) {
                    continue;
                }

                tableRef = {
                    // TODO:
                    // jeśli tabela występuje w wielu schema,
                    // zwracać wszystkie dopasowania zamiast pierwszego.
                    schema:
                        match[1]
                        || defaultSchema
                        || db.findSchemaByTable(match[2])
                        || '',
                    table: match[2]
                };

                break;
            }

            // Brak aliasu — identyfikator traktowany jako nazwa tabeli.
            if (!tableRef) {
                tableRef = {
                    schema:
                        defaultSchema
                        || db.findSchemaByTable(alias)
                        || '',
                    table: alias
                };
            }

            // FIX #6: Pobieramy kolumny tylko dla docelowej tabeli
            // zamiast wszystkich tabel z zapytania.
            // FIX #1: Usunięto zbędny `if (tableRef)` — po bloku
            // `if (!tableRef) { tableRef = ... }` wartość jest zawsze
            // ustawiona, dodatkowe sprawdzenie było zawsze prawdziwe.
            const columnsMap =
                await getCachedColumnsBatch([tableRef]);

            const columns =
                columnsMap[getTableRefKey(tableRef)] ?? [];

            return columns.map(
                column => this.createColumnItem(tableRef!.table, column)
            );
        }

        if (token.isCancellationRequested) {
            return [];
        }

        /*
            SELECT <Ctrl+Space>
        */
        const queryStartOffset =
            document.offsetAt(
                new vscode.Position(currentQuery.startLine, 0)
            );
        const queryOffset =
            document.offsetAt(position) - queryStartOffset;
        const beforeCursor =
            fullText.substring(0, queryOffset).toLowerCase();
        
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
        
        const currentClause =
                clauses
                    .filter(c => c.index !== -1)
                    .sort((a, b) => b.index - a.index)[0]?.name;
        
        const isInSelectClause  = currentClause === 'select';
        const isInWhereClause   = currentClause === 'where';
        const isInGroupClause   = currentClause === 'group';
        const isInHavingClause  = currentClause === 'having';
        const isInOrderClause   = currentClause === 'order';
        // const isInLimitClause = currentClause === 'limit';
        
        if (isInSelectClause || isInWhereClause || isInGroupClause || isInOrderClause) {

            const defaultSchema = db.getDatabase();

            const result: vscode.CompletionItem[] = [];

            const tableRefs =
                findQueryTables(fullText, defaultSchema, db);

            const columnsMap =
                await getCachedColumnsBatch(tableRefs);

            for (const tableRef of tableRefs) {

                const columns =
                    columnsMap[getTableRefKey(tableRef)] ?? [];

                for (const column of columns) {
                    result.push(
                        this.createColumnItem(tableRef.table, column)
                    );
                }
            }

            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }

            return result;
        }
        
        if (isInHavingClause) {
            const result: vscode.CompletionItem[] = [];

            const selectPart =
                selectIndex !== -1 && fromIndex !== -1
                    ? fullText.slice(
                        selectIndex + 'select'.length,
                        fromIndex
                    )
                    : '';
            const words =
                (selectPart.match(
                    /[a-zA-Z0-9_.]+/g
                ) ?? [])
                .map(word => word.split('.').pop()!);
            for (const word of new Set(words)) {
                const item =
                    new vscode.CompletionItem(
                        word,
                        vscode.CompletionItemKind.Text
                    );
                item.sortText = `5_${word}`;
                result.push(item);
            }
            
            for (const fn of SQL_FUNCTIONS) {
                result.push(this.createFunctionItem(fn));
            }

            return result;
        }

        return [];
    }

    private createTableItem(
        tableName: string,
        order: number
    ): vscode.CompletionItem {

        const item =
            new vscode.CompletionItem(
                tableName,
                vscode.CompletionItemKind.Struct
            );

        item.insertText = tableName;
        item.detail     = 'Table';

        // Tabele zawsze przed schematami
        item.sortText =
            `0_${order.toString().padStart(5, '0')}`;

        return item;
    }

    private createSchemaItem(
        schema: string,
        order: number
    ): vscode.CompletionItem {

        const item =
            new vscode.CompletionItem(
                schema,
                vscode.CompletionItemKind.Module
            );

        item.insertText = schema;
        item.detail     = 'Schema';

        // Schematy zawsze po tabelach
        item.sortText =
            `1_${order.toString().padStart(5, '0')}`;

        return item;
    }

    private createColumnItem(
        tableName: string,
        column: TableColumn
    ): vscode.CompletionItem {

        const item =
            new vscode.CompletionItem(
                column.name,
                vscode.CompletionItemKind.Field
            );

        item.sortText   = `0_${column.name}`;
        item.insertText = column.name;

        const formattedType = formatColumnType(column);

        const details: string[] = [formattedType];

        details.push(
            column.isNullable === 'YES' ? 'NULL' : 'NOT NULL'
        );

        if (column.columnKey === 'PRI') {
            details.push('🔑 PRIMARY KEY');
        }

        if (column.columnKey === 'UNI') {
            details.push('🔗 UNIQUE');
        }

        if (column.extra === 'auto_increment') {
            details.push('📈 AUTO_INCREMENT');
        }

        if (column.defaultValue !== null) {
            details.push(`📌 DEFAULT: ${column.defaultValue}`);
        }

        item.detail =
            `📊 ${formattedType} | ${details.slice(1).join(' | ')}`;

        item.documentation =
            `${tableName}.${column.name}\n\n${details.join('\n')}`;

        return item;
    }

    private createFunctionItem(
        fn: SqlFunction
    ): vscode.CompletionItem {

        const item =
            new vscode.CompletionItem(
                `${fn.signature}`,
                vscode.CompletionItemKind.Function
            );

        item.filterText = fn.name;

        item.insertText =
            new vscode.SnippetString(fn.snippet);

        item.documentation =
            new vscode.MarkdownString(fn.documentation);

        item.sortText = `9_${fn.name}`;

        return item;
    }
}
