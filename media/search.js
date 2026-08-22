import { State } from './state.js';

let vscodeRef;
let debounceTimer = null;

// debounce dla wyszukiwania w locie - bez tego każde naciśnięcie klawisza wywoływałoby pełne przeskanowanie this._allRows w backendzie
const SEARCH_DEBOUNCE_MS = 150;

// wskaźnik "szukam" pokazujemy dopiero po tylu ms od wysłania zapytania - krótkie wyszukiwania (większość przypadków) nigdy go nie zobaczą
const SEARCH_INDICATOR_SHOW_DELAY_MS = 150;
// gdy wskaźnik już się pokazał, trzymamy go minimum tyle ms, żeby nie migał przy wyszukiwaniach które akurat skończyły się chwilę po progu pokazania
const SEARCH_INDICATOR_MIN_HOLD_MS = 300;

let indicatorShowTimer = null;
let indicatorHideTimer = null;
let indicatorVisible = false;
let indicatorShownAt = 0;

function getEls() {
    return {
        input: document.getElementById('searchInput'),
        count: document.getElementById('searchCount'),
        clearBtn: document.getElementById('searchClearBtn'),
        spinner: document.getElementById('searchSpinner'),
    };
}

/** pokazuje/chowa krzyżyk czyszczenia frazy - widoczny tylko gdy input ma treść */
function updateClearButtonVisibility() {
    const { input, clearBtn } = getEls();
    if (!clearBtn) {return;}
    clearBtn.classList.toggle('visible', Boolean(input && input.value));
}

/** planuje pokazanie wskaźnika "szukam" po SEARCH_INDICATOR_SHOW_DELAY_MS - wywoływane przy każdym faktycznie wysłanym zapytaniu do backendu */
function scheduleIndicatorShow() {
    // nowe zapytanie startuje - ewentualne odliczanie do schowania poprzedniego wskaźnika jest już nieaktualne
    if (indicatorHideTimer) {
        clearTimeout(indicatorHideTimer);
        indicatorHideTimer = null;
    }
    // wskaźnik już widoczny (poprzednie wyszukiwanie wciąż trwa) - to kolejne po prostu kontynuuje ten sam stan "szukam"
    if (indicatorVisible || indicatorShowTimer) {return;}

    indicatorShowTimer = setTimeout(() => {
        indicatorShowTimer = null;
        indicatorVisible = true;
        indicatorShownAt = Date.now();
        const { spinner } = getEls();
        if (spinner) {spinner.classList.add('visible');}
    }, SEARCH_INDICATOR_SHOW_DELAY_MS);
}

/** chowa wskaźnik "szukam" (od razu albo po dopilnowaniu minimalnego czasu pokazania) - wołane, gdy backend odpowiedział wynikiem wyszukiwania */
export function hideSearchIndicator() {
    // wyszukiwanie skończyło się zanim próg pokazania minął - wskaźnik nigdy się nie pokazał, nie ma czego chować
    if (indicatorShowTimer) {
        clearTimeout(indicatorShowTimer);
        indicatorShowTimer = null;
    }
    if (!indicatorVisible) {return;}

    const elapsed = Date.now() - indicatorShownAt;
    const remaining = SEARCH_INDICATOR_MIN_HOLD_MS - elapsed;

    const doHide = () => {
        indicatorHideTimer = null;
        indicatorVisible = false;
        const { spinner } = getEls();
        if (spinner) {spinner.classList.remove('visible');}
    };

    if (remaining <= 0) {
        doHide();
    } else {
        if (indicatorHideTimer) {clearTimeout(indicatorHideTimer);}
        indicatorHideTimer = setTimeout(doHide, remaining);
    }
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
    // wskaźnik liczy realny czas przetwarzania na backendzie, więc startuje dopiero tutaj, nie w momencie naciśnięcia klawisza (debounce to nie "szukanie")
    scheduleIndicatorShow();
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
 *
 * Które komórki są aktualnie podświetlone, trzymamy w osobnym kluczu state.searchHighlightedCells,
 * zamiast wnioskować to z samego cachedGrid - dzięki temu przy zdejmowaniu podświetleń dotykamy
 * tylko komórek, które faktycznie miały <mark> (namierzonych po pozycji z poprzedniego wywołania),
 * a nie zamiatamy całego grida na każde naciśnięcie klawisza w polu wyszukiwania.
 */
export function highlightMatchesOnCurrentPage() {
    if (!State.hasInstance()) {return;}
    const state = State.getInstance();
    // state.searchQuery jest tu zawsze świeżo ustawione z msg.searchQuery (messageHandler.js), już przyciętego u źródła w SqlResultsProvider.performSearch
    const query = state.searchQuery || '';
    const previousMatches = state.searchHighlightedCells;

    // brak aktywnej frazy i strona nie ma żadnych wcześniejszych podświetleń do zdjęcia - nie ma czego robić, pomijamy przejście po wszystkich komórkach
    if (!query && previousMatches.size === 0) {return;}

    const lowerQuery = query.toLowerCase();

    const rows = state.cachedGrid;
    const currentRows = state.currentRows;
    if (!rows || !currentRows) {return;}

    // nowy komplet pozycji, które po tym przebiegu mają być podświetlone - zastąpi previousMatches na końcu
    const nextMatches = new Set();

    rows.forEach((rowCells, i) => {
        const entry = currentRows[i];
        if (!entry) {return;}

        // od indeksu 1, bo indeks 0 to komórka LP, która nigdy nie jest dopasowaniem
        for (let j = 1; j < rowCells.length; j++) {
            const cell = rowCells[j];
            const posKey = `${i}-${j}`;

            // pole w trakcie edycji (input/textarea) pomijamy - podmiana zawartości zniszczyłaby edytowalny element
            if (cell.querySelector('input, textarea')) {continue;}
            // komórka z niezapisanym podglądem bulk-edita kolumny (patrz applyColumnPreview w tableRenderer.js) pokazuje CELOWO inną wartość niż State.currentRows - nie nadpisujemy jej
            if (cell.classList.contains('column-edit-pending')) {continue;}
            // to samo dla niezapisanego podglądu zbiorczej edycji niezależnie zaznaczonych komórek (patrz applyCellGroupPreview w tableRenderer.js)
            if (cell.classList.contains('cell-edit-pending')) {continue;}

            const text = String(entry.data[j - 1] ?? 'NULL');
            const isMatch = Boolean(query) && text.toLowerCase().includes(lowerQuery);

            if (isMatch) {
                cell.replaceChildren(buildHighlightedFragment(text, lowerQuery));
                nextMatches.add(posKey);
            } else if (previousMatches.has(posKey)) {
                // ta komórka miała podświetlenie z poprzedniego wywołania, ale już nie pasuje (fraza się zmieniła/zniknęła) - przywracamy czysty tekst
                cell.textContent = text;
            }
            // komórka, która ani teraz, ani poprzednio nie była dopasowaniem - w ogóle jej nie ruszamy
        }
    });

    state.searchHighlightedCells = nextMatches;

    console.log('HIGHLIGHT_MATCHES_ON_CURRENT_PAGE');
}

/** czyści cały stan wyszukiwania (nowy SQL, zmiana pliku, zamknięcie zakładki) i pole inputu */
export function resetSearch() {
    if (!State.hasInstance()) {return;}
    const state = State.getInstance();
    state.searchQuery = '';

    const { input } = getEls();
    if (input) {input.value = '';}

    updateCountLabel();
    updateClearButtonVisibility();
}

/** czyści frazę i natychmiast wysyła puste zapytanie do backendu, z pominięciem debounce - to jednoznaczna akcja (przycisk/Escape), nie wpisywanie znaków */
function clearSearch() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    resetSearch();
    sendSearch('');
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
    updateClearButtonVisibility();
    highlightMatchesOnCurrentPage();
    
    console.log('RESTORE_SEARCH_UI');
}

export function initSearchListeners(vscode) {
    vscodeRef = vscode;

    document.addEventListener('DOMContentLoaded', () => {
        const { input, clearBtn } = getEls();
        if (!input) {return;}

        input.addEventListener('input', () => {
            if (!State.hasInstance()) {return;}
            State.getInstance().searchQuery = input.value;
            updateCountLabel();
            updateClearButtonVisibility();
            debouncedSearch(input.value);
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                clearSearch();
                input.blur();
            }
        });

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                clearSearch();
                input.focus();
            });
        }

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
