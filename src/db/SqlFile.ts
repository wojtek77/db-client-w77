import * as vscode from 'vscode';
import { ConnectionManager } from './ConnectionManager';

export class SqlFile {
    
    private static instance: SqlFile;
    private static readonly STORAGE_KEY = 'sqlFiles';
    
    private sqlFiles = new Map<string, string>(); // klucz *.sql, wartość nazwa połączenia
    private lastSqlFile: string = ''; // poprawa wydajności, jeśli SQL jest uruchamiany wiele razy z tego samego pliku, nie ma przesunięcia na koniec listy w "sqlFiles"
    private persistPromise: Promise<void> | null = null;
    
    
    public static getInstance(context?: vscode.ExtensionContext): SqlFile {
        if (!this.instance) {
            if (!context) {
                throw new Error('SqlFile not initialized');
            }
            this.instance = new SqlFile(context);
        }
        return this.instance;
    }
    
    private constructor(private context: vscode.ExtensionContext) {}
    
    public sqlFilesRestore(): void {
        const saved = this.context.workspaceState.get<[string, string][]>(
            SqlFile.STORAGE_KEY,
            []
        );
        this.sqlFiles = new Map(saved);
    }
    
    public async sqlFilesPersist(): Promise<void> {

        if (this.persistPromise) {
            return this.persistPromise;
        }

        this.persistPromise = (async () => {
            await this.context.workspaceState.update(
                SqlFile.STORAGE_KEY,
                Array.from(this.sqlFiles.entries())
            );
        })().finally((): void => {
            this.persistPromise = null;
        });

        return this.persistPromise;
    }
    
    public async getConnectionName(isOnlyUpdate = false) {
        // ścieżka do pliku SQL, który jest teraz otwarty w edytorze vscode
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error("żaden edytor nie jest teraz aktywny");
        }
        const sqlFile = editor.document.fileName;
        let connectionName = this.get(sqlFile);
        const configs = ConnectionManager.getInstance().getConfigs();
        
        // trzeba sprawdzić, czy "connectionName" jest aktualne
        if (connectionName && !configs[connectionName]) {
            this.delete(sqlFile);
            void this.sqlFilesPersist();
            vscode.window.showWarningMessage(`Delete "${connectionName}" from list of SQL files`);
            connectionName = undefined;
        }
        
        if (isOnlyUpdate || !connectionName) { // jest tylko UPDATE lub od nowa jest ustawiane "connectionName"
            const connectionNames = Object.keys(configs);
            connectionName = await vscode.window.showQuickPick(connectionNames, {
                placeHolder: 'select DB connection',
                ignoreFocusOut: true // Zapobiega zamknięciu menu przy kliknięciu obok
            });
            if (!connectionName) {
                // vscode.window.showErrorMessage('No DB connection selected');
                throw new Error("No DB connection selected");
            }
            this.set(sqlFile, connectionName);
            void this.sqlFilesPersist();
        } else {
            if (sqlFile !== this.lastSqlFile) { // trzeba przesunąć plik na koniec listy
                this.moveToEnd(sqlFile, connectionName);
            }
        }
        // aby poprawić wydajność i za każdym razem nie przesuwać pozycji na koniec listy
        this.lastSqlFile = sqlFile;
        
        return connectionName;
    }
    
    public async changeConnectionName() {
        return this.getConnectionName(true);
    }
    
    private get(sqlFile: string) {
        return this.sqlFiles.get(sqlFile);
    }
    
    private set(sqlFile: string, connectionName: string) {
        return this.sqlFiles.set(sqlFile, connectionName);
    }
    
    private delete(sqlFile: string) {
        return this.sqlFiles.delete(sqlFile);
    }
    
    private moveToEnd(sqlFile: string, connectionName: string) {
        this.delete(sqlFile);
        this.set(sqlFile, connectionName);
    }
}
