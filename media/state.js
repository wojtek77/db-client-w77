/**
 * @typedef {Object} FileState
 * @property {string} filename - Nazwa aktualnie załadowanego pliku.
 * @property {Array} currentRows - Tablica z aktualnymi wierszami danych.
 * @property {Array<string>} headers - Tablica z nagłówkami kolumn.
 * @property {Array<string>} columnTypes - Typy danych kolumn (np. 'varchar', 'text'), równoległe do headers.
 * @property {number} currentPage - Numer aktualnej strony.
 * @property {number} totalPages - Całkowita liczba stron.
 * @property {number} ROWS_PER_PAGE - Maksymalna liczba wierszy na stronę.
 * @property {Array} cachedGrid - Tablica węzłów DIV jako array
 * @property {Array} cachedGridHtml - Tablica węzłów DIV jako HTML
 * @property {string} gridShape - Ilość wierszy i ilość kolumn np. "2x1".
 * @property {string} connectionName - Nazwa połączenia z DB.
 * @property {string} connectionTime - Czas połączenia z DB.
 * @property {string} queryTime - Czas wykonania ostatniego SQL-a.
 * @property {string} connectionColor - Kolor dla połącznia DB.
 * @property {string} infoMessage - Dodatkowa informacja np. ilość zmienionych rekordów.
 * @property {string} errorMessage - Info o błędzie.
 * @property {Object.<number, string>} pendingColumnEdits - Oczekujące (jeszcze niezapisane
 *   do backendu) zbiorcze edycje CAŁYCH kolumn. Klucz to indeks kolumny (columnIndex),
 *   wartość to nowa wartość ustawiona przez użytkownika. Wspiera wiele kolumn naraz.
 *   To tylko podgląd w webview - prawdziwe dane (State.currentRows) pozostają nietknięte,
 *   dopóki użytkownik nie potwierdzi zapisu przyciskiem "Save".
 */

export class State {
    static #instance = null;
    static #globalFiles = new Map();

    constructor(filename) {
        this.filename = filename;

        if (!State.#globalFiles.has(this.filename)) {
            State.#globalFiles.set(this.filename, {
                currentRows: [],
                headers: [],
                columnTypes: [],
                currentPage: 1,
                totalPages: 1,
                ROWS_PER_PAGE: 200,
                cachedGrid: [],
                cachedGridHtml: [],
                gridShape: '',
                connectionName: '-------',
                connectionTime: '---',
                queryTime: 0,
                connectionColor: null,
                infoMessage: '',
                errorMessage: '',
                pendingColumnEdits: {},
            });
        }

        const fileState = State.#globalFiles.get(this.filename);
        this[this.filename] = fileState;

        Object.keys(fileState).forEach(key => {
            Object.defineProperty(this, key, {
                get: () => fileState[key],
                set: (value) => { fileState[key] = value; },
                enumerable: true,
                configurable: true
            });
        });
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
}
