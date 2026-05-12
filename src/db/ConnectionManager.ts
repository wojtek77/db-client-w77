import * as mariadb from 'mariadb';

export class ConnectionManager {

    private static instance: ConnectionManager;
    private constructor() {}
    private pool: mariadb.Pool | null = null;
    private conn: mariadb.PoolConnection | null = null;
    private connected = false;
    private connectionTime = '0';

    public static getInstance(): ConnectionManager {
        if (!this.instance) {
            this.instance =
                new ConnectionManager();
        }
        return this.instance;
    }

    public async connect(
        config: mariadb.PoolConfig
    ): Promise<string> {

        if (this.connected) {
            return this.connectionTime;
        }
        
        this.pool = mariadb.createPool(config);
        const startConn = performance.now();
        this.conn = await this.pool.getConnection();
        this.conn.on('error', err => {
            console.error('MariaDB connection error:', err);
        });
        const endConn = performance.now();
        this.connectionTime = (endConn - startConn).toFixed(2);
        console.log('Connection time:', this.connectionTime, 'ms');
        this.connected = true;
        
        return this.connectionTime;
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

    public async disconnect(): Promise<void> {

        try {
            if (this.conn) await this.conn.end();
        } catch (err) {
            console.error('Błąd conn.end():', err);
        } finally {
            this.conn = null;
            this.connected = false;
        }

        try {
            if (this.pool) await this.pool.end();
        } catch (err) {
            console.error('Błąd pool.end():', err);
        } finally {
            this.pool = null;
        }
    }
}
