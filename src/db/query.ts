import { ConnectionManager } from './ConnectionManager';

export async function executeQuery(sql: string) {
    
    const db = ConnectionManager.getInstance();
    let rows: any[] = [];
    let queryTime = '0';
    let success = false;
    let errorMessage = '';
    try {
        console.log('=== STARTING QUERY ===');

        const conn = db.getConnection();
        const startQuery = performance.now();
        rows = await conn.query(sql);
        // to działa identycznie jak to co powyżej
        // rows = await conn.query({ sql, metaAsArray: false });
        const endQuery = performance.now();

        queryTime = (
            endQuery - startQuery
        ).toFixed(2);

        console.log(
            `=== QUERY TIME: ${queryTime}ms, ROWS: ${rows.length}`
        );
        success = true;
    } catch (err: any) {
        console.error(err);
        errorMessage = err.message;
    }

    return { rows, queryTime, success, errorMessage };
}
