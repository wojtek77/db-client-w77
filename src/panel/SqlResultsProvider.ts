import * as vscode from 'vscode';
import { getHtml } from './html.js';
import { executeQuery, executeQueryWholeFile } from '../db/query.js';
import { ConnectionManager } from '../db/ConnectionManager.js';
import { Connection } from '../db/Connection.js';
import { RecentSqlFiles } from '../recentFiles/RecentSqlFiles.js';
import { ConnectionColors } from '../db/ConnectionColors.js';
import { TableColumnsCache } from '../cache/TableColumnsCache.js';
import { formatSqlValue, normalizeValueForField } from '../sql/formatSqlValue.js';
import { resolvePrimaryKeyColumns, comparePkTuples } from '../sql/resolvePrimaryKeyColumns.js';
import { pickInsertGenerationOptions, buildInsertSql, getDroppedInsertOptions } from '../sql/insertSqlGenerator.js';
import { pickUpdateGenerationOptions, buildUpdateSql, getDroppedUpdateOptions } from '../sql/updateSqlGenerator.js';
import { pickDeleteGenerationOptions, buildDeleteSql } from '../sql/deleteSqlGenerator.js';
import { resolveTableContext } from '../sql/resolveTableContext.js';
import { computeSortKinds, computeColumnTypes } from '../sql/fieldMetadata.js';
import { ColumnSortCache } from './sortPaging.js';
import { getMultiColumnPageKeys, MultiColumnSortContext } from './multiColumnSortPaging.js';
import { SortKind, buildColumnSortCache, resolveNumericValue, compareCellValues } from './radixEngine.js';
import { isValidWebviewMessage } from './webviewMessages.js';
import { confirmDestructiveOperation } from './confirmDestructiveOperation.js';
import { exportRowsToCsv, exportRowsToTxt, saveAndCopyGeneratedSql } from './resultsExport.js';

/** Pojedyncze kryterium sortowania wielokolumnowego - kolejność w tablicy this._sortCriteria decyduje o priorytecie (pierwszy element = główne sortowanie, kolejne rozstrzygają remisy poprzedniego), dokładnie jak w SQL ORDER BY col1, col2, ... */
interface SortCriterion {
    columnIndex: number;
    direction: 'asc' | 'desc';
}

interface FileResultState {
    // dane dokładnie w kolejności z zapytania SQL, nigdy nieprzestawiane - patrz this._allRows; strony po przywróceniu pliku liczone są leniwie z tego + sortCriteria + sortColumnCache (patrz getSortedPageKeys)
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
    searchQuery: string;
    sortCriteria: SortCriterion[];
    // cache per kolumna (patrz ColumnSortCache) zapamiętany razem z resztą stanu pliku, żeby powrót do zakładki nie wymagał ponownego liczenia grup
    sortColumnCache: Map<number, ColumnSortCache>;
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
    // dane wyniku SQL dokładnie w kolejności, w jakiej przyszły z bazy - NIGDY nieprzestawiane (edycja komórki mutuje wartość w miejscu, ale nie kolejność/skład tablicy); indeks w tej tablicy pełni rolę stabilnego identyfikatora wiersza (dawny "key") używanego przy adresowaniu z webview
    private _allRows: any[][] = [];
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
    // indeksy do this._allRows pasujące do _searchQuery, w kolejności wyświetlania; null = brak aktywnego filtra (wtedy sendPage liczy stronę leniwie z this._allRows/this._sortCriteria, patrz getSortedPageKeys)
    private _filteredIndices: number[] | null = null;
    // fraza (lowercase), z której zbudowano aktualne this._filteredIndices - null gdy brak filtra; używane przez applySearchFilter do zawężania zamiast pełnego skanu
    private _filteredIndicesQuery: string | null = null;
    // referencja do this._allRows, z której zbudowano this._filteredIndices - dopasowania sprzed zmiany pliku/rerunu SQL są dla innej tablicy, więc nie wolno ich zawężać (patrz applySearchFilter)
    private _filteredIndicesDataset: any[][] | null = null;
    // pusta tablica = brak aktywnego sortowania (this._allRows w naturalnej kolejności z zapytania SQL); patrz applySort/toggleSort/performSort
    private _sortCriteria: SortCriterion[] = [];
    // cache TYLKO dla kolumny najważniejszego kryterium (this._sortCriteria[0]), TYLKO dla pełnego zbioru (this._allRows) - kolejne, mniej istotne kryteria NIE mają globalnego cache'a wcale, bo getMultiColumnPageKeys (patrz multiColumnSortPaging.ts) dogrupowuje je leniwie, lokalnie, tylko dla akurat trafionej strony grupy remisowej. Odpowiednik dla przefiltrowanego podzbioru przy aktywnym wyszukiwaniu - patrz this._filteredPrimaryColumnCache. Czyszczony bezwarunkowo przy każdym Ctrl+Enter (executeQuery) i przy usuwaniu wierszy; pojedyncza kolumna jest czyszczona osobno przy edycji komórki w tej kolumnie (patrz invalidateColumnSortCache)
    private _sortColumnCache = new Map<number, ColumnSortCache>();
    /**
     * Odpowiednik this._sortColumnCache, ale dla this._filteredIndices (aktywne wyszukiwanie) zamiast this._allRows - patrz applyFilteredPrimarySort.
     * Kluczowany PARĄ (columnIndex, searchGeneration), nie samym columnIndex jak this._sortColumnCache - bo tu "ten sam zbiór danych" oznacza
     * "tę samą frazę wyszukiwania", a nie po prostu "cały czas ten sam this._allRows". Dzięki temu Shift+klik na drugie/trzecie kryterium
     * (np. study_id, study_group_id PO agency_id) podczas wyszukiwania NIE przelicza radixu dla agency_id od nowa - dokładnie tak samo jak
     * przy pełnym zbiorze, gdzie applySort() też liczy kolumnę #0 tylko raz, niezależnie od tego, ile kolejnych kryteriów dojdzie później.
     */
    private _filteredPrimaryColumnCache: { columnIndex: number; searchGeneration: number; cache: ColumnSortCache } | null = null;
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
            if (!isValidWebviewMessage(msg)) {
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
                await exportRowsToCsv(this._context, this._headers, this._allRows);
            }
            
            if (msg.command === 'exportTXT') {
                await exportRowsToTxt(this._context, this._headers, this._allRows);
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
    
    public isQueryRunning(): boolean {
        return this._queryRunning;
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
            this._filteredIndices = null;
            this._filteredIndicesQuery = null;
            this._filteredIndicesDataset = null;
            // this._filteredPrimaryColumnCache POCHODZI z this._filteredIndices - jak znika jedno, musi zniknąć i drugie, tutaj, wprost,
            // a nie jako efekt uboczny późniejszego applyFilteredPrimarySort() w performSearch (za bardzo niejawna zależność między metodami)
            this._filteredPrimaryColumnCache = null;
            return true;
        }

        // wyszukiwanie bez rozróżniania wielkości liter, tak jak filtr w większości narzędzi tabelarycznych
        const needle = query.toLowerCase();
        const columnCount = this._headers.length;

        // dopisanie liter do wcześniej wyszukanej frazy (np. "a" -> "ab") może tylko zawęzić poprzedni zbiór trafień, nigdy go poszerzyć -
        // wtedy przeszukujemy wyłącznie this._filteredIndices z poprzedniego przebiegu zamiast całego this._allRows od nowa. Warunek dataset
        // === this._allRows (referencja, nie zawartość) chroni przed zawężeniem po zmianie pliku/rerunie SQL, gdzie stare indeksy wskazywałyby na zupełnie inną tablicę
        const canNarrow = this._filteredIndices !== null
            && this._filteredIndicesQuery !== null
            && this._filteredIndicesDataset === this._allRows
            && needle.startsWith(this._filteredIndicesQuery);
        // przy zawężaniu skanujemy tylko poprzednie dopasowania (indeksy do this._allRows), w przeciwnym razie cały zbiór w naturalnej kolejności
        const candidateIndices = canNarrow ? this._filteredIndices : null;
        // zawsze this._allRows (niezmienne), nigdy przez cache sortowania - dzięki temu wyszukiwanie nigdy nie zależy od tego, czy pełny (potencjalnie milionowy) zbiór jest już posortowany, patrz performSort
        const source = this._allRows;
        const scanCount = candidateIndices ? candidateIndices.length : source.length;
        const filteredIndices: number[] = [];

        // przetwarzamy rekordy partiami, aby event loop mógł obsłużyć nowe wyszukiwanie
        for (let i = 0; i < scanCount; i++) {
            // nowe wyszukiwanie albo zmiana danych unieważniły tę operację
            if (generation !== this._searchGeneration) {
                return false;
            }

            // przy zawężaniu i-ty krok to poprzednie trafienie, w przeciwnym razie i-ty wiersz pełnego zbioru
            const rowIndex = candidateIndices ? candidateIndices[i] : i;
            const row = source[rowIndex];

            for (let j = 0; j < columnCount; j++) {
                const value = row[j];
                // null i undefined są wyświetlane jako NULL, więc wyszukiwanie null powinno je znaleźć
                const text = (value === null || value === undefined) ? 'NULL' : String(value);

                if (text.toLowerCase().includes(needle)) {
                    filteredIndices.push(rowIndex);
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

        // TYLKO dopasowania - żadnego sortowania tutaj (to zmiana względem wcześniejszej wersji tej metody). Kolejność w ramach this._filteredIndices
        // jest odtąd nieistotna (naturalna, index-ascending) - o właściwą kolejność stron dba leniwie sendPage/applyFilteredPrimarySort, dokładnie tak
        // samo jak this._allRows nigdy nie jest fizycznie przestawiane dla pełnego zbioru (patrz applySort). Stary cache kolumny #0 (jeśli jakiś
        // istniał) dotyczył INNEJ frazy - już nieaktualny, przeliczy go leniwie applyFilteredPrimarySort przy najbliższym sendPage
        this._filteredIndices = filteredIndices;
        this._filteredIndicesQuery = needle;
        this._filteredIndicesDataset = this._allRows;
        this._filteredPrimaryColumnCache = null;
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

        // wyszukiwanie mogło działać z sortowaniem, którego cache jeszcze nie odzwierciedla (performSort pomija applySort przy aktywnym query, patrz tam) - domykamy to tutaj, jednorazowo przy czyszczeniu frazy, zamiast przy każdym kliknięciu sortowania w trakcie wyszukiwania
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

        // przygotowuje (albo reużywa, jeśli akurat nic się nie zmieniło - patrz komentarz przy this._filteredPrimaryColumnCache) cache kolumny #0, zanim sendPage zażąda pierwszej strony
        if (this._sortCriteria.length > 0) {
            const searchGeneration = this._searchGeneration;
            const sorted = await this.applyFilteredPrimarySort(this._sortGeneration, searchGeneration);
            if (!sorted || searchGeneration !== this._searchGeneration) {return;}
        }

        // nowe wyszukiwanie zawsze wraca na stronę 1 - poprzednia strona mogła nie istnieć w przefiltrowanym zbiorze
        this.sendPage(1, true, false);
    }

    /**
     * Upewnia się, że globalny cache kolumny NAJWAŻNIEJSZEGO kryterium (this._sortCriteria[0]) jest zbudowany, zanim ktokolwiek zażąda strony
     * (patrz sendPage/getSortedPageKeys). Brak kryteriów -> nic do zrobienia. To JEDYNA "prawdziwa", potencjalnie kosztowna praca sortująca w
     * całym mechanizmie - kolejne, mniej istotne kryteria (jeśli są) NIE mają tu żadnego trwałego cache'a wcale, bo getSortedPageKeys dogrupowuje
     * je leniwie, lokalnie, dopiero przy konkretnym żądaniu strony (patrz multiColumnSortPaging.ts) - nigdy dla całego zbioru.
     * this._allRows sam w sobie NIGDY nie jest przestawiany - patrz sendPage.
     */
    private async applySort(generation: number = this._sortGeneration): Promise<boolean> {
        if (this._allRows.length < 2 || this._sortCriteria.length === 0) {
            return generation === this._sortGeneration;
        }

        const columnIndex = this._sortCriteria[0].columnIndex;
        if (!this._sortColumnCache.has(columnIndex)) {
            const built = await this.buildColumnSortCache(columnIndex, () => generation === this._sortGeneration);
            if (built === null || generation !== this._sortGeneration) {return false;}
            this._sortColumnCache.set(columnIndex, built);
        }

        return true;
    }

    /**
     * Buduje (leniwie, raz na kolumnę - patrz this._sortColumnCache) grupowanie indeksów wg wartości komórki, rosnąco - dokładnie to samo, co
     * dawniej liczył jednorazowy radixSortSingleColumn, tylko że wynik (podział na grupy) zostaje zapamiętany zamiast zaraz wyrzucony. ZAWSZE
     * czyta z this._allRows (niezmienna, jedyna kolejność), dzięki czemu grupy remisowe (ta sama wartość) wychodzą stabilnie w kolejności
     * rosnącej po indeksie - bo this._allRows jest z definicji index-ascending, a radixSortIndices jest stabilny (counting sort per bajt).
     */
    // cienki adapter do radixEngine.ts (patrz komentarz przy this._sortColumnCache) - jedyna rola tej metody to podstawienie this._allRows/this._sortKinds, cała właściwa logika jest w buildColumnSortCache z radixEngine.ts, żeby dało się ją testować w izolacji, bez SqlResultsProvider
    private async buildColumnSortCache(columnIndex: number, isValid: () => boolean, sourceIndices?: number[]): Promise<ColumnSortCache | null> {
        return buildColumnSortCache(this._allRows, this._sortKinds, columnIndex, isValid, sourceIndices);
    }

    // odczytuje wartość komórki jako klucz do PROSTEGO porównania (< > ===) - używane w decorate-sort-undecorate (patrz getSortKey w multiColumnSortPaging.ts), żeby przy sortowaniu k elementów czytać/konwertować wartość RAZ (O(k)) zamiast przy każdym porównaniu w Array.sort (O(k log k))
    private getSortKey(row: number, columnIndex: number): number | string | null {
        const value = this._allRows[row][columnIndex];
        if (value === null || value === undefined) {return null;}
        const kind: SortKind = this._sortKinds[columnIndex] ?? 'string';
        if (kind === 'string') {return typeof value === 'string' ? value : String(value);}
        return resolveNumericValue(value, kind);
    }

    // wspólna część buildSortContext/buildFilteredSortContext (patrz obie niżej) - jedyna różnica między "sortuj pełny zbiór" a "sortuj wynik wyszukiwania" to SKĄD bierze się cache kolumny #0, więc tylko to jest parametrem
    private makeSortContext(getColumnCache: (columnIndex: number) => ColumnSortCache): MultiColumnSortContext {
        return {
            getColumnCache,
            compareCellValues: (rowA: number, rowB: number, columnIndex: number): number => {
                const kind: SortKind = this._sortKinds[columnIndex] ?? 'string';
                return compareCellValues(this._allRows[rowA][columnIndex], this._allRows[rowB][columnIndex], kind);
            },
            // patrz komentarz przy MultiColumnSortContext.getSortKey w multiColumnSortPaging.ts - odczyt RAZ na wiersz zamiast przy każdym porównaniu w Array.sort
            getSortKey: (row: number, columnIndex: number): number | string | null => this.getSortKey(row, columnIndex),
        };
    }

    // odpowiednik buildSortContext (patrz niżej), ale dla this._filteredIndices - getColumnCache czyta z this._filteredPrimaryColumnCache zamiast z this._sortColumnCache; rzuca, jeśli cache nie istnieje dla ŻĄDANEJ kolumny, co oznacza błąd w kolejności wywołań (applyFilteredPrimarySort musi zakończyć się sukcesem przed jakimkolwiek sendPage przy aktywnym wyszukiwaniu)
    private buildFilteredSortContext(): MultiColumnSortContext {
        return this.makeSortContext((columnIndex: number): ColumnSortCache => {
            const entry = this._filteredPrimaryColumnCache;
            if (!entry || entry.columnIndex !== columnIndex) {throw new Error(`Brak zbudowanego cache'a sortowania (wyszukiwanie) dla kolumny ${columnIndex} - applyFilteredPrimarySort() musi zakończyć się sukcesem przed sendPage()`);}
            return entry.cache;
        });
    }

    /**
     * Odpowiednik applySort() (patrz niżej), ale dla this._filteredIndices zamiast this._allRows - buduje/reużywa this._filteredPrimaryColumnCache
     * dla kolumny NAJWAŻNIEJSZEGO kryterium. Kluczowe: jeśli kolejne wywołanie dotyczy TEJ SAMEJ kolumny #0 i TEJ SAMEJ frazy wyszukiwania
     * (searchGeneration bez zmian) - a dokładnie to się dzieje przy Shift+klik na drugie/trzecie kryterium sortowania - radix NIE jest liczony
     * ponownie, tylko reużywany. To jest właśnie ta symetria z applySort(), której brakowało we wcześniejszej wersji (poprzednie podejście
     * liczyło WSZYSTKO od zera przy KAŻDYM kliknięciu, dla CAŁEGO przefiltrowanego zbioru).
     */
    private async applyFilteredPrimarySort(sortGeneration: number, searchGeneration: number): Promise<boolean> {
        if (this._sortCriteria.length === 0 || !this._filteredIndices) {
            this._filteredPrimaryColumnCache = null;
            return true;
        }

        const columnIndex = this._sortCriteria[0].columnIndex;
        const existing = this._filteredPrimaryColumnCache;
        if (existing && existing.columnIndex === columnIndex && existing.searchGeneration === searchGeneration) {
            return true; // ta sama kolumna #0, ta sama fraza co przy poprzednim kliknięciu - nic do przeliczenia (patrz applySort)
        }

        const isValid = () => sortGeneration === this._sortGeneration && searchGeneration === this._searchGeneration;
        const cache = await this.buildColumnSortCache(columnIndex, isValid, this._filteredIndices);
        if (cache === null || !isValid()) {return false;}

        this._filteredPrimaryColumnCache = { columnIndex, searchGeneration, cache };
        return true;
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
            // przy aktywnym wyszukiwaniu w ogóle nie dotykamy pełnego zbioru/cache'a kolumn - odpowiednik applySort, ale dla this._filteredIndices (patrz applyFilteredPrimarySort/this._filteredPrimaryColumnCache); this._allRows zostaje na razie nieaktualne, domykane dopiero przy skasowaniu wyszukiwania w performSearch
            const searchGeneration = this._searchGeneration;
            const sorted = await this.applyFilteredPrimarySort(generation, searchGeneration);
            if (!sorted || generation !== this._sortGeneration || searchGeneration !== this._searchGeneration) {return;}
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

    /**
     * Cienki adapter między this._allRows/this._sortColumnCache (stan klasy) a czystymi, testowalnymi w izolacji modułami sortPaging.ts/
     * multiColumnSortPaging.ts - patrz getSortedPageKeys. getColumnCache jest wołane WYŁĄCZNIE dla kolumny najważniejszego kryterium
     * (this._sortCriteria[0], patrz komentarz przy applySort) - rzuca, jeśli cache nie istnieje, co oznacza błąd w kolejności wywołań
     * (applySort musi zakończyć się sukcesem przed jakimkolwiek sendPage - patrz wszystkie miejsca wołające applySort).
     */
    // wartość w danej kolumnie mogła się zmienić (edycja komórki) - jej cache grupowania jest nieaktualny, dotyczy to ZARÓWNO cache'a pełnego zbioru, jak i cache'a przefiltrowanego (jeśli akurat dotyczy tej samej kolumny), patrz this._sortColumnCache/this._filteredPrimaryColumnCache; pozostałe kolumny zostają ważne
    private invalidateColumnSortCache(columnIndex: number): void {
        this._sortColumnCache.delete(columnIndex);
        if (this._filteredPrimaryColumnCache?.columnIndex === columnIndex) {this._filteredPrimaryColumnCache = null;}
    }

    private buildSortContext(): MultiColumnSortContext {
        return this.makeSortContext((columnIndex: number): ColumnSortCache => {
            const cache = this._sortColumnCache.get(columnIndex);
            if (!cache) {throw new Error(`Brak zbudowanego cache'a sortowania dla kolumny ${columnIndex} - applySort() musi zakończyć się sukcesem przed sendPage()`);}
            return cache;
        });
    }

    /**
     * Leniwie liczy indeksy do this._allRows dla DOKŁADNIE jednej żądanej strony - NIGDY nie materializuje permutacji dla całego zbioru,
     * niezależnie od tego, ile jest wierszy (patrz sortPaging.ts dla jednej kolumny i multiColumnSortPaging.ts dla wielu, tam jest cała
     * właściwa logika). Brak aktywnego sortowania -> naturalna kolejność (sama this._allRows), zero pracy.
     */
    private getSortedPageKeys(start: number, count: number): number[] {
        if (this._sortCriteria.length === 0) {
            const end = Math.min(start + count, this._allRows.length);
            const keys = new Array<number>(Math.max(0, end - start));
            for (let i = 0; i < keys.length; i++) {keys[i] = start + i;}
            return keys;
        }

        return getMultiColumnPageKeys(this._sortCriteria, this.buildSortContext(), start, count);
    }

    private sendPage(pageNumber: number, clearSelection = false, isSameQuery = true) {
        if (!this._view) {return;}

        // gdy wyszukiwanie jest aktywne, paginujemy po przefiltrowanych indeksach zamiast leniwie liczyć wg this._sortCriteria
        const filtered = this._filteredIndices;
        const totalRows = filtered ? filtered.length : this._allRows.length;
        const totalPages = Math.max(1, Math.ceil(totalRows / this.ROWS_PER_PAGE));

        // pageNumber mogło zostać policzone dla innego (większego) zbioru wierszy niż aktualny - przycinamy, żeby nie wysłać pustej/nieistniejącej strony
        const clampedPage = Math.min(Math.max(1, pageNumber), totalPages);
        this._currentPage = clampedPage;

        const start = (clampedPage - 1) * this.ROWS_PER_PAGE;
        const end = Math.min(start + this.ROWS_PER_PAGE, totalRows);
        const pageLength = Math.max(0, end - start);
        // rowKeys to indeksy do this._allRows dla wierszy tej strony - webview odsyła je z powrotem przy edycji/usuwaniu zamiast liczyć page-relative -> global offset
        // przy aktywnym wyszukiwaniu BEZ sortowania - zwykły slice (dopasowania w naturalnej kolejności, patrz applySearchFilter)
        // przy aktywnym wyszukiwaniu Z sortowaniem - ta sama leniwa, per-stronowa ścieżka co dla pełnego zbioru (getMultiColumnPageKeys), tylko z cache'em z this._filteredPrimaryColumnCache zamiast this._sortColumnCache - patrz buildFilteredSortContext/applyFilteredPrimarySort
        let rowKeys: number[];
        if (filtered) {
            rowKeys = this._sortCriteria.length > 0
                ? getMultiColumnPageKeys(this._sortCriteria, this.buildFilteredSortContext(), start, pageLength)
                : filtered.slice(start, end);
        } else {
            rowKeys = this.getSortedPageKeys(start, pageLength);
        }
        const pageRows = new Array<any[]>(pageLength);
        for (let i = 0; i < pageLength; i++) {
            pageRows[i] = this._allRows[rowKeys[i]];
        }
        
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

            // rowKey to indeks w this._allRows - żadnej arytmetyki z bieżącą stroną, działa niezależnie od tego, co jest aktualnie wyrenderowane
            const row = this._allRows[rowKey];

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
            this.invalidateColumnSortCache(columnIndex);

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
            // rowKeys to indeksy w this._allRows - żadnej arytmetyki z bieżącą stroną
            const rows = rowKeys
                .map((key) => this._allRows[key])
                .filter((row): row is any[] => row !== undefined);

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

            const confirmed = await confirmDestructiveOperation(
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
            const db = await this.getDbForCurrentFile();
            const context = await resolveTableContext(this._meta, db);
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
            const scopedRows = this._filteredIndices ? this._filteredIndices.map((i) => this._allRows[i]) : this._allRows;

            if (scopedRows.length === 0) {
                vscode.window.showErrorMessage('No rows matching the current search to update');
                this._view?.webview.postMessage({ command: 'columnEditsCancelled' });
                return;
            }

            // ID (wartości PK) wszystkich wierszy objętych operacją (scopedRows), nie tylko z wyrenderowanej strony – to one wyznaczają zakres UPDATE-u
            const pkValueTuples = scopedRows.map(
                (row) => primaryKeys.map((pk) => row[pk.index])
            );

            // sortujemy ID przed wstawieniem do UPDATE-u, żeby były czytelne w logach SQL
            pkValueTuples.sort((tupleA, tupleB) => comparePkTuples(tupleA, tupleB));

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

            const recordCount = scopedRows.length;

            const confirmed = await confirmDestructiveOperation(
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

            // backend jest źródłem prawdy – odzwierciedlamy zmianę tylko w wierszach objętych operacją (scopedRows), żeby webview pokazał aktualne wartości
            for (const edit of normalizedEdits) {
                for (const row of scopedRows) {
                    row[edit.columnIndex] = edit.value;
                }
                // wartości w tej kolumnie mogły się zmienić - jej cache grupowania jest nieaktualny (patrz this._sortColumnCache), reszta kolumn zostaje ważna
                this.invalidateColumnSortCache(edit.columnIndex);
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
            const db = await this.getDbForCurrentFile();
            const context = await resolveTableContext(this._meta, db);
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

            // rowKey to indeks w this._allRows - żadnej arytmetyki page-relative -> global
            const rowByRowKey = new Map(cells.map((cell) => [cell.rowKey, this._allRows[cell.rowKey]]));
            if ([...rowByRowKey.values()].some((row) => !row)) {
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
                    .map((rowKey) => rowByRowKey.get(rowKey)!)
                    .map((row) => primaryKeys.map((pk) => row[pk.index]));

                // sortujemy ID przed wstawieniem do UPDATE-u, żeby były czytelne w logach SQL - tak samo jak w saveColumnEdits
                pkValueTuples.sort((tupleA, tupleB) => comparePkTuples(tupleA, tupleB));

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

            const confirmed = await confirmDestructiveOperation(
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
                const row = rowByRowKey.get(cell.rowKey)!;
                row[cell.columnIndex] = normalizedValueByColumnName.get(cell.columnName);
            }
            // wartości w tych kolumnach mogły się zmienić - ich cache grupowania jest nieaktualny (patrz this._sortColumnCache), pozostałe kolumny zostają ważne
            for (const cell of cells) {this.invalidateColumnSortCache(cell.columnIndex);}

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

    /** Zwraca wiersze (z this._allRows) odpowiadające rowKeys (indeksom) z webview - żadnej arytmetyki page-relative -> global. */
    private resolveSelectedRows(rowKeys: number[]): any[][] {
        return rowKeys
            .map((key) => this._allRows[key])
            .filter((row): row is any[] => row !== undefined);
    }

    private async generateInsertSQL(rowKeys: number[]) {
        try {
            if (!rowKeys || rowKeys.length === 0) {return;}

            const db = await this.getDbForCurrentFile();
            const context = await resolveTableContext(this._meta, db);
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowKeys);
            if (rows.length === 0) {
                vscode.window.showErrorMessage('Selected rows not found');
                return;
            }

            const selection = await pickInsertGenerationOptions(this._context?.globalState);
            if (!selection) {return;} // użytkownik anulował QuickPick (Escape) - nic nie generujemy
            const { ids: selectedOptions, batchSize } = selection;

            // ostrzegamy o opcjach, które zostaną pominięte w wygenerowanym SQL z powodu konfliktu z REPLACE INTO, zamiast ciszej ich gubić
            const dropped = getDroppedInsertOptions(selectedOptions);
            if (dropped.length > 0) {
                const labels = dropped.map((d) => d.label).join(', ');
                vscode.window.showWarningMessage(`Generate INSERT: ${labels} skipped - not compatible with REPLACE INTO`);
            }

            const { columns, primaryKeys, qualifiedTable } = context;
            const sql = buildInsertSql(rows, columns, primaryKeys, qualifiedTable, selectedOptions, batchSize);

            await saveAndCopyGeneratedSql(this._context, sql, 'insert');
        } catch (err: any) {
            console.error('Generate INSERT error:', err);
            vscode.window.showErrorMessage(`❌ Generate INSERT error: ${err.message}`);
        }
    }

    private async generateUpdateSQL(rowKeys: number[]) {
        try {
            if (!rowKeys || rowKeys.length === 0) {return;}

            const db = await this.getDbForCurrentFile();
            const context = await resolveTableContext(this._meta, db);
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowKeys);
            if (rows.length === 0) {
                vscode.window.showErrorMessage('Selected rows not found');
                return;
            }

            const selection = await pickUpdateGenerationOptions(this._context?.globalState);
            if (!selection) {return;} // użytkownik anulował QuickPick (Escape) - nic nie generujemy
            const { ids: selectedOptions, batchSize } = selection;

            const { columns, primaryKeys, qualifiedTable } = context;

            // ostrzegamy o opcjach, które zostaną pominięte w wygenerowanym SQL z powodu złożonego klucza głównego, zamiast ciszej ich gubić
            const dropped = getDroppedUpdateOptions(selectedOptions, primaryKeys);
            if (dropped.length > 0) {
                const labels = dropped.map((d) => d.label).join(', ');
                vscode.window.showWarningMessage(`Generate UPDATE: ${labels} skipped - table has a composite primary key`);
            }

            const sql = buildUpdateSql(rows, columns, primaryKeys, qualifiedTable, selectedOptions, batchSize);

            await saveAndCopyGeneratedSql(this._context, sql, 'update');
        } catch (err: any) {
            console.error('Generate UPDATE error:', err);
            vscode.window.showErrorMessage(`❌ Generate UPDATE error: ${err.message}`);
        }
    }

    private async generateDeleteSQL(rowKeys: number[]) {
        try {
            if (!rowKeys || rowKeys.length === 0) {return;}

            const db = await this.getDbForCurrentFile();
            const context = await resolveTableContext(this._meta, db);
            if (!context) {return;}

            const rows = this.resolveSelectedRows(rowKeys);
            if (rows.length === 0) {
                vscode.window.showErrorMessage('Selected rows not found');
                return;
            }

            const { primaryKeys, qualifiedTable } = context;

            const selection = await pickDeleteGenerationOptions(this._context?.globalState);
            if (!selection) {return;} // użytkownik anulował QuickPick (Escape) - nic nie generujemy
            const { ids: selectedOptions, batchSize } = selection;

            const sql = buildDeleteSql(rows, primaryKeys, qualifiedTable, selectedOptions, batchSize);

            await saveAndCopyGeneratedSql(this._context, sql, 'delete');
        } catch (err: any) {
            console.error('Generate DELETE error:', err);
            vscode.window.showErrorMessage(`❌ Generate DELETE error: ${err.message}`);
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
     * typ this._allRows do "never" kawałek dalej w tej samej funkcji (mimo jawnie zadeklarowanego typu pola any[][]).
     */
    private resetStateBeforeQuery(sqlFile: string): void {
        this._sortCriteria = [];
        this._sortColumnCache = new Map();
        this._sortGeneration++;

        this._allRows = [];
        this._filteredIndices = null;
        this._filteredIndicesQuery = null;
        this._filteredIndicesDataset = null;
        this._filteredPrimaryColumnCache = null;
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
        
        // dane dokładnie w kolejności z DB - indeks w tablicy pełni rolę stabilnego identyfikatora wiersza, this._allRows nigdy nie jest przestawiane
        this._allRows = rows;
        this._headers = headers;
        this._lastSQL = sql;
        this._meta = meta;
        this._sortKinds = success && Array.isArray(meta) ? computeSortKinds(meta) : [];
        this._columnTypes = success ? computeColumnTypes(meta) : [];
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

        const totalRows = this._filteredIndices ? this._filteredIndices.length : this._allRows.length;
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
        this._headers = [];
        this._meta = [];
        this._columnTypes = [];
        this._searchQuery = '';
        this._filteredIndices = null;
        this._filteredIndicesQuery = null;
        this._filteredIndicesDataset = null;
        this._filteredPrimaryColumnCache = null;
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
        // state.rows to ZAWSZE niezmieniona kolejność z DB (patrz FileResultState.rows) - applySort() niżej tylko upewnia się, że cache kolumny najważniejszego kryterium (state.sortColumnCache) jest gotowy, więc nawet aktywne sortowanie wraca bez ponownego liczenia
        this._allRows = state.rows;
        this._headers = state.headers;
        this._lastSQL = state.sql;
        this._meta = state.meta;
        this._columnTypes = state.columnTypes ?? [];
        this._sortKinds = Array.isArray(this._meta) ? computeSortKinds(this._meta) : [];
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
}