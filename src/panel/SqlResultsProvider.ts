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
import { openConnectionFile } from '../commands/connectionSetupCommands.js';

interface FileResultState {
    rows: any[][];
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
    
    
    private _view?: vscode.WebviewView;
    
    private _fileStates = new Map<string, FileResultState>();
    
    private _connectionName: string = '';
    private _connectionTime: number = 0;
    private _connectionColor: string | null = null;
    private _isProduction = false;
    private _isReadOnly = false;
    private _extensionUri: vscode.Uri;
    private _allRows: any[][] = [];
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
    private _context?: vscode.ExtensionContext;
    // _viewReady === true oznacza, że skrypt JS wewnątrz webview (media/app.js)
    // faktycznie się załadował i zarejestrował swój listener na wiadomości
    // (patrz media/messageHandler.js) - a nie tylko że sam kontener webview
    // istnieje. To ważne rozróżnienie: samo istnienie `this._view` (ustawiane
    // w resolveWebviewView()) NIE gwarantuje, że webview jest już w stanie
    // odebrać postMessage() - ładowanie strony webview jest asynchroniczne
    // (osobny sandboxowany proces/iframe), więc bez tego rozróżnienia
    // wiadomości wysłane zbyt wcześnie (np. 'queryStarted', wyniki zapytania)
    // mogły ginąć, mimo że zapytanie SQL wykonywało się poprawnie w tle.
    private _viewReady = false;
    private _resolveViewReady?: (value: boolean) => void;
    private _currentSqlFile = '';
    private _queryRunning = false;

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

        // Nowa instancja webviewView = zupełnie nowa strona, która musi się
        // dopiero załadować od zera - resetujemy flagę gotowości, żeby nie
        // dziedziczyć stanu "gotowy" z ewentualnego poprzedniego widoku.
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
            // Sprawdzamy tożsamość: ten callback jest przypisany do KONKRETNEJ
            // instancji webviewView (przez domknięcie), ale odwołuje się do
            // współdzielonego pola this._view. Gdyby VS Code z jakiegoś powodu
            // utworzył NOWY widok (nowe wywołanie resolveWebviewView, nowe
            // this._view) zanim formalnie zutylizuje ten STARY widok, to dispose
            // starej, "zombie" instancji odpaliłby się później i wyzerowałby
            // this._view, mimo że w tym momencie wskazuje ono już na całkiem
            // nowy, aktywny widok. Ten warunek zapobiega takiemu nadpisaniu.
            if (this._view === webviewView) {
                this._view = undefined; // Dzięki temu program wie, że stary widok już nie istnieje!
                this._viewReady = false;
                console.log('WEBVIEW_CLOSE');
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (!SqlResultsProvider.isValidWebviewMessage(msg)) {
                console.error('Ignored malformed message from webview:', msg);
                return;
            }

            if (msg.command === 'webviewReady') {
                // Sygnał, że skrypt JS wewnątrz TEGO KONKRETNEGO webview
                // faktycznie się załadował i jest gotowy odbierać kolejne
                // postMessage() (np. wyniki zapytania). To jedyny wiarygodny
                // moment, w którym wiemy, że webview jest naprawdę gotowy -
                // w przeciwieństwie do samego utworzenia kontenera przez
                // resolveWebviewView(), które nie gwarantuje, że strona
                // skończyła się ładować.
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
                this._currentPage = msg.page;
                
                // zapamiętaj aktualną stronę w stanie tego pliku, żeby po ponownym
                // uruchomieniu tego samego SQL-a można było na nią wrócić
                const fileState = this._fileStates.get(this._currentSqlFile);
                if (fileState) {
                    fileState.currentPage = msg.page;
                }
                
                this.sendPage(msg.page);
            }
            
            if (msg.command === 'updateCell') {
                await this.updateCellInDB(msg.rowIndex, msg.columnIndex, msg.value);
            }
            
            if (msg.command === 'deleteRows') {
                await this.deleteRowsInDB(msg.rowIndexes);
            }

            if (msg.command === 'saveColumnEdits') {
                await this.saveColumnEdits(msg.edits);
            }

            if (msg.command === 'generateInsert') {
                await this.generateInsertSQL(msg.rowIndexes);
            }

            if (msg.command === 'generateUpdate') {
                await this.generateUpdateSQL(msg.rowIndexes);
            }

            if (msg.command === 'generateDelete') {
                await this.generateDeleteSQL(msg.rowIndexes);
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

            case 'updateCell':
                return typeof msg.rowIndex === 'number' && typeof msg.columnIndex === 'number';

            case 'deleteRows':
            case 'generateInsert':
            case 'generateUpdate':
            case 'generateDelete':
                return isNumberArray(msg.rowIndexes);

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
            const typed = await vscode.window.showInputBox({
                prompt: `Type the connection name "${connectionName}" to confirm`,
                placeHolder: connectionName,
                ignoreFocusOut: true,
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
        
        const start = (pageNumber - 1) * this.ROWS_PER_PAGE;
        const end = start + this.ROWS_PER_PAGE;
        const pageRows = this._allRows.slice(start, end);
        const totalPages = Math.ceil(this._allRows.length / this.ROWS_PER_PAGE);
        
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
                headers: this._headers,
                columnTypes: this._columnTypes,
                totalRows: this._allRows.length,
                isLast: (pageNumber === totalPages),
                currentPage: pageNumber,
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

    private async updateCellInDB(rowIndex: number, columnIndex: number, value: any) {
        try {
            const db = await ConnectionManager.getInstance().getDb();

            // rowIndex przychodzi z webview jako indeks w obrębie aktualnie wyrenderowanej
            // strony (0..ROWS_PER_PAGE-1) - doliczamy offset bieżącej strony, żeby trafić
            // we właściwy wiersz w this._allRows (które trzyma pełny wynik zapytania)
            const globalIndex = (this._currentPage - 1) * this.ROWS_PER_PAGE + rowIndex;
            const row = this._allRows[globalIndex];

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

            const primaryKeys = tableColumns.filter((c: any) => c.columnKey === 'PRI');

            if (primaryKeys.length === 0) {
                vscode.window.showErrorMessage(`Table ${tableName} does not have a PRIMARY KEY`);
                return;
            }

            const whereParts: string[] = [];
            const whereValues: any[] = [];

            for (const pk of primaryKeys) {
                const pkIndex = this._meta.findIndex((m: any) => {
                    return (
                        m.orgTable?.() === tableName &&
                        m.orgName?.() === pk.name
                    );
                });

                if (pkIndex === -1) {
                    vscode.window.showErrorMessage(
                        `Missing PRIMARY KEY '${pk.name}' in the SELECT results`
                    );
                    return;
                }

                whereParts.push(`\`${pk.name}\` = ?`);
                whereValues.push(row[pkIndex]);
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

            this._allRows[globalIndex][columnIndex] = value;

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

            vscode.window.showInformationMessage(
                `✅ Updated ${tableName}.${columnName} (${pkDisplay})`
            );
        } catch (err: any) {
            console.error('Update error:', err);
            vscode.window.showErrorMessage(`❌ Update error: ${err.message}`);
        }
    }

    private async deleteRowsInDB(rowIndexes: number[]) {
        if (!rowIndexes || rowIndexes.length === 0) {
            return;
        }

        try {
            // rowIndexes przychodzą jako indeksy w obrębie aktualnie wyrenderowanej strony -
            // doliczamy offset bieżącej strony (tak samo jak w updateCellInDB)
            const globalIndexes = rowIndexes.map(
                (rowIndex) => (this._currentPage - 1) * this.ROWS_PER_PAGE + rowIndex
            );

            const rows = globalIndexes.map((idx) => this._allRows[idx]).filter(Boolean);

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

            const primaryKeys = tableColumns.filter((c: any) => c.columnKey === 'PRI');

            if (primaryKeys.length === 0) {
                vscode.window.showErrorMessage(`Table ${tableName} does not have a PRIMARY KEY`);
                return;
            }

            // indeks każdej kolumny PK w obrębie wyników SELECT (this._meta / wiersz danych)
            const pkIndexes: number[] = [];
            for (const pk of primaryKeys) {
                const pkIndex = this._meta.findIndex((m: any) => {
                    return (
                        m.orgTable?.() === tableName &&
                        m.orgName?.() === pk.name
                    );
                });

                if (pkIndex === -1) {
                    vscode.window.showErrorMessage(
                        `Missing PRIMARY KEY '${pk.name}' in the SELECT results`
                    );
                    return;
                }

                pkIndexes.push(pkIndex);
            }

            // wartości PK dla każdego zaznaczonego wiersza, w tej samej kolejności co primaryKeys
            const pkValueTuples = rows.map((row) => pkIndexes.map((idx) => row[idx]));

            const db = await ConnectionManager.getInstance().getDb();

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

            // backend jest źródłem prawdy - usuwamy skasowane wiersze z lokalnego cache
            const deletedGlobalIndexes = new Set(globalIndexes);
            this._allRows = this._allRows.filter((_, idx) => !deletedGlobalIndexes.has(idx));

            // jeśli usunięto ostatnie wiersze na ostatniej stronie, cofamy się do istniejącej strony
            const totalPages = Math.max(1, Math.ceil(this._allRows.length / this.ROWS_PER_PAGE));
            if (this._currentPage > totalPages) {
                this._currentPage = totalPages;
            }

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

            // BEZPIECZEŃSTWO: edit.columnName pochodzi z webview (nie jest zaufanym
            // źródłem) i jest wstawiane bezpośrednio do zapytania UPDATE (SET `<columnName>` = ?).
            // Musi zostać porównane z zaufanymi metadanymi tabeli (columns, pochodzące
            // z meta zapytania SELECT), zanim zostanie użyte - w przeciwnym razie
            // dowolna wartość columnName pozwoliłaby na wstrzyknięcie SQL.
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

            // ID (wartości PK) WSZYSTKICH wierszy z bieżących wyników SQL (this._allRows),
            // nie tylko z aktualnie wyrenderowanej strony - to one wyznaczają zakres UPDATE-u
            const pkValueTuples = this._allRows.map(
                (row) => primaryKeys.map((pk) => row[pk.index])
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

            const recordCount = this._allRows.length;

            const db = await ConnectionManager.getInstance().getDb();

            const confirmed = await this.confirmDestructiveOperation(
                `Change ${changesPreview} for ${recordCount} record(s) matching the current SQL results in table "${tableName}"? ` +
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

            // backend jest źródłem prawdy - odzwierciedlamy zmianę we wszystkich
            // lokalnie przechowywanych wierszach (this._allRows), żeby po odświeżeniu
            // strony webview pokazał aktualne wartości
            for (const edit of normalizedEdits) {
                for (const row of this._allRows) {
                    row[edit.columnIndex] = edit.value;
                }
            }

            // odśwież widok: znika czerwone podświetlenie kolumny i przycisk zapisu,
            // a komórki pokazują nową wartość
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

        // tylko kolumny faktycznie należące do tej tabeli (bez wyliczanych, np. COUNT(*))
        const columns = this._meta
            .map((m: any, index: number) => ({ index, name: m.orgName?.(), field: m }))
            .filter((c) => c.name && c.field.orgTable?.() === tableName);

        const tableColumnsService = TableColumnsCache.getInstance();
        const columnsMap = await tableColumnsService.getCachedColumnsBatch([{schema, table: tableName}]);
        const tableColumns = columnsMap[tableColumnsService.getTableRefKey({schema, table: tableName})] ?? [];

        const primaryKeyNames = new Set(
            tableColumns.filter((c: any) => c.columnKey === 'PRI').map((c: any) => c.name)
        );

        if (primaryKeyNames.size === 0) {
            vscode.window.showErrorMessage(`Table ${tableName} does not have a PRIMARY KEY`);
            return null;
        }

        const primaryKeys = columns.filter((c) => primaryKeyNames.has(c.name));

        if (primaryKeys.length !== primaryKeyNames.size) {
            vscode.window.showErrorMessage(`Not all PRIMARY KEY columns are present in the SELECT results`);
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
        const db = await ConnectionManager.getInstance().getDb();
        const connectionDatabase = db.getDatabase();

        return connectionDatabase
            ? `\`${tableName}\``
            : `\`${schema}\`.\`${tableName}\``;
    }

    /** Zwraca wiersze (z this._allRows) odpowiadające page-relative rowIndexes z webview. */
    private resolveSelectedRows(rowIndexes: number[]): any[][] {
        return rowIndexes
            .map((rowIndex) => (this._currentPage - 1) * this.ROWS_PER_PAGE + rowIndex)
            .map((globalIndex) => this._allRows[globalIndex])
            .filter(Boolean);
    }

    private async generateInsertSQL(rowIndexes: number[]) {
        try {
            if (!rowIndexes || rowIndexes.length === 0) {return;}

            const context = await this.resolveTableContext();
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowIndexes);
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

    private async generateUpdateSQL(rowIndexes: number[]) {
        try {
            if (!rowIndexes || rowIndexes.length === 0) {return;}

            const context = await this.resolveTableContext();
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowIndexes);
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

    private async generateDeleteSQL(rowIndexes: number[]) {
        try {
            if (!rowIndexes || rowIndexes.length === 0) {return;}

            const context = await this.resolveTableContext();
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowIndexes);
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
            // Timeout dla bezpieczeństwa - jeśli webview nie zasygnalizuje
            // gotowości na czas (np. skrypt się nie załadował z jakiegoś
            // powodu), rozwiązujemy z false i CZYŚCIMY _resolveViewReady,
            // żeby nie zostawiać nieaktualnej referencji do już
            // rozstrzygniętego Promise'a.
            setTimeout(() => {
                resolve(this._viewReady);
                this._resolveViewReady = undefined;
            }, 5000);
        });
    }

    public async executeQuery(sql: string, sqlFile: string, wholeFile = false) {
        this._currentSqlFile = sqlFile;
        
        // Pokazujemy widok - to jednocześnie obsługuje przypadek "widoku jeszcze
        // nie było" (VS Code utworzy nowy kontener i wywoła resolveWebviewView())
        // jak i "widok już istnieje, ale użytkownik był przełączony na inną
        // zakładkę np. terminal" (zwykłe show()).
        await this.show({ preserveFocus: true });

        // Czekamy, aż webview faktycznie zasygnalizuje gotowość - czyli aż jego
        // skrypt JS się załaduje i będzie w stanie odebrać kolejne postMessage()
        // (patrz komentarz przy polu _viewReady). Samo istnienie this._view
        // (czyli tylko utworzenie kontenera) NIE wystarczy - w tej samej chwili
        // strona webview może być jeszcze w trakcie ładowania. W zdecydowanej
        // większości przypadków (widok był już wcześniej użyty w tej sesji VS
        // Code) _viewReady jest już true i w ogóle tu nie czekamy.
        if (!this._viewReady) {
            await this.waitForViewReady();
        }

        if (!this._viewReady || !this._view) {
            vscode.window.showErrorMessage("Failed to open the SQL results window.");
            return;
        }
        
        // dzięki temu jeśli nie jest przypisane połączenie do pliku SQL nie wystaruje webview
        //
        // WAŻNE: przekazujemy jawnie "sqlFile" (zapamiętane na samym początku tej metody,
        // patrz "this._currentSqlFile = sqlFile" powyżej), a NIE pozwalamy, żeby
        // getConnectionName() samo na nowo odczytało vscode.window.activeTextEditor.
        // Powyżej były dwa awaity (this.show() oraz ewentualnie waitForViewReady(),
        // które przy pierwszym uruchomieniu webview może czekać do 5 sekund) - w tym
        // czasie użytkownik mógł zdążyć przełączyć się na inny plik. Bez tej poprawki
        // prowadziło to do rzadkiego błędu: na liście ostatnich plików SQL (F3)
        // pojawiał się plik inny niż ten, dla którego faktycznie uruchomiono zapytanie.
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

            // Przypadek "brak żadnego skonfigurowanego połączenia" jest już
            // obsłużony RAZ, przy starcie rozszerzenia (safeStartExtension w
            // extension.ts) - nie sprawdzamy/nie proponujemy tego ponownie przy
            // każdym Run SQL, bo nie ma po co (jak ktoś już to skonfiguruje,
            // zawsze będzie dobrze).
            //
            // Nie próbujemy zgadywać, CO dokładnie jest nie tak w pliku .cnf
            // (to zadanie użytkownika) - jedyne, co sprawdzamy, to czy istnieje
            // dokładnie jeden plik .cnf. Wtedy możemy jednoznacznie zaproponować
            // jego edycję, bo nie ma dwuznaczności, który plik otworzyć.
            const configs = ConnectionManager.getInstance().getConfigs();
            const configNames = Object.keys(configs);

            if (configNames.length === 1) {
                const cnfPath = configs[configNames[0]];
                const editLabel = `Edit ${path.basename(cnfPath)}`;
                vscode.window.showErrorMessage(errorMessage, editLabel).then((choice) => {
                    if (choice === editLabel) {
                        openConnectionFile(cnfPath);
                    }
                });
            } else {
                vscode.window.showErrorMessage(errorMessage);
            }
        } finally {
            // Niezależnie od tego, czy zapytanie się powiodło, czy nawet nie udało się
            // uzyskać połączenia z bazą - spinner ładowania i przycisk "cancel" muszą
            // zawsze wrócić do stanu spoczynku.
            this._queryRunning = false;
            this._view?.webview.postMessage({
                command: 'queryFinished'
            });
        }

        if (!db) {
            // Nie udało się nawet uzyskać połączenia z bazą - nie mamy czym
            // zaktualizować widoku wyników (connectionName/connectionTime itd.)
            return;
        }
        
        if (!success) {
            // headers = [];
            // rows = [];
        }
        
        // jeśli to jest DOKŁADNIE ten sam SQL co poprzednio uruchomiony dla tego pliku,
        // zostajemy na tej samej stronie co poprzednio; w przeciwnym razie (nowy/inny SQL)
        // zawsze wracamy do strony 1
        const previousFileState = this._fileStates.get(sqlFile);
        const isSameQueryAsBefore = previousFileState?.sql === sql;
        
        this._allRows = rows;
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
        
        const totalPages = Math.max(1, Math.ceil(this._allRows.length / this.ROWS_PER_PAGE));
        if (isSameQueryAsBefore) {
            // ten sam SQL co poprzednio -> zostajemy na poprzedniej stronie (przycięte do zakresu,
            // gdyby liczba wierszy się zmieniła i poprzednia strona już nie istniała)
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
        });
        
        // wysłanie info o tym że dane się łądują (blur)
        this._view.webview.postMessage({ 
            command: 'loadingWebview'
        });
        
        this.sendPage(this._currentPage, false, isSameQueryAsBefore);
    }
    
    public showResultsForFile(sqlFile: string) {
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

        this._view.webview.postMessage({
            command: 'showResultsForFile',
            sqlFile: sqlFile,
            connectionColor: this._connectionColor,
            isProduction: this._isProduction,
            isReadOnly: this._isReadOnly,
            sentAt: Date.now() // znacznik czasu w ms
        });
    }

    private async show(options?: { preserveFocus?: boolean }) {
        const preserveFocus = options?.preserveFocus ?? true;
        
        if (this._view) {
            // ! WAŻNE: W VS Code flaga 'preserveFocus' działa odwrotnie niż Twój stary wpis.
            // Przekazanie true oznacza: ZACHOWAJ FOKUS W EDYTORZE (nie kradnij go).
            this._view.show?.(preserveFocus); 
        } else {
            await vscode.commands.executeCommand('sqlResultsView.focus', { preserveFocus: preserveFocus });
        }
    }
    
    private async changeConnection() {

        const connectionName = await RecentSqlFiles.getInstance().changeConnectionName();

        // utworzenia nowego połączenia z bozą aby uzyskać czas łaczenia
        const db = await ConnectionManager.getInstance().getDb();

        this._connectionName = connectionName;
        this._connectionTime = db.getConnectionTime();
        this._connectionColor = ConnectionColors.getInstance().getColor(this._connectionName);
        this._isProduction = db.isProductionConnection();
        this._isReadOnly = db.isReadOnlyConnection();

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

        // Zaktualizuj kolor we wszystkich zapisanych stanach dla tego połączenia
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
            const rows = this._allRows;
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
            const rows = this._allRows;
            const headers = this._headers;

            if (rows.length === 0) {
                vscode.window.showWarningMessage('No data to export.');
                return;
            }

            const escapeCell = (value: unknown): string =>
                value === null || value === undefined ? '' : String(value);

            // Szerokości kolumn — max z nagłówka i danych, ograniczone do 50
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