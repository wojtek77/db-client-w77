import { ConnectionManager } from '../db/ConnectionManager.js';
import { getTableColumnsBatch } from '../db/query.js';

export interface TableColumn {
    schema: string;
    table: string;
    name: string;
    order: number;
    type: string;
    columnType: string,
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

type Cache = Record<
    string,
    Record<string, Record<string, TableColumn[]>>
>;

export class TableColumnsCache {
    private static instance: TableColumnsCache | null = null;
    
    // prywatny cache dostępny tylko przez metody klasy
    private tableColumnsCache: Cache = {};
    
    // prywatny konstruktor
    private constructor() {}
    
    /**
     * Metoda statyczna do pobierania jedynej instancji klasy
     */
    public static getInstance(): TableColumnsCache {
        if (!TableColumnsCache.instance) {
        TableColumnsCache.instance = new TableColumnsCache();
        }
        return TableColumnsCache.instance;
    }

    /**
     * Generuje klucz tekstowy dla referencji tabeli
     */
    public getTableRefKey(tableRef: TableRef): string {
        return `${tableRef.schema}.${tableRef.table}`;
    }

    /**
     * Pobiera kolumny z cache lub bazy danych w paczkach
     */
    public async getCachedColumnsBatch(
        tableRefs: TableRef[]
    ): Promise<Record<string, TableColumn[]>> {
        const db = await ConnectionManager.getInstance().getDb();
        const connectionName = db.getConnectionName();
        const result: Record<string, TableColumn[]> = {};
        const missing: TableRef[] = [];

        for (const tableRef of tableRefs) {
            const cached = this.getCachedEntry(
                connectionName,
                tableRef.schema,
                tableRef.table
            );
            if (cached) {
                result[this.getTableRefKey(tableRef)] = cached;
                continue;
            }
            missing.push(tableRef);
        }

        if (missing.length === 0) {
            return result;
        }

        const columns = await getTableColumnsBatch(missing);
        const grouped: Record<string, TableColumn[]> = {};

        for (const column of columns) {
            const key = `${column.schema}.${column.table}`;
            if (!grouped[key]) {
                grouped[key] = [];
            }
            grouped[key].push(column);
        }

        for (const [key, tableColumns] of Object.entries(grouped)) {
            tableColumns.sort((a, b) => a.order - b.order);
            const [schema, table] = key.split('.');
            this.setCachedEntry(connectionName, schema, table, tableColumns);
            result[key] = tableColumns;
        }

        // tabele bez zwróconych kolumn (literówka / nie istnieje) też cache'ujemy jako pustą tablicę, żeby nie odpytywać bazy w kółko
        for (const tableRef of missing) {
            const key = this.getTableRefKey(tableRef);
            if (key in grouped) {
                continue;
            }
            this.setCachedEntry(connectionName, tableRef.schema, tableRef.table, []);
            result[key] = [];
        }

        return result;
    }

    /**
     * Czyszczenie pamięci podręcznej
     */
    public clearTableColumnsCache(): void {
        this.tableColumnsCache = {};
    }

    /**
     * Zwraca aktualny stan cache (odpowiednik dawnego getTableColumnsCache)
     */
    public getCache(): Cache {
        return this.tableColumnsCache;
    }

    // prywatne metody pomocnicze ukryte przed światem zewnętrznym
    private getCachedEntry(
        connectionName: string,
        schema: string,
        tableName: string
    ): TableColumn[] | undefined {
        return this.tableColumnsCache[connectionName]?.[schema]?.[tableName];
    }

    private setCachedEntry(
        connectionName: string,
        schema: string,
        tableName: string,
        columns: TableColumn[]
    ): void {
        this.tableColumnsCache[connectionName] ??= {};
        this.tableColumnsCache[connectionName][schema] ??= {};
        this.tableColumnsCache[connectionName][schema][tableName] = columns;
    }
}
