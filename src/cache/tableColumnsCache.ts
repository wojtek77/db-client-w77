import { ConnectionManager } from '../db/ConnectionManager';
import { getTableColumns } from '../db/query';

export interface TableColumn {
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

// Funkcja do pobierania kolumn z cache lub z bazy (dla autouzupełniania)
export async function getCachedColumns(
    schema: string,
    tableName: string
): Promise<TableColumn[]> {

    const db =
        await ConnectionManager
            .getInstance()
            .getDb();

    const connectionName =
        db.getConnectionName();

    const cached =
        getCachedEntry(
            connectionName,
            schema,
            tableName
        );

    if (cached) {
        return cached;
    }

    const columns =
        await getTableColumns(
            schema,
            tableName
        );

    setCachedEntry(
        connectionName,
        schema,
        tableName,
        columns
    );

    return columns;
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
