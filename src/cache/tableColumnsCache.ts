import { ConnectionManager } from '../db/ConnectionManager.js';
import { getTableColumnsBatch } from '../db/query.js';

export interface TableColumn {
    schema: string;
    table: string;
    name: string;
    order: number;
    type: string;
    isNullable: string;
    defaultValue: any;
    columnKey: string;
    extra: string;
    characterMaximumLength: number | null;
    numericPrecision: number | null;
    numericScale: number | null;
}

export interface TableRef {
    schema: string;
    table: string;
}

type TableColumnsCache =
    Record<
        string,
        Record<
            string,
            Record<
                string,
                TableColumn[]
            >
        >
    >;

// Cache dla kolumn tabel - przechowuje pełne informacje o kolumnach
let tableColumnsCache: TableColumnsCache = {};

export function getTableRefKey(tableRef: TableRef): string {
    return `${tableRef.schema}.${tableRef.table}`;
}

export async function getCachedColumnsBatch(
    tableRefs: TableRef[]
): Promise<Record<string, TableColumn[]>> {

    const db =
        await ConnectionManager
            .getInstance()
            .getDb();

    const connectionName =
        db.getConnectionName();

    const result: Record<string, TableColumn[]> = {};

    const missing: TableRef[] = [];

    for (
        const tableRef
        of tableRefs
    ) {

        const cached =
            getCachedEntry(
                connectionName,
                tableRef.schema,
                tableRef.table
            );

        if (cached) {
            result[getTableRefKey(tableRef)] = cached;
            continue;
        }

        missing.push(tableRef);
    }

    if (missing.length === 0) {
        return result;
    }

    const columns =
        await getTableColumnsBatch(
            missing
        );

    const grouped: Record<string, TableColumn[]> = {};

    for (
        const column
        of columns
    ) {

        const key = `${column.schema}.${column.table}`;

        if (!grouped[key]) {
            grouped[key] = [];
        }
        grouped[key].push(
            column
        );
    }

    for (
        const [
            key,
            tableColumns
        ]
        of Object.entries(grouped)
    ) {
        tableColumns.sort(
            (a, b) =>
                a.order - b.order
        );

        const [
            schema,
            table
        ] = key.split('.');

        setCachedEntry(
            connectionName,
            schema,
            table,
            tableColumns
        );

        result[key] = tableColumns;
    }

    return result;
}

// Funkcja dla parsera SQL (zwraca tylko nazwy kolumn jako string[])
// export async function getCachedColumnsAsStrings(tableName: string): Promise<string[]> {
//     const columns = await getCachedColumns(tableName);
//     return columns.map((col: any) => col.name);
// }

export function clearTableColumnsCache(): void {
    tableColumnsCache = {};
    console.log('clearTableColumnsCache');
}

function getCachedEntry(
    connectionName: string,
    schema: string,
    tableName: string
): TableColumn[] | undefined {

    return tableColumnsCache
        [connectionName]
        ?. [schema]
        ?. [tableName];
}

function setCachedEntry(
    connectionName: string,
    schema: string,
    tableName: string,
    columns: TableColumn[]
): void {

    tableColumnsCache
        [connectionName]
        ??= {};

    tableColumnsCache
        [connectionName]
        [schema]
        ??= {};

    tableColumnsCache
        [connectionName]
        [schema]
        [tableName]
        = columns;
}

export function getTableColumnsCache(): TableColumnsCache {
    return tableColumnsCache;
}
