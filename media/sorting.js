import { State } from './state.js';

let vscodeRef;

// cykl po kliknięciu w strzałkę sortowania danej kolumny: brak sortowania -> rosnąco -> malejąco -> brak sortowania
function nextDirection(currentDirection) {
    if (currentDirection === 'asc') {return 'desc';}
    if (currentDirection === 'desc') {return null;}
    return 'asc';
}

/**
 * nasłuch kliknięcia w strzałkę sortowania (.sort-indicator) w nagłówku kolumny. Rejestrowany w fazie
 * capture na #gridHeader, żeby zadziałać PRZED listenerem zaznaczania kolumny z editor.js (initColumnSelection),
 * który też nasłuchuje 'click' na tym samym #gridHeader w domyślnej fazie bubble - inaczej stopPropagation()
 * wywołane w listenerze zarejestrowanym później (bubble) nie zdążyłoby powstrzymać tego zarejestrowanego wcześniej.
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
            const state = State.getInstance();
            const currentDirection = state.sortColumn === columnIndex ? state.sortDirection : null;
            const direction = nextDirection(currentDirection);

            vscodeRef.postMessage({ command: 'sortColumn', columnIndex, direction });
        }, { capture: true });
    });
}
