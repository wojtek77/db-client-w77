import { ConnectionManager } from './ConnectionManager.js';
import { Connection } from './Connection.js';
import { SqlUtil } from '../sql/SqlUtil.js';
import { TableColumn, TableRef } from '../cache/tableColumnsCache.js';
import * as vscode from 'vscode';

const CONNECTION_CLOSED_ERRORS = [
    'connection closed',
    'socket hang up',
    'connection lost',
    'connection end',
    'cannot execute new commands',
];

function isConnectionClosedError(message: string): boolean {
    const lower = message.toLowerCase();
    return CONNECTION_CLOSED_ERRORS.some(e => lower.includes(e));
}

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
        let conn = db.getConnection();
        
        let startQuery = performance.now();
        
        try {
            [rows, meta] = await conn.query({ sql, rowsAsArray: true, metaAsArray: true });
        } catch (err: any) {
            // Jeśli połączenie zostało zerwane (np. restart MariaDB) — spróbuj reconnect
            if (err.message && isConnectionClosedError(err.message)) {
                const manager = ConnectionManager.getInstance();
                const connectionName = db.getConnectionName();

                const reconnected = await manager.reconnect(connectionName);
                conn = reconnected.getConnection();

                vscode.window.showInformationMessage(
                    `🔄 Reconnect DB "${connectionName}".`
                );

                startQuery = performance.now();
                [rows, meta] = await conn.query({ sql, rowsAsArray: true, metaAsArray: true });
            } else {
                throw err;
            }
        }

        headers = meta.map((field: any) => field.name());
        
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

export async function getTableColumnsBatch(
    tables: TableRef[]
): Promise<TableColumn[]> {

    if (tables.length === 0) {
        return [];
    }
    
    const db = await ConnectionManager.getInstance().getDb();

    try {
        const conn = db.getConnection();

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
            await conn.query(sql, params);

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
