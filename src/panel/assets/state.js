/**
 * @typedef {Object} FileState
 * @property {Array} currentRows - Tablica z aktualnymi wierszami danych.
 * @property {Array<string>} headers - Tablica z nagłówkami kolumn.
 * @property {number} currentPage - Numer aktualnej strony.
 * @property {number} totalPages - Całkowita liczba stron.
 * @property {number} ROWS_PER_PAGE - Maksymalna liczba wierszy na stronę.
 * @property {string} filename - Nazwa aktualnie załadowanego pliku.
 */

class StatePerFile {
    static #instance = null;
    static #globalFiles = new Map();

    constructor(filename) {
        this.filename = filename;

        if (!StatePerFile.#globalFiles.has(this.filename)) {
            StatePerFile.#globalFiles.set(this.filename, {
                currentRows: [],
                headers: [],
                currentPage: 1,
                totalPages: 1,
                ROWS_PER_PAGE: 200
            });
        }

        const fileState = StatePerFile.#globalFiles.get(this.filename);
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
     * @returns {StatePerFile & FileState} Instancja stanu z podpowiedziami pól pliku.
     */
    static init(filename) {
        if (!filename) {
            throw new Error("Nazwa pliku jest wymagana do inicjalizacji.");
        }
        StatePerFile.#instance = new StatePerFile(filename);
        return StatePerFile.#instance;
    }

    /**
     * Pobiera aktywną instancję Singletona.
     * @returns {StatePerFile & FileState} Instancja stanu z podpowiedziami pól pliku.
     */
    static getInstance() {
        if (!StatePerFile.#instance) {
            throw new Error("Brak aktywnej instancji. Najpierw wywołaj State.init(filename).");
        }
        return StatePerFile.#instance;
    }
}

class State extends StatePerFile {
    constructor() {
        super(undefined); 
    }

    /**
     * Nadpisana metoda getInstance dla State.
     * Jeśli instancja nie istnieje, tworzy ją automatycznie z wartością undefined.
     */
    static getInstance() {
        if (!State._instance) {
            // Automatyczna inicjalizacja domyślnego stanu bez wyrzucania błędu
            State._instance = new State();
        }
        return State._instance;
    }
}
