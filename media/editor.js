export function initEditor(vscode) {
    document.addEventListener('DOMContentLoaded', () => {

        initCellEditing(vscode);
        initRowSelection();
        initColumnSelection();
        initCellSelection();
        initClipboard();
        initConnectionButton(vscode);
        initCancelButton(vscode);
        initConnectionColorButton(vscode);
        initDeleteRowsButton(vscode);

    });
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

// Przenosi fokus klawiatury z edytora SQL do siatki wyników.
// Bez tego kliknięcie w wynikach nie zabiera fokusu edytorowi (bo mousedown ma preventDefault
// dla ochrony przed zaznaczaniem tekstu), przez co np. Ctrl+C trafiał wciąż do edytora.
function focusGridContainer() {
    const gridContainer = document.getElementById('gridContainer');
    if (gridContainer) {
        gridContainer.focus();
    }
}

/* edycja komórki */
function initCellEditing(vscode) {

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
}

/* zaznaczenie wiersza */
function initRowSelection() {

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
            // przejmujemy fokus klawiatury z edytora SQL, żeby Ctrl+C działał od razu
            focusGridContainer();
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

            updateDeleteButtonVisibility(rows);
            return;
        }

        // CTRL - przełącz zaznaczenie pojedynczego wiersza
        if (event.ctrlKey) {

            targetRow.classList.toggle('selected-row');

            // kliknięty wiersz staje się nowym anchorem
            anchorRow = targetRow;

            updateDeleteButtonVisibility(rows);
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

        updateDeleteButtonVisibility(rows);
    });
}

/* pokazuje ikonę kosza tylko wtedy, gdy przynajmniej jeden wiersz jest zaznaczony */
function updateDeleteButtonVisibility(rows) {
    const deleteBtn = document.getElementById('deleteRowsBtn');
    if (!deleteBtn) {
        return;
    }

    const hasSelection = rows.some(r => r.classList.contains('selected-row'));
    deleteBtn.style.display = hasSelection ? 'inline-block' : 'none';
}

/* obsługa kliknięcia ikony kosza - wysyła indeksy zaznaczonych wierszy do rozszerzenia */
function initDeleteRowsButton(vscode) {
    const deleteBtn = document.getElementById('deleteRowsBtn');
    const gridBody = document.getElementById('gridBody');
    if (!deleteBtn || !gridBody) {
        return;
    }

    deleteBtn.addEventListener('click', () => {
        const selectedRows = [...gridBody.querySelectorAll('.grid-row.selected-row')];
        if (selectedRows.length === 0) {
            return;
        }

        const rowIndexes = selectedRows
            .map(row => {
                const dataCell = row.querySelector('.grid-cell:not(.lp-cell)');
                return dataCell && dataCell._index ? dataCell._index.row : null;
            })
            .filter(rowIndex => rowIndex !== null);

        if (rowIndexes.length === 0) {
            return;
        }

        vscode.postMessage({
            command: 'deleteRows',
            rowIndexes
        });
    });
}

/* zaznaczenie kolumny */
function initColumnSelection() {

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
            // przejmujemy fokus klawiatury z edytora SQL, żeby Ctrl+C działał od razu
            focusGridContainer();
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
}

/* zaznaczenie komórki */
function initCellSelection() {

    const gridBody = document.getElementById('gridBody');
    if (!gridBody) {
        return;
    }

    // punkt początkowy zaznaczenia (anchor)
    let anchorCell = null; // {row, col}

    // zapobiega zaznaczaniu tekstu podczas klikania komórek (poza trwającą edycją)
    gridBody.addEventListener('mousedown', (event) => {
        const cell = event.target.closest('.grid-cell');
        if (!cell || cell.classList.contains('lp-cell')) {
            return;
        }
        if (cell.querySelector('input, textarea')) {
            return;
        }
        event.preventDefault();
        // przejmujemy fokus klawiatury z edytora SQL, żeby Ctrl+C działał od razu
        focusGridContainer();
    });

    function getCell(rowIndex, colIndex) {
        const rows = gridBody.querySelectorAll('.grid-row');
        const row = rows[rowIndex];
        if (!row) {
            return null;
        }
        // +1, bo pierwsza komórka wiersza to LP
        return row.children[colIndex + 1] || null;
    }

    function selectCell(rowIndex, colIndex, select) {
        const cell = getCell(rowIndex, colIndex);
        if (cell) {
            cell.classList.toggle('selected-cell', select);
        }
    }

    function clearAllCells() {
        gridBody.querySelectorAll('.grid-cell.selected-cell').forEach(c => {
            c.classList.remove('selected-cell');
        });
    }

    gridBody.addEventListener('click', (event) => {

        // reagujemy wyłącznie na kliknięcie komórki z danymi (nie LP)
        const cell = event.target.closest('.grid-cell');
        if (!cell || cell.classList.contains('lp-cell')) {
            return;
        }

        // trwa edycja tej komórki - klik ma ustawić kursor w polu tekstowym, a nie zaznaczać
        if (cell.querySelector('input, textarea')) {
            return;
        }

        // pomijamy drugi klik podwójnego kliknięcia (on uruchamia edycję komórki)
        if (event.detail > 1) {
            return;
        }

        const targetIndex = cell._index;
        if (!targetIndex) {
            return;
        }

        // SHIFT - zaznaczenie prostokątnego zakresu od anchora
        if (event.shiftKey && anchorCell) {

            if (!event.ctrlKey) {
                clearAllCells();
            }

            const rowStart = Math.min(anchorCell.row, targetIndex.row);
            const rowEnd = Math.max(anchorCell.row, targetIndex.row);
            const colStart = Math.min(anchorCell.col, targetIndex.col);
            const colEnd = Math.max(anchorCell.col, targetIndex.col);

            for (let r = rowStart; r <= rowEnd; r++) {
                for (let c = colStart; c <= colEnd; c++) {
                    selectCell(r, c, true);
                }
            }

            return;
        }

        // CTRL - przełącz zaznaczenie pojedynczej komórki
        if (event.ctrlKey) {

            const isSelected = cell.classList.contains('selected-cell');
            selectCell(targetIndex.row, targetIndex.col, !isSelected);

            // kliknięta komórka staje się nowym anchorem
            anchorCell = targetIndex;

            return;
        }

        // zwykły klik

        const wasSelected = cell.classList.contains('selected-cell');
        const selectedCount = gridBody.querySelectorAll('.grid-cell.selected-cell').length;

        clearAllCells();

        // kliknięcie jedynej zaznaczonej komórki -> odznaczenie
        if (!(wasSelected && selectedCount === 1)) {
            selectCell(targetIndex.row, targetIndex.col, true);
            anchorCell = targetIndex;
        } else {
            anchorCell = null;
        }

    });
}

/* kopiowanie zaznaczenia (wiersze / kolumny / komórki) do schowka */
function initClipboard() {

    const gridBody = document.getElementById('gridBody');
    if (!gridBody) {
        return;
    }

    function cellValue(rowIndex, colIndex) {
        const rows = gridBody.querySelectorAll('.grid-row');
        const row = rows[rowIndex];
        if (!row) {return '';}
        const cell = row.children[colIndex + 1];
        return cell ? cell.textContent : '';
    }

    // zbiera pozycje (row-col) ze wszystkich trzech typów zaznaczenia
    function collectSelectedPositions() {
        const positions = new Set();

        // zaznaczone wiersze -> wszystkie kolumny danego wiersza
        gridBody.querySelectorAll('.grid-row.selected-row').forEach(row => {
            row.querySelectorAll('.grid-cell:not(.lp-cell)').forEach(cell => {
                if (cell._index) {
                    positions.add(`${cell._index.row}-${cell._index.col}`);
                }
            });
        });

        // zaznaczone kolumny -> wszystkie wiersze danej kolumny
        gridBody.querySelectorAll('.grid-cell.selected-col').forEach(cell => {
            if (cell._index) {
                positions.add(`${cell._index.row}-${cell._index.col}`);
            }
        });

        // pojedyncze zaznaczone komórki
        gridBody.querySelectorAll('.grid-cell.selected-cell').forEach(cell => {
            if (cell._index) {
                positions.add(`${cell._index.row}-${cell._index.col}`);
            }
        });

        return positions;
    }

    // buduje tekst w formacie TSV (wklejalny wprost do Excela/Sheets),
    // odtwarzając prostokąt na podstawie użytych wierszy/kolumn;
    // pola spoza zaznaczenia (ale w obrębie prostokąta) wychodzą puste
    function buildClipboardText(positions) {
        if (positions.size === 0) {
            return '';
        }

        const rowsSet = new Set();
        const colsSet = new Set();

        positions.forEach(key => {
            const [r, c] = key.split('-').map(Number);
            rowsSet.add(r);
            colsSet.add(c);
        });

        const rowsSorted = [...rowsSet].sort((a, b) => a - b);
        const colsSorted = [...colsSet].sort((a, b) => a - b);

        const lines = rowsSorted.map(r => {
            return colsSorted.map(c => {
                return positions.has(`${r}-${c}`) ? cellValue(r, c) : '';
            }).join('\t');
        });

        return lines.join('\n');
    }

    function fallbackCopy(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy');
        } catch (e) {
            // schowek niedostępny - nic nie robimy
        }
        document.body.removeChild(textarea);
    }

    function copyToClipboard(text) {
        if (!text) {
            return;
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        } else {
            fallbackCopy(text);
        }
    }

    document.addEventListener('keydown', (event) => {

        const isCopyShortcut = (event.ctrlKey || event.metaKey) && (event.key === 'c' || event.key === 'C');
        if (!isCopyShortcut) {
            return;
        }

        // podczas edycji pola (input/textarea) nie przejmujemy Ctrl+C - ma zadziałać zwykłe kopiowanie zaznaczonego tekstu
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            return;
        }

        const positions = collectSelectedPositions();
        if (positions.size === 0) {
            return;
        }

        event.preventDefault();
        copyToClipboard(buildClipboardText(positions));
    });
}

/* zmiana połączenia z DB */
function initConnectionButton(vscode) {

    const btn = document.getElementById('connectionName');
    if (btn) {
        btn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'changeConnection'
            });
        });
    }
}

/* przerwanie działania SQL-a */
function initCancelButton(vscode) {

    const btn = document.getElementById('cancelQuery');
    if (btn) {
        btn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'cancelQuery'
            });
        });
    }
}

/* zmiana koloru DB */
function initConnectionColorButton(vscode) {

    const btn = document.getElementById('connectionColorBtn');
    if (btn) {
        btn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'pickConnectionColor'
            });
        });
    }
}
