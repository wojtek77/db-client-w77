import * as vscode from 'vscode';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { ConnectionColors } from '../db/ConnectionColors.js';
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
     * Zwraca ścieżkę do katalogu, w którym zapisywany jest plik z listą ostatnich plików SQL.
     * Jeśli w ustawieniach "db-client.recentSqlFilesDir" podano własną ścieżkę, zostanie ona użyta,
     * w przeciwnym razie użyty zostanie domyślny folder rozszerzenia (globalStorageUri) - tak jak dotychczas.
     */
    private getStorageDir(): string {
        const configuredDir =
            vscode.workspace
                .getConfiguration('db-client')
                .get<string>('recentSqlFilesDir', '');

        return configuredDir
            ? configuredDir
            : this.context.globalStorageUri.fsPath;
    }

    /**
     * Zwraca pełną ścieżkę do pliku zapisu w folderze rozszerzenia
     */
    private getStorageFilePath(): string {
        return path.join(this.getStorageDir(), RecentSqlFiles.FILE_NAME);
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
            } else {
                this.sqlFiles = new Map();
            }
        } catch (err) {
            console.error('RecentSqlFiles: Error while restoring state:', err);
            this.sqlFiles = new Map();
        }
    }
    
    /**
     * Gwarantowany, synchroniczny zapis danych na dysku podczas zamykania
     */
    public persist(): void {
        try {
            const storagePath = this.getStorageDir();
            
            // upewniamy się, że katalog globalStorageUri istnieje
            if (!fs.existsSync(storagePath)) {
                fs.mkdirSync(storagePath, { recursive: true });
            }

            const filePath = this.getStorageFilePath();
            const dataToSave = JSON.stringify(Array.from(this.sqlFiles.entries()));

            // blokujący zapis synchroniczny - VS Code nie ubije procesu przed zakończeniem zapisu
            fs.writeFileSync(filePath, dataToSave, 'utf-8');
        } catch (err) {
            console.error('RecentSqlFiles: Critical write error in dispose:', err);
        }
    }
    
    public async getConnectionName(isOnlyUpdate = false, sqlFileOverride?: string) {
        // jeśli wywołujący przekazał konkretny plik, używamy go zamiast activeTextEditor w tym momencie
        // między uruchomieniem zapytania a tym wywołaniem może minąć czas (do 5s), a activeTextEditor mógłby już wskazywać na inny plik
        let sqlFile = sqlFileOverride;
        if (!sqlFile) {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                throw new Error("no editor is currently active");
            }
            // bez tego sprawdzenia plik nie-SQL (np. nowa pusta zakładka) mógłby trafić do listy ostatnich plików SQL
            if (editor.document.languageId !== 'sql') {
                throw new Error("the active editor is not an SQL file");
            }
            sqlFile = editor.document.fileName;
        }
        let connectionName = this.get(sqlFile);
        const configs = ConnectionManager.getInstance().getConfigs();
        
        // trzeba sprawdzić, czy "connectionName" jest aktualne
        if (connectionName && !configs[connectionName]) {
            this.delete(sqlFile);
            void this.persist();
            vscode.window.showWarningMessage(`Delete "${connectionName}" from list of SQL files`);
            connectionName = undefined;
        }
        
        // gdy wywołanie jest z ConnectionManager i plik nie ma ustawionego połączenia, ustawiamy ostatnio używane połączenie DB (analogicznie jak w DBeaver)
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
    
        // przycisk (ikona kosza) przy każdej pozycji na liście - usuwa tylko tę jedną pozycję
        const removeItemButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: 'Remove this file from the list'
        };

        // null = brak filtra (pokazujemy wszystkie połączenia), w przeciwnym razie zbiór wybranych nazw połączeń
        let filterConnections: Set<string> | null = null;

        // true tylko wtedy, gdy aktualny filtr został ustawiony skrótem-gwiazdką (a nie przez lejek) - dzięki temu ikona lejka nie zmienia się przy klikaniu gwiazdki
        let isQuickCurrentConnectionFilter = false;

        // true, gdy główny QuickPick jest chwilowo chowany, bo otwieramy nad nim inny quick input (filtr / trim) - wtedy "onDidHide" nie powinno traktować tego jako anulowanie przez użytkownika
        let isShowingSubPicker = false;

        // funkcja pomocnicza (lokalna) budująca elementy QuickPick na podstawie aktualnego stanu sqlFiles
        const buildQuickPickItems = () => {
            const sqlFiles = RecentSqlFiles.getInstance().getSqlFiles();

            // jeśli aktywny jest filtr połączeń, usuwamy z kopii listy wpisy spoza wybranych połączeń
            if (filterConnections) {
                for (const [filePath, connectionName] of Array.from(sqlFiles.entries())) {
                    if (!filterConnections.has(connectionName)) {
                        sqlFiles.delete(filePath);
                    }
                }
            }

            // zbierz ścieżki wszystkich otwartych dokumentów w edytorze
            const openFilePaths = new Set<string>();
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    // sprawdzamy, czy karta to plik tekstowy
                    if (tab.input instanceof vscode.TabInputText) {
                        const filePath = tab.input.uri.fsPath;

                        // warunek: interesują nas tylko pliki z rozszerzeniem .sql
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

            // mapowanie na elementy QuickPickItem w odwróconej kolejności – zamieniamy wpisy mapy na tablicę i odwracamy przez .reverse()
            return Array.from(sqlFiles.entries())
                .reverse()
                .map(([filePath, connectionName], index) => {
                    // pobieramy samą nazwę pliku (np. "query.sql")
                    const fileName = path.basename(filePath);

                    const orderNumber = index + 1;

                    return {
                        // label: `${orderNumber}. ${fileName} (${connectionName})`, // To co widzi użytkownik
                        label: `${fileName}`, // To co widzi użytkownik
                        description: `(${connectionName}) ${orderNumber}.`,                     // Opcjonalnie: podgląd pełnej ścieżki na dole
                        value: filePath,                     // Ukryta wartość, którą chcemy wyciągnąć
                        connectionName: connectionName,      // nazwa połączenia (potrzebna np. przy komunikacie o usunięciu z listy)
                        iconPath: ConnectionColors.getInstance().getColorIconUri(connectionName), // kolorowa ikona zgodna z kolorem przypisanym do połączenia
                        buttons: [removeItemButton]          // ikona kosza przy tej pozycji - usuwa tylko ją
                    };
                });
        };

        // przycisk (ikona kosza w prawym górnym rogu QuickPick) do przycinania listy
        const TRIM_TOOLTIP = 'Trim list (keep only N most recent files)';
        // tooltip przycisku filtra zmienia się w zależności od stanu - jasno mówi, co zrobi kliknięcie
        const FILTER_TOOLTIP = 'Filter by connection(s)';
        const CLEAR_FILTER_TOOLTIP = 'Clear connection filter';
        const CURRENT_CONNECTION_TOOLTIP = 'Filter by current connection';
        const CLEAR_CURRENT_CONNECTION_TOOLTIP = 'Show all connections';

        // buduje aktualny zestaw przycisków - skrót do aktualnego połączenia (gwiazdka), filtr (lejek) i przycinanie listy (kosz)
        const buildButtons = (): vscode.QuickInputButton[] => {
            const currentConnectionName = ConnectionManager.getInstance().getCurrentNameConnection();
            // gwiazdka jest "aktywna" tylko wtedy, gdy filtr zawęża listę dokładnie do aktualnie aktywnego połączenia
            const isCurrentConnectionFilterActive = !!currentConnectionName &&
                !!filterConnections && filterConnections.size === 1 && filterConnections.has(currentConnectionName);

            // lejek reaguje tylko na filtr ustawiony przez siebie - filtr ustawiony gwiazdką nie zmienia jego ikony ani zachowania
            const isFunnelFilterActive = !!filterConnections && !isQuickCurrentConnectionFilter;

            return [
                {
                    iconPath: new vscode.ThemeIcon(isCurrentConnectionFilterActive ? 'star-full' : 'star-empty'),
                    tooltip: isCurrentConnectionFilterActive ? CLEAR_CURRENT_CONNECTION_TOOLTIP : CURRENT_CONNECTION_TOOLTIP
                },
                {
                    iconPath: new vscode.ThemeIcon(isFunnelFilterActive ? 'filter-filled' : 'filter'),
                    // gdy filtr ustawiony przez lejek jest aktywny, ten sam przycisk od razu go czyści zamiast otwierać picker - eliminuje osobny, dwuznaczny przycisk "x"
                    tooltip: isFunnelFilterActive ? CLEAR_FILTER_TOOLTIP : FILTER_TOOLTIP
                },
                {
                    iconPath: new vscode.ThemeIcon('trash'),
                    tooltip: TRIM_TOOLTIP
                }
            ];
        };

        // zwraca tekst placeholdera, uwzględniając aktualnie aktywny filtr połączeń
        const buildPlaceholder = () => filterConnections
            ? `select SQL file(s) - filtered by: ${Array.from(filterConnections).join(', ')}`
            : 'select SQL file(s)';

        const quickPick = vscode.window.createQuickPick<{ label: string; description: string; value: string; connectionName: string; iconPath?: vscode.Uri; buttons?: readonly vscode.QuickInputButton[] }>();
        quickPick.items = buildQuickPickItems();
        quickPick.placeholder = buildPlaceholder();
        quickPick.ignoreFocusOut = true;
        quickPick.buttons = buildButtons();
        quickPick.canSelectMany = true; // pozwala zaznaczyć checkboxami wiele plików naraz i otworzyć je jednym Enterem
        if (quickPick.items.length > 0) {
            quickPick.activeItems = [quickPick.items[0]]; // domyślnie podświetlony pierwszy element, tak jak dawniej przy pojedynczym wyborze
        }

        // obsługa kliknięcia przycisków (filtr połączeń / skrót do aktualnego połączenia / przycinanie listy) - rozpoznajemy przycisk po tooltipie, bo przyciski są tworzone od nowa przy każdym buildButtons()
        quickPick.onDidTriggerButton(async (button) => {
            if (button.tooltip === CLEAR_CURRENT_CONNECTION_TOOLTIP) {
                // gwiazdka jest już aktywna - drugie kliknięcie w nią czyści filtr i pokazuje znów wszystkie połączenia
                filterConnections = null;
                isQuickCurrentConnectionFilter = false;
                quickPick.items = buildQuickPickItems();
                quickPick.placeholder = buildPlaceholder();
                quickPick.buttons = buildButtons();
                return;
            }

            if (button.tooltip === CURRENT_CONNECTION_TOOLTIP) {
                const currentConnectionName = ConnectionManager.getInstance().getCurrentNameConnection();
                if (!currentConnectionName) {
                    vscode.window.showInformationMessage('No active DB connection');
                    return;
                }

                // od razu, bez otwierania jakiegokolwiek pickera, filtrujemy do aktualnie aktywnego połączenia
                filterConnections = new Set([currentConnectionName]);
                isQuickCurrentConnectionFilter = true;
                quickPick.items = buildQuickPickItems();
                quickPick.placeholder = buildPlaceholder();
                quickPick.buttons = buildButtons();
                return;
            }

            if (button.tooltip === CLEAR_FILTER_TOOLTIP) {
                // filtr ustawiony przez lejek jest już aktywny - to samo kliknięcie od razu go czyści, bez otwierania pickera
                filterConnections = null;
                quickPick.items = buildQuickPickItems();
                quickPick.placeholder = buildPlaceholder();
                quickPick.buttons = buildButtons();
                return;
            }

            if (button.tooltip === FILTER_TOOLTIP) {
                const instance = RecentSqlFiles.getInstance();

                // unikalne nazwy połączeń zebrane z całej (niefiltrowanej) listy ostatnich plików
                const uniqueConnectionNames = Array.from(new Set(instance.getSqlFiles().values())).sort();

                if (uniqueConnectionNames.length === 0) {
                    vscode.window.showInformationMessage('No connections in the recent files list');
                    return;
                }

                const filterPick = vscode.window.createQuickPick<{ label: string; iconPath?: vscode.Uri }>();
                filterPick.items = uniqueConnectionNames.map(name => ({
                    label: name,
                    iconPath: ConnectionColors.getInstance().getColorIconUri(name) // ta sama kolorowa ikona co przy plikach danego połączenia
                }));
                filterPick.canSelectMany = true;
                filterPick.placeholder = 'select connection(s) to filter by (leave empty to show all)';
                filterPick.ignoreFocusOut = true;
                // domyślnie zaznaczone są połączenia z aktualnie aktywnego filtra
                filterPick.selectedItems = filterPick.items.filter(item => filterConnections?.has(item.label));

                // sygnalizujemy, że chowanie głównego QuickPicka teraz jest tylko chwilowe (pod filterPick), a nie anulowaniem przez użytkownika
                isShowingSubPicker = true;

                const chosenNames = await new Promise<string[] | undefined>(res => {
                    filterPick.onDidAccept(() => {
                        res(filterPick.selectedItems.map(item => item.label));
                        filterPick.hide();
                    });
                    filterPick.onDidHide(() => { res(undefined); filterPick.dispose(); });
                    filterPick.show();
                });

                isShowingSubPicker = false;

                if (chosenNames === undefined) {
                    quickPick.show(); // anulowano wybór filtra (Esc) - przywracamy główną listę bez zmian
                    return;
                }

                // pusty wybór oznacza wyłączenie filtra (pokazujemy wszystkie połączenia)
                filterConnections = chosenNames.length > 0 ? new Set(chosenNames) : null;
                isQuickCurrentConnectionFilter = false; // ten filtr został teraz ustawiony przez lejek, nie przez gwiazdkę

                quickPick.items = buildQuickPickItems();
                quickPick.placeholder = buildPlaceholder();
                quickPick.buttons = buildButtons(); // odświeżamy przyciski - ikona lejka i ewentualny przycisk "x" muszą odzwierciedlać nowy stan filtra
                // filterPick.hide() nie przywraca automatycznie głównego QuickPicka na ekranie - trzeba pokazać go ponownie ręcznie
                quickPick.show();
                return;
            }

            if (button.tooltip !== TRIM_TOOLTIP) {
                return;
            }

            // pole input z domyślną wartością 0 (0 = wyczyść całą listę)
            isShowingSubPicker = true;
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
            isShowingSubPicker = false;

            if (input === undefined) {
                quickPick.show(); // anulowano - wracamy do listy bez zmian
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
            quickPick.show();
            vscode.window.showInformationMessage(`Recent SQL files list trimmed - kept ${trimmedEntries.length} most recent entries`);
        });

        // obsługa kliknięcia w kosz przy pojedynczej pozycji na liście - usuwa tylko tę jedną pozycję
        quickPick.onDidTriggerItemButton((event) => {
            if (event.button !== removeItemButton) {
                return;
            }

            // zapamiętujemy indeks usuwanej pozycji, żeby po odświeżeniu listy zaznaczenie zostało w tym samym miejscu
            const removedIndex = quickPick.items.indexOf(event.item);

            const instance = RecentSqlFiles.getInstance();
            instance.delete(event.item.value);
            void instance.persist();

            // odśwież listę widoczną w otwartym QuickPicku (bez zamykania go)
            const newItems = buildQuickPickItems();
            quickPick.items = newItems;

            // ustawiamy aktywną pozycję na tym samym indeksie co usunięta (a przy ostatniej pozycji – na nowym ostatnim elemencie)
            if (newItems.length > 0) {
                const newActiveIndex = Math.min(removedIndex, newItems.length - 1);
                quickPick.activeItems = [newItems[newActiveIndex]];
            }
        });

        // wyświetlenie menu użytkownikowi - teraz zwracamy całą tablicę zaznaczonych elementów, nie tylko pierwszy
        const selectedItems = await new Promise<ReadonlyArray<{ label: string; description: string; value: string; connectionName: string }>>(res => {
            quickPick.onDidAccept(() => {
                // jeśli nic nie zaznaczono checkboxem, otwieramy po prostu podświetloną (aktywną) pozycję - jak w trybie pojedynczego wyboru
                const items = quickPick.selectedItems.length > 0 ? quickPick.selectedItems : quickPick.activeItems;
                res(items);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                // jeśli chowanie jest tylko tymczasowe (bo otwarty jest filtr lub input przycinania na wierzchu), to nie jest to anulowanie przez użytkownika
                if (isShowingSubPicker) {
                    return;
                }
                res([]);
                quickPick.dispose();
            });
            quickPick.show();
        });

        // OTWARCIE WSZYSTKICH ZAZNACZONYCH PLIKÓW W EDYTORZE, w kolejności w jakiej były na liście
        for (const selectedItem of selectedItems) {
            const sqlFile = selectedItem.value;

            try {
                // zamiana ścieżki tekstowej na obiekt Uri wymagany przez VS Code
                const fileUri = vscode.Uri.file(sqlFile);

                await vscode.window.showTextDocument(fileUri, {
                    preview: false,       // pełne otwarcie, nie preview
                    preserveFocus: false  // opcjonalnie: od razu aktywuje edytor
                });
            } catch (error) {
                // plik mógł zostać usunięty lub zmieniona jego nazwa na dysku – sprawdzamy, czy faktycznie już nie istnieje
                if (!fs.existsSync(sqlFile)) {
                    const instance = RecentSqlFiles.getInstance();
                    instance.delete(sqlFile);
                    void instance.persist();
                    const fileName = path.basename(sqlFile);
                    vscode.window.showWarningMessage(`File "${fileName}" no longer exists and has been removed from the list of recent SQL files`);
                } else {
                    vscode.window.showErrorMessage(`Could not open file: ${error instanceof Error ? error.message : error}`);
                }
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
