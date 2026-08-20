import { State } from './state.js';

let vscodeRef;

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
        }, { capture: true });
    });
}
