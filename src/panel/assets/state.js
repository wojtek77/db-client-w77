/**
 * @typedef {Object} FileState
 * @property {Array} currentRows - Tablica z aktualnymi wierszami danych.
 * @property {Array<string>} headers - Tablica z nagłówkami kolumn.
 * @property {number} currentPage - Numer aktualnej strony.
 * @property {number} totalPages - Całkowita liczba stron.
 * @property {number} ROWS_PER_PAGE - Maksymalna liczba wierszy na stronę.
 * @property {Array} cachedGrid - Tablica węzłów DIV jako array
 * @property {Array} cachedGridHtml - Tablica węzłów DIV jako HTML
 * @property {string} filename - Nazwa aktualnie załadowanego pliku.
 */

class State {
    static #instance = null;
    static #globalFiles = new Map();

    constructor(filename) {
        this.filename = filename;

        if (!State.#globalFiles.has(this.filename)) {
            State.#globalFiles.set(this.filename, {
                currentRows: [],
                headers: [],
                currentPage: 1,
                totalPages: 1,
                ROWS_PER_PAGE: 200,
                cachedGrid: [],
                cachedGridHtml: [],
                gridShape: '',
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
            throw new Error("Nazwa pliku jest wymagana do inicjalizacji.");
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
            throw new Error("Brak aktywnej instancji. Najpierw wywołaj State.init(filename).");
        }
        return State.#instance;
    }
}
