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
import { formatSqlValue, normalizeValueForField } from '../sql/formatSqlValue.js';
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

/** Pojedyncze kryterium sortowania wielokolumnowego - kolejność w tablicy this._sortCriteria decyduje o priorytecie (pierwszy element = główne sortowanie, kolejne rozstrzygają remisy poprzedniego), dokładnie jak w SQL ORDER BY col1, col2, ... */
interface SortCriterion {
    columnIndex: number;
    direction: 'asc' | 'desc';
}

/** Cache jednej kolumny na potrzeby składania dowolnej kombinacji sortowań bez ponownego sortowania - patrz buildColumnSortCache/composeSortOrder. Budowany leniwie (dopiero gdy kolumna pierwszy raz wystąpi w jakimkolwiek kryterium) zawsze na bazie this._naturalOrderRows (nigdy this._allRows, bo to ono może być akurat w dowolnej, złożonej kolejności).
 * CELOWO same typed arrays (Int32Array), nie zagnieżdżone number[][]/Map - dla kolumny o wysokiej kardynalności (np. klucz główny, prawie każda wartość unikalna) number[][] tworzyłby prawie tyle osobnych obiektów Array ile jest wierszy, co dla kilku milionów wierszy kosztuje nawet kilkaset MB na SAMĄ jedną kolumnę (zmierzone), bo każdy obiekt Array ma spory narzut stały niezależnie od tego, ile elementów trzyma. Płaska reprezentacja (CSR - compressed sparse row) tego problemu nie ma niezależnie od kardynalności kolumny. */
interface ColumnSortCache {
    // klucze wierszy w jednej płaskiej tablicy, ułożone grupami wg wartości rosnąco (pierwsza grupa = zawsze NULL, może być pusta); wewnątrz grupy klucze rosnąco
    flatKeysAsc: Int32Array;
    // granice grup we flatKeysAsc - grupa g to flatKeysAsc.subarray(bucketStart[g], bucketStart[g + 1]); length = liczba grup + 1
    bucketStart: Int32Array;
    // key wiersza -> indeks jego grupy w bucketStart; indeksowane BEZPOŚREDNIO przez key (klucze to zawsze 0..n-1 nadawane sekwencyjnie przy wczytaniu, patrz nextKey w executeQuery), więc zwykła Int32Array zamiast Map - szybciej i bez narzutu pamięciowego struktury haszującej
    keyToBucket: Int32Array;
}

// typ danych kolumny na potrzeby wyboru komparatora sortowania - ustalany WYŁĄCZNIE z metadanych SQL (field.type), patrz computeSortKinds; 'date' to DATE/DATETIME/TIMESTAMP - mimo że wartość przychodzi jako string (dateStrings:true), na potrzeby sortowania jest parsowana na liczbę (patrz parseDateToSortableNumber) i idzie tą samą szybką ścieżką radix co 'number'
type SortKind = 'number' | 'string' | 'date';

interface FileResultState {
    // ZAWSZE naturalna kolejność z zapytania SQL (nigdy zapamiętany widok posortowany) - patrz this._naturalOrderRows; po przywróceniu pliku this._allRows jest odtwarzane z tego + sortCriteria przez applySort()
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
    sortCriteria: SortCriterion[];
    // cache per kolumna (patrz ColumnSortCache) zapamiętany razem z resztą stanu pliku, żeby powrót do zakładki nie wymagał ponownego liczenia grup
    sortColumnCache: Map<number, ColumnSortCache>;
}

export class SqlResultsProvider implements vscode.WebviewViewProvider {
    private static instance: SqlResultsProvider;
    /**
     * Nazwy typów z field.type (mariadb driver, enum Types) klasyfikowane jako NUMBER na potrzeby sortowania - reszta (w tym VARCHAR/VAR_STRING/STRING)
     * to STRING, poza DATE_SORT_TYPE_NAMES niżej. Nazwy dokładnie wg node_modules/mariadb/lib/const/field-type.js (sterownik 'mariadb', nie 'mysql2' - stąd 'INT', nie 'LONG'). DECIMAL/NEWDECIMAL trafiają tu mimo że driver zwraca je jako JS string (decimalAsNumber nie jest
     * ustawione w Connection.ts) - komparator numeryczny (odejmowanie) działa poprawnie niezależnie od tego, czy wartość jest JS number czy numerycznym
     * stringiem, bo operator '-' zawsze wymusza konwersję obu argumentów na liczbę. YEAR jest już liczbą 4-cyfrową, więc nie potrzebuje osobnego parsera dat.
     */
    private static readonly NUMERIC_SORT_TYPE_NAMES = new Set(['TINY', 'SHORT', 'INT', 'INT24', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR', 'BIT']);
    // nazwy typów z field.type klasyfikowane jako DATE na potrzeby sortowania - wszystkie u nas zawsze stringi (dateStrings:true, patrz Connection.ts), więc idą przez parseDateOrTimeToSortableNumber zamiast wprost przez Number()
    private static readonly DATE_SORT_TYPE_NAMES = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'TIME']);
    // dopasowuje 'YYYY-MM-DD' albo 'YYYY-MM-DD HH:MM:SS[.ułamek]' (DATE/DATETIME/TIMESTAMP z dateStrings:true) - patrz parseDateOrTimeToSortableNumber
    private static readonly DATE_STRING_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/;
    // dopasowuje TIME MariaDB/MySQL: opcjonalny minus, godziny 1-3 cyfry (zakres do 838), MM:SS, opcjonalny ułamek sekundy - patrz parseDateOrTimeToSortableNumber
    private static readonly TIME_STRING_PATTERN = /^(-)?(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
    // ile pierwszych znaków (jednostek UTF-16) stringa wchodzi do klucza radix sortu - patrz buildStringPrefixWords/STRING_RADIX_WORD_COUNT; reszta rozstrzygana pełnym porównaniem tylko w obrębie grup o identycznym prefiksie
    private static readonly STRING_RADIX_PREFIX_CHARS = 4;
    // 2 znaki UTF-16 (2x16 bit) na słowo 32-bitowe -> STRING_RADIX_PREFIX_CHARS/2 słów na string
    private static readonly STRING_RADIX_WORD_COUNT = SqlResultsProvider.STRING_RADIX_PREFIX_CHARS / 2;
    // liczba (JS number/Float64) zajmuje dokładnie 2 słowa 32-bitowe (64-bitowa reprezentacja IEEE-754) - patrz buildNumberWords
    private static readonly NUMBER_RADIX_WORD_COUNT = 2;
    // pojedynczy, reużywany bufor do konwersji Float64 -> bity IEEE-754 (uint32 x2) - unikamy alokacji nowego ArrayBuffer/DataView dla każdej porównywanej wartości
    private static readonly float64Scratch = new DataView(new ArrayBuffer(8));


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
    // AKTUALNA kolejność wyświetlania (naturalna, gdy brak sortowania, albo złożona z cache'y kolumn, gdy sortowanie aktywne) - patrz applySort. Wszystko poza applySort/buildColumnSortCache (sendPage, applySearchFilter, edycje...) czyta/pisze do tego pola dokładnie tak jak dotychczas.
    private _allRows: RowEntry[] = [];
    // niezmienna (nigdy nie przestawiana) kolejność wierszy z zapytania SQL - JEDYNE źródło, z którego buildColumnSortCache buduje grupy; dzięki temu cache zawsze da się poprawnie zbudować niezależnie od tego, w jakiej kolejności aktualnie jest this._allRows
    private _naturalOrderRows: RowEntry[] = [];
    // key -> RowEntry, indeksowane bezpośrednio przez key - budowane RAZ przy każdej zmianie this._naturalOrderRows (patrz rebuildNaturalOrderRowsByKey), a nie przy każdym applySort() - dawniej budowane od nowa przy KAŻDYM kliknięciu sortowania, co dokładało zbędny koszt O(n) do każdej pojedynczej interakcji zamiast tylko do wczytania/zmiany danych
    private _naturalOrderRowsByKey: RowEntry[] = [];
    private _headers: string[] = [];
    private _lastQueryTime = 0;
    private _meta: any[] = [];
    private _columnTypes: string[] = [];
    private _sortKinds: SortKind[] = [];
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
    // pusta tablica = brak aktywnego sortowania (this._allRows w naturalnej kolejności z zapytania SQL); patrz applySort/toggleSort/performSort
    private _sortCriteria: SortCriterion[] = [];
    // cache per kolumna używany przez applySort/composeSortOrder do składania dowolnego sortowania bez ponownego sortowania - patrz ColumnSortCache/buildColumnSortCache. Czyszczony bezwarunkowo przy każdym Ctrl+Enter (executeQuery) i przy usuwaniu wierszy; pojedyncza kolumna jest czyszczona osobno przy edycji komórki w tej kolumnie
    private _sortColumnCache = new Map<number, ColumnSortCache>();
    private _context?: vscode.ExtensionContext;
    // _viewReady === true oznacza, że skrypt JS w webview się załadował i zarejestrował listener – samo `this._view` tego nie gwarantuje
    private _viewReady = false;
    private _resolveViewReady?: (value: boolean) => void;
    private _currentSqlFile = '';
    private _queryRunning = false;
    // numer operacji filtrowania, który pozwala unieważnić poprzednie wyszukiwanie
    private _searchGeneration = 0;
    private readonly SEARCH_YIELD_EVERY = 10000;
    // numer operacji sortowania unieważnia starsze sortowanie po kolejnym kliknięciu
    private _sortGeneration = 0;

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

            if (msg.command === 'sortColumn') {
                // tak jak wyszukiwanie - asynchroniczne (dzieli pracę z applySearchFilter), nie blokuje kolejnych komunikatów
                void this.performSort(msg.columnIndex, msg.additive);
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

            if (msg.command === 'saveCellEdits') {
                await this.saveCellEdits(msg.value, msg.cells);
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

            case 'sortColumn':
                // additive=true -> Shift+klik (dokłada/aktualizuje/usuwa TĘ kolumnę jako kolejne kryterium, nie ruszając pozostałych); additive=false -> zwykły klik (patrz toggleSort)
                return typeof msg.columnIndex === 'number' && typeof msg.additive === 'boolean';

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

            case 'saveCellEdits':
                return typeof msg.value !== 'undefined' &&
                    Array.isArray(msg.cells) && msg.cells.length > 0 && msg.cells.every((cell: any) =>
                        cell && typeof cell === 'object' &&
                        typeof cell.rowKey === 'number' &&
                        typeof cell.columnIndex === 'number' &&
                        typeof cell.columnName === 'string'
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
        // _searchQuery jest już przycięte u źródła (performSearch), nie trzeba tego powtarzać tutaj
        const query = this._searchQuery;

        if (!query) {
            this._filteredEntries = null;
            return true;
        }

        // wyszukiwanie bez rozróżniania wielkości liter, tak jak filtr w większości narzędzi tabelarycznych
        const needle = query.toLowerCase();
        const columnCount = this._headers.length;
        // ZAWSZE this._naturalOrderRows, nigdy this._allRows - dzięki temu wyszukiwanie nigdy nie zależy od tego, czy pełny (potencjalnie milionowy) zbiór jest już posortowany, patrz performSort
        const source = this._naturalOrderRows;
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

        // przefiltrowany zbiór jest zwykle mały - sortujemy go na żywo (bez cache'a per kolumna), patrz compareRowsBySortCriteria
        if (this._sortCriteria.length > 0) {
            filteredEntries.sort((a, b) => this.compareRowsBySortCriteria(a, b));
        }

        this._filteredEntries = filteredEntries;
        return true;
    }

    // obsługuje wyszukiwanie z webview i wysyła pierwszą stronę przefiltrowanych wyników
    private async performSearch(rawQuery: string): Promise<void> {
        if (!this._view) {return;}

        // przycinamy raz u źródła, żeby cały system (fileState, webview State.searchQuery, wiadomości appendData) operował na tej samej, spójnej wartości zamiast każdy konsument robił własny trim
        this._searchQuery = rawQuery.trim();

        const fileState = this._fileStates.get(this._currentSqlFile);
        if (fileState) {
            fileState.searchQuery = this._searchQuery;
        }

        // wyszukiwanie mogło działać z sortowaniem, którego this._allRows jeszcze nie odzwierciedla (performSort pomija applySort przy aktywnym query, patrz tam) - domykamy to tutaj, jednorazowo przy czyszczeniu frazy, zamiast przy każdym kliknięciu sortowania w trakcie wyszukiwania
        if (!this._searchQuery && this._sortCriteria.length > 0) {
            const sortGeneration = ++this._sortGeneration;
            const sorted = await this.applySort(sortGeneration);
            if (!sorted) {return;}
        }

        const completed = await this.applySearchFilter();

        // nowsza fraza unieważnia poprzednie wyszukiwanie i jego wynik
        if (!completed) {
            return;
        }

        // nowe wyszukiwanie zawsze wraca na stronę 1 - poprzednia strona mogła nie istnieć w przefiltrowanym zbiorze
        this.sendPage(1, true, false);
    }

    // przelicza this._naturalOrderRowsByKey - wołane WYŁĄCZNIE przy każdej zmianie this._naturalOrderRows (executeQuery, showResultsForFile, deleteRowsInDB, clearActiveFile), nigdy przy sortowaniu - patrz komentarz przy polu
    private rebuildNaturalOrderRowsByKey(): void {
        const rows = this._naturalOrderRows;
        const maxKey = rows.length > 0 ? rows[rows.length - 1].key : -1;
        const byKey = new Array<RowEntry>(maxKey + 1);
        for (const row of rows) {byKey[row.key] = row;}
        this._naturalOrderRowsByKey = byKey;
    }

    /**
     * Ustawia this._allRows na aktualnie obowiązującą kolejność wyświetlania. Brak kryteriów -> po prostu this._naturalOrderRows (zero pracy).
     * Kryteria aktywne -> composeSortOrder składa finalną kolejność kluczy z cache'y per kolumna (patrz buildColumnSortCache), bez żadnego
     * porównawczego sortowania całego zbioru - jedyna "prawdziwa" praca sortująca to (leniwe, per kolumna) budowanie cache'a przy jego
     * pierwszym użyciu; każda kolejna kombinacja kryteriów (w tym każde zwykłe ASC<->DESC) to już tylko przegrupowanie gotowych danych.
     */
    private async applySort(generation: number = this._sortGeneration): Promise<boolean> {
        if (this._naturalOrderRows.length < 2 || this._sortCriteria.length === 0) {
            this._allRows = this._naturalOrderRows;
            return generation === this._sortGeneration;
        }

        const order = await this.composeSortOrder([...this._sortCriteria], generation);
        if (order === null || generation !== this._sortGeneration) {return false;}

        const keyToRow = this._naturalOrderRowsByKey;
        const sortedRows = new Array<RowEntry>(order.length);
        for (let i = 0; i < order.length; i++) {sortedRows[i] = keyToRow[order[i]];}
        this._allRows = sortedRows;
        return true;
    }

    /**
     * Składa finalną kolejność kluczy dla DOWOLNEJ kombinacji kryteriów z gotowych cache'y per kolumna - bez żadnych porównań, tylko
     * przegrupowanie do koszyków. Przetwarzamy kryteria od NAJMNIEJ do NAJBARDZIEJ istotnego (LSD, jak radix sort na kartach perforowanych):
     * - najmniej istotna kolumna (przetwarzana jako pierwsza, gdy jeszcze nie ma żadnego wyniku niżej do ochrony) - jej flatKeysAsc już JEST
     *   gotową spłaszczoną kolejnością ASC, pogrupowaną wg bucketStart; dla DESC odwracamy TYLKO kolejność grup (bucketów), zachowując
     *   kolejność WEWNĄTRZ każdej grupy bez zmian - dokładnie tak, jak działa natywny SQL ORDER BY (sprawdzone w phpMyAdmin): remisy
     *   (duplikaty wartości, w tym NULL-e) nie zamieniają się wzajemnie miejscami przy zmianie ASC<->DESC, zmienia się tylko kolejność
     *   samych grup wartości
     * - każda kolejna, istotniejsza kolumna - przegrupowuje OBECNY wynik do swoich koszyków (wg keyToBucket) i skleja koszyki rosnąco/malejąco,
     *   tym samym mechanizmem co powyżej (NIE ruszając kolejności WEWNĄTRZ koszyka - to ona niesie porządek ustalony przez mniej istotne
     *   kolumny; odwrócenie całości na tym poziomie zepsułoby np. "colA DESC, colB ASC", odwracając przy okazji colB, którego użytkownik
     *   nie ruszał)
     * Całość na Int32Array (żadnych zagnieżdżonych tablic/Map) - patrz komentarz przy ColumnSortCache, ten sam powód (pamięć przy dużych zbiorach).
     */
    private async composeSortOrder(criteria: SortCriterion[], generation: number): Promise<Int32Array | null> {
        let order: Int32Array | null = null;

        for (let i = criteria.length - 1; i >= 0; i--) {
            const { columnIndex, direction } = criteria[i];

            let cache = this._sortColumnCache.get(columnIndex);
            if (!cache) {
                const built = await this.buildColumnSortCache(columnIndex, generation);
                if (built === null || generation !== this._sortGeneration) {return null;}
                cache = built;
                this._sortColumnCache.set(columnIndex, cache);
            }

            if (order === null) {
                if (direction === 'asc') {
                    // NIE kopiujemy - cache.flatKeysAsc jest tylko CZYTANE na kolejnych, wyższych poziomach (nigdy modyfikowane w miejscu), więc bezpiecznie dzielimy tę samą tablicę z cache'em
                    order = cache.flatKeysAsc;
                } else {
                    // odwracamy TYLKO kolejność grup (bucketStart[b]..bucketStart[b+1]), NIE elementów wewnątrz grupy - patrz komentarz przy funkcji
                    const reversed = new Int32Array(cache.flatKeysAsc.length);
                    let pos = 0;
                    for (let b = cache.bucketStart.length - 2; b >= 0; b--) {
                        for (let p = cache.bucketStart[b]; p < cache.bucketStart[b + 1]; p++) {reversed[pos++] = cache.flatKeysAsc[p];}
                    }
                    order = reversed;
                }
                continue;
            }

            // przeliczamy rozmiar każdego koszyka jednym przejściem, żeby od razu wiedzieć, gdzie w wyniku zaczyna się każdy koszyk (bez trzymania koszyków jako osobnych tablic)
            const bucketCount = cache.bucketStart.length - 1;
            const bucketSize = new Int32Array(bucketCount);
            for (let k = 0; k < order.length; k++) {bucketSize[cache.keyToBucket[order[k]]]++;}

            const writeCursor = new Int32Array(bucketCount);
            if (direction === 'asc') {
                let acc = 0;
                for (let b = 0; b < bucketCount; b++) {writeCursor[b] = acc; acc += bucketSize[b];}
            } else {
                let acc = 0;
                for (let b = bucketCount - 1; b >= 0; b--) {writeCursor[b] = acc; acc += bucketSize[b];}
            }

            const next: Int32Array = new Int32Array(order.length);
            for (let k = 0; k < order.length; k++) {
                const key = order[k];
                const bucket = cache.keyToBucket[key];
                next[writeCursor[bucket]++] = key;
            }
            order = next;
        }

        return order;
    }

    /**
     * Buduje (leniwie, raz na kolumnę - patrz this._sortColumnCache) grupowanie kluczy wg wartości komórki, rosnąco - dokładnie to samo, co
     * dawniej liczył jednorazowy radixSortSingleColumn, tylko że wynik (podział na grupy) zostaje zapamiętany zamiast zaraz wyrzucony. ZAWSZE
     * czyta z this._naturalOrderRows (nigdy this._allRows), dzięki czemu grupy remisowe (ta sama wartość) wychodzą stabilnie w kolejności
     * rosnącej po key - bo naturalOrderRows samo jest już key-ascending, a radixSortIndices jest stabilny (counting sort per bajt).
     */
    private async buildColumnSortCache(columnIndex: number, generation: number): Promise<ColumnSortCache | null> {
        const rows = this._naturalOrderRows;
        const length = rows.length;
        const kind: SortKind = this._sortKinds[columnIndex] ?? 'string';

        const nullKeys: number[] = [];
        const valueRows: RowEntry[] = [];
        for (let i = 0; i < length; i++) {
            const row = rows[i];
            const value = row.data[columnIndex];
            if (value === null || value === undefined) {nullKeys.push(row.key);} else {valueRows.push(row);}
        }

        // flatKeysAsc: grupa NULL na początku (indeks 0 - najmniejsza wartość w SQL ORDER BY), potem realne wartości rosnąco - naturalOrderRows jest już key-ascending, więc nullKeys też, bez dodatkowego sortowania
        const flatKeysAsc = new Int32Array(length);
        flatKeysAsc.set(nullKeys, 0);
        // granice grup zbieramy do zwykłej (płaskiej, nie zagnieżdżonej) tablicy liczb podczas budowy, dopiero na końcu zamieniamy na Int32Array - sama liczba grup może być duża dla kolumn wysokiej kardynalności, ale to JEDNA płaska tablica liczb, nie miliony osobnych obiektów Array
        const bucketStarts: number[] = [0, nullKeys.length];

        if (valueRows.length === 1) {
            flatKeysAsc[nullKeys.length] = valueRows[0].key;
            bucketStarts.push(nullKeys.length + 1);
        } else if (valueRows.length > 1) {
            // 'date' idzie tą samą ścieżką co 'number' (buildNumberWords) - różni się tylko sposobem zamiany wartości komórki na liczbę, patrz resolveNumericValue
            const wordCount = kind === 'string' ? SqlResultsProvider.STRING_RADIX_WORD_COUNT : SqlResultsProvider.NUMBER_RADIX_WORD_COUNT;
            const words = kind === 'string'
                ? SqlResultsProvider.buildStringPrefixWords(valueRows, columnIndex)
                : SqlResultsProvider.buildNumberWords(valueRows, columnIndex, kind);

            const sortedIndices = await this.radixSortIndices(words, valueRows.length, wordCount, generation);
            if (sortedIndices === null) {return null;}

            let writePos = nullKeys.length;
            // grupy o identycznych słowach radix -> doprecyzowanie: dla NUMBER/DATE słowo = pełna wartość (remis = naprawdę ta sama liczba, jedna grupa); dla STRING słowo = tylko prefiks (remis może kryć różne pełne wartości - dogrupowujemy po pełnej wartości)
            let groupStart = 0;
            for (let i = 1; i <= sortedIndices.length; i++) {
                const sameWordGroup = i < sortedIndices.length && SqlResultsProvider.wordsEqual(words, sortedIndices[groupStart], sortedIndices[i], wordCount);
                if (sameWordGroup) {continue;}

                if (kind === 'string' && i - groupStart > 1) {
                    // dogrupowanie po pełnej wartości w obrębie identycznego prefiksu - Map (lokalna, ograniczona do rozmiaru TEJ grupy, nie całego zbioru) zachowuje kolejność pierwszego wystąpienia, a ta jest już key-ascending (radix jest stabilny, valueRows key-ascending u źródła)
                    const queues = new Map<string, number[]>();
                    for (let j = groupStart; j < i; j++) {
                        const idx = sortedIndices[j];
                        const value = valueRows[idx].data[columnIndex] as string;
                        let queue = queues.get(value);
                        if (!queue) {queue = []; queues.set(value, queue);}
                        queue.push(valueRows[idx].key);
                    }
                    for (const value of [...queues.keys()].sort()) {
                        for (const key of queues.get(value)!) {flatKeysAsc[writePos++] = key;}
                        bucketStarts.push(writePos);
                    }
                } else {
                    for (let j = groupStart; j < i; j++) {flatKeysAsc[writePos++] = valueRows[sortedIndices[j]].key;}
                    bucketStarts.push(writePos);
                }

                groupStart = i;
            }
        }

        const bucketStart = Int32Array.from(bucketStarts);

        // key -> indeks grupy, indeksowane bezpośrednio przez key (patrz komentarz przy interfejsie ColumnSortCache) - rozmiar wg NAJWIĘKSZEGO klucza obecnego w zbiorze (nie liczby wierszy!), bo po usunięciu wierszy klucze przestają być ciągłe 0..n-1 (patrz deleteRowsInDB - key nigdy nie jest przenumerowywany)
        const maxKey = length > 0 ? rows[length - 1].key : -1;
        const keyToBucket = new Int32Array(maxKey + 1);
        for (let b = 0; b < bucketStart.length - 1; b++) {
            for (let p = bucketStart[b]; p < bucketStart[b + 1]; p++) {keyToBucket[flatKeysAsc[p]] = b;}
        }

        return { flatKeysAsc, bucketStart, keyToBucket };
    }

    // zamienia surową wartość komórki na liczbę do zapakowania w słowa radix - 'number' wprost przez Number(), 'date' przez parser DATE/DATETIME/TIMESTAMP/TIME (patrz parseDateOrTimeToSortableNumber)
    private static resolveNumericValue(value: number | string, kind: SortKind): number {
        if (kind === 'date') {return SqlResultsProvider.parseDateOrTimeToSortableNumber(typeof value === 'string' ? value : String(value));}
        return typeof value === 'number' ? value : Number(value);
    }

    // null-aware porównanie dwóch surowych wartości komórki wg typu kolumny, do sortowania NA ŻYWO małych zbiorów (patrz compareRowsBySortCriteria) - NULL zawsze najmniejszy, tak jak bucket 0 w buildColumnSortCache; string porównywany operatorami < > (ten sam porządek UTF-16 co charCodeAt w buildStringPrefixWords), number/date przez resolveNumericValue
    private static compareCellValues(a: any, b: any, kind: SortKind): number {
        const aNull = a === null || a === undefined;
        const bNull = b === null || b === undefined;
        if (aNull || bNull) {return aNull === bNull ? 0 : (aNull ? -1 : 1);}

        if (kind === 'string') {
            const av = typeof a === 'string' ? a : String(a);
            const bv = typeof b === 'string' ? b : String(b);
            return av < bv ? -1 : (av > bv ? 1 : 0);
        }

        const av = SqlResultsProvider.resolveNumericValue(a, kind);
        const bv = SqlResultsProvider.resolveNumericValue(b, kind);
        return av < bv ? -1 : (av > bv ? 1 : 0);
    }

    // komparator wielokolumnowy do sortowania NA ŻYWO this._filteredEntries (patrz resortFilteredEntries/applySearchFilter) - bez cache'a per kolumna, bo przefiltrowany zbiór jest zwykle mały; remis wszystkich kryteriów zwraca 0, a stabilność Array.prototype.sort zachowuje wtedy naturalną (key-ascending) kolejność, dokładnie jak bucketowa ścieżka dla pełnego zbioru
    private compareRowsBySortCriteria(a: RowEntry, b: RowEntry): number {
        for (const { columnIndex, direction } of this._sortCriteria) {
            const cmp = SqlResultsProvider.compareCellValues(a.data[columnIndex], b.data[columnIndex], this._sortKinds[columnIndex] ?? 'string');
            if (cmp !== 0) {return direction === 'asc' ? cmp : -cmp;}
        }
        return 0;
    }

    // sortuje this._filteredEntries w miejscu wg aktualnych this._sortCriteria, bez ponownego przeliczania samego wyszukiwania - dopasowania się nie zmieniają, zmienia się tylko ich kolejność, patrz performSort
    private resortFilteredEntries(): void {
        if (!this._filteredEntries || this._sortCriteria.length === 0) {return;}
        this._filteredEntries.sort((a, b) => this.compareRowsBySortCriteria(a, b));
    }

    // pakuje wartości liczbowe/datowe kolumny w słowa 32-bitowe (2 słowa = 64-bitowa reprezentacja IEEE-754 double) - gęsta tablica indeksowana wprost pozycją w 'rows' (bez cache, bez indeksowania po row.key)
    private static buildNumberWords(rows: RowEntry[], columnIndex: number, kind: SortKind): Uint32Array {
        const length = rows.length;
        const words = new Uint32Array(length * SqlResultsProvider.NUMBER_RADIX_WORD_COUNT);
        for (let i = 0; i < length; i++) {
            const numericValue = SqlResultsProvider.resolveNumericValue(rows[i].data[columnIndex], kind);
            const [hi, lo] = SqlResultsProvider.encodeFloat64SortableWords(numericValue);
            words[i * 2] = hi;
            words[i * 2 + 1] = lo;
        }
        return words;
    }

    // zamienia liczbę na dwa słowa 32-bitowe tak, żeby zwykłe porównanie bez znaku (jak w radix sorcie) odpowiadało prawdziwemu porządkowi liczbowemu IEEE-754
    private static encodeFloat64SortableWords(numericValue: number): [number, number] {
        SqlResultsProvider.float64Scratch.setFloat64(0, numericValue, false);
        let hi = SqlResultsProvider.float64Scratch.getUint32(0, false);
        let lo = SqlResultsProvider.float64Scratch.getUint32(4, false);

        // standardowa sztuczka bitowa: liczby ujemne (bit znaku=1) odwracamy całe, nieujemne (bit znaku=0) odwracamy tylko bit znaku - bez tego -5 wypadłoby "większe" niż 5 przy prostym porównaniu bitowym
        if ((hi & 0x80000000) !== 0) {
            hi = (~hi) >>> 0;
            lo = (~lo) >>> 0;
        } else {
            hi = (hi | 0x80000000) >>> 0;
        }

        return [hi, lo];
    }

    // pakuje pierwsze STRING_RADIX_PREFIX_CHARS znaków (jednostek UTF-16) stringa w słowa 32-bitowe, po 2 znaki na słowo - gęsta tablica indeksowana wprost pozycją w 'rows'
    private static buildStringPrefixWords(rows: RowEntry[], columnIndex: number): Uint32Array {
        const length = rows.length;
        const wordCount = SqlResultsProvider.STRING_RADIX_WORD_COUNT;
        const words = new Uint32Array(length * wordCount);

        for (let i = 0; i < length; i++) {
            const raw = rows[i].data[columnIndex];
            const value = typeof raw === 'string' ? raw : String(raw);
            const offset = i * wordCount;
            for (let w = 0; w < wordCount; w++) {
                const charIndex = w * 2;
                // brakujące znaki (string krótszy niż prefiks) dopełniamy zerami - to sortuje się PRZED każdym prawdziwym znakiem, więc "ab" trafia przed "abc" tak jak w zwykłym porządku leksykograficznym; pełne rozstrzygnięcie w razie potrzeby i tak dostaje grupa remisowa (patrz buildColumnSortCache)
                const c0 = charIndex < value.length ? value.charCodeAt(charIndex) : 0;
                const c1 = charIndex + 1 < value.length ? value.charCodeAt(charIndex + 1) : 0;
                words[offset + w] = ((c0 << 16) | c1) >>> 0;
            }
        }

        return words;
    }

    // porównuje wordCount słów dwóch pozycji bez odczytywania oryginalnej wartości
    private static wordsEqual(words: Uint32Array, a: number, b: number, wordCount: number): boolean {
        const aOffset = a * wordCount, bOffset = b * wordCount;
        for (let w = 0; w < wordCount; w++) {
            if (words[aOffset + w] !== words[bOffset + w]) {return false;}
        }
        return true;
    }

    // generyczny LSD radix sort (najmniej znaczący bajt najpierw) na dowolnej liczbie słów 32-bitowych - działa identycznie dla liczb (2 słowa) i prefiksów stringów (4 słowa); zwraca ROSNĄCO posortowaną permutację indeksów 0..length-1 (kierunek/desc obsługiwany przez wywołującego), albo null jeśli generation przestało być aktualne w trakcie oddawania event loop
    private async radixSortIndices(words: Uint32Array, length: number, wordCount: number, generation: number): Promise<Uint32Array | null> {
        let source = new Uint32Array(length);
        for (let i = 0; i < length; i++) {source[i] = i;}
        let target = new Uint32Array(length);
        const counts = new Uint32Array(256);

        for (let word = wordCount - 1; word >= 0; word--) {
            for (let byte = 0; byte < 4; byte++) {
                counts.fill(0);
                const shift = byte * 8;

                for (let i = 0; i < length; i++) {
                    counts[(words[source[i] * wordCount + word] >>> shift) & 0xff]++;
                }

                let total = 0;
                for (let i = 0; i < 256; i++) {
                    const count = counts[i];
                    counts[i] = total;
                    total += count;
                }

                for (let i = 0; i < length; i++) {
                    const idx = source[i];
                    const bucket = (words[idx * wordCount + word] >>> shift) & 0xff;
                    target[counts[bucket]++] = idx;
                }

                const swap = source;
                source = target;
                target = swap;

                // yield PO KAŻDYM przebiegu bajtowym, nie dopiero po całym słowie (4 przebiegi) - inaczej pojedyncza blokada event loop rośnie 4x (zmierzone: po słowie ~108ms max_lag przy 200k, po bajcie ~25-30ms)
                await new Promise<void>((resolve) => setImmediate(resolve));
                if (generation !== this._sortGeneration) {return null;}
            }
        }

        return source;
    }


    /**
     * Aktualizuje this._sortCriteria na podstawie kliknięcia strzałki sortowania w danej kolumnie.
     * Zwykły klik (additive=false): jeśli ta kolumna jest JEDYNYM aktywnym kryterium, cyklujemy jej kierunek
     * (asc -> desc -> brak sortowania); w przeciwnym razie staje się nowym, jedynym kryterium (reszta czyszczona) -
     * to zachowanie jednokolumnowe, znane z wcześniejszej wersji tej funkcji.
     * Shift+klik (additive=true): dokłada/aktualizuje/usuwa TĘ kolumnę jako kolejne kryterium na końcu listy priorytetów,
     * nie ruszając pozostałych - pozwala budować sortowanie wielokolumnowe (ORDER BY col1, col2, ...).
     */
    private toggleSort(columnIndex: number, additive: boolean): void {
        const existingIndex = this._sortCriteria.findIndex((c) => c.columnIndex === columnIndex);

        if (!additive) {
            const isSoleCriterion = this._sortCriteria.length === 1 && existingIndex === 0;

            if (isSoleCriterion) {
                const current = this._sortCriteria[0].direction;
                this._sortCriteria = (current === 'asc') ? [{ columnIndex, direction: 'desc' }] : [];
            } else {
                this._sortCriteria = [{ columnIndex, direction: 'asc' }];
            }
            return;
        }

        if (existingIndex === -1) {
            this._sortCriteria = [...this._sortCriteria, { columnIndex, direction: 'asc' }];
        } else if (this._sortCriteria[existingIndex].direction === 'asc') {
            this._sortCriteria = this._sortCriteria.map((c, i) => (i === existingIndex ? { columnIndex, direction: 'desc' } : c));
        } else {
            this._sortCriteria = this._sortCriteria.filter((_, i) => i !== existingIndex);
        }
    }

    // obsługuje kliknięcie strzałki sortowania w webview - aktualizuje listę kryteriów, przelicza filtr wyszukiwania (jego dopasowania się nie zmieniają, ale ich kolejność już tak) i wysyła stronę 1
    private async performSort(columnIndex: number, additive: boolean): Promise<void> {
        if (!this._view) {return;}
        if (columnIndex < 0 || columnIndex >= this._headers.length) {return;}

        this._sortGeneration++;
        const generation = this._sortGeneration;
        this.toggleSort(columnIndex, additive);

        const fileState = this._fileStates.get(this._currentSqlFile);
        if (fileState) {
            fileState.sortCriteria = this._sortCriteria;
        }

        if (this._searchQuery) {
            // przy aktywnym wyszukiwaniu w ogóle nie dotykamy pełnego zbioru/cache'a kolumn - sortujemy tylko już przefiltrowany (zwykle mały) podzbiór, patrz resortFilteredEntries; this._allRows zostaje na razie nieaktualne, domykane dopiero przy skasowaniu wyszukiwania w performSearch
            this.resortFilteredEntries();
            this.sendPage(1, true, false);
            return;
        }

        const sorted = await this.applySort(generation);
        if (!sorted) {return;}

        const completed = await this.applySearchFilter();
        if (!completed || generation !== this._sortGeneration) {return;}

        // nowe sortowanie zawsze wraca na stronę 1 - poprzednia strona mogła nie odpowiadać już tym samym wierszom
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
                // backend jest źródłem prawdy dla sortowania - webview synchronizuje z tym strzałki (i numery priorytetu) w nagłówku
                sortCriteria: this._sortCriteria,
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
    // określa strategię sortowania na podstawie metadanych wyniku SQL - WYŁĄCZNIE na podstawie field.type (bez próbkowania wartości, bez specjalnego traktowania UUID - patrz NUMERIC_SORT_TYPE_NAMES/DATE_SORT_TYPE_NAMES); wszystko poza tymi listami to 'string', w tym VARCHAR/CHAR (raportowane przez driver jako VAR_STRING/STRING)
    private computeSortKinds(meta: any[]): SortKind[] {
        return meta.map((field: any) => {
            const type = String(field?.type ?? '').toUpperCase();
            if (SqlResultsProvider.NUMERIC_SORT_TYPE_NAMES.has(type)) {return 'number';}
            if (SqlResultsProvider.DATE_SORT_TYPE_NAMES.has(type)) {return 'date';}
            return 'string';
        });
    }

    /**
     * Zamienia string DATE/DATETIME/TIMESTAMP/TIME (dateStrings:true, patrz Connection.ts) na liczbę porządkującą wartości tak samo jak
     * natywny SQL ORDER BY - dzięki temu kolumna typu 'date' idzie tą samą szybką ścieżką radix co 'number' (pełna wartość w kluczu,
     * bez dużych grup remisowych jak przy sortowaniu prefiksu stringa - patrz buildStringPrefixWords). Nie jest to prawdziwy unix time
     * (DATE/DATETIME są bez strefy czasowej), liczy się wyłącznie monotoniczność względem innych wartości tej samej kolumny.
     * '0000-00-00'/'0000-00-00 00:00:00' (MySQL dopuszcza taki "zerowy" DATE/DATETIME) oraz wartości niepasujące do żadnego wzorca -> 0,
     * czyli najmniejsza możliwa wartość, tak jak sugerował użytkownik.
     */
    private static parseDateOrTimeToSortableNumber(value: string): number {
        const trimmed = value.trim();

        const dateMatch = SqlResultsProvider.DATE_STRING_PATTERN.exec(trimmed);
        if (dateMatch) {
            const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, fracStr] = dateMatch;
            const year = Number(yearStr);
            const month = Number(monthStr);
            const day = Number(dayStr);
            if (year === 0 || month === 0 || day === 0) {return 0;} // zerowy DATE/DATETIME MySQL
            const hour = hourStr ? Number(hourStr) : 0;
            const minute = minuteStr ? Number(minuteStr) : 0;
            const second = secondStr ? Number(secondStr) : 0;
            const fracMs = fracStr ? Number(fracStr.padEnd(3, '0').slice(0, 3)) : 0; // mikrosekundy (fsp do 6 cyfr) obcinamy do milisekund - wystarczająca precyzja do sortowania
            return Date.UTC(year, month - 1, day, hour, minute, second, fracMs);
        }

        const timeMatch = SqlResultsProvider.TIME_STRING_PATTERN.exec(trimmed);
        if (timeMatch) {
            const [, signStr, hourStr, minuteStr, secondStr, fracStr] = timeMatch;
            const sign = signStr === '-' ? -1 : 1;
            const totalMs = ((Number(hourStr) * 3600 + Number(minuteStr) * 60 + Number(secondStr)) * 1000)
                + (fracStr ? Number(fracStr.padEnd(3, '0').slice(0, 3)) : 0);
            return sign * totalMs;
        }

        return 0; // wartość niepasująca do żadnego znanego formatu - traktujemy jak zerowy DATE/DATETIME
    }


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

            // obsługa NULL (można wpisywać tak: null, NULL) i konwersja typu zgodnie z kolumną (np. BIT: string -> number)
            value = normalizeValueForField(value, field);
            
            await db.query(updateSQL, [value, ...whereValues]);

            row[columnIndex] = value;
            // wartość w tej kolumnie mogła się zmienić - cache jej grupowania (patrz this._sortColumnCache) jest nieaktualny, reszta kolumn zostaje ważna
            this._sortColumnCache.delete(columnIndex);

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

            const displayValues = pkValueTuples.map((tuple) => tuple.join(', ')).join('; ');
            vscode.window.showInformationMessage(
                `✅ Deleted from ${tableName}: ${displayValues}`
            );

            // zamiast lokalnie filtrować cache, wymuszamy pełny re-run zapytania - re-run tym samym sql/sqlFile zostaje na tej samej stronie/filtrze/sortowaniu
            await this.executeQuery(this._lastSQL, this._currentSqlFile);
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

            const columnInfoByName = new Map(columns.map((c) => [c.name, c]));

            const normalizedEdits = edits.map((edit) => {
                const value = normalizeValueForField(edit.value, columnInfoByName.get(edit.columnName)?.field);
                return { ...edit, value };
            });

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
                // wartości w tej kolumnie mogły się zmienić - jej cache grupowania jest nieaktualny (patrz this._sortColumnCache), reszta kolumn zostaje ważna
                this._sortColumnCache.delete(edit.columnIndex);
            }

            // wartości mogły się zmienić w kolumnie, po której filtruje aktywne wyszukiwanie - przeliczamy, jakie wiersze nadal pasują
            await this.applySearchFilter();

            // odśwież widok: znika czerwone podświetlenie kolumny i przycisk zapisu, komórki pokazują nową wartość
            this.sendPage(this._currentPage, true);

            const columnNames = normalizedEdits.map((e) => `\`${e.columnName}\``).join(', ');
            // vscode.window.showInformationMessage(
            //     `✅ Updated ${columnNames} for ${recordCount} record(s) in ${tableName}`
            // );
        } catch (err: any) {
            console.error('Column bulk update error:', err);
            vscode.window.showErrorMessage(`❌ Column bulk update error: ${err.message}`);
            this._view?.webview.postMessage({ command: 'columnEditsCancelled' });
        }
    }

    /**
     * Zbiorcza edycja NIEZALEŻNIE ZAZNACZONYCH KOMÓREK (nowa funkcja, osobna od saveColumnEdits) -
     * wszystkie przekazane komórki dostają tę samą nową wartość. Zakres to wyłącznie komórki
     * przekazane z webview (bieżąca strona, w przeciwieństwie do saveColumnEdits, które obejmuje
     * całe wyniki SQL) - stąd rowKey adresujący pojedynczy wiersz zamiast globalnego WHERE ... IN
     * po wszystkich rekordach. Minimalizacja liczby SQL-i: komórki grupujemy najpierw po wierszu
     * (jeden UPDATE z wieloma SET dla wiersza z kilkoma zaznaczonymi kolumnami), a potem wiersze
     * o dokładnie tym samym zestawie edytowanych kolumn scalamy w jeden UPDATE z WHERE pk IN (...),
     * analogicznie do mechanizmu WHERE IN z saveColumnEdits (celowo nie wydzielony jako wspólna
     * funkcja - to kilkanaście prostych linii, a duplikacja jest tu czytelniejsza niż pośredni helper).
     */
    private async saveCellEdits(
        value: any,
        cells: { rowKey: number; rowIndex: number; columnIndex: number; columnName: string }[]
    ) {
        if (!cells || cells.length === 0) {
            return;
        }

        try {
            const context = await this.resolveTableContext();
            if (!context) {
                this._view?.webview.postMessage({ command: 'cellEditsCancelled' });
                return;
            }

            const { tableName, qualifiedTable, columns, primaryKeys } = context;

            // bezpieczeństwo: columnName z webview trafia wprost do UPDATE (SET `<columnName>` = ?), musi być zweryfikowane tak samo jak w saveColumnEdits
            const trustedColumnNames = new Set(columns.map((c) => c.name));
            const unknownColumn = cells.find((cell) => !trustedColumnNames.has(cell.columnName));
            if (unknownColumn) {
                vscode.window.showErrorMessage(`Refusing to update unknown column "${unknownColumn.columnName}"`);
                this._view?.webview.postMessage({ command: 'cellEditsCancelled' });
                return;
            }

            // rowKey to stabilny identyfikator wiersza (patrz RowEntry) - mapujemy na realny wiersz w this._allRows, żadnej arytmetyki page-relative -> global
            const entryByRowKey = new Map(cells.map((cell) => [cell.rowKey, this._allRows.find((r) => r.key === cell.rowKey)]));
            if ([...entryByRowKey.values()].some((entry) => !entry)) {
                vscode.window.showErrorMessage('Row not found for one of the selected cells');
                this._view?.webview.postMessage({ command: 'cellEditsCancelled' });
                return;
            }

            const columnInfoByName = new Map(columns.map((c) => [c.name, c]));

            // normalizeValueForField zależy od typu kolumny (np. BIT), a ta sama wartość może trafić do różnych kolumn - liczymy normalizację osobno per nazwa kolumny
            const normalizedValueByColumnName = new Map<string, unknown>();
            for (const cell of cells) {
                if (!normalizedValueByColumnName.has(cell.columnName)) {
                    normalizedValueByColumnName.set(
                        cell.columnName,
                        normalizeValueForField(value, columnInfoByName.get(cell.columnName)?.field)
                    );
                }
            }

            // grupujemy komórki wg rowKey - wiersz z kilkoma zaznaczonymi kolumnami dostanie jeden UPDATE z wieloma SET (ta sama wartość w każdym SET)
            const columnNamesByRowKey = new Map<number, string[]>();
            for (const cell of cells) {
                const list = columnNamesByRowKey.get(cell.rowKey) ?? [];
                if (!list.includes(cell.columnName)) {
                    list.push(cell.columnName);
                }
                columnNamesByRowKey.set(cell.rowKey, list);
            }

            // wiersze o dokładnie tym samym zestawie edytowanych kolumn scalają się w jeden UPDATE z WHERE pk IN (...)
            const rowKeysByColumnSet = new Map<string, number[]>();
            for (const [rowKey, columnNames] of columnNamesByRowKey) {
                const setKey = [...columnNames].sort().join('\u0000');
                const list = rowKeysByColumnSet.get(setKey) ?? [];
                list.push(rowKey);
                rowKeysByColumnSet.set(setKey, list);
            }

            const pkColumnNames = primaryKeys.map((pk) => `\`${pk.name}\``);

            const updates: { sql: string; values: any[] }[] = [];

            for (const [setKey, rowKeys] of rowKeysByColumnSet) {
                const columnNames = setKey.split('\u0000');

                const pkValueTuples = rowKeys
                    .map((rowKey) => entryByRowKey.get(rowKey)!.data)
                    .map((row) => primaryKeys.map((pk) => row[pk.index]));

                // sortujemy ID przed wstawieniem do UPDATE-u, żeby były czytelne w logach SQL - tak samo jak w saveColumnEdits
                pkValueTuples.sort((tupleA, tupleB) => this.comparePkTuples(tupleA, tupleB));

                let whereClause: string;
                let whereValues: any[];

                if (pkColumnNames.length === 1) {
                    const placeholders = pkValueTuples.map(() => '?').join(', ');
                    whereClause = `${pkColumnNames[0]} IN (${placeholders})`;
                    whereValues = pkValueTuples.map((tuple) => tuple[0]);
                } else {
                    const tuplePlaceholder = `(${pkColumnNames.map(() => '?').join(', ')})`;
                    const placeholders = pkValueTuples.map(() => tuplePlaceholder).join(', ');
                    whereClause = `(${pkColumnNames.join(', ')}) IN (${placeholders})`;
                    whereValues = pkValueTuples.flat();
                }

                const setClause = columnNames.map((name) => `\`${name}\` = ?`).join(', ');
                const setValues = columnNames.map((name) => normalizedValueByColumnName.get(name));

                updates.push({
                    sql: `UPDATE ${qualifiedTable} SET ${setClause} WHERE ${whereClause}`,
                    values: [...setValues, ...whereValues]
                });
            }

            const firstColumnName = cells[0].columnName;
            const valuePreview = formatSqlValue(normalizedValueByColumnName.get(firstColumnName), columnInfoByName.get(firstColumnName)?.field);

            const db = await this.getDbForCurrentFile();

            const confirmed = await this.confirmDestructiveOperation(
                `Change ${cells.length} cell(s) across ${columnNamesByRowKey.size} record(s) in table "${tableName}" to ${valuePreview}? ` +
                `This cannot be undone.`,
                'Update',
                db
            );
            if (!confirmed) {
                this._view?.webview.postMessage({ command: 'cellEditsCancelled' });
                return;
            }

            await db.startTransaction();
            try {
                for (const update of updates) {
                    await db.query(update.sql, update.values);
                }
                await db.commit();
            } catch (err) {
                await db.rollback();
                throw err;
            }

            // backend jest źródłem prawdy - odzwierciedlamy zmianę w this._allRows dla wszystkich edytowanych komórek
            for (const cell of cells) {
                const entry = entryByRowKey.get(cell.rowKey)!;
                entry.data[cell.columnIndex] = normalizedValueByColumnName.get(cell.columnName);
            }
            // wartości w tych kolumnach mogły się zmienić - ich cache grupowania jest nieaktualny (patrz this._sortColumnCache), pozostałe kolumny zostają ważne
            for (const cell of cells) {this._sortColumnCache.delete(cell.columnIndex);}

            // wartości mogły się zmienić w kolumnie, po której filtruje aktywne wyszukiwanie - przeliczamy, jakie wiersze nadal pasują
            await this.applySearchFilter();

            // odśwież widok: znika czerwone podświetlenie komórek i przyciski zapisu, komórki pokazują nową wartość
            this.sendPage(this._currentPage, true);

            // vscode.window.showInformationMessage(
            //     `✅ Updated ${cells.length} cell(s) across ${columnNamesByRowKey.size} record(s) in ${tableName}`
            // );
        } catch (err: any) {
            console.error('Cell bulk update error:', err);
            vscode.window.showErrorMessage(`❌ Cell bulk update error: ${err.message}`);
            this._view?.webview.postMessage({ command: 'cellEditsCancelled' });
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

    /**
     * Zwalnia STARE dane (jeśli ten plik był już wcześniej uruchomiony) - zarówno pola instancji, jak i wpis w _fileStates - PRZED
     * uruchomieniem nowego zapytania, żeby nie zajmowały pamięci w tym samym momencie, w którym zapytanie zaczyna alokować pamięć na
     * (potencjalnie miliony) nowych wierszy. Samo wyzerowanie pól instancji NIE wystarczyłoby - _fileStates.get(sqlFile) trzyma DRUGĄ
     * referencję do tych samych starych wierszy/cache'a sortowania (patrz _fileStates.set w executeQuery), a ten wpis normalnie zostaje
     * nadpisany dopiero na samym końcu executeQuery, czyli przez CAŁY czas trwania zapytania stare dane i tak byłyby osiągalne i GC nie
     * mógłby ich zwolnić. Nie usuwamy całego wpisu w _fileStates - sql/currentPage/searchQuery są jeszcze potrzebne w executeQuery po
     * zapytaniu (patrz previousFileState/isSameQueryAsBefore), więc mutujemy go w miejscu, zwalniając tylko ciężkie pola.
     * CELOWO osobna metoda (nie inline w executeQuery) - poza czytelnością, odseparowanie od dalszej części executeQuery zapobiega dziwnej
     * usterce w analizie przepływu sterowania TypeScript, która przy tych samych przypisaniach zrobionych inline potrafiła błędnie zwęzić
     * typ this._allRows do "never" kawałek dalej w tej samej funkcji (mimo jawnie zadeklarowanego typu pola RowEntry[]).
     */
    private resetStateBeforeQuery(sqlFile: string): void {
        this._sortCriteria = [];
        this._sortColumnCache = new Map();
        this._sortGeneration++;

        this._allRows = [];
        this._naturalOrderRows = [];
        this._naturalOrderRowsByKey = [];
        this._filteredEntries = null;
        this._searchGeneration++; // unieważnia ewentualne wciąż trwające applySearchFilter liczone na starych danych

        const existingFileState = this._fileStates.get(sqlFile);
        if (existingFileState) {
            existingFileState.rows = [];
            existingFileState.sortColumnCache = new Map();
        }
    }

    public async executeQuery(sql: string, sqlFile: string, wholeFile = false) {
        this._currentSqlFile = sqlFile;

        // czyścimy PRZED uruchomieniem zapytania (nie po, jak poprzednio) - zapytanie i materializacja wielu milionów wierszy same w sobie potrzebują sporo pamięci, a stare dane (potencjalnie po wielu kliknięciach na różne kolumny) nie powinny w tym momencie nadal jej zajmować - patrz komentarz przy resetStateBeforeQuery
        this.resetStateBeforeQuery(sqlFile);

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
        this._naturalOrderRows = rows.map((data: any[]) => ({ key: nextKey++, data }));
        this.rebuildNaturalOrderRowsByKey();
        this._allRows = this._naturalOrderRows;
        this._headers = headers;
        this._lastSQL = sql;
        this._meta = meta;
        this._sortKinds = success && Array.isArray(meta) ? this.computeSortKinds(meta) : [];
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

        // sortowanie i jego cache zostały już wyczyszczone na samym początku funkcji (przed uruchomieniem zapytania) - tutaj tylko przeliczamy this._allRows z (pustych) kryteriów, więc to zawsze trywialny, szybki branch (patrz applySort)
        const sortGeneration = this._sortGeneration;
        const sorted = await this.applySort(sortGeneration);
        if (!sorted) {return;}

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
            rows: this._naturalOrderRows,
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
            sortCriteria: this._sortCriteria,
            sortColumnCache: this._sortColumnCache,
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
        this._naturalOrderRows = [];
        this._naturalOrderRowsByKey = [];
        this._headers = [];
        this._meta = [];
        this._columnTypes = [];
        this._searchQuery = '';
        this._filteredEntries = null;
        this._sortCriteria = [];
        this._sortColumnCache = new Map();

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
        // state.rows to ZAWSZE naturalna kolejność (patrz FileResultState.rows) - this._allRows odtwarzamy niżej przez applySort(), korzystając z zapamiętanego cache'a kolumn (state.sortColumnCache), więc nawet aktywne sortowanie wraca bez ponownego liczenia
        this._naturalOrderRows = state.rows;
        this.rebuildNaturalOrderRowsByKey();
        this._headers = state.headers;
        this._lastSQL = state.sql;
        this._meta = state.meta;
        this._columnTypes = state.columnTypes ?? [];
        this._sortKinds = Array.isArray(this._meta) ? this.computeSortKinds(this._meta) : [];
        this._lastQueryTime = state.queryTime;
        this._connectionName = state.connectionName;
        this._connectionTime = state.connectionTime;
        this._connectionColor = state.connectionColor ?? null;
        this._isProduction = state.isProduction ?? false;
        this._isReadOnly = state.isReadOnly ?? false;
        this._currentPage = state.currentPage ?? 1;
        this._sortCriteria = state.sortCriteria ?? [];
        this._sortColumnCache = state.sortColumnCache ?? new Map();
        this._sortGeneration++;
        const sorted = await this.applySort(this._sortGeneration);
        if (!sorted) {return;}
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
            sortCriteria: this._sortCriteria,
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