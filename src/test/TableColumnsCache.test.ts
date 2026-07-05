import * as assert from 'assert';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { TableColumnsCache } from '../cache/TableColumnsCache.js';
import * as queryModule from '../db/query.js';

// ─── Pomocniki ────────────────────────────────────────────────────────────────

type FakeDb = {
    getConnectionName: () => string;
};

function makeFakeDb(connectionName: string): FakeDb {
    return {
        getConnectionName: () => connectionName,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TableColumnsCache — negative caching dla nieistniejących tabel
// ─────────────────────────────────────────────────────────────────────────────

suite('TableColumnsCache — negative caching', () => {

    test('does not query the database twice for the same nonexistent table', async () => {
        const db = makeFakeDb('conn-test-1');

        // 1. Podmiana ConnectionManager.getInstance — zachowaj oryginał
        const origConnectionGetInstance = ConnectionManager.getInstance.bind(ConnectionManager);
        (ConnectionManager as any).getInstance = () => ({
            getDb: async () => db,
        });

        // 2. Podmiana getTableColumnsBatch tak, by zliczała wywołania
        //    i zawsze zwracała [] (symulacja: tabela nie istnieje)
        const origGetTableColumnsBatch = queryModule.getTableColumnsBatch;
        let callCount = 0;
        (queryModule as any).getTableColumnsBatch = async () => {
            callCount++;
            return [];
        };

        // Upewnij się, że startujemy z czystym cache (singleton dzielony między testami)
        const cache = TableColumnsCache.getInstance();
        cache.clearTableColumnsCache();

        try {
            const tableRef = { schema: 'public', table: 'nonexistent_table' };

            // Pierwsze zapytanie — tabeli nie ma w cache, więc leci zapytanie do bazy
            const result1 = await cache.getCachedColumnsBatch([tableRef]);
            assert.strictEqual(callCount, 1, 'first call should query the database');
            assert.deepStrictEqual(
                result1['public.nonexistent_table'],
                [],
                'result for a nonexistent table should be an empty array'
            );

            // Drugie zapytanie o tę samą (connection, schema, table) —
            // baza NIE powinna być odpytana ponownie
            const result2 = await cache.getCachedColumnsBatch([tableRef]);
            assert.strictEqual(
                callCount, 1,
                'second call should not query the database again (negative cache)'
            );
            assert.deepStrictEqual(
                result2['public.nonexistent_table'],
                [],
                'second result should also be an empty array (from cache)'
            );

            // Trzecie zapytanie, dla pewności — cache dalej działa
            await cache.getCachedColumnsBatch([tableRef]);
            assert.strictEqual(callCount, 1, 'third call should also hit the cache');

        } finally {
            // 3. Przywrócenie oryginalnych zachowań
            (ConnectionManager as any).getInstance = origConnectionGetInstance;
            (queryModule as any).getTableColumnsBatch = origGetTableColumnsBatch;
            cache.clearTableColumnsCache();
        }
    });

    test('negative cache is isolated per connection name', async () => {
        const dbA = makeFakeDb('conn-A');
        const dbB = makeFakeDb('conn-B');

        const origConnectionGetInstance = ConnectionManager.getInstance.bind(ConnectionManager);
        let currentDb = dbA;
        (ConnectionManager as any).getInstance = () => ({
            getDb: async () => currentDb,
        });

        const origGetTableColumnsBatch = queryModule.getTableColumnsBatch;
        let callCount = 0;
        (queryModule as any).getTableColumnsBatch = async () => {
            callCount++;
            return [];
        };

        const cache = TableColumnsCache.getInstance();
        cache.clearTableColumnsCache();

        try {
            const tableRef = { schema: 'public', table: 'missing_table' };

            currentDb = dbA;
            await cache.getCachedColumnsBatch([tableRef]);
            assert.strictEqual(callCount, 1, 'connection A: first call should query the database');

            currentDb = dbB;
            await cache.getCachedColumnsBatch([tableRef]);
            assert.strictEqual(
                callCount, 2,
                'connection B: negative cache from connection A should not be used here'
            );

            currentDb = dbA;
            await cache.getCachedColumnsBatch([tableRef]);
            assert.strictEqual(
                callCount, 2,
                'connection A: should still use its own negative cache'
            );

        } finally {
            (ConnectionManager as any).getInstance = origConnectionGetInstance;
            (queryModule as any).getTableColumnsBatch = origGetTableColumnsBatch;
            cache.clearTableColumnsCache();
        }
    });
});
