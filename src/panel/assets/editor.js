function initEditor(vscode) {

    registerEvents(vscode);
}

function registerEvents(vscode) {
    /* edycja komórki */
    document.addEventListener('DOMContentLoaded', () => {
        const gridBody = document.getElementById('gridBody');
        if (!gridBody) return;

        gridBody.addEventListener('dblclick', (event) => {
            const cell = event.target.closest('.grid-cell');
            
            // Blokujemy nagłówki, LP oraz sytuację gdy input już istnieje
            if (!cell || cell.classList.contains('lp-cell') || cell.querySelector('input')) return;

            const rowIndex = cell._index.row;
            const colIndex = cell._index.col;
            const oldValue = cell.textContent;

            const input = document.createElement('input');
            input.type = 'text';
            input.value = oldValue;
            input.className = 'grid-edit-input';

            cell.textContent = '';
            cell.appendChild(input);
            input.focus();
            input.select();

            function saveEdit() {
                const newValue = input.value;
                
                if (newValue === oldValue) {
                    cell.textContent = oldValue;
                    return;
                }

                // Tekst zmieniamy tymczasowo, pełne potwierdzenie (zielony błysk) przyjdzie z bazy danych
                cell.textContent = newValue;

                // Wysyłamy dokładnie to, co odbiera: msg.rowIndex, msg.columnIndex, msg.value
                vscode.postMessage({
                    command: 'updateCell',
                    rowIndex: rowIndex,
                    columnIndex: colIndex,
                    value: newValue
                });
            }

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    cell.textContent = oldValue;
                }
            });

            input.addEventListener('blur', () => {
                saveEdit();
            });
        });
    });
    
    /* zaznaczenie wiersza */
    document.addEventListener('DOMContentLoaded', () => {
        const gridBody = document.getElementById('gridBody');
        
        if (gridBody) {
            gridBody.addEventListener('click', (event) => {
                // Szukamy najbliższej komórki (div z klasą .grid-cell)
                const cell = event.target.closest('.grid-cell');
                if (!cell) return;
                
                // Ignorujemy kliknięcia w komórkę LP (numer wiersza), jeśli nie chcesz jej zaznaczać
                // if (cell.classList.contains('lp-cell')) return;

                // Znajdujemy cały wiersz, w którym znajduje się kliknięta komórka
                const targetRow = cell.closest('.grid-row');
                if (!targetRow) return;

                // 🚀 WYDAJNOŚĆ: Usuwamy klasę 'selected-row' z poprzednio zaznaczonego wiersza
                const previousSelected = gridBody.querySelector('.selected-row');
                if (previousSelected) {
                    previousSelected.classList.remove('selected-row');
                }

                // Dodajemy klasę podświetlenia do nowego wiersza
                targetRow.classList.add('selected-row');
                
                // Log pomocniczy (możesz go usunąć)
                // console.log(`Zaznaczono wiersz o indeksie globalnym: ${targetRow.dataset.rowIndex}`);
            });
        }
    });
    
    /* zmiana połączenia z DB */
    document.addEventListener('DOMContentLoaded', () => {

        const btn = document.getElementById('connectionName');
        if (btn) {
            btn.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'changeConnection'
                });
            });
        }
    });
    
    /* przerwanie działania SQL-a */
    document.addEventListener('DOMContentLoaded', () => {

        const btn = document.getElementById('cancelQuery');
        if (btn) {
            btn.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'cancelQuery'
                });
            });
        }
    });
}
