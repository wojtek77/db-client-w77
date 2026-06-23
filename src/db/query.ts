import { ConnectionManager } from './ConnectionManager.js';
import { Connection } from './Connection.js';
import { SqlUtil } from '../sql/SqlUtil.js';
import { TableColumn, TableRef } from '../cache/tableColumnsCache.js';
import * as vscode from 'vscode';
import { findCurrentQuery } from '../sql/findCurrentQuery.js';
import { SqlResultsProvider } from '../panel/SqlResultsProvider.js';

export async function executeQuery(db: Connection, sql: string) {
    let rows: any[] = [];
    let queryTime = 0;
    let success = false;
    let errorMessage = '';
    let headers: string[] = [];
    let meta: any;
    
    try {
        // wcześniej na SQL był TRIM
        sql = SqlUtil.appendLimit(sql);
        
        let startQuery = performance.now();
        
        const [queryData, queryMeta] = await db.query({ sql, rowsAsArray: true, metaAsArray: true });
        if (Array.isArray(queryData)) {
            // SELECT: queryData to wiersze, queryMeta to definicje kolumn
            rows = queryData;
            meta = queryMeta;
            headers = meta.map((field: any) => field.name());
        } else {
            // Nie-SELECT (np. SET, INSERT, UPDATE, DELETE): queryData to OkPacket,
            // więc budujemy własną tabelę wyniku
            headers = ['Name', 'Value'];
            rows = [
                ['Updated Rows', queryData?.affectedRows ?? 0],
                ['Query', sql]
            ];
            meta = undefined;
        }
        
        const endQuery = performance.now();
        queryTime = endQuery - startQuery;
        
        success = true;
    } catch (err: any) {
        console.error(err);
        if (err.message?.includes('Query execution was interrupted')) {
            errorMessage = 'Query cancelled by user';
        } else {
            errorMessage = err.message;
        }
    }
    
    return { rows, headers, meta, queryTime, success, errorMessage };
}

export async function executeQueryWholeFile(db: Connection, fullText: string) {
    let rows: any[] = [];
    let queryTime = 0;
    let success = true;
    let errorMessage = '';
    let headers: string[] = [];
    let meta: any;
    
    const lines = fullText.split('\n');

    let selectExecuted = false;
    let executedSqlCount = 0;
    let skippedSelectCount = 0;

    let lineIndex = 0;
    
    let startQuery = performance.now();

    while (lineIndex < lines.length) {
        // Pomijamy puste linie
        if (lines[lineIndex].trim() === '') {
            lineIndex++;
            continue;
        }

        // Używamy findCurrentQuery, żeby znaleźć zapytanie zaczynające się od tej linii
        const query = findCurrentQuery(fullText, lineIndex);
        if (!query) {
            lineIndex++;
            continue;
        }

        const sql = query.sql;

        if (SqlUtil.isSelect(sql)) {
            if (!selectExecuted) {
                // Wykonaj pierwszy SELECT przez executeQuery
                ({ rows, headers, meta, success, errorMessage } = await executeQuery(db, sql));
                if (!success) {
                    break;
                }
                selectExecuted = true;
                ++executedSqlCount;
            } else {
                // Pomiń kolejne SELECT-y
                ++skippedSelectCount;
            }
        } else {
            // Nie-SELECT: wykonaj przez połączenie z bazą danych
            ({success, errorMessage} = await executeQuery(db, sql));
            if (!success) {
                break;
            }
            ++executedSqlCount;
        }

        // Przeskocz do linii po końcu znalezionego zapytania
        lineIndex = query.endLine + 1;
    }
    
    const endQuery = performance.now();
    queryTime = endQuery - startQuery;

    // Wyświetl ogólną informację
    vscode.window.showInformationMessage(`Executed ${executedSqlCount} ${executedSqlCount === 1 ? 'query' : 'queries'}`);
    
    if (skippedSelectCount > 0) {
        
        // Wyświetl informację o pominiętych SELECT-ach przez flashMessage w webview
        SqlResultsProvider.getInstance().showFlashMessage(
            `Skipped ${skippedSelectCount} SELECT ${skippedSelectCount === 1 ? 'query' : 'queries'}`,
            4
        );
    }
    
    success = true;
        
    return { rows, headers, meta, queryTime, success, errorMessage };
}

export async function getTableColumnsBatch(
    tables: TableRef[]
): Promise<TableColumn[]> {

    if (tables.length === 0) {
        return [];
    }
    
    const db = await ConnectionManager.getInstance().getDb();

    try {
        const placeholders =
            tables
                .map(
                    () => '(?, ?)'
                )
                .join(', ');

        const params =
            tables.flatMap(
                table => [
                    table.schema,
                    table.table
                ]
            );

        const sql = `
            SELECT
                TABLE_SCHEMA,
                TABLE_NAME,
                COLUMN_NAME,
                ORDINAL_POSITION,
                DATA_TYPE,
                IS_NULLABLE,
                COLUMN_DEFAULT,
                COLUMN_KEY,
                EXTRA,
                CHARACTER_MAXIMUM_LENGTH,
                NUMERIC_PRECISION,
                NUMERIC_SCALE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE (
                TABLE_SCHEMA,
                TABLE_NAME
            ) IN (
                ${placeholders}
            )
        `;

        const rows =
            await db.query(sql, params);

        return rows.map(
            (row: any) => ({
                schema: row.TABLE_SCHEMA,
                table: row.TABLE_NAME,
                name: row.COLUMN_NAME,
                order: row.ORDINAL_POSITION,
                type: row.DATA_TYPE,
                isNullable: row.IS_NULLABLE,
                defaultValue: row.COLUMN_DEFAULT,
                columnKey: row.COLUMN_KEY,
                extra: row.EXTRA,
                characterMaximumLength: row.CHARACTER_MAXIMUM_LENGTH,
                numericPrecision: row.NUMERIC_PRECISION,
                numericScale: row.NUMERIC_SCALE
            })
        );

    } catch (err) {
        const tableList =
            tables
                .map(
                    table =>
                        `${table.schema}.${table.table}`
                )
                .join(', ');
        console.error(
            `Error getting columns for tables: ${tableList}`,
            err
        );
        return [];
    }
}