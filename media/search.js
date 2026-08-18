import { State } from './state.js';

let vscodeRef;
let debounceTimer = null;

// debounce dla wyszukiwania w locie - bez tego każde naciśnięcie klawisza wywoływałoby pełne przeskanowanie this._allRows w backendzie
const SEARCH_DEBOUNCE_MS = 300;

function getEls() {
    return {
        input: document.getElementById('searchInput'),
        count: document.getElementById('searchCount'),
    };
}

function updateCountLabel() {
    const { count } = getEls();
    if (!count || !State.hasInstance()) {return;}

    const state = State.getInstance();
    if (!state.searchQuery) {
        count.textContent = '';
        return;
    }

    count.textContent = `${state.totalRows} of ${state.totalRowsUnfiltered}`;
}

function sendSearch(query) {
    vscodeRef.postMessage({ command: 'search', query });
}

function debouncedSearch(query) {
    if (debounceTimer) {clearTimeout(debounceTimer);}
    debounceTimer = setTimeout(() => sendSearch(query), SEARCH_DEBOUNCE_MS);
}

/**
 * Buduje fragment DOM z tekstu, w którym każde wystąpienie lowerQuery jest owinięte w <mark>.
 * Działa wyłącznie na węzłach tekstowych (bez innerHTML), więc treść komórki - w pełni
 * niezaufana, bo pochodzi z bazy danych - nigdy nie jest interpretowana jako HTML.
 * @param {string} text - oryginalny (nieprzeskalowany) tekst komórki
 * @param {string} lowerQuery - fraza wyszukiwania, już zamieniona na małe litery
 */
function buildHighlightedFragment(text, lowerQuery) {
    const fragment = document.createDocumentFragment();
    const lowerText = text.toLowerCase();

    let cursor = 0;
    let matchAt = lowerText.indexOf(lowerQuery, cursor);

    while (matchAt !== -1) {
        if (matchAt > cursor) {
            fragment.appendChild(document.createTextNode(text.slice(cursor, matchAt)));
        }
        const mark = document.createElement('mark');
        mark.className = 'search-match';
        mark.textContent = text.slice(matchAt, matchAt + lowerQuery.length);
        fragment.appendChild(mark);

        cursor = matchAt + lowerQuery.length;
        matchAt = lowerText.indexOf(lowerQuery, cursor);
    }

    if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    return fragment;
}

/**
 * Podświetla fragmenty tekstu w komórkach BIEŻĄCEJ strony, które pasują do aktywnej frazy
 * wyszukiwania - czysto kosmetyczne, o TYM, KTÓRE wiersze w ogóle są widoczne, decyduje już
 * backend (filtruje this._allRows przed wysłaniem strony - patrz applySearchFilter), więc tu
 * wystarczy podkreślić, dlaczego dany wiersz się załapał. Surowy tekst bierzemy zawsze z
 * State.currentRows (entry.data), a nie z DOM, żeby nie gubić/dublować oryginalnej wartości
 * przy kolejnych wywołaniach.
 */
export function highlightMatchesOnCurrentPage() {
    if (!State.hasInstance()) {return;}
    const state = State.getInstance();
    const query = (state.searchQuery || '').trim();
    const lowerQuery = query.toLowerCase();

    const rows = state.cachedGrid;
    const currentRows = state.currentRows;
    if (!rows || !currentRows) {return;}

    rows.forEach((rowCells, i) => {
        const entry = currentRows[i];
        if (!entry) {return;}

        // od indeksu 1, bo indeks 0 to komórka LP, która nigdy nie jest dopasowaniem
        for (let j = 1; j < rowCells.length; j++) {
            const cell = rowCells[j];

            // pole w trakcie edycji (input/textarea) pomijamy - podmiana zawartości zniszczyłaby edytowalny element
            if (cell.querySelector('input, textarea')) {continue;}
            // komórka z niezapisanym podglądem bulk-edita kolumny (patrz applyColumnPreview w tableRenderer.js) pokazuje CELOWO inną wartość niż State.currentRows - nie nadpisujemy jej
            if (cell.classList.contains('column-edit-pending')) {continue;}

            const text = String(entry.data[j - 1] ?? 'NULL');

            if (query && text.toLowerCase().includes(lowerQuery)) {
                cell.replaceChildren(buildHighlightedFragment(text, lowerQuery));
            } else {
                cell.textContent = text;
            }
        }
    });
}

/** czyści cały stan wyszukiwania (nowy SQL, zmiana pliku, zamknięcie zakładki) i pole inputu */
export function resetSearch() {
    if (!State.hasInstance()) {return;}
    const state = State.getInstance();
    state.searchQuery = '';

    const { input } = getEls();
    if (input) {input.value = '';}

    updateCountLabel();
}

/**
 * Synchronizuje pole inputu/licznik z per-plikowym State (backend jest źródłem prawdy dla
 * searchQuery - patrz msg.searchQuery w messageHandler.js) i dokleja podświetlenie na
 * właśnie wyrenderowaną stronę. Wywoływane po każdym appendData/showResultsForFile.
 */
export function restoreSearchUI() {
    if (!State.hasInstance()) {return;}
    const state = State.getInstance();
    const { input } = getEls();

    // nie nadpisujemy inputu, jeśli user właśnie w nim pisze - debounce mógł jeszcze nie zdążyć wysłać najnowszej frazy do backendu
    if (input && document.activeElement !== input) {
        input.value = state.searchQuery || '';
    }

    updateCountLabel();
    highlightMatchesOnCurrentPage();
}

export function initSearchListeners(vscode) {
    vscodeRef = vscode;

    document.addEventListener('DOMContentLoaded', () => {
        const { input } = getEls();
        if (!input) {return;}

        input.addEventListener('input', () => {
            if (!State.hasInstance()) {return;}
            State.getInstance().searchQuery = input.value;
            updateCountLabel();
            debouncedSearch(input.value);
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                resetSearch();
                sendSearch('');
                input.blur();
            }
        });

        // Ctrl/Cmd+F wewnątrz webview przenosi fokus do pola wyszukiwania - bezpieczne, bo webview to osobny kontekst DOM niż główny edytor SQL w VS Code, więc nie koliduje z jego wbudowanym "Find"
        document.addEventListener('keydown', (event) => {
            const isFindShortcut = (event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F');
            if (!isFindShortcut) {return;}

            event.preventDefault();
            input.focus();
            input.select();
        });
    });
}
