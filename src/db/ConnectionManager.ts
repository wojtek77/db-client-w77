import { Connection } from './Connection';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SqlFile } from './SqlFile';

export class ConnectionManager {
    
    private static instance: ConnectionManager;
    
    private connections: Record<string, Connection> = {};
    private configs: Record<string, string> = {};
    
    
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

    public async getDb() {
        const connectionName = await SqlFile.getInstance().getConnectionName();
        if (!this.connections[connectionName]) {
            const path = this.configs[connectionName];
            const connection = await Connection.create(path);
            this.connections[connectionName] = connection;
        }
        return this.connections[connectionName];
    }
    
    public start() {
        
    }
    
    public stop() {
        // usuwanie wszystkich połączeń z bazą
        Object.values(this.connections).forEach(async (conn) => {
            await conn.disconnect();
        });
        this.connections = {};
    }
    
    public getConfigs() {
        return this.configs;
    }
    
    private loadConfigs(): Record<string, string> {
        const configDir = path.join(os.homedir(), '.db_configs');
        const configs: Record<string, string> = {};

        if (!fs.existsSync(configDir)) {
            throw new Error(`brak katalogu z plikami *.cnf "${configDir}"`);
        }

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
