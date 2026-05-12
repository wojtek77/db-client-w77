import * as fs from 'fs';
import * as ini from 'ini';
import * as os from 'os';

export class CnfLoader {

    public static async getOptionsFromCnf(filePath: string): Promise<any> {

        const absolutePath = filePath.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
        
        if (!fs.existsSync(absolutePath)) return null;
    
        const fileContent = fs.readFileSync(absolutePath, 'utf-8');
        const lines = fileContent.split(/\r?\n/);
    
        let rawConfig: any = { client: {}, mysql: {}, mariadb: {} };
    
        for (const line of lines) {
            const trimmed = line.trim();
    
            if (trimmed.startsWith('!include ')) {
                const includePath = trimmed.replace('!include ', '').trim();
    
                const includedRaw = await this.getRawSections(includePath);
    
                if (includedRaw) {
                    rawConfig.client = { ...rawConfig.client, ...includedRaw.client };
                    rawConfig.mysql = { ...rawConfig.mysql, ...includedRaw.mysql };
                    rawConfig.mariadb = { ...rawConfig.mariadb, ...includedRaw.mariadb };
                }
            }
        }
    
        const parsedIni = ini.parse(fileContent);
    
        const mergedClient = {
            ...rawConfig.mysql,
            ...rawConfig.mariadb,
            ...rawConfig.client,
            ...(parsedIni.mysql || {}),
            ...(parsedIni.mariadb || {}),
            ...(parsedIni.client || {})
        };
    
        const options: any = {};
    
        if (mergedClient.socket) options.socketPath = mergedClient.socket;
        if (mergedClient.host) options.host = mergedClient.host;
        if (mergedClient.user) options.user = mergedClient.user;
        if (mergedClient.password) options.password = mergedClient.password;
        if (mergedClient.database) options.database = mergedClient.database;
        if (mergedClient.port) options.port = parseInt(mergedClient.port);
    
        if (mergedClient.hasOwnProperty('skip-ssl')) {
            options.ssl = !(mergedClient['skip-ssl'] === true || mergedClient['skip-ssl'] === 'true');
        }
    
        if (mergedClient.hasOwnProperty('compress')) {
            options.compress = (mergedClient.compress === true || mergedClient.compress === 'true');
        }
    
        if (mergedClient.hasOwnProperty('reconnect')) {
            options.reconnect = (mergedClient.reconnect === true || mergedClient.reconnect === 'true');
        }
    
        return options;
    }

    private static async getRawSections(filePath: string): Promise<any> {

        const absolutePath = filePath.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
        
        if (!fs.existsSync(absolutePath)) {
            return null;
        }
    
        const parsed = ini.parse(
            fs.readFileSync(absolutePath, 'utf-8')
        );
    
        return {
            client: parsed.client || {},
            mysql: parsed.mysql || {},
            mariadb: parsed.mariadb || {}
        };
    }
}
