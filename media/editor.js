export function initEditor(vscode) {

    registerEvents(vscode);
}

// Typy kolumn, dla których edycja odbywa się w polu wieloliniowym (textarea).
// Wszystko poza tą listą (np. varchar, char, int, decimal, date...) dostaje zwykły <input>.
const MULTILINE_COLUMN_TYPES = new Set([
    'text',
    'tinytext',
    'mediumtext',
    'longtext'
]);

function isMultilineColumnType(columnType) {
    if (!columnType) {return false;}
    return MULTILINE_COLUMN_TYPES.has(columnType.toLowerCase());
}

function registerEvents(vscode) {
    /* edycja komórki */
    document.addEventListener('DOMContentLoaded', () => {
        const gridBody = document.getElementById('gridBody');
        if (!gridBody) {return;}

        gridBody.addEventListener('dblclick', (event) => {
            const cell = event.target.closest('.grid-cell');
            
            // Blokujemy nagłówki, LP oraz sytuację gdy pole edycji już istnieje
            if (!cell || cell.classList.contains('lp-cell') || cell.querySelector('input, textarea')) {return;}

            const rowIndex = cell._index.row;
            const colIndex = cell._index.col;
            const oldValue = cell.textContent;
            const columnType = cell.dataset.columnType;
            const multiline = isMultilineColumnType(columnType);

            const input = document.createElement(multiline ? 'textarea' : 'input');
            const row = cell.closest('.grid-row');
            if (!multiline) {
                input.type = 'text';
            } else {
                input.rows = 4;
                input.classList.add('grid-edit-input-multiline');
                // Cały wiersz rośnie, żeby zmieściła się textarea (bez rozjeżdżania innych wierszy)
                if (row) {row.classList.add('editing-row');}
            }
            input.value = oldValue;
            input.className += (input.className ? ' ' : '') + 'grid-edit-input';

            cell.textContent = '';
            cell.appendChild(input);
            input.focus();
            input.select();

            function saveEdit() {
                const newValue = input.value;
                if (row) {row.classList.remove('editing-row');}
                
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
                if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
                    e.preventDefault();
                    input.blur();
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (row) {row.classList.remove('editing-row');}
                    cell.textContent = oldValue;
                }
            });

            input.addEventListener('blur', () => {
                saveEdit();
            });
        });
    });
    
    /* zaznaczenie wiersza */
    /* zaznaczenie wiersza */
    document.addEventListener('DOMContentLoaded', () => {

        const gridBody = document.getElementById('gridBody');
        if (!gridBody) {
            return;
        }

        // punkt początkowy zaznaczenia (anchor)
        let anchorRow = null;

        // zapobiega zaznaczaniu tekstu podczas klikania numerów wierszy
        gridBody.addEventListener('mousedown', (event) => {
            if (event.target.closest('.lp-cell')) {
                event.preventDefault();
            }
        });

        gridBody.addEventListener('click', (event) => {

            // reagujemy wyłącznie na kliknięcie numeru wiersza
            const lpCell = event.target.closest('.lp-cell');
            if (!lpCell) {
                return;
            }

            const targetRow = lpCell.closest('.grid-row');
            if (!targetRow) {
                return;
            }

            const rows = [...gridBody.querySelectorAll('.grid-row')];

            // SHIFT - zaznaczenie zakresu od anchora
            if (event.shiftKey && anchorRow) {

                if (!event.ctrlKey) {
                    rows.forEach(r => r.classList.remove('selected-row'));
                }

                const from = rows.indexOf(anchorRow);
                const to = rows.indexOf(targetRow);

                if (from !== -1 && to !== -1) {

                    const start = Math.min(from, to);
                    const end = Math.max(from, to);

                    for (let i = start; i <= end; i++) {
                        rows[i].classList.add('selected-row');
                    }
                }

                return;
            }

            // CTRL - przełącz zaznaczenie pojedynczego wiersza
            if (event.ctrlKey) {

                targetRow.classList.toggle('selected-row');

                // kliknięty wiersz staje się nowym anchorem
                anchorRow = targetRow;

                return;
            }

            // zwykły klik

            const wasSelected = targetRow.classList.contains('selected-row');
            const selectedCount = rows.filter(r => r.classList.contains('selected-row')).length;

            rows.forEach(r => r.classList.remove('selected-row'));

            // kliknięcie jedynego zaznaczonego wiersza -> odznaczenie
            if (!(wasSelected && selectedCount === 1)) {
                targetRow.classList.add('selected-row');
                anchorRow = targetRow;
            } else {
                anchorRow = null;
            }

        });

    });
    
    /* zaznaczenie kolumny */
    document.addEventListener('DOMContentLoaded', () => {

        const gridHeader = document.getElementById('gridHeader');
        const gridBody = document.getElementById('gridBody');
        if (!gridHeader || !gridBody) {
            return;
        }

        // punkt początkowy zaznaczenia (anchor)
        let anchorCol = null;

        // zapobiega zaznaczaniu tekstu podczas klikania nagłówków kolumn
        gridHeader.addEventListener('mousedown', (event) => {
            const headerCell = event.target.closest('.header-cell');
            if (headerCell && !headerCell.classList.contains('lp-cell')) {
                event.preventDefault();
            }
        });

        function getColumnIndex(headerCell) {
            const idx = headerCell.dataset.columnIndex;
            return idx === undefined ? null : parseInt(idx, 10);
        }

        // zaznacza/odznacza nagłówek kolumny oraz wszystkie komórki danych w tej kolumnie
        function selectColumn(colIndex, select) {
            const headerCell = gridHeader.querySelector(`.header-cell[data-column-index="${colIndex}"]`);
            if (headerCell) {
                headerCell.classList.toggle('selected-col', select);
            }

            const rows = gridBody.querySelectorAll('.grid-row');
            rows.forEach(row => {
                const cell = row.children[colIndex + 1];
                if (cell) {
                    cell.classList.toggle('selected-col', select);
                }
            });
        }

        function clearAllColumns(headerCells) {
            headerCells.forEach(hc => {
                const idx = getColumnIndex(hc);
                if (idx !== null) {
                    selectColumn(idx, false);
                }
            });
        }

        gridHeader.addEventListener('click', (event) => {

            // reagujemy wyłącznie na kliknięcie nagłówka kolumny (nie LP)
            const headerCell = event.target.closest('.header-cell');
            if (!headerCell || headerCell.classList.contains('lp-cell')) {
                return;
            }

            const targetCol = getColumnIndex(headerCell);
            if (targetCol === null) {
                return;
            }

            const headerCells = [...gridHeader.querySelectorAll('.header-cell:not(.lp-cell)')];

            // SHIFT - zaznaczenie zakresu od anchora
            if (event.shiftKey && anchorCol !== null) {

                if (!event.ctrlKey) {
                    clearAllColumns(headerCells);
                }

                const start = Math.min(anchorCol, targetCol);
                const end = Math.max(anchorCol, targetCol);

                for (let i = start; i <= end; i++) {
                    selectColumn(i, true);
                }

                return;
            }

            // CTRL - przełącz zaznaczenie pojedynczej kolumny
            if (event.ctrlKey) {

                const isSelected = headerCell.classList.contains('selected-col');
                selectColumn(targetCol, !isSelected);

                // kliknięta kolumna staje się nowym anchorem
                anchorCol = targetCol;

                return;
            }

            // zwykły klik

            const wasSelected = headerCell.classList.contains('selected-col');
            const selectedCount = headerCells.filter(hc => hc.classList.contains('selected-col')).length;

            clearAllColumns(headerCells);

            // kliknięcie jedynej zaznaczonej kolumny -> odznaczenie
            if (!(wasSelected && selectedCount === 1)) {
                selectColumn(targetCol, true);
                anchorCol = targetCol;
            } else {
                anchorCol = null;
            }

        });

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
    
    /* zmiana koloru DB */
    document.addEventListener('DOMContentLoaded', () => {

        const btn = document.getElementById('connectionColorBtn');
        if (btn) {
            btn.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'pickConnectionColor'
                });
            });
        }
    });
}
