import { State } from './state.js';

let vscodeRef;

// te same wartości i ten sam mechanizm co przy wyszukiwaniu (patrz SEARCH_INDICATOR_* w search.js) - przy dużych zbiorach (np. 2 mln wierszy) samo sortowanie potrafi zająć kilka sekund
const SORT_INDICATOR_SHOW_DELAY_MS = 150;
const SORT_INDICATOR_MIN_HOLD_MS = 300;

let sortIndicatorShowTimer = null;
let sortIndicatorHideTimer = null;
// element aktualnie pokazanego/planowanego spinnera - trzymany tu, a nie odnajdywany na nowo przy chowaniu, bo nagłówek mógł zostać w międzyczasie przebudowany (renderHeaders)
let activeSortSpinnerEl = null;
let sortIndicatorShownAt = 0;

/** planuje pokazanie spinnera przy TEJ konkretnej strzałce po SORT_INDICATOR_SHOW_DELAY_MS - wywoływane przy każdym kliknięciu w strzałkę sortowania */
function scheduleSortSpinnerShow(spinnerEl) {
    if (sortIndicatorHideTimer) {
        clearTimeout(sortIndicatorHideTimer);
        sortIndicatorHideTimer = null;
    }
    // poprzedni spinner (np. inna kolumna, jeszcze niepokazany) jest już nieaktualny - to kliknięcie zastępuje go tym nowym
    if (activeSortSpinnerEl && activeSortSpinnerEl !== spinnerEl) {
        activeSortSpinnerEl.classList.remove('visible');
    }
    if (sortIndicatorShowTimer) {clearTimeout(sortIndicatorShowTimer);}

    sortIndicatorShowTimer = setTimeout(() => {
        sortIndicatorShowTimer = null;
        activeSortSpinnerEl = spinnerEl;
        sortIndicatorShownAt = Date.now();
        spinnerEl.classList.add('visible');
    }, SORT_INDICATOR_SHOW_DELAY_MS);
}

/** chowa spinner sortowania (od razu albo po dopilnowaniu minimalnego czasu pokazania) - wołane, gdy backend odpowiedział posortowaną stroną (appendData) */
export function hideSortSpinner() {
    if (sortIndicatorShowTimer) {
        clearTimeout(sortIndicatorShowTimer);
        sortIndicatorShowTimer = null;
    }
    if (!activeSortSpinnerEl) {return;}

    const spinnerEl = activeSortSpinnerEl;
    activeSortSpinnerEl = null;

    const elapsed = Date.now() - sortIndicatorShownAt;
    const remaining = SORT_INDICATOR_MIN_HOLD_MS - elapsed;

    const doHide = () => {
        sortIndicatorHideTimer = null;
        spinnerEl.classList.remove('visible');
    };

    if (remaining <= 0) {
        doHide();
    } else {
        if (sortIndicatorHideTimer) {clearTimeout(sortIndicatorHideTimer);}
        sortIndicatorHideTimer = setTimeout(doHide, remaining);
    }
}

/**
 * nasłuch kliknięcia w strzałkę sortowania (.sort-indicator) w nagłówku kolumny. Rejestrowany w fazie
 * capture na #gridHeader, żeby zadziałać PRZED listenerem zaznaczania kolumny z editor.js (initColumnSelection),
 * który też nasłuchuje 'click' na tym samym #gridHeader w domyślnej fazie bubble - inaczej stopPropagation()
 * wywołane w listenerze zarejestrowanym później (bubble) nie zdążyłoby powstrzymać tego zarejestrowanego wcześniej.
 *
 * Zwykły klik = ta kolumna staje się jedynym kryterium sortowania (cykl asc -> desc -> brak, patrz backend toggleSort).
 * Shift+klik = dokłada/aktualizuje/usuwa TĘ kolumnę jako kolejne kryterium, budując sortowanie wielokolumnowe
 * (ORDER BY col1, col2, ...) - backend jest źródłem prawdy dla całej listy, więc webview tylko zgłasza klik + Shift.
 */
export function initSortListeners(vscode) {
    vscodeRef = vscode;

    document.addEventListener('DOMContentLoaded', () => {
        const gridHeader = document.getElementById('gridHeader');
        if (!gridHeader) {return;}

        gridHeader.addEventListener('click', (event) => {
            const indicator = event.target.closest('.sort-indicator');
            if (!indicator) {return;} // klik poza strzałką - niech dojdzie normalnie do zaznaczania kolumny w editor.js

            // powstrzymujemy dalszą propagację, żeby klik w strzałkę nie odpalił też zaznaczenia kolumny
            event.stopPropagation();

            const headerCell = indicator.closest('.header-cell');
            const columnIndex = headerCell ? parseInt(headerCell.dataset.columnIndex, 10) : NaN;
            if (Number.isNaN(columnIndex)) {return;}

            if (!State.hasInstance()) {return;}

            vscodeRef.postMessage({ command: 'sortColumn', columnIndex, additive: event.shiftKey });

            // spinner planujemy zaraz po wysłaniu, tak samo jak w search.js - odlicza realny czas przetwarzania na backendzie
            const spinnerEl = headerCell ? headerCell.querySelector('.sort-spinner') : null;
            if (spinnerEl) {scheduleSortSpinnerShow(spinnerEl);}
        }, { capture: true });
    });
}
