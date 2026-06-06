import * as mariadb from 'mariadb';
import path from 'path';
import { CnfLoader } from "./CnfLoader";

export class Connection {
    private pool: mariadb.Pool | null = null;
    private conn: mariadb.PoolConnection | null = null;
    private connected = false;
    private connectionName = '';
    private connectionTime = 0;
    private tableNames: string[] = [];
    private threadId: number | null = null;
    
    public static async create(cnfFile: string): Promise<Connection> {
        const db = new this();
        const connectionName = path.basename(cnfFile, '.cnf');
        const cnfOptions = await CnfLoader.getOptionsFromCnf(cnfFile);
        await db.connect(connectionName, cnfOptions);
        return db;
    }
    
    private constructor() {}
    
    public async connect(
        connectionName: string,
        config: mariadb.PoolConfig
    ): Promise<number> {
        this.connectionName = connectionName;
        
        if (this.connected) {
            return this.connectionTime;
        }
        
        this.pool = mariadb.createPool({
            ...config,
            connectionLimit: 2,
            connectTimeout: 10000,
            acquireTimeout: 10000,
            supportBigNumbers: true,
            bigNumberStrings: false,
            insertIdAsNumber: true,
            bigIntAsNumber: true,
            dateStrings: true
        });
        const startConn = performance.now();
        this.conn = await this.pool.getConnection();
        this.threadId = this.conn.threadId;
        this.conn.on('error', err => {
            console.error('MariaDB connection error:', err);
        });
        const endConn = performance.now();
        this.connectionTime = endConn - startConn;
        
        this.connected = true;
        
        // Po połączeniu, pobierz nazwy tabel
        try {
            const databaseName = config.database || '';
            this.tableNames = await this.readTableNames(this.conn, databaseName);
        } catch (err) {
            console.error('Nie udało się pobrać tabel:', err);
        }
        
        return this.connectionTime;
    }
    
    public getConnectionName(): string {

        return this.connectionName;
    }
    
    public getConnectionTime(): number {

        return this.connectionTime;
    }
    
    public getThreadId(): number | null {
        return this.threadId;
    }
    
    public async cancelCurrentQuery(): Promise<void> {
        if (!this.pool || !this.threadId) {
            return;
        }

        const killConn = await this.pool.getConnection();

        try {
            await killConn.query(
                `KILL QUERY ${this.threadId}`
            );
        } finally {
            await killConn.end();
        }
    }
    
    public getTableNames(): string[] {

        return this.tableNames;
    }

    public getConnection() {
        if (!this.conn) {
            throw new Error(
                'Database is not connected'
            );
        }
        return this.conn;
    }

    public isConnected(): boolean {

        return this.connected;
    }

    public disconnect() {

        try {
            if (this.conn) this.conn.end();
        } catch (err) {
            console.error('Błąd conn.end():', err);
        } finally {
            this.conn = null;
            this.connected = false;
        }

        try {
            if (this.pool) this.pool.end();
        } catch (err) {
            console.error('Błąd pool.end():', err);
        } finally {
            this.pool = null;
        }
    }
    
    private async readTableNames(conn: mariadb.PoolConnection, database?: string): Promise<string[]> {
        let tables: string[] = [];
        
        try {
            let sql;
            if (database) {
                // Jeśli podano konkretną bazę danych
                sql = `
                    SELECT TABLE_NAME 
                    FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_SCHEMA = '${database}'
                    ORDER BY TABLE_NAME
                `;
            } else {
                // SQL dla MariaDB/MySQL - pobiera nazwy tabel z aktywnej bazy
                sql = `
                    SELECT TABLE_NAME 
                    FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_SCHEMA = DATABASE()
                    ORDER BY TABLE_NAME
                `
            }
            
            const rows = await conn.query(sql);
            tables = rows.map((row: any) => row.TABLE_NAME);
            
        } catch (err: any) {
            console.error('Błąd pobierania tabel:', err);
        }
        
        return tables;
    }
}
