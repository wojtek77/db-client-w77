import * as vscode from 'vscode';
import { ConnectionManager } from './ConnectionManager';

export class SqlFile {
    
    private static instance: SqlFile;
    
    private sqlFiles: Map<string, string> = new Map(); // klucz *.sql, wartość nazwa połączenia
    private lastSqlFile: string = ''; // poprawa wydajności, jeśli SQL jest uruchamiany wiele razy z tego samego pliku, nie ma przesunięcia na koniec listy w "sqlFiles"
    
    
    public static getInstance(): SqlFile {
        if (!this.instance) {
            this.instance =
                new SqlFile();
        }
        return this.instance;
    }
    
    private constructor() {}
    
    public async getConnectionName() {
        // ścieżka do pliku SQL, który jest teraz otwarty w edytorze vscode
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error("żaden edytor nie jest teraz aktywny");
        }
        const sqlFile = editor.document.fileName;
        let connectionName = this.get(sqlFile);
        if (connectionName) {
            if (sqlFile !== this.lastSqlFile) { // trzeba przesunąć plik na koniec listy
                this.moveToEnd(sqlFile, connectionName);
            }
        } else {
            const connectionNames = ConnectionManager.getInstance().getConnectionNames();
            connectionName = await vscode.window.showQuickPick(connectionNames, {
                placeHolder: 'select DB connection',
                ignoreFocusOut: true // Zapobiega zamknięciu menu przy kliknięciu obok
            });
            if (!connectionName) {
                // vscode.window.showErrorMessage('No DB connection selected');
                throw new Error("No DB connection selected");
            }
            this.set(sqlFile, connectionName);
        }
        // aby poprawić wydajność i za każdym razem nie przesuwać pozycji na koniec listy
        this.lastSqlFile = sqlFile;
        
        return connectionName;
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
