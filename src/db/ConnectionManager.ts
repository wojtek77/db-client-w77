import * as vscode from 'vscode';
import { Connection } from './Connection.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { RecentSqlFiles } from '../recentFiles/RecentSqlFiles.js';

export class ConnectionManager {
    
    private static instance: ConnectionManager;
    
    private connections: Record<string, Connection> = {};
    private configs: Record<string, string> = {};
    private currentNameConnection = '';
    private configDir = '';
    private configDirMissing = false;
    
    
    public static getInstance(): ConnectionManager {
        if (!this.instance) {
            this.instance =
                new ConnectionManager();
        }
        return this.instance;
    }
    
    private constructor() {
        this.configs = this.loadConfigs();
    }

    public isConfigDirMissing(): boolean {
        return this.configDirMissing;
    }

    /** Prawda, jeśli nie ma ani jednego działającego pliku .cnf - niezależnie od tego,
     *  czy to dlatego, że katalog konfiguracji w ogóle nie istnieje, czy dlatego,
     *  że istnieje, ale jest pusty. */
    public hasNoConnections(): boolean {
        return Object.keys(this.configs).length === 0;
    }

    public getConfigDir(): string {
        return this.configDir;
    }

    /** Ponownie wczytuje pliki *.cnf z katalogu konfiguracji (np. po jego utworzeniu). */
    public reloadConfigs(): Record<string, string> {
        this.configs = this.loadConfigs();
        return this.configs;
    }

    /**
     * Zwraca połączenie do DB
     * @param connectionName  nazwa połączenia z DB, jeśli jest podana, nie będzie sprawdzana poprawność nazwy połączenia
     * @returns 
     */
    public async getDb(connectionName = '') {
        if (!connectionName) {
            connectionName = await RecentSqlFiles.getInstance().getConnectionName();
        }
        if (!this.connections[connectionName]) {
            const path = this.configs[connectionName];
            if (!path) {
                throw new Error(
                    this.configDirMissing
                        ? `No connection config directory found at "${this.configDir}". Run "DB client: Create Connection Config Directory" to get started.`
                        : `No connection configuration found for "${connectionName}". Add a .cnf file to "${this.configDir}" and run "DB client: Reload Connection Files".`
                );
            }
            const connection = await Connection.create(path);
            this.connections[connectionName] = connection;
        }
        this.currentNameConnection = connectionName;
        return this.connections[connectionName];
    }

    public async reconnect(connectionName: string): Promise<Connection> {
        // zamknij stare połączenie jeśli istnieje
        if (this.connections[connectionName]) {
            try {
                this.connections[connectionName].disconnect();
            } catch (err) {
                console.error('Error closing old connection:', err);
            }
            delete this.connections[connectionName];
        }

        const cnfPath = this.configs[connectionName];
        if (!cnfPath) {
            throw new Error(`No configuration for connection: "${connectionName}"`);
        }

        const connection = await Connection.create(cnfPath);
        this.connections[connectionName] = connection;
        return connection;
    }
    
    public start() {
        
    }
    
    public stop() {
        // usuwanie wszystkich połączeń z bazą
        Object.values(this.connections).forEach((conn) => {
            conn.disconnect();
        });
        this.connections = {};
        this.currentNameConnection = '';
    }
    
    public getConfigs() {
        return this.configs;
    }
    
    public getCurrentNameConnection() {
        return this.currentNameConnection;
    }
    
    private loadConfigs(): Record<string, string> {
        const configuredDir =
            vscode.workspace
                .getConfiguration('db-client')
                .get<string>('dbConfigsDir', '');

        const configDir = configuredDir
            ? configuredDir
            : path.join(os.homedir(), '.db_configs');
        
        const configs: Record<string, string> = {};

        this.configDir = configDir;

        if (!fs.existsSync(configDir)) {
            // nie rzucamy błędu: brak katalogu przy pierwszym uruchomieniu to normalny stan, obsługiwane przez friendly setup screen
            this.configDirMissing = true;
            return configs;
        }
        this.configDirMissing = false;

        const files = fs.readdirSync(configDir);
        files.forEach(file => {
            if (file.endsWith('.cnf')) {
                const name = path.basename(file, '.cnf');
                const fullPath = path.join(configDir, file);
                configs[name] = fullPath;
            }
        });
        
        const sortedKeys = Object.keys(configs).sort();
        const sortedConfigs: Record<string, string> = {};
        sortedKeys.forEach(key => {
            sortedConfigs[key] = configs[key];
        });
        return sortedConfigs;
    }
}
