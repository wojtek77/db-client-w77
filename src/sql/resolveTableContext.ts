// wspólny kontekst tabeli potrzebny do edycji wyników (saveColumnEdits/saveCellEdits) i generowania SQL INSERT/UPDATE/DELETE -
// wydzielone z SqlResultsProvider.ts, bo to czysto "SQL-owa" logika oparta wyłącznie na meta wyniku SELECT + cache kolumn tabeli, bez zależności od stanu grida (paginacji/sortowania/wyszukiwania)
import * as vscode from 'vscode';
import { Connection } from '../db/Connection.js';
import { TableColumnsCache } from '../cache/TableColumnsCache.js';
import { resolvePrimaryKeyColumns, resolveTableColumns, ResolvedColumnRef } from './resolvePrimaryKeyColumns.js';

export interface TableContext {
    tableName: string;
    schema: string;
    qualifiedTable: string;
    columns: ResolvedColumnRef[];
    primaryKeys: ResolvedColumnRef[];
}

/**
 * Buduje nazwę tabeli do użycia w SQL: `schema`.`table`, jeśli połączenie
 * nie ma ustawionej domyślnej bazy (database=''), albo samo `table`,
 * jeśli połączenie już łączy się z konkretną bazą (wtedy prefiks schemy
 * jest zbędny i tylko zaśmieca wygenerowany/wykonywany SQL).
 */
export function qualifyTableName(db: Connection, schema: string, tableName: string): string {
    return db.getDatabase()
        ? `\`${tableName}\``
        : `\`${schema}\`.\`${tableName}\``;
}

/**
 * Wspólny kontekst potrzebny do generowania INSERT/UPDATE/DELETE oraz do
 * zbiorczej edycji kolumn/komórek: nazwa tabeli/schemy, kolumny faktycznie
 * widoczne w wynikach SELECT (bez kolumn wyliczanych typu COUNT(*)), oraz
 * które z nich są PRIMARY KEY. Nie wykonuje żadnego dodatkowego zapytania
 * do bazy - tabela/PK są rozpoznawane z metadanych (meta) + cache kolumn tabeli.
 */
export async function resolveTableContext(meta: any[], db: Connection): Promise<TableContext | null> {
    const firstField = meta[0];
    if (!firstField) {
        vscode.window.showErrorMessage('Unable to determine the source table');
        return null;
    }

    const tableName = firstField.orgTable?.();
    const schema = firstField.schema?.();

    if (!tableName || !schema) {
        vscode.window.showErrorMessage('Unable to determine the source table or schema');
        return null;
    }

    const qualifiedTable = qualifyTableName(db, schema, tableName);

    // tylko kolumny faktycznie należące do tej tabeli (bez wyliczanych, np. COUNT(*)), każda nazwa raz - nawet jeśli SELECT ją duplikuje (np. f.id, f.*)
    const columns = resolveTableColumns(meta, tableName);

    const tableColumnsService = TableColumnsCache.getInstance();
    const columnsMap = await tableColumnsService.getCachedColumnsBatch([{schema, table: tableName}]);
    const tableColumns = columnsMap[tableColumnsService.getTableRefKey({schema, table: tableName})] ?? [];

    const primaryKeyNames = tableColumns.filter((c: any) => c.columnKey === 'PRI').map((c: any) => c.name);

    if (primaryKeyNames.length === 0) {
        vscode.window.showErrorMessage(`Table ${tableName} does not have a PRIMARY KEY`);
        return null;
    }

    // ta sama logika co przy edycji pojedynczej komórki i bezpośrednim kasowaniu wierszy - jedno (pierwsze) wystąpienie każdej kolumny PK w wynikach SELECT
    const { found: primaryKeys, missingNames } = resolvePrimaryKeyColumns(meta, tableName, primaryKeyNames);

    if (missingNames.length > 0) {
        vscode.window.showErrorMessage(
            `Missing PRIMARY KEY column(s) in the SELECT results: ${missingNames.join(', ')}`
        );
        return null;
    }

    return { tableName, schema, qualifiedTable, columns, primaryKeys };
}
