import * as mariadb from 'mariadb';
import path from 'path';
import { CnfLoader } from "./CnfLoader.js";
import * as vscode from 'vscode';

type PoolConfig = Parameters<typeof mariadb.createPool>[0];

export class Connection {
    private pool: mariadb.Pool | null = null;
    private conn: mariadb.PoolConnection | null = null;
    private connected = false;
    private connectionName = '';
    private connectionTime = 0;
    private database = '';
    private schemaTables = new Map<string, string[]>();
    private threadId: number | null = null;
    private cnfFile = '';
    // Przechowujemy konfigurację, aby móc wykonać reconnect bez podawania parametrów na nowo
    private cachedConfig: PoolConfig | null = null;
    private cancelled = false; // kill query
    private isTransactionActive = false;
    
    public static async create(cnfFile: string): Promise<Connection> {
        const db = new this();
        db.cnfFile = cnfFile;
        const connectionName = path.basename(cnfFile, '.cnf');
        const cnfOptions = await CnfLoader.getOptionsFromCnf(cnfFile);
        await db.connect(connectionName, cnfOptions);
        return db;
    }
    
    private constructor() {}
    
    public async connect(
        connectionName: string,
        config: PoolConfig
    ): Promise<number> {
        this.connectionName = connectionName;
        this.cachedConfig = config; // Zapisujemy konfigurację do cache
        
        // Jeśli już jesteśmy połączeni, a połączenie jest aktywne, zwracamy dotychczasowy czas
        if (this.connected && this.conn) {
            return this.connectionTime;
        }

        // Zabezpieczenie: jeśli istniały stare, wiszące zasoby, sprzątamy je przed re-connectem
        this.cleanupResources();
        
        this.pool = mariadb.createPool({
            ...config,
            connectionLimit: 1,
            connectTimeout: 10000,
            socketTimeout: 0,
            acquireTimeout: 10000,
            supportBigNumbers: true,
            bigNumberStrings: false,
            insertIdAsNumber: true,
            bigIntAsNumber: true,
            dateStrings: true
        });

        const startConn = performance.now();
        try {
            this.conn = await this.pool.getConnection();
            this.threadId = this.conn.threadId;
            
            this.conn.on('error', err => {
                console.error('MariaDB connection error:', err);
                // W przypadku krytycznego błędu połączenia (np. zerwanie linku), 
                // oznaczamy obiekt jako rozłączony, co pozwoli na ponowny connect
                this.connected = false;
                this.threadId = null;
                this.cancelled = false;
                this.isTransactionActive = false;
            });

            const endConn = performance.now();
            this.connectionTime = endConn - startConn;
            this.connected = true;
            
            // Po połączeniu, pobierz nazwy tabel
            try {
                this.database = config.database ?? '';
                this.schemaTables = await this.readTableNames(this.conn);
            } catch (err) {
                console.error('Nie udało się pobrać tabel:', err);
            }
            
            return this.connectionTime;
        } catch (err) {
            this.connected = false;
            this.cleanupResources();
            throw err; // Przekazujemy błąd wyżej, żeby aplikacja wiedziała, że nie udało się połączyć
        }
    }

    /**
     * Metoda wymuszająca ponowne połączenie z użyciem zachowanej konfiguracji
     */
    public async reconnect(): Promise<number> {
        if (!this.cachedConfig || !this.connectionName) {
            throw new Error('Brak wcześniejszej konfiguracji do wykonania reconnect.');
        }
        // Resetujemy flagę, aby connect nie zakończył się przedwcześnie
        this.connected = false; 
        return await this.connect(this.connectionName, this.cachedConfig);
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
    
    public async query(params: string | any, values?: any[]): Promise<any> {
        try {
            const conn = this.getConnection();
            return await conn.query(params, values);
        } catch (err: any) {
            // Dodano bezpieczne sprawdzanie err.message?.includes
            const isClosed = 
                err.code === 'ER_CMD_CONNECTION_CLOSED' || 
                err.code === 'ECONNRESET' ||
                err.code === 'PROTOCOL_CONNECTION_LOST' ||
                err.message === 'Database is not connected';

            if (isClosed && !this.cancelled) {
                // Reconnect z Rozwiązania 3 automatycznie wyczyści stare zasoby
                await this.reconnect();
                
                const conn = this.getConnection();
                const connectionName = this.getConnectionName();
                
                // Informacja dla użytkownika w VS Code
                vscode.window.showInformationMessage(
                    `🔄 Reconnect DB "${connectionName}".`
                );
                
                return await conn.query(params, values);
            }
            throw err;
        }
    }
    
    public async cancelCurrentQuery(): Promise<void> {
        if (!this.threadId || !this.cnfFile) {
            return;
        }

        const killConn = await Connection.create(this.cnfFile);
        try {
            this.cancelled = true;
            await killConn.getConnection().query(
                `KILL QUERY ${this.threadId}`
            );
        } catch (err: any) {
            console.debug('Cancel query:', err.message);
        } finally {
            this.cancelled = false;
            killConn.disconnect();
        }
    }
    
    public getSchemas(): string[] {
        return [
            ...this.schemaTables.keys()
        ];
    }
    
    public getTableNames(): Map<string, string[]> {
        return this.schemaTables;
    }
    
    public getTables(schema: string): string[] {
        return (
            this.schemaTables.get(schema)
            ?? []
        );
    }
    
    public getDefaultDatabaseTables(): string[] {
        if (!this.database) {
            return [];
        }
        return (
            this.schemaTables.get(
                this.database
            ) ?? []
        );
    }
    
    public findSchemaByTable(
        tableName: string
    ): string | null {
        for (
            const [schema, tables]
            of this.schemaTables
        ) {
            if (
                tables.includes(tableName)
            ) {
                return schema;
            }
        }
        return null;
    }

    public getDatabase(): string {
        return this.database;
    }
    
    public async startTransaction() {
        await this.query('START TRANSACTION');
        this.isTransactionActive = true;
    }
    
    public async commit() {
        if (this.isTransactionActive) {
            await this.query('COMMIT');
            this.isTransactionActive = false;
        }
    }
    
    public async rollback() {
        if (this.isTransactionActive) {
            await this.query('ROLLBACK');
            this.isTransactionActive = false;
        }
    }

    private getConnection() {
        if (!this.connected || !this.conn) {
            throw new Error(
                'Database is not connected'
            );
        }
        return this.conn;
    }

    public isConnected(): boolean {
        return this.connected;
    }

    /**
     * Wewnętrzna metoda pomocnicza czyszcząca referencje bez mutowania flagi `connected`
     */
    private cleanupResources() {
        try {
            if (this.conn) this.conn.end();
        } catch (err) {
            console.error('Błąd conn.end():', err);
        } finally {
            this.conn = null;
        }

        try {
            if (this.pool) this.pool.end();
        } catch (err) {
            console.error('Błąd pool.end():', err);
        } finally {
            this.pool = null;
        }
        this.threadId = null;
    }

    public disconnect() {
        this.cleanupResources();
        this.connected = false;
    }
    
    private async readTableNames(
        conn: mariadb.PoolConnection
    ): Promise<Map<string, string[]>> {
        const schemaTables = new Map<string, string[]>();

        try {
            const rows = await conn.query(`
                SELECT
                    TABLE_SCHEMA,
                    TABLE_NAME
                FROM INFORMATION_SCHEMA.TABLES
            `);

            for (const row of rows) {
                const schema = row.TABLE_SCHEMA;
                const table = row.TABLE_NAME;
                let tables = schemaTables.get(schema);

                if (!tables) {
                    tables = [];
                    schemaTables.set(schema, tables);
                }
                tables.push(table);
            }

            const systemSchemas = new Set([
                'information_schema',
                'mysql',
                'performance_schema',
                'sys'
            ]);

            const sortedSchemas = [...schemaTables.keys()]
                .sort((a, b) => {
                    const aSystem = systemSchemas.has(a);
                    const bSystem = systemSchemas.has(b);

                    if (aSystem !== bSystem) {
                        return aSystem ? 1 : -1;
                    }
                    return a.localeCompare(b);
                });

            const sortedMap = new Map<string, string[]>();

            for (const schema of sortedSchemas) {
                const tables = schemaTables.get(schema)!;
                tables.sort((a, b) => a.localeCompare(b));
                sortedMap.set(schema, tables);
            }

            return sortedMap;
        } catch (err) {
            console.error('Unable to read table metadata', err);
            return new Map();
        }
    }
}
