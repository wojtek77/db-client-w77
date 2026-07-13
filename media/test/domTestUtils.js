import { JSDOM } from 'jsdom';
import { State } from '../state.js';
import { renderHeaders, initializeGrid, renderPage } from '../tableRenderer.js';

// Minimalny szkielet HTML odpowiadający strukturze z src/panel/html.ts -
// tylko elementy, na których faktycznie operuje media/*.js.
const BASE_HTML = `<!doctype html>
<html>
<body>
    <div id="gridContainer" class="grid-container" tabindex="-1">
        <div id="gridHeader" class="grid-header"></div>
        <div id="gridBody" class="grid-body"></div>
    </div>
    <span id="generateInsertBtn" class="tools-btn generate-insert-btn"></span>
    <span id="generateUpdateBtn" class="tools-btn generate-update-btn"></span>
    <span id="generateDeleteBtn" class="tools-btn generate-delete-btn"></span>
    <span id="deleteRowsBtn" class="tools-btn delete-rows-btn"></span>
    <span id="saveColumnEditsBtn" class="tools-btn save-column-edits-btn"></span>
</body>
</html>`;

/**
 * Tworzy świeże środowisko jsdom i podpina je pod globalne obiekty (document,
 * window, navigator...), których używa media/*.js tak, jak w prawdziwej przeglądarce.
 * Wywołaj na początku każdego testu (albo w beforeEach), żeby testy się nie mieszały.
 * @returns {JSDOM}
 */
export function setupDom() {
    const dom = new JSDOM(BASE_HTML, { url: 'https://example.test/' });

    global.window = dom.window;
    global.document = dom.window.document;
    // Node (>=21) już ma własny, tylko-do-odczytu globalny `navigator` - trzeba go
    // nadpisać przez defineProperty, zwykłe przypisanie rzuci TypeError.
    Object.defineProperty(global, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
        writable: true,
    });
    global.MouseEvent = dom.window.MouseEvent;
    global.KeyboardEvent = dom.window.KeyboardEvent;
    global.HTMLElement = dom.window.HTMLElement;

    return dom;
}

/**
 * Inicjalizuje State dla podanego "pliku" i buduje siatkę (nagłówek + wiersze)
 * dokładnie tak samo, jak robi to prawdziwa aplikacja (renderHeaders + initializeGrid
 * z tableRenderer.js) - żadnych ręcznie sklejanych fixture'ów.
 *
 * @param {string} filename - unikalna nazwa "pliku" dla State (każdy test powinien użyć innej,
 *   bo State.#globalFiles trzyma dane per-plik przez cały czas trwania procesu testowego)
 * @param {{headers: string[], columnTypes?: string[], currentRows: Array<Array<any>>}} data
 * @returns {State & object} instancja State dla tego pliku
 */
export function buildGrid(filename, { headers, columnTypes = [], currentRows }) {
    const state = State.init(filename);
    state.headers = headers;
    state.columnTypes = columnTypes;

    renderHeaders(currentRows);
    initializeGrid(currentRows);

    // tak samo jak w messageHandler.js: currentRows musi być "undefined" przed renderPage(),
    // inaczej renderPage porówna dane ze sobą, uzna wiersze za "bez zmian" i nie wypełni komórek
    state.currentRows = undefined;
    renderPage(currentRows);

    return state;
}

/** Symuluje klik myszą (z opcjonalnym ctrlKey/shiftKey/detail dla dblclick) na elemencie. */
export function click(el, { ctrlKey = false, shiftKey = false, detail = 1 } = {}) {
    el.dispatchEvent(new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey,
        shiftKey,
        detail,
    }));
}

/** Symuluje wciśnięcie klawisza (np. Ctrl+C) na danym elemencie (domyślnie document). */
export function keydown(target, { key, ctrlKey = false, metaKey = false } = {}) {
    (target ?? window.document).dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
        ctrlKey,
        metaKey,
    }));
}

/** Zwraca komórkę LP (numer wiersza) dla danego page-relative indexu wiersza. */
export function lpCellOf(state, rowIndex) {
    return state.cachedGridHtml[rowIndex].querySelector('.lp-cell');
}

/** Zwraca komórkę nagłówka (bez LP) dla danego indeksu kolumny. */
export function headerCellOf(state, colIndex) {
    return state.cachedHeaderHtml[colIndex + 1];
}

/** Zwraca komórkę danych (bez LP) dla danego wiersza/kolumny. */
export function dataCellOf(state, rowIndex, colIndex) {
    return state.cachedGrid[rowIndex][colIndex + 1];
}
