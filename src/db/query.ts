import * as vscode from 'vscode';
import { ConnectionManager } from './ConnectionManager.js';
import { Connection } from './Connection.js';
import { SqlUtil } from '../sql/SqlUtil.js';
import { findCurrentQuery } from '../sql/findCurrentQuery.js';
import { TableColumn, TableRef } from '../cache/TableColumnsCache.js';

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

        if (SqlUtil.isUpdateOrDelete(sql) && !SqlUtil.hasWhereClause(sql)) {
            const blockUnsafe = vscode.workspace
                .getConfiguration('db-client')
                .get<boolean>('blockUnsafeUpdateDelete', true);

            if (blockUnsafe) {
                return {
                    rows: [], headers: [], meta: undefined, queryTime: 0, success: false,
                    errorMessage: 'Blocked: UPDATE/DELETE without a WHERE clause affects the whole table. ' +
                        'Disable "db-client.blockUnsafeUpdateDelete" in settings to allow this.'
                };
            }
        }
        
        let startQuery = performance.now();
        
        const [queryData, queryMeta] = await db.query({ sql, rowsAsArray: true, metaAsArray: true });
        if (Array.isArray(queryData)) {
            // SELECT: queryData to wiersze, queryMeta to definicje kolumn
            rows = queryData;
            meta = queryMeta;
            headers = meta.map((field: any) => field.name());
        } else {
            // nie-SELECT (np. SET, INSERT, UPDATE, DELETE): queryData to OkPacket, więc budujemy własną tabelę wyniku
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
    let updatedRows = 0;
    
    const lines = fullText.split('\n');

    let executedSqlCount = 0;
    let executedSelectCount = 0;
    let containsDDL = false;

    let lineIndex = 0;
    
    let startQuery = performance.now();

    await db.startTransaction();
    while (lineIndex < lines.length) {
        // pomijamy puste linie
        if (lines[lineIndex].trim() === '') {
            lineIndex++;
            continue;
        }

        // używamy findCurrentQuery, żeby znaleźć zapytanie zaczynające się od tej linii
        const query = findCurrentQuery(fullText, lineIndex);
        if (!query) {
            lineIndex++;
            continue;
        }

        const sql = query.sql;

        if (SqlUtil.isDDL(sql)) {
            containsDDL = true;
        }

        if (SqlUtil.isSelect(sql)) {
            // wykonaj każdy SELECT z pliku – 'Run SQL Whole File' wykonuje wszystkie polecenia, pokazujemy wyniki ostatniego SELECT-a
            ({ rows, headers, meta, success, errorMessage } = await executeQuery(db, sql));
            if (!success) {
                break;
            }
            ++executedSqlCount;
            ++executedSelectCount;
        } else {
            // nie-SELECT: wykonaj przez połączenie z bazą danych
            let noSelectRows: any[][] = [];
            ({success, errorMessage, rows: noSelectRows} = await executeQuery(db, sql));
            if (!success) {
                break;
            }
            ++executedSqlCount;
            updatedRows += noSelectRows[0][1];
        }

        // przeskocz do linii po końcu znalezionego zapytania
        lineIndex = query.endLine + 1;
    }
    
    if (success) {
        await db.commit();
    } else {
        await db.rollback();
        headers = [];
        rows = [];
    }
    
    const endQuery = performance.now();
    queryTime = endQuery - startQuery;

    // wyświetl ogólną informację
    const infoMessage = `Updated Rows: ${updatedRows}, Executed ${executedSqlCount} ${executedSqlCount === 1 ? 'query' : 'queries'}` +
        (executedSelectCount > 1 ? ` (showing results of the last of ${executedSelectCount} SELECT queries)` : '');
    let flashMessage;
    if (containsDDL) {
        // DDL (CREATE/ALTER/DROP/TRUNCATE/RENAME) wykonuje niejawny COMMIT, więc transakcja na cały skrypt nie gwarantuje pełnego rollbacku przy błędzie
        flashMessage = 'This script contains DDL statements, which auto-commit and cannot be rolled back';
    }
    
    return { rows, headers, meta, queryTime, success, errorMessage, infoMessage, flashMessage };
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
                COLUMN_TYPE,
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
        
        if (rows && rows.length > 0) {
            console.log(`Executed SQL, completion data for: ` + JSON.stringify(params));
        } else {
            const err = `Executed SQL, completion data, NO ROWS SQL: ` + JSON.stringify(params);
            console.error(err);
        }

        return rows.map(
            (row: any) => ({
                schema: row.TABLE_SCHEMA,
                table: row.TABLE_NAME,
                name: row.COLUMN_NAME,
                order: row.ORDINAL_POSITION,
                type: row.DATA_TYPE,
                columnType: row.COLUMN_TYPE,
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