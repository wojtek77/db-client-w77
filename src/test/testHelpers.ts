import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { TableColumn, TableColumnsCache } from '../cache/TableColumnsCache.js';
import { TableCompletionProvider } from '../completion/TableCompletionProvider.js';

// ─── Typy pomocnicze ──────────────────────────────────────────────────────────

export type FakeDb = {
    getTables:               (schema: string) => string[];
    getDefaultDatabaseTables: () => string[];
    getSchemas:              () => string[];
    getDatabase:             () => string;
    findSchemaByTable:       (table: string) => string | null;
    getConnectionName:       () => string;
};

// ─── Pomocniki ────────────────────────────────────────────────────────────────

export function makeColumn(
    name: string,
    type: string,
    key = '',
    extra = '',
    defaultValue: string | null = null,
    isNullable: 'YES' | 'NO' = 'NO',
): TableColumn {
    return {
        schema: 'public', table: 'users', name,
        order: 1, type, columnType: type, isNullable, defaultValue,
        columnKey: key, extra, characterMaximumLength: null,
        numericPrecision: null, numericScale: null,
    };
}

export function makeFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
    return {
        getTables:               overrides.getTables               ?? (() => []),
        getDefaultDatabaseTables: overrides.getDefaultDatabaseTables ?? (() => []),
        getSchemas:              overrides.getSchemas              ?? (() => []),
        getDatabase:             overrides.getDatabase             ?? (() => ''),
        findSchemaByTable:       overrides.findSchemaByTable       ?? (() => null),
        getConnectionName:       overrides.getConnectionName       ?? (() => 'test'),
    };
}

/**
 * Uruchamia TableCompletionProvider z podmienionym ConnectionManager
 * i getCachedColumnsBatch, bez potrzeby biblioteki do mockowania.
 */
export async function getCompletions(
    content:      string,
    cursorOffset: number,
    dbOverrides:  Partial<FakeDb> = {},
    columnsStub:  Record<string, TableColumn[]> = {},
): Promise<vscode.CompletionItem[]> {

    const db = makeFakeDb(dbOverrides);

    // 1. Podmiana ConnectionManager.getInstance — zachowaj oryginał
    const origConnectionGetInstance = ConnectionManager.getInstance.bind(ConnectionManager);
    (ConnectionManager as any).getInstance = () => ({
        getDb: async () => db,
    });

    // 2. Podmiana metody w instancji TableColumnsService — zachowaj oryginał
    const columnsServiceInstance = TableColumnsCache.getInstance();
    const origGetCachedColumnsBatch = columnsServiceInstance.getCachedColumnsBatch.bind(columnsServiceInstance);

    // Nadpisujemy metodę na instancji, aby zwracała dane testowe (stub)
    columnsServiceInstance.getCachedColumnsBatch = async () => columnsStub;

    try {
        const document = await vscode.workspace.openTextDocument({
            language: 'sql',
            content,
        });
        const position = document.positionAt(cursorOffset);
        const provider = new TableCompletionProvider();
        const token    = new vscode.CancellationTokenSource().token;

        const result = await provider.provideCompletionItems(
            document, position, token,
        );
        return result ?? [];

    } finally {
        // 3. Przywrócenie oryginalnych zachowań w bloku finally
        (ConnectionManager as any).getInstance = origConnectionGetInstance;
        columnsServiceInstance.getCachedColumnsBatch = origGetCachedColumnsBatch;
    }
}

/** Wyciąga string z label, który może być string lub CompletionItemLabel. */
export function labelOf(item: vscode.CompletionItem): string {
    return typeof item.label === 'string' ? item.label : item.label.label;
}

/** Wyciąga insertText jako zwykły string (obsługuje SnippetString i zwykłe stringi). */
export function insertTextOf(item: vscode.CompletionItem): string {
    if (!item.insertText) { return ''; }
    return typeof item.insertText === 'string' ? item.insertText : item.insertText.value;
}
