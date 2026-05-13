import { ConnectionManager } from './ConnectionManager';
import { parseSelectQuery, setGetCachedColumnsFunction } from './SqlParser';
import { SqlUtil } from './SqlUtil';

// Eksportuj funkcję do ustawienia callbacku
export { setGetCachedColumnsFunction };

export async function executeQuery(sql: string) {
    const db = ConnectionManager.getInstance();
    let rows: any[] = [];
    let queryTime = '0';
    let success = false;
    let errorMessage = '';
    let headers: string[] = [];
    
    try {
        console.log('=== STARTING QUERY ===');
        console.log('SQL:', sql);
        
        // 1. Parsuj SQL, aby poznać kolumny
        const parsed = await parseSelectQuery(sql);
        console.log('Parsed columns:', parsed.columns);
        console.log('Parsed tables:', parsed.tables);
        
        sql = SqlUtil.appendLimit(sql);
        
        // 2. Wykonaj zapytanie (rowsAsArray = true)
        const conn = db.getConnection();
        const startQuery = performance.now();
        rows = await conn.query({ sql, rowsAsArray: true });
        const endQuery = performance.now();
        
        queryTime = (endQuery - startQuery).toFixed(2);
        
        // 3. Ustal nagłówki (z parsera lub z cache)
        if (parsed.columns.length > 0) {
            headers = parsed.columns;
            console.log('Headers from parser:', headers);
        } else {
            // Fallback: jeśli parser nie dał rady, użyj numerów kolumn
            console.log('No headers from parser, using fallback');
            if (rows.length > 0) {
                headers = rows[0].map((_: any, index: number) => `col_${index + 1}`);
                console.log('Fallback headers:', headers);
            }
        }
        
        console.log(`=== QUERY TIME: ${queryTime}ms, ROWS: ${rows.length}, HEADERS: ${headers.join(', ')}`);
        success = true;
    } catch (err: any) {
        console.error(err);
        errorMessage = err.message;
    }
    
    return { rows, headers, queryTime, success, errorMessage };
}

export async function getTableNames(database?: string): Promise<string[]> {
    const db = ConnectionManager.getInstance();
    let tables: string[] = [];
    
    try {
        const conn = db.getConnection();
        
        // SQL dla MariaDB/MySQL - pobiera nazwy tabel z aktywnej bazy
        let sql = `
            SELECT TABLE_NAME 
            FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = DATABASE()
            ORDER BY TABLE_NAME
        `;
        
        // Jeśli podano konkretną bazę danych
        if (database) {
            sql = `
                SELECT TABLE_NAME 
                FROM INFORMATION_SCHEMA.TABLES 
                WHERE TABLE_SCHEMA = '${database}'
                ORDER BY TABLE_NAME
            `;
        }
        
        const rows = await conn.query(sql);
        tables = rows.map((row: any) => row.TABLE_NAME);
        
        console.log(`Pobrano ${tables.length} tabel:`, tables);
    } catch (err: any) {
        console.error('Błąd pobierania tabel:', err);
    }
    
    return tables;
}

export async function getTableColumns(tableName: string): Promise<{ 
    name: string, 
    order: number,
    type: string,
    isNullable: string,
    defaultValue: any,
    columnKey: string,
    extra: string,
    characterMaximumLength: number | null,  // dla VARCHAR, CHAR
    numericPrecision: number | null,        // dla INT, DECIMAL
    numericScale: number | null             // dla DECIMAL (liczba miejsc po przecinku)
}[]> {
    const db = ConnectionManager.getInstance();
    let columns: any[] = [];
    
    try {
        const conn = db.getConnection();
        
        const sql = `
            SELECT 
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
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = '${tableName}'
            ORDER BY ORDINAL_POSITION
        `;
        
        const rows = await conn.query(sql);
        columns = rows.map((row: any) => ({
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
        }));
        
        console.log(`Pobrano ${columns.length} kolumn dla tabeli ${tableName}`);
    } catch (err: any) {
        console.error(`Błąd pobierania kolumn dla tabeli ${tableName}:`, err);
    }
    
    return columns;
}
