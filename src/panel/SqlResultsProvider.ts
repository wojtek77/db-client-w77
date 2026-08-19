import * as vscode from 'vscode';
import { getHtml } from './html.js';
import { executeQuery, executeQueryWholeFile } from '../db/query.js';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { Connection } from '../db/Connection.js';
import * as path from 'path';
import * as os from 'os';
import { RecentSqlFiles } from '../recentFiles/RecentSqlFiles.js';
import { ConnectionColors } from '../db/ConnectionColors.js';
import { TableColumnsCache } from '../cache/TableColumnsCache.js';
import { formatSqlValue } from '../sql/formatSqlValue.js';
import { resolvePrimaryKeyColumns, resolveTableColumns } from '../sql/resolvePrimaryKeyColumns.js';

/** Wiersz wyniku SQL razem ze stabilnym, permanentnym identyfikatorem (key). Klucz jest
 * niezależny od pozycji w tablicy - nigdy nie jest przypisywany ponownie innemu wierszowi,
 * nawet gdy inne wiersze zostaną usunięte (this._allRows.filter() przesuwa pozycje, ale
 * nie dotyka wartości .key). Dzięki temu webview może zawsze zaadresować konkretny wiersz
 * przez jego key, niezależnie od tego, która strona/w jakiej kolejności jest renderowana. */
interface RowEntry {
    key: number;
    data: any[];
}

interface FileResultState {
    rows: RowEntry[];
    headers: string[];
    sql: string;
    meta: any[];
    columnTypes: string[];
    connectionName: string;
    connectionTime: number;
    queryTime: number;
    connectionColor: string | null;
    isProduction: boolean;
    isReadOnly: boolean;
    currentPage: number;
    searchQuery: string;
}

export class SqlResultsProvider implements vscode.WebviewViewProvider {
    private static instance: SqlResultsProvider;
    
    static initialize(
        context: vscode.ExtensionContext
    ) {
        if (!SqlResultsProvider.instance) {
            SqlResultsProvider.instance =
                new SqlResultsProvider(context);
        }

        return SqlResultsProvider.instance;
    }

    static getInstance() {
        if (!SqlResultsProvider.instance) {
            throw new Error(
                "SqlResultsProvider not initialized"
            );
        }

        return SqlResultsProvider.instance;
    }
    
    public hasOpenPanel: boolean | null = false;
    
    private _view?: vscode.WebviewView;
    
    private _fileStates = new Map<string, FileResultState>();
    
    private _connectionName: string = '';
    private _connectionTime: number = 0;
    private _connectionColor: string | null = null;
    private _isProduction = false;
    private _isReadOnly = false;
    private _extensionUri: vscode.Uri;
    private _allRows: RowEntry[] = [];
    private _headers: string[] = [];
    private _lastQueryTime = 0;
    private _meta: any[] = [];
    private _columnTypes: string[] = [];
    private _lastSQL = '';
    private _currentPage = 1;
    private _infoMessage = '';
    private _flashMessage = '';
    private _errorMessage = '';
    private readonly ROWS_PER_PAGE = 200;
    // pusty string = brak aktywnego wyszukiwania; niepusty = aktywna fraza (patrz applySearchFilter/performSearch)
    private _searchQuery = '';
    // podzbiór this._allRows pasujący do _searchQuery, w kolejności wyświetlania; null = brak aktywnego filtra (wtedy sendPage używa całego _allRows).
    // Trzymamy same RowEntry (z ich .key), nie osobne indeksy - dzięki temu updateCellInDB/deleteRowsInDB/resolveSelectedRows w ogóle nie muszą wiedzieć,
    // czy filtr jest aktywny: zawsze adresują wiersz przez .key w this._allRows, niezależnie od tego, co jest akurat wyświetlane.
    private _filteredEntries: RowEntry[] | null = null;
    private _context?: vscode.ExtensionContext;
    // _viewReady === true oznacza, że skrypt JS w webview się załadował i zarejestrował listener – samo `this._view` tego nie gwarantuje
    private _viewReady = false;
    private _resolveViewReady?: (value: boolean) => void;
    private _currentSqlFile = '';
    private _queryRunning = false;
    // numer operacji filtrowania, który pozwala unieważnić poprzednie wyszukiwanie
    private _searchGeneration = 0;
    private readonly SEARCH_YIELD_EVERY = 10000;

    private constructor(context: vscode.ExtensionContext) {
        this._extensionUri = context.extensionUri;
        this._context = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        // nowa instancja webviewView to nowa strona, musi się załadować od zera – resetujemy flagę gotowości, żeby nie dziedziczyć stanu z poprzedniego widoku
        this._viewReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'dist')
            ]
        };

        this.updateHtml();

        // ⭐ REWELACYJNE ZABEZPIECZENIE:
        webviewView.onDidDispose(() => {
            // sprawdzamy tożsamość – dispose starej 'zombie' instancji mógłby odpalić się po utworzeniu nowego widoku i wyzerować this._view
            if (this._view === webviewView) {
                this._view = undefined; // Dzięki temu program wie, że stary widok już nie istnieje!
                this._viewReady = false;
                console.log('WEBVIEW_CLOSE');
            }
        });
        
        webviewView.onDidChangeVisibility(() => {
            // zmiana zakładki w panelu z "SQL" na np. "Terminal" spowoduje, że this.hasOpenPanel = null
            this.hasOpenPanel = webviewView.visible ? true : null;
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (!SqlResultsProvider.isValidWebviewMessage(msg)) {
                console.error('Ignored malformed message from webview:', msg);
                return;
            }

            if (msg.command === 'webviewReady') {
                // sygnał, że skrypt JS tego webview jest gotowy na postMessage() – jedyny wiarygodny moment, w odróżnieniu od utworzenia kontenera
                if (this._view === webviewView) {
                    this._viewReady = true;
                    if (this._resolveViewReady) {
                        this._resolveViewReady(true);
                        this._resolveViewReady = undefined;
                    }
                    console.log('WEBVIEW_START');
                }
                return;
            }

            if (msg.command === 'loadPage') {
                this.sendPage(msg.page);

                // zapamiętaj aktualną stronę w stanie tego pliku (po ewentualnym przycięciu w sendPage) - żeby po powrocie do pliku/rerunie tego samego SQL-a wrócić na właściwą
                const fileState = this._fileStates.get(this._currentSqlFile);
                if (fileState) {
                    fileState.currentPage = this._currentPage;
                }
            }

            if (msg.command === 'search') {
                // wyszukiwanie jest asynchroniczne i anulowalne, więc nie blokuje obsługi kolejnych komunikatów
                void this.performSearch(msg.query);
            }
            
            if (msg.command === 'updateCell') {
                await this.updateCellInDB(msg.rowKey, msg.rowIndex, msg.columnIndex, msg.value);
            }
            
            if (msg.command === 'deleteRows') {
                await this.deleteRowsInDB(msg.rowKeys);
            }

            if (msg.command === 'saveColumnEdits') {
                await this.saveColumnEdits(msg.edits);
            }

            if (msg.command === 'generateInsert') {
                await this.generateInsertSQL(msg.rowKeys);
            }

            if (msg.command === 'generateUpdate') {
                await this.generateUpdateSQL(msg.rowKeys);
            }

            if (msg.command === 'generateDelete') {
                await this.generateDeleteSQL(msg.rowKeys);
            }
            
            if (msg.command === 'changeConnection') {
                await this.changeConnection();
            }
            
            if (msg.command === 'openRecentFiles') {
                await this.openRecentFiles();
            }
            
            if (msg.command === 'exportCSV') {
                await this.exportToCSV();
            }
            
            if (msg.command === 'exportTXT') {
                await this.exportToTXT();
            }
            
            if (msg.command === 'cancelQuery') {
                await this.cancelCurrentQuery();
            }
            
            if (msg.command === 'pickConnectionColor') {
                await this.pickConnectionColor();
            }
        });
    }
    
    public isFocusSqlTab() {
        return this._view?.visible;
    }
    
    /**
     * Czyści zapisany stan wyników zapytań dla danego pliku SQL, żeby uniknąć
     * wycieku pamięci (m.in. pełnych `rows`), gdy plik przestał być potrzebny
     * (zamknięto jego zakładkę). Czyści zarówno cache w backendzie, jak i
     * odpowiadający mu cache w webview (m.in. `cachedGrid`/`cachedGridHtml`
     * w media/state.js), który ma dokładnie ten sam cykl życia.
     */
    public clearCache(sqlFile: string) {
        this._fileStates.delete(sqlFile);
        console.log('CLEAR_CACHE_BACKEND');

        if (this._view) {
            this._view.webview.postMessage({
                command: 'clearCache',
                sqlFile: sqlFile
            });
            console.log('CLEAR_CACHE_WEBVIEW');
        }
    }
    
    /**
     * Waliduje kształt komunikatów przychodzących z webview. Webview nie jest
     * zaufanym źródłem (renderuje dane z bazy i mogłoby zostać skompromitowane
     * przez np. XSS), więc każdy komunikat musi mieć oczekiwany "command" oraz
     * pola o oczekiwanym typie, zanim zostanie użyty do czegokolwiek (a w
     * szczególności zanim trafi do zapytania SQL).
     */
    private static isValidWebviewMessage(msg: any): boolean {
        if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string') {
            return false;
        }

        const isNumberArray = (v: any) => Array.isArray(v) && v.every((n) => typeof n === 'number');

        switch (msg.command) {
            case 'loadPage':
                return typeof msg.page === 'number' && msg.page > 0;

            case 'search':
                return typeof msg.query === 'string';

            case 'updateCell':
                return typeof msg.rowKey === 'number' && typeof msg.rowIndex === 'number' && typeof msg.columnIndex === 'number';

            case 'deleteRows':
            case 'generateInsert':
            case 'generateUpdate':
            case 'generateDelete':
                return isNumberArray(msg.rowKeys);

            case 'saveColumnEdits':
                return Array.isArray(msg.edits) && msg.edits.every((edit: any) =>
                    edit && typeof edit === 'object' &&
                    typeof edit.columnIndex === 'number' &&
                    typeof edit.columnName === 'string'
                );

            case 'webviewReady':
            case 'changeConnection':
            case 'openRecentFiles':
            case 'exportCSV':
            case 'exportTXT':
            case 'cancelQuery':
            case 'pickConnectionColor':
                return true;

            default:
                // nieznana komenda - odrzucamy
                return false;
        }
    }

    public isQueryRunning(): boolean {
        return this._queryRunning;
    }

    /**
     * Wspólne potwierdzenie destrukcyjnej, zbiorczej operacji (bulk UPDATE / DELETE
     * z widoku wyników): pokazuje host i bazę danych, na które operacja faktycznie
     * trafi, a opcjonalnie (ustawienie db-client.requireConnectionNameConfirmation)
     * wymaga wpisania nazwy połączenia, zanim operacja zostanie wykonana.
     */
    private async confirmDestructiveOperation(
        message: string,
        confirmLabel: string,
        db: Connection
    ): Promise<boolean> {
        const target = [db.getHost(), db.getDatabase()].filter(Boolean).join(' / ');
        const productionWarning = db.isProductionConnection() ? '\n\n⚠ This is a PRODUCTION connection.' : '';
        const fullMessage = target
            ? `${message}\n\nConnection: "${db.getConnectionName()}" (${target})${productionWarning}`
            : `${message}${productionWarning}`;

        const answer = await vscode.window.showWarningMessage(
            fullMessage,
            { modal: true },
            confirmLabel
        );
        if (answer !== confirmLabel) {
            return false;
        }

        const requireTypedName = vscode.workspace
            .getConfiguration('db-client')
            .get<boolean>('requireConnectionNameConfirmation', false);

        if (requireTypedName) {
            const connectionName = db.getConnectionName();
            // validateInput trzyma pole otwarte i pokazuje czerwony błąd dopóki nazwa się nie zgadza, zamiast od razu anulować całą operację
            const typed = await vscode.window.showInputBox({
                prompt: `Type the connection name "${connectionName}" to confirm`,
                placeHolder: connectionName,
                ignoreFocusOut: true,
                validateInput: (value) =>
                    value === connectionName ? null : `Connection name doesn't match "${connectionName}"`,
            });
            if (typed !== connectionName) {
                return false;
            }
        }

        return true;
    }
    
    private async cancelCurrentQuery() {
        try {
            const db =
                await ConnectionManager
                    .getInstance()
                    .getDb();

            await db.cancelCurrentQuery();

            // vscode.window.showInformationMessage(
            //     'SQL query cancelled'
            // );
        } catch (err: any) {
            vscode.window.showErrorMessage(
                err.message
            );
        }
    }

    // przelicza filtrowane wyniki na podstawie aktualnych danych i frazy wyszukiwania
    private async applySearchFilter(): Promise<boolean> {
        const generation = ++this._searchGeneration;
        const query = this._searchQuery.trim();

        if (!query) {
            this._filteredEntries = null;
            return true;
        }

        // wyszukiwanie bez rozróżniania wielkości liter, tak jak filtr w większości narzędzi tabelarycznych
        const needle = query.toLowerCase();
        const columnCount = this._headers.length;
        const source = this._allRows;
        const filteredEntries: RowEntry[] = [];

        // przetwarzamy rekordy partiami, aby event loop mógł obsłużyć nowe wyszukiwanie
        for (let i = 0; i < source.length; i++) {
            // nowe wyszukiwanie albo zmiana danych unieważniły tę operację
            if (generation !== this._searchGeneration) {
                return false;
            }

            const entry = source[i];

            for (let j = 0; j < columnCount; j++) {
                const value = entry.data[j];
                // null i undefined są wyświetlane jako NULL, więc wyszukiwanie null powinno je znaleźć
                const text = (value === null || value === undefined) ? 'NULL' : String(value);

                if (text.toLowerCase().includes(needle)) {
                    filteredEntries.push(entry);
                    break; // wystarczy jedno trafienie w wierszu

                }
            }

            if ((i + 1) % this.SEARCH_YIELD_EVERY === 0) {
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        }

        // sprawdzamy generację przed zapisaniem wyniku
        if (generation !== this._searchGeneration) {
            return false;
        }

        this._filteredEntries = filteredEntries;
        return true;
    }

    // obsługuje wyszukiwanie z webview i wysyła pierwszą stronę przefiltrowanych wyników
    private async performSearch(rawQuery: string): Promise<void> {
        if (!this._view) {return;}

        this._searchQuery = rawQuery;

        const fileState = this._fileStates.get(this._currentSqlFile);
        if (fileState) {
            fileState.searchQuery = this._searchQuery;
        }

        const completed = await this.applySearchFilter();

        // nowsza fraza unieważnia poprzednie wyszukiwanie i jego wynik
        if (!completed) {
            return;
        }

        // nowe wyszukiwanie zawsze wraca na stronę 1 - poprzednia strona mogła nie istnieć w przefiltrowanym zbiorze
        this.sendPage(1, true, false);
    }

    private updateHtml() {
        if (!this._view) {throw new Error("missing webview");}
        
        if (!this._view.webview.html) {
            const html = getHtml(
                this._view.webview,
                this._extensionUri
            );
            this._view.webview.html = html;
            console.log('WEBVIEW_HTML_UPDATE');
        }
    }

    private sendPage(pageNumber: number, clearSelection = false, isSameQuery = true) {
        if (!this._view) {return;}

        // gdy wyszukiwanie jest aktywne, paginujemy po przefiltrowanym podzbiorze zamiast po całym _allRows
        const source = this._filteredEntries ?? this._allRows;
        const totalRows = source.length;
        const totalPages = Math.max(1, Math.ceil(totalRows / this.ROWS_PER_PAGE));

        // pageNumber mogło zostać policzone dla innego (większego) zbioru wierszy niż aktualny - przycinamy, żeby nie wysłać pustej/nieistniejącej strony
        const clampedPage = Math.min(Math.max(1, pageNumber), totalPages);
        this._currentPage = clampedPage;

        const start = (clampedPage - 1) * this.ROWS_PER_PAGE;
        const end = start + this.ROWS_PER_PAGE;
        const pageEntries = source.slice(start, end);
        const pageRows = pageEntries.map((entry) => entry.data);
        // stabilne identyfikatory wierszy tej strony - webview odsyła je z powrotem przy edycji/usuwaniu zamiast liczyć page-relative -> global offset
        const rowKeys = pageEntries.map((entry) => entry.key);
        
        // 1. Konwertujemy wiersze na string JSON
        const rowsJsonString = JSON.stringify(pageRows);
        // 2. Zamieniamy na binarny Uint8Array
        const encoder = new TextEncoder();
        const rowsBuffer = encoder.encode(rowsJsonString); // Zwraca Uint8Array
        
        setImmediate(() => {
            // 3. Wysyłamy
            this._view?.webview.postMessage({
                command: 'appendData',
                sqlFile: this._currentSqlFile,
                rows: rowsBuffer, // VS Code automatycznie obsłuży to jako transfer binarny
                rowKeys, // mała tablica liczb - nie wymaga binarnego kodowania jak rows
                headers: this._headers,
                columnTypes: this._columnTypes,
                totalRows,
                // pełna (nieprzefiltrowana) liczba wierszy w wynikach - webview używa jej do etykiety "X z Y" obok pola wyszukiwania
                totalRowsUnfiltered: this._allRows.length,
                // backend jest źródłem prawdy dla frazy wyszukiwania - webview synchronizuje z tym pole inputu
                searchQuery: this._searchQuery,
                isLast: (clampedPage === totalPages),
                currentPage: clampedPage,
                totalPages: totalPages,
                connectionName: this._connectionName,
                connectionTime: this._connectionTime,
                queryTime: this._lastQueryTime,
                connectionColor: this._connectionColor,
                isProduction: this._isProduction,
                isReadOnly: this._isReadOnly,
                infoMessage: this._infoMessage,
                clearSelection,
                isSameQuery,
                flashMessage: this._flashMessage,
                errorMessage: this._errorMessage,
                isEncoded: true,
                sentAt: Date.now() // znacznik czasu w ms
            });
        });
    }

    /**
     * MySQL/MariaDB flaga BINARY_COLLATION z FieldInfo.flags (bit 1<<7).
     * Odróżnia prawdziwy BLOB (collation binarne) od TEXT (collation tekstowe) -
     * na poziomie protokołu oba typy są raportowane tym samym field.type.
     */
    private static readonly BINARY_COLLATION_FLAG = 1 << 7;

    /**
     * field.type dla kolumn TEXT-owych - protokół MySQL/MariaDB raportuje je
     * pod tymi samymi nazwami co odpowiadające im rozmiarowo typy BLOB.
     */
    private static readonly BLOB_TEXT_TYPE_NAMES: Record<string, string> = {
        TINY_BLOB: 'tinytext',
        BLOB: 'text',
        MEDIUM_BLOB: 'mediumtext',
        LONG_BLOB: 'longtext'
    };

    /**
     * Na podstawie metadanych kolumn (meta z mariadb) ustala typ danych
     * potrzebny wyłącznie do decyzji input/textarea przy edycji komórki
     * (patrz media/editor.js: MULTILINE_COLUMN_TYPES). Typy TEXT/TINYTEXT/
     * MEDIUMTEXT/LONGTEXT rozpoznajemy bez żadnego dodatkowego zapytania do
     * bazy - metadane zwrócone razem z wynikiem (field.type + field.flags)
     * już to zawierają. Dla pozostałych kolumn zwracamy '', bo nic więcej
     * z tej wartości nie korzysta.
     */
    private computeColumnTypes(meta: any[]): string[] {
        if (!meta || meta.length === 0) {
            return [];
        }

        return meta.map((field: any) => {
            const textTypeName = SqlResultsProvider.BLOB_TEXT_TYPE_NAMES[field?.type];
            if (!textTypeName) {
                return '';
            }

            const isBinaryBlob =
                ((field.flags ?? 0) & SqlResultsProvider.BINARY_COLLATION_FLAG) !== 0;

            return isBinaryBlob ? '' : textTypeName;
        });
    }

    /**
     * Zwraca połączenie do bazy powiązane z aktualnie wyświetlanym plikiem (this._currentSqlFile), a NIE z tym,
     * jaki edytor akurat ma fokus w VS Code w chwili wywołania. Dzięki temu operacje modyfikujące dane
     * (UPDATE/DELETE z widoku wyników) zawsze trafiają na bazę, która faktycznie wygenerowała widoczne w
     * panelu wyniki - nawet gdyby użytkownik zdążył w międzyczasie przełączyć się na inną/nie-SQL zakładkę.
     */
    private async getDbForCurrentFile(): Promise<Connection> {
        const fileState = this._fileStates.get(this._currentSqlFile);
        if (!fileState) {
            throw new Error('No active SQL file - run a query first');
        }
        return ConnectionManager.getInstance().getDb(fileState.connectionName);
    }

    private async updateCellInDB(rowKey: number, rowIndex: number, columnIndex: number, value: any) {
        try {
            const db = await this.getDbForCurrentFile();

            // rowKey to stabilny identyfikator wiersza (patrz RowEntry) - żadnej arytmetyki z bieżącą stroną, działa niezależnie od tego, co jest aktualnie wyrenderowane
            const entry = this._allRows.find((r) => r.key === rowKey);
            const row = entry?.data;

            if (!row) {
                vscode.window.showErrorMessage(`Row ${rowIndex} not found`);
                return;
            }

            const field = this._meta[columnIndex];

            if (!field) {
                vscode.window.showErrorMessage(`Column metadata for ${columnIndex} not found`);
                return;
            }

            const tableName = field.orgTable?.();
            const columnName = field.orgName?.();

            if (!tableName || !columnName) {
                vscode.window.showErrorMessage('Unable to determine the source table or column');
                return;
            }
            
            const schema = field.schema?.();
            if (!schema) {
                vscode.window.showErrorMessage(`Unable to determine schema for table ${tableName}`);
                return;
            }
            
            const tableColumnsService = TableColumnsCache.getInstance();
            const columnsMap = await tableColumnsService.getCachedColumnsBatch([{schema, table: tableName}]);
            const tableColumns = columnsMap[tableColumnsService.getTableRefKey({schema, table: tableName})] ?? [];

            const primaryKeyNames = tableColumns.filter((c: any) => c.columnKey === 'PRI').map((c: any) => c.name);

            if (primaryKeyNames.length === 0) {
                vscode.window.showErrorMessage(`Table ${tableName} does not have a PRIMARY KEY`);
                return;
            }

            const { found: primaryKeys, missingNames } = resolvePrimaryKeyColumns(this._meta, tableName, primaryKeyNames);

            if (missingNames.length > 0) {
                vscode.window.showErrorMessage(
                    `Missing PRIMARY KEY '${missingNames[0]}' in the SELECT results`
                );
                return;
            }

            const whereParts: string[] = [];
            const whereValues: any[] = [];

            for (const pk of primaryKeys) {
                whereParts.push(`\`${pk.name}\` = ?`);
                whereValues.push(row[pk.index]);
            }

            const qualifiedTable = db.getDatabase()
                ? `\`${tableName}\``
                : `\`${schema}\`.\`${tableName}\``;

            const updateSQL = `
                UPDATE ${qualifiedTable}
                SET \`${columnName}\` = ?
                WHERE ${whereParts.join(' AND ')}
            `;

            // obsługa NULL (można wpisywać tak: null, NULL)
            if (typeof value === 'string' && value.trim().toUpperCase() === 'NULL') {
                value = null;
            }
            
            await db.query(updateSQL, [value, ...whereValues]);

            row[columnIndex] = value;

            if (this._view) {
                this._view.webview.postMessage({
                    command: 'updateConfirmed',
                    rowIndex,
                    columnIndex,
                    value
                });
            }

            const pkDisplay = primaryKeys
                .map((pk: any, i: number) => `${pk.name} = ${whereValues[i]}`)
                .join(', ');

            // vscode.window.showInformationMessage(
            //     `✅ Updated ${tableName}.${columnName} (${pkDisplay})`
            // );
        } catch (err: any) {
            console.error('Update error:', err);
            vscode.window.showErrorMessage(`❌ Update error: ${err.message}`);
        }
    }

    private async deleteRowsInDB(rowKeys: number[]) {
        if (!rowKeys || rowKeys.length === 0) {
            return;
        }

        try {
            // rowKeys to stabilne identyfikatory (patrz RowEntry) - żadnej arytmetyki z bieżącą stroną
            const entries = rowKeys
                .map((key) => this._allRows.find((r) => r.key === key))
                .filter((entry): entry is RowEntry => entry !== undefined);

            const rows = entries.map((entry) => entry.data);

            if (rows.length === 0) {
                vscode.window.showErrorMessage('Selected rows not found');
                return;
            }

            const field = this._meta[0];
            if (!field) {
                vscode.window.showErrorMessage('Unable to determine the source table');
                return;
            }

            const tableName = field.orgTable?.();
            const schema = field.schema?.();

            if (!tableName || !schema) {
                vscode.window.showErrorMessage('Unable to determine the source table or schema');
                return;
            }

            const tableColumnsService = TableColumnsCache.getInstance();
            const columnsMap = await tableColumnsService.getCachedColumnsBatch([{schema, table: tableName}]);
            const tableColumns = columnsMap[tableColumnsService.getTableRefKey({schema, table: tableName})] ?? [];

            const primaryKeyNames = tableColumns.filter((c: any) => c.columnKey === 'PRI').map((c: any) => c.name);

            if (primaryKeyNames.length === 0) {
                vscode.window.showErrorMessage(`Table ${tableName} does not have a PRIMARY KEY`);
                return;
            }

            const { found: primaryKeys, missingNames } = resolvePrimaryKeyColumns(this._meta, tableName, primaryKeyNames);

            if (missingNames.length > 0) {
                vscode.window.showErrorMessage(
                    `Missing PRIMARY KEY '${missingNames[0]}' in the SELECT results`
                );
                return;
            }

            // wartości PK dla każdego zaznaczonego wiersza, w tej samej kolejności co primaryKeys
            const pkValueTuples = rows.map((row) => primaryKeys.map((pk) => row[pk.index]));

            const db = await this.getDbForCurrentFile();

            const confirmed = await this.confirmDestructiveOperation(
                `Delete ${rows.length} row(s) from "${tableName}"? This cannot be undone.`,
                'Delete',
                db
            );
            if (!confirmed) {
                return;
            }

            const pkColumnNames = primaryKeys.map((pk: any) => `\`${pk.name}\``);

            const qualifiedTable = db.getDatabase()
                ? `\`${tableName}\``
                : `\`${schema}\`.\`${tableName}\``;

            let deleteSQL: string;
            let deleteValues: any[];

            if (pkColumnNames.length === 1) {
                // pojedyncza kolumna PK - jeden DELETE z WHERE pk IN (?, ?, ...)
                const placeholders = pkValueTuples.map(() => '?').join(', ');
                deleteSQL = `
                    DELETE FROM ${qualifiedTable}
                    WHERE ${pkColumnNames[0]} IN (${placeholders})
                `;
                deleteValues = pkValueTuples.map((tuple) => tuple[0]);
            } else {
                // PK złożony - WHERE (pk1, pk2) IN ((?,?), (?,?), ...)
                const tuplePlaceholder = `(${pkColumnNames.map(() => '?').join(', ')})`;
                const placeholders = pkValueTuples.map(() => tuplePlaceholder).join(', ');
                deleteSQL = `
                    DELETE FROM ${qualifiedTable}
                    WHERE (${pkColumnNames.join(', ')}) IN (${placeholders})
                `;
                deleteValues = pkValueTuples.flat();
            }

            await db.startTransaction();
            try {
                await db.query(deleteSQL, deleteValues);
                await db.commit();
            } catch (err) {
                await db.rollback();
                throw err;
            }

            // backend jest źródłem prawdy - usuwamy skasowane wiersze z lokalnego cache. Filtrujemy po .key (stabilny, nigdy nie przypisywany ponownie),
            // nie po pozycji w tablicy - klucze pozostałych wierszy pozostają nietknięte niezależnie od tego, ile wierszy przed nimi zniknęło
            const deletedKeys = new Set(rowKeys);
            this._allRows = this._allRows.filter((entry) => !deletedKeys.has(entry.key));

            // wiersze zniknęły z this._allRows - przeliczamy filtr wyszukiwania na nowo (sendPage sam przytnie stronę, jeśli trzeba)
            await this.applySearchFilter();

            this.sendPage(this._currentPage, true);

            const displayValues = pkValueTuples.map((tuple) => tuple.join(', ')).join('; ');
            vscode.window.showInformationMessage(
                `✅ Deleted from ${tableName}: ${displayValues}`
            );
        } catch (err: any) {
            console.error('Delete error:', err);
            vscode.window.showErrorMessage(`❌ Delete error: ${err.message}`);
        }
    }

    /** Porównuje dwie wartości PK (obsługuje liczby, stringi, null) - do sortowania. */
    private comparePkValues(a: any, b: any): number {
        if (a === b) {return 0;}
        if (a === null || a === undefined) {return -1;}
        if (b === null || b === undefined) {return 1;}
        if (typeof a === 'number' && typeof b === 'number') {return a - b;}
        if (typeof a === 'bigint' && typeof b === 'bigint') {return a < b ? -1 : (a > b ? 1 : 0);}
        return String(a).localeCompare(String(b), undefined, { numeric: true });
    }

    /** Porównuje dwie krotki wartości PK kolumna po kolumnie (obsługuje też PK złożony). */
    private comparePkTuples(tupleA: any[], tupleB: any[]): number {
        for (let i = 0; i < tupleA.length; i++) {
            const cmp = this.comparePkValues(tupleA[i], tupleB[i]);
            if (cmp !== 0) {return cmp;}
        }
        return 0;
    }

    /**
     * Zbiorcza edycja CAŁEJ kolumny (lub kilku kolumn na raz, każda z własną nową
     * wartością) - zmienia wartość dla WSZYSTKICH rekordów, których ID znajdują się
     * w this._allRows (czyli w bieżących wynikach SQL - może ich być więcej niż jedna
     * strona, jeśli zapytanie miało własny LIMIT). NIE dotyka rekordów spoza wyników
     * SQL - WHERE pk IN (id1, id2, ...), gdzie id pochodzą wyłącznie z this._allRows
     * (posortowane, żeby były czytelne w logach SQL). Każda kolumna jest zmieniana
     * JEDNYM zapytaniem UPDATE, a wszystkie kolumny razem są zapisywane w JEDNEJ
     * transakcji: albo wszystkie się powiodą, albo żadna (rollback).
     */
    private async saveColumnEdits(
        edits: { columnIndex: number; columnName: string; value: any }[]
    ) {
        if (!edits || edits.length === 0) {
            return;
        }

        try {
            const context = await this.resolveTableContext();
            if (!context) {
                this._view?.webview.postMessage({ command: 'columnEditsCancelled' });
                return;
            }

            const { tableName, qualifiedTable, columns, primaryKeys } = context;

            // bezpieczeństwo: edit.columnName z webview trafia wprost do UPDATE (SET `<columnName>` = ?), musi być zweryfikowane, inaczej SQL injection
            const trustedColumnNames = new Set(columns.map((c) => c.name));
            const unknownColumn = edits.find((edit) => !trustedColumnNames.has(edit.columnName));
            if (unknownColumn) {
                vscode.window.showErrorMessage(
                    `Refusing to update unknown column "${unknownColumn.columnName}"`
                );
                this._view?.webview.postMessage({ command: 'columnEditsCancelled' });
                return;
            }

            if (this._allRows.length === 0) {
                vscode.window.showErrorMessage('No rows in the SQL results to update');
                this._view?.webview.postMessage({ command: 'columnEditsCancelled' });
                return;
            }

            // gdy aktywny jest filtr wyszukiwania, bulk-edit dotyczy tylko wierszy, które aktualnie przez niego przechodzą - nie całych wyników SQL
            const scopedEntries = this._filteredEntries ?? this._allRows;

            if (scopedEntries.length === 0) {
                vscode.window.showErrorMessage('No rows matching the current search to update');
                this._view?.webview.postMessage({ command: 'columnEditsCancelled' });
                return;
            }

            // ID (wartości PK) wszystkich wierszy objętych operacją (scopedEntries), nie tylko z wyrenderowanej strony – to one wyznaczają zakres UPDATE-u
            const pkValueTuples = scopedEntries.map(
                (entry) => primaryKeys.map((pk) => entry.data[pk.index])
            );

            // sortujemy ID przed wstawieniem do UPDATE-u, żeby były czytelne w logach SQL
            pkValueTuples.sort((tupleA, tupleB) => this.comparePkTuples(tupleA, tupleB));

            const pkColumnNames = primaryKeys.map((pk) => `\`${pk.name}\``);

            let whereClause: string;
            let whereValues: any[];

            if (pkColumnNames.length === 1) {
                // pojedyncza kolumna PK - WHERE pk IN (?, ?, ...)
                const placeholders = pkValueTuples.map(() => '?').join(', ');
                whereClause = `${pkColumnNames[0]} IN (${placeholders})`;
                whereValues = pkValueTuples.map((tuple) => tuple[0]);
            } else {
                // PK złożony - WHERE (pk1, pk2) IN ((?,?), (?,?), ...)
                const tuplePlaceholder = `(${pkColumnNames.map(() => '?').join(', ')})`;
                const placeholders = pkValueTuples.map(() => tuplePlaceholder).join(', ');
                whereClause = `(${pkColumnNames.join(', ')}) IN (${placeholders})`;
                whereValues = pkValueTuples.flat();
            }

            const normalizedEdits = edits.map((edit) => {
                let value = edit.value;
                if (typeof value === 'string' && value.trim().toUpperCase() === 'NULL') {
                    value = null;
                }
                return { ...edit, value };
            });

            const columnInfoByName = new Map(columns.map((c) => [c.name, c]));

            const changesPreview = normalizedEdits
                .map((edit) => {
                    const columnInfo = columnInfoByName.get(edit.columnName);
                    return `\`${edit.columnName}\` = ${formatSqlValue(edit.value, columnInfo?.field)}`;
                })
                .join(', ');

            const recordCount = scopedEntries.length;

            const db = await this.getDbForCurrentFile();

            const confirmed = await this.confirmDestructiveOperation(
                `Change ${changesPreview} for ${recordCount} record(s) matching the current SQL results${this._searchQuery ? ' and search filter' : ''} in table "${tableName}"? ` +
                `This cannot be undone.`,
                'Update',
                db
            );
            if (!confirmed) {
                this._view?.webview.postMessage({ command: 'columnEditsCancelled' });
                return;
            }

            await db.startTransaction();
            try {
                for (const edit of normalizedEdits) {
                    const updateSQL = `
                        UPDATE ${qualifiedTable}
                        SET \`${edit.columnName}\` = ?
                        WHERE ${whereClause}
                    `;
                    await db.query(updateSQL, [edit.value, ...whereValues]);
                }
                await db.commit();
            } catch (err) {
                await db.rollback();
                throw err;
            }

            // backend jest źródłem prawdy – odzwierciedlamy zmianę tylko w wierszach objętych operacją (scopedEntries), żeby webview pokazał aktualne wartości
            for (const edit of normalizedEdits) {
                for (const entry of scopedEntries) {
                    entry.data[edit.columnIndex] = edit.value;
                }
            }

            // wartości mogły się zmienić w kolumnie, po której filtruje aktywne wyszukiwanie - przeliczamy, jakie wiersze nadal pasują
            await this.applySearchFilter();

            // odśwież widok: znika czerwone podświetlenie kolumny i przycisk zapisu, komórki pokazują nową wartość
            this.sendPage(this._currentPage, true);

            const columnNames = normalizedEdits.map((e) => `\`${e.columnName}\``).join(', ');
            vscode.window.showInformationMessage(
                `✅ Updated ${columnNames} for ${recordCount} record(s) in ${tableName}`
            );
        } catch (err: any) {
            console.error('Column bulk update error:', err);
            vscode.window.showErrorMessage(`❌ Column bulk update error: ${err.message}`);
            this._view?.webview.postMessage({ command: 'columnEditsCancelled' });
        }
    }

    /**
     * Wspólny kontekst potrzebny do generowania INSERT/UPDATE/DELETE:
     * nazwa tabeli/schemy, kolumny faktycznie widoczne w wynikach SELECT
     * (bez kolumn wyliczanych typu COUNT(*)), oraz które z nich są PRIMARY KEY.
     * Nie wykonuje żadnego dodatkowego zapytania do bazy - tabela/PK są
     * rozpoznawane z metadanych (this._meta) + cache kolumn tabeli.
     */
    private async resolveTableContext(): Promise<{
        tableName: string;
        schema: string;
        qualifiedTable: string;
        columns: { index: number; name: string; field: any }[];
        primaryKeys: { index: number; name: string; field: any }[];
    } | null> {
        const firstField = this._meta[0];
        if (!firstField) {
            vscode.window.showErrorMessage('Unable to determine the source table');
            return null;
        }

        const tableName = firstField.orgTable?.();
        const schema = firstField.schema?.();

        if (!tableName || !schema) {
            vscode.window.showErrorMessage('Unable to determine the source table or schema');
            return null;
        }

        const qualifiedTable = await this.qualifyTableName(schema, tableName);

        // tylko kolumny faktycznie należące do tej tabeli (bez wyliczanych, np. COUNT(*)), każda nazwa raz - nawet jeśli SELECT ją duplikuje (np. f.id, f.*)
        const columns = resolveTableColumns(this._meta, tableName);

        const tableColumnsService = TableColumnsCache.getInstance();
        const columnsMap = await tableColumnsService.getCachedColumnsBatch([{schema, table: tableName}]);
        const tableColumns = columnsMap[tableColumnsService.getTableRefKey({schema, table: tableName})] ?? [];

        const primaryKeyNames = tableColumns.filter((c: any) => c.columnKey === 'PRI').map((c: any) => c.name);

        if (primaryKeyNames.length === 0) {
            vscode.window.showErrorMessage(`Table ${tableName} does not have a PRIMARY KEY`);
            return null;
        }

        // ta sama logika co przy edycji pojedynczej komórki i bezpośrednim kasowaniu wierszy - jedno (pierwsze) wystąpienie każdej kolumny PK w wynikach SELECT
        const { found: primaryKeys, missingNames } = resolvePrimaryKeyColumns(this._meta, tableName, primaryKeyNames);

        if (missingNames.length > 0) {
            vscode.window.showErrorMessage(
                `Missing PRIMARY KEY column(s) in the SELECT results: ${missingNames.join(', ')}`
            );
            return null;
        }

        return { tableName, schema, qualifiedTable, columns, primaryKeys };
    }

    /**
     * Buduje nazwę tabeli do użycia w SQL: `schema`.`table`, jeśli połączenie
     * nie ma ustawionej domyślnej bazy (database=''), albo samo `table`,
     * jeśli połączenie już łączy się z konkretną bazą (wtedy prefiks schemy
     * jest zbędny i tylko zaśmieca wygenerowany/wykonywany SQL).
     */
    private async qualifyTableName(schema: string, tableName: string): Promise<string> {
        const db = await this.getDbForCurrentFile();
        const connectionDatabase = db.getDatabase();

        return connectionDatabase
            ? `\`${tableName}\``
            : `\`${schema}\`.\`${tableName}\``;
    }

    /** Zwraca wiersze (z this._allRows) odpowiadające stabilnym rowKeys z webview - żadnej arytmetyki page-relative -> global (patrz RowEntry). */
    private resolveSelectedRows(rowKeys: number[]): any[][] {
        return rowKeys
            .map((key) => this._allRows.find((r) => r.key === key))
            .filter((entry): entry is RowEntry => entry !== undefined)
            .map((entry) => entry.data);
    }

    private async generateInsertSQL(rowKeys: number[]) {
        try {
            if (!rowKeys || rowKeys.length === 0) {return;}

            const context = await this.resolveTableContext();
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowKeys);
            if (rows.length === 0) {
                vscode.window.showErrorMessage('Selected rows not found');
                return;
            }

            const { columns, qualifiedTable } = context;
            const columnNames = columns.map((c) => `\`${c.name}\``).join(', ');

            const valuesLines = rows.map((row) => {
                const values = columns.map((c) => formatSqlValue(row[c.index], c.field));
                return `(${values.join(', ')})`;
            });

            const sql =
                `INSERT INTO ${qualifiedTable} (${columnNames})\n` +
                `VALUES\n${valuesLines.join(',\n')};\n`;

            await this.saveAndCopySql(sql, 'insert');
        } catch (err: any) {
            console.error('Generate INSERT error:', err);
            vscode.window.showErrorMessage(`❌ Generate INSERT error: ${err.message}`);
        }
    }

    private async generateUpdateSQL(rowKeys: number[]) {
        try {
            if (!rowKeys || rowKeys.length === 0) {return;}

            const context = await this.resolveTableContext();
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowKeys);
            if (rows.length === 0) {
                vscode.window.showErrorMessage('Selected rows not found');
                return;
            }

            const { columns, primaryKeys, qualifiedTable } = context;
            const pkIndexSet = new Set(primaryKeys.map((pk) => pk.index));
            const setColumns = columns.filter((c) => !pkIndexSet.has(c.index));

            const statements = rows.map((row) => {
                const setParts = setColumns.map(
                    (c) => `\`${c.name}\` = ${formatSqlValue(row[c.index], c.field)}`
                );
                const whereParts = primaryKeys.map(
                    (pk) => `\`${pk.name}\` = ${formatSqlValue(row[pk.index], pk.field)}`
                );

                return (
                    `UPDATE ${qualifiedTable}\n` +
                    `SET ${setParts.join(', ')}\n` +
                    `WHERE ${whereParts.join(' AND ')};`
                );
            });

            const sql = statements.join('\n\n') + '\n';

            await this.saveAndCopySql(sql, 'update');
        } catch (err: any) {
            console.error('Generate UPDATE error:', err);
            vscode.window.showErrorMessage(`❌ Generate UPDATE error: ${err.message}`);
        }
    }

    private async generateDeleteSQL(rowKeys: number[]) {
        try {
            if (!rowKeys || rowKeys.length === 0) {return;}

            const context = await this.resolveTableContext();
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowKeys);
            if (rows.length === 0) {
                vscode.window.showErrorMessage('Selected rows not found');
                return;
            }

            const { primaryKeys, qualifiedTable } = context;
            const pkColumnNames = primaryKeys.map((pk) => `\`${pk.name}\``);

            let sql: string;

            if (pkColumnNames.length === 1) {
                const pk = primaryKeys[0];
                const values = rows.map((row) => formatSqlValue(row[pk.index], pk.field));
                sql = `DELETE FROM ${qualifiedTable}\nWHERE ${pkColumnNames[0]} IN (${values.join(', ')});\n`;
            } else {
                const tuples = rows.map((row) => {
                    const values = primaryKeys.map((pk) => formatSqlValue(row[pk.index], pk.field));
                    return `(${values.join(', ')})`;
                });
                sql =
                    `DELETE FROM ${qualifiedTable}\n` +
                    `WHERE (${pkColumnNames.join(', ')}) IN (${tuples.join(', ')});\n`;
            }

            await this.saveAndCopySql(sql, 'delete');
        } catch (err: any) {
            console.error('Generate DELETE error:', err);
            vscode.window.showErrorMessage(`❌ Generate DELETE error: ${err.message}`);
        }
    }

    /** Kopiuje wygenerowany SQL do schowka i - opcjonalnie - zapisuje na dysk (ten sam mechanizm co exportToTXT/CSV). */
    private async saveAndCopySql(sql: string, kind: 'insert' | 'update' | 'delete') {
        await vscode.env.clipboard.writeText(sql);

        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const fileName = `${kind}_${timestamp}.sql`;

        const lastPath = this.getLastExportPath('sql');
        const defaultDir = lastPath ? path.dirname(lastPath) : path.join(os.homedir(), 'Desktop');
        const defaultUri = vscode.Uri.file(path.join(defaultDir, fileName));

        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'SQL files': ['sql'] }
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(sql, 'utf8'));
            this.setLastExportPath(uri.fsPath, 'sql');
            vscode.window.showInformationMessage(`✅ ${kind.toUpperCase()} SQL saved to ${uri.fsPath} (also copied to clipboard)`);
        } else {
            vscode.window.showInformationMessage(`✅ ${kind.toUpperCase()} SQL copied to clipboard`);
        }
    }
    
    private async waitForViewReady(): Promise<boolean> {
        if (this._viewReady) {return true;}
        
        return new Promise(resolve => {
            this._resolveViewReady = resolve;
            // timeout dla bezpieczeństwa – jeśli webview nie zasygnalizuje gotowości na czas, rozwiązujemy z false i czyścimy _resolveViewReady
            setTimeout(() => {
                resolve(this._viewReady);
                this._resolveViewReady = undefined;
            }, 5000);
        });
    }

    public async executeQuery(sql: string, sqlFile: string, wholeFile = false) {
        this._currentSqlFile = sqlFile;
        
        // pokazujemy widok – obsługuje 'widoku jeszcze nie było' (nowy kontener, resolveWebviewView()) i 'widok już istnieje' (zwykłe show())
        await this.show({ preserveFocus: true });
        this.hasOpenPanel = true;

        // czekamy, aż webview zasygnalizuje gotowość (patrz _viewReady) – samo this._view nie wystarczy, strona może się jeszcze ładować
        if (!this._viewReady) {
            await this.waitForViewReady();
        }

        if (!this._viewReady || !this._view) {
            vscode.window.showErrorMessage("Failed to open the SQL results window.");
            return;
        }
        
        // jeśli nie ma przypisanego połączenia do pliku SQL, webview nie wystartuje
        // przekazujemy jawnie zapamiętane 'sqlFile' zamiast pozwolić getConnectionName() odczytać activeTextEditor na nowo (użytkownik mógł zmienić plik)
        const dBconnectionName = await RecentSqlFiles.getInstance().getConnectionName(false, sqlFile);
        
        this._queryRunning = true;
        this._view.webview.postMessage({
            command: 'queryStarted',
            startedAt: Date.now()
        });
        
        let rows: any[] = [], headers: string[] = [], meta, queryTime = 0, success = false, errorMessage = '', infoMessage, flashMessage;
        let db;
        try {
            db = await ConnectionManager.getInstance().getDb(dBconnectionName);

            if (wholeFile) {
                ({ rows, headers, meta, queryTime, success, errorMessage, infoMessage, flashMessage } = await executeQueryWholeFile(db, sql));
            } else {
                ({ rows, headers, meta, queryTime, success, errorMessage } = await executeQuery(db, sql));
            }
        } catch (err: any) {
            errorMessage = err.message;
        } finally {
            // niezależnie od wyniku zapytania (nawet przy braku połączenia z bazą) spinner ładowania i przycisk 'cancel' muszą zawsze wrócić do stanu spoczynku
            this._queryRunning = false;
            this._view?.webview.postMessage({
                command: 'queryFinished',
                // przy błędzie chowamy spinner tutaj, bo 'appendData' (które normalnie go chowa) nie zostanie wysłane
                errorMessage: errorMessage
            });
        }

        if (!db) {
            // nie udało się uzyskać połączenia z bazą – nie mamy czym zaktualizować widoku wyników (connectionName/connectionTime itd.)
            return;
        }
        
        if (!success) {
            // headers = [];
            // rows = [];
        }
        
        // jeśli to dokładnie ten sam SQL co poprzednio dla tego pliku, zostajemy na tej samej stronie, w przeciwnym razie wracamy do strony 1
        const previousFileState = this._fileStates.get(sqlFile);
        const isSameQueryAsBefore = previousFileState?.sql === sql;
        
        // każdy wiersz dostaje stabilny, permanentny key (0, 1, 2...) niezależny od pozycji w tablicy - patrz RowEntry
        let nextKey = 0;
        this._allRows = rows.map((data: any[]) => ({ key: nextKey++, data }));
        this._headers = headers;
        this._lastSQL = sql;
        this._meta = meta;
        this._columnTypes = success ? this.computeColumnTypes(meta) : [];
        this._connectionName = db.getConnectionName();
        this._connectionTime = db.getConnectionTime();
        this._lastQueryTime = queryTime;
        this._connectionColor = ConnectionColors.getInstance().getColor(this._connectionName);
        this._isProduction = db.isProductionConnection();
        this._isReadOnly = db.isReadOnlyConnection();
        this._infoMessage = infoMessage ?? '';
        this._flashMessage = flashMessage ?? '';
        this._errorMessage = errorMessage ?? '';

        // ten sam SQL co poprzednio -> filtr wyszukiwania przeżywa rerun (przeliczony na nowo dla świeżych danych), inaczej/nowy SQL -> filtr czyścimy
        this._searchQuery = isSameQueryAsBefore ? (previousFileState?.searchQuery ?? '') : '';
        await this.applySearchFilter();

        const totalRows = this._filteredEntries ? this._filteredEntries.length : this._allRows.length;
        const totalPages = Math.max(1, Math.ceil(totalRows / this.ROWS_PER_PAGE));
        if (isSameQueryAsBefore) {
            // ten sam SQL co poprzednio -> zostajemy na poprzedniej stronie (przycięte do zakresu, gdyby liczba wierszy się zmieniła)
            this._currentPage = Math.min(previousFileState!.currentPage, totalPages);
        } else {
            // inny/nowy SQL -> zawsze strona 1
            this._currentPage = 1;
        }
        
        this._fileStates.set(sqlFile, {
            rows: this._allRows,
            headers: this._headers,
            sql: this._lastSQL,
            meta: this._meta,
            columnTypes: this._columnTypes,
            connectionName: this._connectionName,
            connectionTime: this._connectionTime,
            queryTime: this._lastQueryTime,
            connectionColor: this._connectionColor,
            isProduction: this._isProduction,
            isReadOnly: this._isReadOnly,
            currentPage: this._currentPage,
            searchQuery: this._searchQuery,
        });
        
        // wysłanie info o tym że dane się łądują (blur)
        this._view.webview.postMessage({ 
            command: 'loadingWebview'
        });
        
        this.sendPage(this._currentPage, false, isSameQueryAsBefore);
    }
    
    /**
     * wołane, gdy aktywny edytor przestaje być plikiem .sql (np. nowa pusta zakładka, plik innego typu, brak edytora) -
     * zapomina aktualny plik i czyści widoczną siatkę, żeby panel nie zostawał "przyklejony" do poprzedniego pliku SQL
     * i nie dało się przez niego edytować/usuwać danych, które nie są już powiązane z żadną widoczną zakładką SQL
     */
    public clearActiveFile() {
        // unieważnij filtrowanie, które nadal skanuje poprzedni wynik
        this._searchGeneration++;
        this._currentSqlFile = '';
        this._allRows = [];
        this._headers = [];
        this._meta = [];
        this._columnTypes = [];
        this._searchQuery = '';
        this._filteredEntries = null;

        if (this._view) {
            this._view.webview.postMessage({
                command: 'showEmpty',
                sentAt: Date.now() // znacznik czasu w ms
            });
        }
    }

    // pozwala wywołującemu (np. extension.ts) sprawdzić, czy dany plik ma już zapisane wyniki, zanim zdecyduje o pokazaniu panelu
    public hasResultsForFile(sqlFile: string): boolean {
        return this._fileStates.has(sqlFile);
    }

    public async showResultsForFile(sqlFile: string) {
        if (!this._view) {
            return;
        }
        
        const state = this._fileStates.get(sqlFile);
        if (!state) {
            this._view.webview.postMessage({
                command: 'showEmpty',
                sentAt: Date.now() // znacznik czasu w ms
            });
            return;
        }

        this._currentSqlFile = sqlFile;
        this._allRows = state.rows;
        this._headers = state.headers;
        this._lastSQL = state.sql;
        this._meta = state.meta;
        this._columnTypes = state.columnTypes ?? [];
        this._lastQueryTime = state.queryTime;
        this._connectionName = state.connectionName;
        this._connectionTime = state.connectionTime;
        this._connectionColor = state.connectionColor ?? null;
        this._isProduction = state.isProduction ?? false;
        this._isReadOnly = state.isReadOnly ?? false;
        this._currentPage = state.currentPage ?? 1;
        // przywracamy filtr wyszukiwania zapamiętany dla tego pliku, żeby powrót do zakładki nie gubił frazy/zawężonej listy
        this._searchQuery = state.searchQuery ?? '';
        await this.applySearchFilter();

        this._view.webview.postMessage({
            command: 'showResultsForFile',
            sqlFile: sqlFile,
            connectionColor: this._connectionColor,
            isProduction: this._isProduction,
            isReadOnly: this._isReadOnly,
            searchQuery: this._searchQuery,
            sentAt: Date.now() // znacznik czasu w ms
        });
    }

    public async show(options?: { preserveFocus?: boolean }) {
        const preserveFocus = options?.preserveFocus ?? true;
        
        if (this._view) {
            // ważne: w VS Code flaga 'preserveFocus' działa odwrotnie niż stary wpis – true oznacza 'zachowaj fokus w edytorze' (nie kradnij go)
            this._view.show?.(preserveFocus); 
        } else {
            await vscode.commands.executeCommand('sqlResultsView.focus', { preserveFocus: preserveFocus });
        }
    }
    
    private async changeConnection() {
        try {
            // gdy jest aktywny plik w panelu, podajemy go jawnie - zamiast pozwolić na odczyt activeTextEditor na nowo (użytkownik mógł już przełączyć zakładkę); w przeciwnym razie (np. świeżo uruchomione rozszerzenie, panel jeszcze pusty) przekazujemy undefined, a RecentSqlFiles samo sięgnie po activeTextEditor
            const connectionName = await RecentSqlFiles.getInstance().changeConnectionName(this._currentSqlFile || undefined);

            // utworzenia nowego połączenia z bozą aby uzyskać czas łaczenia
            const db = await ConnectionManager.getInstance().getDb(connectionName);

            this._connectionName = connectionName;
            this._connectionTime = db.getConnectionTime();
            this._connectionColor = ConnectionColors.getInstance().getColor(this._connectionName);
            this._isProduction = db.isProductionConnection();
            this._isReadOnly = db.isReadOnlyConnection();

            // zapisany stan pliku też musi znać nowe połączenie - inaczej kolejna akcja (np. edycja komórki) użyłaby starego connectionName z _fileStates
            const fileState = this._fileStates.get(this._currentSqlFile);
            if (fileState) {
                fileState.connectionName = this._connectionName;
                fileState.connectionTime = this._connectionTime;
                fileState.connectionColor = this._connectionColor;
                fileState.isProduction = this._isProduction;
                fileState.isReadOnly = this._isReadOnly;
            }

            if (this._view) {
                this._view.webview.postMessage({
                    command: 'changeConnection',
                    connectionName: this._connectionName,
                    connectionTime: this._connectionTime,
                    connectionColor: this._connectionColor,
                    isProduction: this._isProduction,
                    isReadOnly: this._isReadOnly,
                });
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`❌ Change connection error: ${err.message}`);
        }
    }
    
    private async pickConnectionColor() {
        if (!this._connectionName) {
            return;
        }

        const newColor = await ConnectionColors.getInstance().pickColor(this._connectionName);

        if (newColor === undefined) {
            return; // anulowano
        }

        this._connectionColor = newColor;

        // zaktualizuj kolor we wszystkich zapisanych stanach dla tego połączenia
        for (const [file, state] of this._fileStates.entries()) {
            if (state.connectionName === this._connectionName) {
                state.connectionColor = newColor;
            }
        }

        if (this._view) {
            this._view.webview.postMessage({
                command: 'changeConnection',
                connectionName: this._connectionName,
                connectionTime: this._connectionTime,
                connectionColor: this._connectionColor,
            });
        }
    }
    
    private async openRecentFiles() {

        await RecentSqlFiles.getInstance().openRecentFiles();
    }
    
    private async exportToCSV() {
        try {
            const rows = this._allRows.map((entry) => entry.data); // eksport operuje na surowych danych, key jest szczegółem wewnętrznym backendu
            const headers = this._headers;

            if (rows.length === 0) {
                vscode.window.showWarningMessage('No data to export.');
                return;
            }

            const escapeCell = (value: unknown): string => {
                const str = value === null || value === undefined ? '' : String(value);
                return str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')
                    ? `"${str.replace(/"/g, '""')}"`
                    : str;
            };

            const parts: string[] = [];
            parts.push(headers.map(escapeCell).join(','));

            for (const row of rows) {
                parts.push(row.map(escapeCell).join(','));
            }

            const csv = parts.join('\n') + '\n';

            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const fileName = `export_${timestamp}.csv`;

            const lastPath = this.getLastExportPath('csv');
            const defaultDir = lastPath ? path.dirname(lastPath) : path.join(os.homedir(), 'Desktop');
            const defaultUri = vscode.Uri.file(path.join(defaultDir, fileName));

            const uri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'CSV files': ['csv'] }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
                this.setLastExportPath(uri.fsPath, 'csv');
                vscode.window.showInformationMessage(`✅ Exported ${rows.length} rows to ${uri.fsPath}`);
            }
        } catch (err: any) {
            console.error('Export error:', err);
            vscode.window.showErrorMessage(`❌ Export error: ${err.message}`);
        }
    }
    
    private async exportToTXT() {
        try {
            const rows = this._allRows.map((entry) => entry.data); // eksport operuje na surowych danych, key jest szczegółem wewnętrznym backendu
            const headers = this._headers;

            if (rows.length === 0) {
                vscode.window.showWarningMessage('No data to export.');
                return;
            }

            const escapeCell = (value: unknown): string =>
                value === null || value === undefined ? '' : String(value);

            // szerokości kolumn — max z nagłówka i danych, ograniczone do 50
            const colWidths = headers.map((h, i) => {
                let max = h.length;
                for (const row of rows) {
                    const len = escapeCell(row[i]).length;
                    if (len > max) {max = len;}
                }
                return Math.min(max, 50);
            });

            const separator = '+-' + colWidths.map(w => '-'.repeat(w)).join('-+-') + '-+';
            const headerRow = '| ' + headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ') + ' |';

            const parts: string[] = [separator, headerRow, separator];

            for (const row of rows) {
                let line = '| ';
                for (let i = 0; i < headers.length; i++) {
                    let cell = escapeCell(row[i]);
                    if (cell.length > colWidths[i]) {
                        cell = cell.substring(0, colWidths[i] - 3) + '...';
                    }
                    line += cell.padEnd(colWidths[i]) + ' | ';
                }
                parts.push(line);
            }

            parts.push(separator);
            parts.push(`Row count: ${rows.length}`);

            const txt = parts.join('\n') + '\n';

            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const fileName = `export_${timestamp}.txt`;

            const lastPath = this.getLastExportPath('txt');
            const defaultDir = lastPath ? path.dirname(lastPath) : path.join(os.homedir(), 'Desktop');
            const defaultUri = vscode.Uri.file(path.join(defaultDir, fileName));

            const uri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'Text files': ['txt'] }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(txt, 'utf8'));
                this.setLastExportPath(uri.fsPath, 'txt');
                vscode.window.showInformationMessage(`✅ Exported ${rows.length} rows to ${uri.fsPath}`);
            }
        } catch (err: any) {
            console.error('TXT export error:', err);
            vscode.window.showErrorMessage(`❌ TXT export error: ${err.message}`);
        }
    }
    
    private getLastExportPath(extension: string): string | undefined {
        return this._context?.globalState.get<string>(`lastExportPath_${extension}`);
    }

    private setLastExportPath(path: string, extension: string) {
        this._context?.globalState.update(`lastExportPath_${extension}`, path);
    }
}