import { ConnectionManager } from '../db/ConnectionManager.js';
import { getTableIndexesBatch } from '../db/query.js';
import { TableRef } from './TableColumnsCache.js';

export interface TableIndex {
    schema: string;
    table: string;
    name: string;
}

type Cache = Record<
    string,
    Record<string, Record<string, TableIndex[]>>
>;

export class TableIndexesCache {
    private static instance: TableIndexesCache | null = null;

    // prywatny cache dostępny tylko przez metody klasy
    private tableIndexesCache: Cache = {};

    // prywatny konstruktor
    private constructor() {}

    /**
     * Metoda statyczna do pobierania jedynej instancji klasy
     */
    public static getInstance(): TableIndexesCache {
        if (!TableIndexesCache.instance) {
            TableIndexesCache.instance = new TableIndexesCache();
        }
        return TableIndexesCache.instance;
    }

    /**
     * Generuje klucz tekstowy dla referencji tabeli
     */
    public getTableRefKey(tableRef: TableRef): string {
        return `${tableRef.schema}.${tableRef.table}`;
    }

    /**
     * Pobiera nazwy indeksów z cache lub bazy danych w paczkach
     */
    public async getCachedIndexesBatch(
        tableRefs: TableRef[]
    ): Promise<Record<string, TableIndex[]>> {
        const db = await ConnectionManager.getInstance().getDb();
        const connectionName = db.getConnectionName();
        const result: Record<string, TableIndex[]> = {};
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

        const indexes = await getTableIndexesBatch(missing);
        const grouped: Record<string, TableIndex[]> = {};

        for (const index of indexes) {
            const key = `${index.schema}.${index.table}`;
            if (!grouped[key]) {
                grouped[key] = [];
            }
            grouped[key].push(index);
        }

        for (const [key, tableIndexes] of Object.entries(grouped)) {
            const [schema, table] = key.split('.');
            this.setCachedEntry(connectionName, schema, table, tableIndexes);
            result[key] = tableIndexes;
        }

        // tabele bez indeksów też cache'ujemy jako pustą tablicę, żeby nie odpytywać bazy w kółko
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
    public clearTableIndexesCache(): void {
        this.tableIndexesCache = {};
    }

    // prywatne metody pomocnicze ukryte przed światem zewnętrznym
    private getCachedEntry(
        connectionName: string,
        schema: string,
        tableName: string
    ): TableIndex[] | undefined {
        return this.tableIndexesCache[connectionName]?.[schema]?.[tableName];
    }

    private setCachedEntry(
        connectionName: string,
        schema: string,
        tableName: string,
        indexes: TableIndex[]
    ): void {
        this.tableIndexesCache[connectionName] ??= {};
        this.tableIndexesCache[connectionName][schema] ??= {};
        this.tableIndexesCache[connectionName][schema][tableName] = indexes;
    }
}
