import { ConnectionManager } from './ConnectionManager';
import { parseSelectQuery, setGetCachedColumnsFunction } from '../sql/sqlParser';
import { SqlUtil } from '../sql/SqlUtil';

// Eksportuj funkcję do ustawienia callbacku
export { setGetCachedColumnsFunction };

export async function executeQuery(sql: string) {
    const db = await ConnectionManager.getInstance().getDb();
    let rows: any[] = [];
    let queryTime = '0';
    let success = false;
    let errorMessage = '';
    let headers: string[] = [];
    
    try {
        // 1. Parsuj SQL, aby poznać kolumny
        const parsed = await parseSelectQuery(sql);
        
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
        } else {
            // Fallback: jeśli parser nie dał rady, użyj numerów kolumn
            if (rows.length > 0) {
                headers = rows[0].map((_: any, index: number) => `col_${index + 1}`);
                
            }
        }
        
        success = true;
    } catch (err: any) {
        console.error(err);
        errorMessage = err.message;
    }
    
    return { rows, headers, queryTime, success, errorMessage };
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
    const db = await ConnectionManager.getInstance().getDb();
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
        
        
    } catch (err: any) {
        console.error(`Błąd pobierania kolumn dla tabeli ${tableName}:`, err);
    }
    
    return columns;
}
