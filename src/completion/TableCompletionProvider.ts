import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager';
import { getCachedColumns, TableColumn } from '../cache/tableColumnsCache';
import { formatColumnType } from './columnFormatter';
import { findCurrentQuery } from '../sql/findCurrentQuery';

export class TableCompletionProvider
    implements vscode.CompletionItemProvider {

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
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
                /\b(?:from|join)\s+(\w+)\.(\w*)$/i
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
                /\b(?:from|join)\s+(\w*)$/i
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
                /([a-zA-Z0-9_.]+)\.$/
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

                const columns =
                    await getCachedColumns(
                        schema,
                        table
                    );

                return columns.map(
                    column =>
                        this.createColumnItem(
                            table,
                            column
                        )
                );
            }

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

            let tableRef: {
                schema: string;
                table: string;
            } | null = null;

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

                const columns =
                    await getCachedColumns(
                        tableRef.schema,
                        tableRef.table
                    );

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
            );
        const selectIndex =
            beforeCursor
                .toLowerCase()
                .lastIndexOf('select');
        const fromIndex =
            beforeCursor
                .toLowerCase()
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

            const tableRefs: Array<{
                schema: string;
                table: string;
            }> = [];

            const regex =
                /\b(?:from|join)\s+(?:(\w+)\s*\.\s*)?(\w+)/gi;

            let match:
                RegExpExecArray | null;

            while (
                (match = regex.exec(fullText))
                !== null
            ) {

                tableRefs.push({

                    schema:
                        match[1]
                        ?? defaultSchema,

                    table:
                        match[2]
                });
            }
            
            const addedColumns =
                new Set<string>();

            for (
                const tableRef of tableRefs
            ) {

                const columns =
                    await getCachedColumns(
                        tableRef.schema,
                        tableRef.table
                    );
                
                for (
                    const column of columns
                ) {
                    if (
                        addedColumns.has(
                            column.name
                        )
                    ) {
                        continue;
                    }

                    addedColumns.add(
                        column.name
                    );

                    result.push(
                        this.createColumnItem(
                            tableRef.table,
                            column
                        )
                    );
                }
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
}