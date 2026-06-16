import * as mariadb from 'mariadb';
import path from 'path';
import { CnfLoader } from "./CnfLoader";

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
        config: mariadb.PoolConfig
    ): Promise<number> {
        this.connectionName = connectionName;
        
        if (this.connected) {
            return this.connectionTime;
        }
        
        console.log('config', config);
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
            this.database = config.database ?? '';
            this.schemaTables = await this.readTableNames(this.conn);
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
        if (!this.threadId || !this.cnfFile) {
            return;
        }

        const killConn = await Connection.create(this.cnfFile);
        try {
            await killConn.getConnection().query(
                `KILL QUERY ${this.threadId}`
            );
        } catch (err: any) {
            console.debug('Cancel query:', err.message);
        } finally {
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
    
    private async readTableNames(
        conn: mariadb.PoolConnection
    ): Promise<Map<string, string[]>> {

        const schemaTables = new Map<
            string,
            string[]
        >();

        try {

            /* 
                WHERE TABLE_TYPE = 'BASE TABLE' ozn. bez widoków
            */
            const rows = await conn.query(`
                SELECT
                    TABLE_SCHEMA,
                    TABLE_NAME
                FROM INFORMATION_SCHEMA.TABLES
            `);

            for (const row of rows) {

                const schema =
                    row.TABLE_SCHEMA;

                const table =
                    row.TABLE_NAME;

                let tables =
                    schemaTables.get(schema);

                if (!tables) {

                    tables = [];

                    schemaTables.set(
                        schema,
                        tables
                    );
                }

                tables.push(table);
            }

            const systemSchemas = new Set([
                'information_schema',
                'mysql',
                'performance_schema',
                'sys'
            ]);
            
            // console.log(
            //     'Schemas:',
            //     [...schemaTables.keys()]
            // );

            const sortedSchemas =
                [...schemaTables.keys()]
                    .sort((a, b) => {

                        const aSystem =
                            systemSchemas.has(a);

                        const bSystem =
                            systemSchemas.has(b);

                        if (
                            aSystem !== bSystem
                        ) {
                            return aSystem
                                ? 1
                                : -1;
                        }

                        return a.localeCompare(b);
                    });

            const sortedMap =
                new Map<string, string[]>();

            for (
                const schema of sortedSchemas
            ) {

                const tables =
                    schemaTables.get(schema)!;

                tables.sort(
                    (a, b) =>
                        a.localeCompare(b)
                );

                sortedMap.set(
                    schema,
                    tables
                );
            }
            
            // console.log(
            //     sortedMap
            // );

            return sortedMap;

        } catch (err) {

            console.error(
                'Unable to read table metadata',
                err
            );

            return new Map();
        }
    }
}
