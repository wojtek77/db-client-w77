import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { State } from '../state.js';
import { renderHeaders, initializeGrid, renderPage } from '../tableRenderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = path.join(__dirname, '..', 'styles.css');

// minimalny szkielet HTML odpowiadający strukturze z src/panel/html.ts – tylko elementy, na których operuje media/*.js
// (uwaga: sekcja toolbar/pagination/loadingOverlay jest tu potrzebna tylko dla messageHandler.js - patrz messageHandler.test.js)
const BASE_HTML = `<!doctype html>
<html>
<body>
    <div class="toolbar" id="connectionColor">
        <span id="connectionName">-------</span>
        <span id="connectionTime">---</span>
        <span id="queryTime">---</span>
        <span id="queryTimeUnit">ms</span>
        <span id="cancelQuery" class="cancel-query"></span>
        <span id="infoMessage"></span>
        <span id="flashMessage"></span>
        <span id="generateInsertBtn" class="tools-btn generate-insert-btn"></span>
        <span id="generateUpdateBtn" class="tools-btn generate-update-btn"></span>
        <span id="generateDeleteBtn" class="tools-btn generate-delete-btn"></span>
        <span id="deleteRowsBtn" class="tools-btn delete-rows-btn"></span>
        <span id="saveColumnEditsBtn" class="tools-btn save-column-edits-btn"></span>
    </div>
    <div class="pagination">
        <button class="btn" id="firstBtn"></button>
        <button class="btn" id="prevBtn"></button>
        <span id="currentPage">1</span>
        <span id="totalPages">1</span>
        <button class="btn" id="nextBtn"></button>
        <button class="btn" id="lastBtn"></button>
    </div>
    <p id="errorDisplay" class="error-message"></p>
    <div id="gridContainer" class="grid-container" tabindex="-1">
        <div id="loadingOverlay" class="loading-overlay">
            <div class="spinner"></div>
            <div class="loading-text">Loading data...</div>
        </div>
        <div id="gridHeader" class="grid-header"></div>
        <div id="gridBody" class="grid-body"></div>
    </div>
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
    // Node (>=21) ma własny, tylko-do-odczytu `navigator` – trzeba go nadpisać przez defineProperty, zwykłe przypisanie rzuci TypeError
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

    // tak samo jak w messageHandler.js: currentRows musi być 'undefined' przed renderPage(), inaczej uzna wiersze za bez zmian i nie wypełni komórek
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

/**
 * Wstrzykuje prawdziwy plik media/styles.css do bieżącego dokumentu jsdom (jako <style> w <head>),
 * żeby getComputedStyle() liczył się z realną kaskadą CSS (np. dziedziczenie cursor między .grid-row a .lp-cell).
 * Wywołaj po setupDom(), przed sprawdzaniem computed style.
 */
export function loadStylesheet() {
    const css = fs.readFileSync(STYLES_PATH, 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
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
