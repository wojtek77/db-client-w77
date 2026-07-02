import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager.js';
import * as path from 'path';
import * as fs from 'fs';

export class RecentSqlFiles {
    
    private static instance: RecentSqlFiles;
    private static readonly FILE_NAME = 'recent_sql_files.json';
    
    private sqlFiles = new Map<string, string>(); // klucz *.sql, wartość nazwa połączenia
    private lastSqlFile: string = ''; // poprawa wydajności, jeśli SQL jest uruchamiany wiele razy z tego samego pliku, nie ma przesunięcia na koniec listy w "sqlFiles"
    
    
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
    
    /**
     * Zwraca pełną ścieżkę do pliku zapisu w folderze rozszerzenia
     */
    private getStorageFilePath(): string {
        return path.join(this.context.globalStorageUri.fsPath, RecentSqlFiles.FILE_NAME);
    }
    
    /**
     * Odtwarza dane synchronicznie z pliku na dysku
     */
    public restore(): void {
        try {
            const filePath = this.getStorageFilePath();
            if (fs.existsSync(filePath)) {
                const rawData = fs.readFileSync(filePath, 'utf-8');
                const saved = JSON.parse(rawData) as [string, string][];
                this.sqlFiles = new Map(saved);
                console.log('RecentSqlFiles: Przywrócono stan z dysku');
            } else {
                this.sqlFiles = new Map();
            }
        } catch (err) {
            console.error('RecentSqlFiles: Błąd podczas odtwarzania stanu:', err);
            this.sqlFiles = new Map();
        }
    }
    
    /**
     * Gwarantowany, synchroniczny zapis danych na dysku podczas zamykania
     */
    public persist(): void {
        console.log('RecentSqlFiles: Rozpoczęto synchroniczne dispose');
        try {
            const storagePath = this.context.globalStorageUri.fsPath;
            
            // Upewniamy się, że katalog globalStorageUri istnieje
            if (!fs.existsSync(storagePath)) {
                fs.mkdirSync(storagePath, { recursive: true });
            }

            const filePath = this.getStorageFilePath();
            const dataToSave = JSON.stringify(Array.from(this.sqlFiles.entries()));

            // Blokujący zapis synchroniczny - VS Code nie ubije procesu przed zakończeniem zapisu
            fs.writeFileSync(filePath, dataToSave, 'utf-8');
            console.log('RecentSqlFiles: Zapisano pomyślnie na dysku');
        } catch (err) {
            console.error('RecentSqlFiles: Krytyczny błąd zapisu w dispose:', err);
        }
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
        
        // kiedy wywołanie jest z ConnectionManager (nie jest to zmiana połączenia)
        // i nie jest ustawione połączenie z DB dla pliku
        // wtedy zostanie ustawione ostatnio używane połączenie DB
        // jest to analogiczne działanie do tego co jest w DBeaver
        if (!isOnlyUpdate && !connectionName) {
            connectionName = ConnectionManager.getInstance().getCurrentNameConnection();
        }
        
        if (isOnlyUpdate || !connectionName) { // jest tylko UPDATE lub od nowa jest ustawiane "connectionName"
            if (!connectionName && !isOnlyUpdate) { // wywołanie jest tylko od ConnectionManager, nie ma tu zmiany połączenia
                const answer = await vscode.window.showInformationMessage(
                    "There is no active DB connection for this file. Would you like to select a connection?",
                    "Yes", "Cancel"
                );
                if (answer !== "Yes") {
                    throw new Error("No DB connection selected");
                }
            }
            
            const defaultConnectionName = ConnectionManager.getInstance().getCurrentNameConnection();
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = Object.keys(configs).map(name => ({
                label: name,
                description: name === defaultConnectionName ? '$(star-full) (active connection)' : undefined
            }));
            quickPick.placeholder = 'select DB connection';
            quickPick.ignoreFocusOut = true;
            quickPick.activeItems = quickPick.items.filter(item => item.label === defaultConnectionName);
            connectionName = await new Promise(res => {
                quickPick.onDidAccept(() => { res(quickPick.selectedItems[0]?.label); quickPick.hide(); });
                quickPick.onDidHide(() => { res(undefined); quickPick.dispose(); });
                quickPick.show();
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
    
        // funkcja pomocnicza (lokalna) budująca elementy QuickPick na podstawie aktualnego stanu sqlFiles
        const buildQuickPickItems = () => {
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

            // Mapowanie na elementy QuickPickItem w odwróconej kolejności (od końca)
            // Zamieniamy wpisy mapy na tablicę i odwracamy ją za pomocą .reverse()
            return Array.from(sqlFiles.entries())
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
        };

        // przycisk (ikona kosza w prawym górnym rogu QuickPick) do przycinania listy
        const trimButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: 'Trim list (keep only N most recent files)'
        };

        const quickPick = vscode.window.createQuickPick<{ label: string; description: string; value: string }>();
        quickPick.items = buildQuickPickItems();
        quickPick.placeholder = 'select SQL file';
        quickPick.ignoreFocusOut = true;
        quickPick.buttons = [trimButton];

        // obsługa kliknięcia przycisku przycinania listy
        quickPick.onDidTriggerButton(async (button) => {
            if (button !== trimButton) {
                return;
            }

            // pole input z domyślną wartością 0 (0 = wyczyść całą listę)
            const input = await vscode.window.showInputBox({
                title: 'Trim recent SQL files list',
                prompt: 'Enter the number of most recent files to keep (0 = clear the whole list)',
                value: '0',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    const num = Number(value);
                    if (!Number.isInteger(num) || num < 0) {
                        return 'Please enter an integer >= 0';
                    }
                    return undefined;
                }
            });

            if (input === undefined) {
                // anulowano - wracamy do listy bez zmian
                return;
            }

            const n = Number(input);

            // przycinanie od początku Map (najstarszy wpis jest pierwszy, najnowszy ostatni)
            const instance = RecentSqlFiles.getInstance();
            const entries = Array.from(instance.getSqlFiles().entries());
            const trimmedEntries = n <= 0 ? [] : entries.slice(Math.max(0, entries.length - n));
            instance.sqlFiles = new Map(trimmedEntries);
            void instance.persist();

            // odśwież listę widoczną w otwartym QuickPicku
            quickPick.items = buildQuickPickItems();
            vscode.window.showInformationMessage(`Recent SQL files list trimmed - kept ${trimmedEntries.length} most recent entries`);
        });

        // Wyświetlenie menu użytkownikowi
        const selectedItem = await new Promise<{ label: string; description: string; value: string } | undefined>(res => {
            quickPick.onDidAccept(() => { res(quickPick.selectedItems[0]); quickPick.hide(); });
            quickPick.onDidHide(() => { res(undefined); quickPick.dispose(); });
            quickPick.show();
        });
        
        // OTWARCIE PLIKU W EDYTORZE
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
                vscode.window.showErrorMessage(`Could not open file: ${error instanceof Error ? error.message : error}`);
            }
        }
    }
    
    public async changeConnectionName() {
        return await this.getConnectionName(true);
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
