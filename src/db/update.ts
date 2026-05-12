import { ConnectionManager } from './ConnectionManager';

export async function executeUpdate(id: any, column: string, value: any) {
    
    let updateTime = '0';
    let success = false;
    let errorMessage = '';
    
    try {
        const db = ConnectionManager.getInstance();
        const conn = db.getConnection();
        const startUpdate = performance.now();
        await conn.execute(
            `UPDATE student SET \`${column}\` = ? WHERE id = ?`,
            [value, id]
        );
        updateTime = (
            performance.now() - startUpdate
        ).toFixed(2);
        success = true;

    } catch (err: any) {
        errorMessage = err.message;
    }
    
    return { updateTime, success, errorMessage };
}
