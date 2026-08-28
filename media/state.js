/**
 * @typedef {Object} FileState
 * @property {string} filename - Nazwa aktualnie załadowanego pliku.
 * @property {Array<{key: number, data: Array}>} currentRows - Ostatnio wyrenderowane wiersze bieżącej
 *   strony. Każdy wpis to {key, data}: key to stabilny identyfikator wiersza z backendu (patrz RowEntry.key
 *   w SqlResultsProvider.ts, page-relative index = pozycja w tej tablicy), data to jego wartości kolumn.
 *   Trzymane razem (nie jako dwie równoległe tablice), żeby nie było dwóch struktur do zsynchronizowania.
 *   Wysyłany z powrotem do backendu przy edycji/usuwaniu, żeby backend nie musiał przeliczać page-relative -> global.
 * @property {Array<string>} headers - Tablica z nagłówkami kolumn.
 * @property {Array<string>} columnTypes - Typy danych kolumn (np. 'varchar', 'text'), równoległe do headers.
 * @property {number} currentPage - Numer aktualnej strony.
 * @property {number} totalPages - Całkowita liczba stron.
 * @property {number} ROWS_PER_PAGE - Maksymalna liczba wierszy na stronę.
 * @property {Array} cachedGrid - Tablica węzłów DIV jako array
 * @property {Array} cachedGridHtml - Tablica węzłów DIV jako HTML
 * @property {Array} cachedHeaderHtml - Tablica węzłów DIV nagłówka (razem z LP), zachowuje
 *   też stan zaznaczenia kolumny (klasa 'selected-col') przy przełączaniu między plikami.
 * @property {string} gridShape - Ilość wierszy i ilość kolumn np. "2x1".
 * @property {string} connectionName - Nazwa połączenia z DB.
 * @property {string} connectionTime - Czas połączenia z DB.
 * @property {string} queryTime - Czas wykonania ostatniego SQL-a.
 * @property {string} connectionColor - Kolor dla połącznia DB.
 * @property {boolean} isProduction - Czy połączenie jest oznaczone jako produkcyjne (readonly=true w .cnf).
 * @property {boolean} isReadOnly - Czy połączenie jest oznaczone jako tylko-do-odczytu w .cnf.
 * @property {string} infoMessage - Dodatkowa informacja np. ilość zmienionych rekordów.
 * @property {string} errorMessage - Info o błędzie.
 * @property {Object.<number, string>} pendingColumnEdits - Oczekujące (jeszcze niezapisane
 *   do backendu) zbiorcze edycje CAŁYCH kolumn. Klucz to indeks kolumny (columnIndex),
 *   wartość to nowa wartość ustawiona przez użytkownika. Wspiera wiele kolumn naraz.
 *   To tylko podgląd w webview - prawdziwe dane (State.currentRows) pozostają nietknięte,
 *   dopóki użytkownik nie potwierdzi zapisu przyciskiem "Save".
 * @property {Set<number>} selectedRowIndexes - Indeksy (page-relative, jak _rowIndex)
 *   aktualnie zaznaczonych wierszy. Źródło prawdy dla zaznaczenia wierszy - klasa CSS
 *   'selected-row' na węźle DOM służy już tylko do wizualnego podświetlenia i jest
 *   aktualizowana równolegle z tym Setem, nigdy odwrotnie odczytywana.
 * @property {Set<number>} selectedColIndexes - Indeksy aktualnie zaznaczonych kolumn
 *   (odpowiednik selectedRowIndexes, ale dla zaznaczenia kolumny). Klasa CSS 'selected-col'
 *   to tylko wizualny efekt uboczny.
 * @property {Set<string>} selectedCellPositions - Pozycje pojedynczo zaznaczonych komórek
 *   w formacie "row-col" (odpowiednik selectedRowIndexes, ale dla zaznaczenia komórki).
 *   Klasa CSS 'selected-cell' to tylko wizualny efekt uboczny.
 * @property {Set<'row'|'col'|'cell'>} selectionTypeOrder - Kolejność ostatniej aktywności trzech typów zaznaczenia (ostatni element = aktualnie "aktywny" typ, czyli ten kopiowany przez Ctrl+C) - jedyny właściciel tego pola to selection.js, patrz tam markXSelected/unmarkXSelected
 * @property {{value: string, positions: Set<string>}|null} pendingCellEdits - Oczekująca (jeszcze niezapisana) zbiorcza edycja NIEZALEŻNYCH ZAZNACZONYCH KOMÓREK (osobny mechanizm od pendingColumnEdits) - tylko jedna grupa naraz, positions to zbiór "rowKey-col" z chwili startu edycji, value to jedna wspólna wartość dla całej grupy, tylko podgląd w webview dopóki użytkownik nie kliknie "Save cells"
 * @property {string} searchQuery - Aktualnie wpisana/zsynchronizowana z backendem fraza wyszukiwania (backend jest źródłem prawdy).
 * @property {Array<{columnIndex: number, direction: 'asc'|'desc'}>} sortCriteria - Aktywne kryteria sortowania w kolejności priorytetu (pierwsze = główne, ORDER BY col1, col2, ...), pusta tablica = brak sortowania (backend jest źródłem prawdy, patrz msg.sortCriteria).
 * @property {number} totalRows - Liczba wierszy PO zastosowaniu filtra wyszukiwania (to na jej podstawie liczona jest paginacja).
 * @property {number} totalRowsUnfiltered - Pełna liczba wierszy w wynikach SQL, bez filtra - używana tylko do etykiety "X z Y" przy polu wyszukiwania.
 * @property {Set<string>} searchHighlightedCells - pozycje "row-col" (col to indeks w rowCells, czyli z przesunięciem +1 od LP) komórek bieżącej strony, które mają teraz nałożone podświetlenie wyszukiwania - osobny klucz w state zamiast wliczania podświetleń do cachedGrid, dzięki czemu highlightMatchesOnCurrentPage czyści tylko te komórki, które faktycznie były podświetlone, zamiast zamiatać cały grid (patrz highlightMatchesOnCurrentPage w search.js)
 */

export class State {
    static #instance = null;
    static #globalFiles = new Map();

    constructor(filename) {
        if (!State.#globalFiles.has(filename)) {
            State.#globalFiles.set(filename, {
                filename,
                currentRows: [],
                headers: [],
                columnTypes: [],
                currentPage: 1,
                totalPages: 1,
                ROWS_PER_PAGE: 200,
                cachedGrid: [],
                cachedGridHtml: [],
                cachedHeaderHtml: [],
                cachedGridTemplate: '',
                gridShape: '',
                connectionName: '-------',
                connectionTime: '---',
                queryTime: 0,
                connectionColor: null,
                isProduction: false,
                isReadOnly: false,
                infoMessage: '',
                errorMessage: '',
                pendingColumnEdits: {},
                pendingCellEdits: null,
                selectedRowIndexes: new Set(),
                selectedColIndexes: new Set(),
                selectedCellPositions: new Set(),
                selectionTypeOrder: new Set(),
                searchQuery: '',
                sortCriteria: [],
                totalRows: 0,
                totalRowsUnfiltered: 0,
                searchHighlightedCells: new Set(),
            });
        }

        const fileState = State.#globalFiles.get(filename);
        // zwracamy z konstruktora sam obiekt z mapy zamiast owijać go w defineProperty/gettery - dzięki temu każdy odczyt/zapis pola to zwykły property access na jednym obiekcie, bez warstwy pośredniej i bez pętli po kluczach przy każdym przełączeniu pliku
        return Object.setPrototypeOf(fileState, State.prototype);
    }

    /**
     * Inicjalizuje stan dla wybranego pliku.
     * @param {string} filename - Nazwa pliku.
     * @returns {State & FileState} Instancja stanu z podpowiedziami pól pliku.
     */
    static init(filename) {
        if (!filename) {
            throw new Error("A filename is required to initialize.");
        }
        // pomijamy tworzenie nowej instancji tylko gdy to ten sam plik I wciąż ten sam obiekt w #globalFiles (nie przeszedł przez State.clear())
        if (State.#instance && State.#instance.filename === filename && State.#instance === State.#globalFiles.get(filename)) {
            return State.#instance;
        }
        State.#instance = new State(filename);
        return State.#instance;
    }

    /**
     * Pobiera aktywną instancję Singletona.
     * @returns {State & FileState} Instancja stanu z podpowiedziami pól pliku.
     */
    static getInstance() {
        if (!State.#instance) {
            throw new Error("No active instance. First call State.init(filename).");
        }
        return State.#instance;
    }

    /**
     * Mówi, czy Singleton został już zainicjalizowany (State.init) - bez rzucania wyjątku.
     * Przydatne tam, gdzie kod może się wykonać zanim padł pierwszy 'appendData'/'showResultsForFile'
     * (np. 'showEmpty' jako pierwsza wiadomość dla pliku bez żadnych wcześniejszych wyników).
     * @returns {boolean}
     */
    static hasInstance() {
        return State.#instance !== null;
    }

    /**
     * Usuwa zapisany stan danego pliku (m.in. cachedGrid/cachedGridHtml/currentRows),
     * gdy backend zgłosi, że plik przestał być potrzebny (zamknięto jego zakładkę).
     * Odpowiednik czyszczenia `_fileStates` w SqlResultsProvider po stronie backendu.
     * @param {string} filename - Nazwa pliku, dla którego czyścimy stan.
     */
    static clear(filename) {
        State.#globalFiles.delete(filename);
    }
}
