import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager';
import { getCachedColumnsBatch, getTableRefKey, TableColumn, TableRef } from '../cache/tableColumnsCache';
import { formatColumnType } from './columnFormatter';
import { findCurrentQuery } from '../sql/findCurrentQuery';
import { findQueryTables } from '../sql/findQueryTables';
import { SQL_FUNCTIONS, SqlFunction } from './sqlFunctions';

const REGEX_SCHEMA_TABLE =
    /\b(?:from|join)\s+(\w+)\.(\w*)$/i;

const REGEX_FROM_OBJECT =
    /\b(?:from|join)\s+(\w*)$/i;

const REGEX_ALIAS_DOT =
    /([a-zA-Z0-9_.]+)\.$/;

export class TableCompletionProvider
    implements vscode.CompletionItemProvider {

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
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
            const fullText =
                currentQuery.sql;
        
        /*
            FROM schema.
            JOIN schema.
        */
        const schemaTableMatch =
            linePrefix.match(
                REGEX_SCHEMA_TABLE
            );

        if (schemaTableMatch) {

            const schema =
                schemaTableMatch[1];

            const filter =
                schemaTableMatch[2]
                    ?.toLowerCase()
                ?? '';

            const db =
                await ConnectionManager
                    .getInstance()
                    .getDb();

            return db
                .getTables(schema)
                .filter(table =>
                    table
                        .toLowerCase()
                        .includes(filter)
                )
                .map((table, index) =>
                    this.createTableItem(table, index)
                );
        }

        /*
            FROM xxx
            JOIN xxx

            Zwracamy:
            - schematy
            - tabele domyślnej bazy
        */
        const objectMatch =
            linePrefix.match(
                REGEX_FROM_OBJECT
            );

        if (objectMatch) {

            const filter =
                objectMatch[1]
                    ?.toLowerCase()
                ?? '';

            const db =
                await ConnectionManager
                    .getInstance()
                    .getDb();

            const result: vscode.CompletionItem[] = [];

            /*
                Jeśli jest ustawiona database,
                najpierw pokaż tabele.
            */
            if (db.getDatabase()) {

                let tableOrder = 0;

                for (
                    const table of
                    db.getDefaultDatabaseTables()
                ) {

                    if (
                        filter &&
                        !table
                            .toLowerCase()
                            .includes(filter)
                    ) {
                        continue;
                    }

                    result.push(
                        this.createTableItem(
                            table,
                            tableOrder++
                        )
                    );
                }

                /*
                    Schematy zawsze na końcu
                */
                const schemas =
                    db.getSchemas();

                schemas.forEach(
                    (schema, index) => {

                        if (
                            filter &&
                            !schema
                                .toLowerCase()
                                .includes(filter)
                        ) {
                            return;
                        }

                        result.push(
                            this.createSchemaItem(
                                schema,
                                index
                            )
                        );
                    }
                );
            }
            else {

                /*
                    Brak database:
                    pokazuj tylko schematy.
                */
                const schemas =
                    db.getSchemas();

                schemas.forEach(
                    (schema, index) => {

                        if (
                            filter &&
                            !schema
                                .toLowerCase()
                                .includes(filter)
                        ) {
                            return;
                        }

                        result.push(
                            this.createSchemaItem(
                                schema,
                                index
                            )
                        );
                    }
                );
            }

            return result;
        }
        
        /*
            Alias.
            Przykład:

            select s.
        */
        const aliasMatch =
            linePrefix.match(
                REGEX_ALIAS_DOT
            );
        if (aliasMatch) {

            const alias =
                aliasMatch[1];
            
            // obsługa pełnej nazwy
            const parts = alias.split('.');
            if (parts.length === 2) {
                const schema =
                    parts[0];

                const table =
                    parts[1];

                const columnsMap =
                    await getCachedColumnsBatch([
                        {
                            schema,
                            table
                        }
                    ]);
                const columns =
                    columnsMap[getTableRefKey({schema, table})] ?? [];

                return columns.map(
                    column =>
                        this.createColumnItem(
                            table,
                            column
                        )
                );
            }

            let tableRef: TableRef | null = null;

            const db =
                await ConnectionManager
                    .getInstance()
                    .getDb();

            const defaultSchema =
                db.getDatabase();

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

                const match =
                    fullText.match(pattern);

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
                        || db.findSchemaByTable(
                            match[2]
                        )
                        || '',

                    table:
                        match[2]
                };

                break;
            }
            
            // Brak aliasu.
            // Użytkownik wpisał np.:
            // contacts.
            // contacts_cstm.
            // Traktujemy identyfikator jako nazwę tabeli.
            if (!tableRef) {
                tableRef = {
                    schema:
                        defaultSchema
                        || db.findSchemaByTable(
                            alias
                        )
                        || '',
                    table:
                        alias
                };
            }

            if (tableRef) {
                
                const tableRefs =
                    findQueryTables(
                        fullText,
                        defaultSchema,
                        db
                    );
                const columnsMap =
                    await getCachedColumnsBatch(tableRefs);
                const columns =
                    columnsMap[getTableRefKey(tableRef)] ?? [];

                return columns.map(
                    column =>
                        this.createColumnItem(
                            tableRef.table,
                            column
                        )
                );
            }
        }
        
        /*
            SELECT <Ctrl+Space>
        */
        const queryStartOffset =
            document.offsetAt(
                new vscode.Position(
                    currentQuery.startLine,
                    0
                )
            );
        const queryOffset =
            document.offsetAt(position) - queryStartOffset;
        const beforeCursor =
            fullText.substring(
                0,
                queryOffset
            ).toLowerCase();
        const selectIndex =
            beforeCursor
                .lastIndexOf('select');
        const fromIndex =
            beforeCursor
                .lastIndexOf('from');
        const isInSelectClause =
            selectIndex !== -1 &&
            (
                fromIndex === -1 ||
                selectIndex > fromIndex
            );
        if (isInSelectClause) {

            const db =
                await ConnectionManager
                    .getInstance()
                    .getDb();

            const defaultSchema =
                db.getDatabase();

            const result:
                vscode.CompletionItem[] = [];

            const tableRefs =
                findQueryTables(
                    fullText,
                    defaultSchema,
                    db
                );
            
            const columnsMap =
                await getCachedColumnsBatch(
                    tableRefs
                );

            for (
                const tableRef of tableRefs
            ) {

                const columns =
                    columnsMap[getTableRefKey(tableRef)] ?? [];

                for (
                    const column of columns
                ) {
                    result.push(
                        this.createColumnItem(
                            tableRef.table,
                            column
                        )
                    );
                }
            }
            
            for (
                const fn
                of SQL_FUNCTIONS
            ) {

                result.push(
                    this.createFunctionItem(
                        fn
                    )
                );
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

        item.insertText =
            tableName;

        item.detail =
            'Table';

        /*
            Tabele zawsze przed schema
        */
        item.sortText =
            `0_${order
                .toString()
                .padStart(5, '0')}`;

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

        item.insertText =
            schema;

        item.detail =
            'Schema';

        /*
            Schematy zawsze po tabelach
        */
        item.sortText =
            `1_${order
                .toString()
                .padStart(5, '0')}`;

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
        
        item.sortText =
            `0_${column.name}`;

        item.insertText =
            column.name;

        const formattedType =
            formatColumnType(
                column
            );

        const details: string[] = [];

        details.push(
            formattedType
        );

        if (
            column.isNullable ===
            'YES'
        ) {
            details.push(
                'NULL'
            );
        } else {
            details.push(
                'NOT NULL'
            );
        }

        if (
            column.columnKey ===
            'PRI'
        ) {
            details.push(
                '🔑 PRIMARY KEY'
            );
        }

        if (
            column.columnKey ===
            'UNI'
        ) {
            details.push(
                '🔗 UNIQUE'
            );
        }

        if (
            column.extra ===
            'auto_increment'
        ) {
            details.push(
                '📈 AUTO_INCREMENT'
            );
        }

        if (
            column.defaultValue !==
            null
        ) {
            details.push(
                `📌 DEFAULT: ${column.defaultValue}`
            );
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
        
        item.filterText =
            fn.name;

        item.insertText =
            new vscode.SnippetString(
                fn.snippet
            );

        item.documentation =
            new vscode.MarkdownString(
                fn.documentation
            );

        item.sortText =
            `9_${fn.name}`;

        return item;
    }
}