import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager';
import * as path from 'path';

export class RecentSqlFiles {
    
    private static instance: RecentSqlFiles;
    private static readonly STORAGE_KEY = 'sqlFiles';
    
    private sqlFiles = new Map<string, string>(); // klucz *.sql, wartość nazwa połączenia
    private lastSqlFile: string = ''; // poprawa wydajności, jeśli SQL jest uruchamiany wiele razy z tego samego pliku, nie ma przesunięcia na koniec listy w "sqlFiles"
    private persistPromise: Promise<void> | null = null;
    
    
    public static getInstance(context?: vscode.ExtensionContext): RecentSqlFiles {
        if (!this.instance) {
            if (!context) {
                throw new Error('SqlFile not initialized');
            }
            this.instance = new RecentSqlFiles(context);
        }
        return this.instance;
    }
    
    private constructor(private context: vscode.ExtensionContext) {}
    
    public restore(): void {
        const saved = this.context.globalState.get<[string, string][]>(
            RecentSqlFiles.STORAGE_KEY,
            []
        );
        this.sqlFiles = new Map(saved);
    }
    
    public async persist(): Promise<void> {

        if (this.persistPromise) {
            return this.persistPromise;
        }

        this.persistPromise = (async () => {
            await this.context.globalState.update(
                RecentSqlFiles.STORAGE_KEY,
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
            void this.persist();
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
            void this.persist();
        } else {
            if (sqlFile !== this.lastSqlFile) { // trzeba przesunąć plik na koniec listy
                this.moveToEnd(sqlFile, connectionName);
            }
        }
        // aby poprawić wydajność i za każdym razem nie przesuwać pozycji na koniec listy
        this.lastSqlFile = sqlFile;
        
        return connectionName;
    }
    
    // zwraca kopię sqlFiles
    private getSqlFiles() {
        return new Map(this.sqlFiles);
    }
    
    public async openRecentFiles() {
    
        const sqlFiles = RecentSqlFiles.getInstance().getSqlFiles();
        
        // zbierz ścieżki wszystkich otwartych dokumentów w edytorze
        const openFilePaths = new Set<string>();
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                // Sprawdzamy, czy karta to plik tekstowy
                if (tab.input instanceof vscode.TabInputText) {
                    const filePath = tab.input.uri.fsPath;
                    
                    // Warunek: interesują nas tylko pliki z rozszerzeniem .sql
                    if (filePath.toLowerCase().endsWith('.sql')) {
                        openFilePaths.add(filePath);
                    }
                }
            }
        }
        
        // usuń z kopii listy otwarte pliki SQL
        for (const filePath of openFilePaths) {
            sqlFiles.delete(filePath);
        }
        
        // 2. Mapowanie na elementy QuickPickItem w odwróconej kolejności (od końca)
        // Zamieniamy wpisy mapy na tablicę i odwracamy ją za pomocą .reverse()
        const quickPickItems = Array.from(sqlFiles.entries())
            .reverse() 
            .map(([filePath, connectionName], index) => {
                // Pobieramy samą nazwę pliku (np. "query.sql")
                const fileName = path.basename(filePath);
                
                const orderNumber = index + 1; 
                
                return {
                    // label: `${orderNumber}. ${fileName} (${connectionName})`, // To co widzi użytkownik
                    label: `${fileName}`, // To co widzi użytkownik
                    description: `(${connectionName}) ${orderNumber}.`,                     // Opcjonalnie: podgląd pełnej ścieżki na dole
                    value: filePath                      // Ukryta wartość, którą chcemy wyciągnąć
                };
            });

        // 3. Wyświetlenie menu użytkownikowi
        const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: 'select SQL file',
            ignoreFocusOut: true
        });
        
        // 4. OTWARCIE PLIKU W EDYTORZE
        if (selectedItem) {
            const sqlFile = selectedItem.value;
            // const connectionName = sqlFiles.get(sqlFile);
            
            try {
                // Zamiana ścieżki tekstowej na obiekt Uri wymagany przez VS Code
                const fileUri = vscode.Uri.file(sqlFile);
                
                await vscode.window.showTextDocument(fileUri, {
                    preview: false,       // pełne otwarcie, nie preview
                    preserveFocus: false  // opcjonalnie: od razu aktywuje edytor
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Nie można otworzyć pliku: ${error instanceof Error ? error.message : error}`);
            }
        }
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
