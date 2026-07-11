import * as mariadb from 'mariadb';
import path from 'path';
import { CnfLoader } from "./CnfLoader.js";
import * as vscode from 'vscode';
import { SqlUtil } from '../sql/SqlUtil.js';

type PoolConfig = Exclude<Parameters<typeof mariadb.createPool>[0], string>;

export class Connection {
    private pool: mariadb.Pool | null = null;
    private conn: mariadb.PoolConnection | null = null;
    private connected = false;
    private connectionName = '';
    private connectionTime = 0;
    private database = '';
    private host = '';
    private isProduction = false;
    private isReadOnly = false;
    private schemaTables = new Map<string, string[]>();
    private schemaTablesLoaded: Promise<void> = Promise.resolve();
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

        // "production" i "readonly" to niestandardowe opcje rozpoznawane tylko przez to
        // rozszerzenie (ustawiane w pliku .cnf) - trzeba je wyciąć z configu, żeby nie
        // trafiły do mariadb.createPool() jako nierozpoznana opcja.
        const { production, readonly, ...poolConfig } = config as any;
        this.isProduction = production === true;
        this.isReadOnly = readonly === true;
        this.host = (config as any).host ?? '';
        
        this.pool = mariadb.createPool({
            ...poolConfig,
            connectionLimit: 1,
            connectTimeout: 10000,
            socketTimeout: 0,
            acquireTimeout: 10000,
            supportBigNumbers: true,
            bigNumberStrings: false,
            insertIdAsNumber: true,
            bigIntAsNumber: true,
            dateStrings: true,
            foundRows: false,
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
            
            // Po połączeniu, pobierz nazwy tabel. Robimy to W TLE (bez await) - na dużych
            // serwerach ze wieloma schematami SELECT z INFORMATION_SCHEMA.TABLES może być
            // wolny, a nie ma powodu, żeby to blokowało samo połączenie z bazą (np. zanim
            // użytkownik zdąży cokolwiek zapytać, autocomplete i tak nie jest jeszcze potrzebny).
            this.database = config.database ?? '';
            this.schemaTablesLoaded = this.readTableNames(this.conn)
                .then((schemaTables) => { this.schemaTables = schemaTables; })
                .catch((err) => {
                    console.error('Failed to fetch tables after start connection:', err);
                });
            
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
            throw new Error('No previous configuration available to perform reconnect.');
        }
        // Resetujemy flagę, aby connect nie zakończył się przedwcześnie
        this.connected = false; 
        return await this.connect(this.connectionName, this.cachedConfig);
    }
    
    public getConnectionName(): string {
        return this.connectionName;
    }

    public getHost(): string {
        return this.host;
    }

    public isProductionConnection(): boolean {
        return this.isProduction;
    }

    public isReadOnlyConnection(): boolean {
        return this.isReadOnly;
    }
    
    public getConnectionTime(): number {
        return this.connectionTime;
    }
    
    public getThreadId(): number | null {
        return this.threadId;
    }
    
    public async query(params: string | any, values?: any[]): Promise<any> {
        const sqlText = typeof params === 'string' ? params : params?.sql;
        if (this.isReadOnly && typeof sqlText === 'string' && SqlUtil.isWriteStatement(sqlText)) {
            throw new Error(
                `Connection "${this.connectionName}" is marked as read-only in its .cnf file; write queries are blocked.`
            );
        }

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

    /**
     * Pozwala poczekać, aż lista tabel/schematów (pobierana w tle po connect(),
     * żeby nie blokować samego połączenia) zostanie faktycznie załadowana.
     * Przydatne np. dla completion providera, który potrzebuje pełnej listy.
     */
    public async waitForSchemaTables(): Promise<void> {
        await this.schemaTablesLoaded;
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
            if (this.conn) {this.conn.end();}
        } catch (err) {
            console.error('Error in conn.end():', err);
        } finally {
            this.conn = null;
        }

        try {
            if (this.pool) {this.pool.end();}
        } catch (err) {
            console.error('Error in pool.end():', err);
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
