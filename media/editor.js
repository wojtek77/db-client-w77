import { State } from './state.js';
import { applyColumnPreview, clearColumnPreview } from './tableRenderer.js';

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
        initGenerateSqlButtons(vscode);
        initSaveColumnEditsButton(vscode);

    });
}

// typy kolumn, dla których edycja odbywa się w textarea, wszystko poza tą listą dostaje zwykły <input>
const MULTILINE_COLUMN_TYPES = new Set([
    'text',
    'tinytext',
    'mediumtext',
    'longtext'
]);

// przyciski zależne od zaznaczenia wierszy pobieramy przez getElementById na żądanie, nie cache'ujemy w module (bo `document` mógłby jeszcze nie istnieć)
// saveColumnEditsBtn celowo pominięty – jego widocznością steruje updateSaveColumnEditsButtonVisibility
function getRowToolsBtnElements() {
    return [
        'generateInsertBtn',
        'generateUpdateBtn',
        'generateDeleteBtn',
        'deleteRowsBtn',
    ].map(id => document.getElementById(id)).filter(Boolean);
}

function isMultilineColumnType(columnType) {
    if (!columnType) {return false;}
    return MULTILINE_COLUMN_TYPES.has(columnType.toLowerCase());
}

// przenosi fokus klawiatury z edytora SQL do siatki wyników – bez tego Ctrl+C trafiał wciąż do edytora (mousedown ma preventDefault chroniący zaznaczanie)
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

        // blokujemy nagłówki, LP oraz sytuację gdy pole edycji już istnieje
        if (!cell || cell.classList.contains('lp-cell') || cell.querySelector('input, textarea')) {return;}

        startEditingCell(cell, vscode);
    });

    // ENTER na zaznaczonej komórce wchodzi w tryb edycji jak dblclick – tylko gdy dokładnie jedna komórka jest zaznaczona i fokus nie jest już w polu edycji
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {return;}

        // sprawdzamy event.target, nie activeElement – blur() w startEditingCell zmienia activeElement przed dobąbelkowaniem, stąd ponowne otwarcie inputu
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {return;}

        const positions = State.getInstance().selectedCellPositions;
        if (!positions || positions.size !== 1) {return;}

        const [key] = positions;
        const [rowIndex, colIndex] = key.split('-').map(Number);
        const cell = State.getInstance().cachedGrid?.[rowIndex]?.[colIndex + 1];
        if (!cell || cell.querySelector('input, textarea')) {return;}

        event.preventDefault();
        startEditingCell(cell, vscode);
    });
}

/**
 * Uruchamia tryb edycji dla podanej komórki (podmienia jej zawartość na input/textarea).
 * Wspólna logika dla dblclick oraz ENTER na zaznaczonej komórce.
 */
function startEditingCell(cell, vscode) {

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
        // cały wiersz rośnie, żeby zmieściła się textarea (bez rozjeżdżania innych wierszy)
        if (row) {row.classList.add('editing-row');}
    }
    input.value = oldValue;
    input.className += (input.className ? ' ' : '') + 'grid-edit-input';

    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    // zapis następuje wyłącznie po ENTER (committed = true przed blur()) – inne opuszczenie pola trafia do blura z committed = false i anuluje edycję
    let committed = false;

    function cancelEdit() {
        if (row) {row.classList.remove('editing-row');}
        cell.textContent = oldValue;
    }

    function saveEdit() {
        const newValue = input.value;
        if (row) {row.classList.remove('editing-row');}

        if (newValue === oldValue) {
            cell.textContent = oldValue;
            return;
        }

        const isColumnSelected = State.getInstance().selectedColIndexes.has(colIndex);

        if (isColumnSelected) {
            // cała kolumna jest zaznaczona -> zamiast update'ować jeden wiersz, startujemy wyłącznie wizualny podgląd zbiorczej edycji tej kolumny
            startColumnEdit(colIndex, newValue);
            return;
        }

        // tekst zmieniamy tymczasowo, pełne potwierdzenie (zielony błysk) przyjdzie z bazy danych
        cell.textContent = newValue;

        // wysyłamy dokładnie to, co odbiera: msg.rowIndex, msg.columnIndex, msg.value
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
            committed = true;
            input.blur();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    });

    input.addEventListener('blur', () => {
        if (committed) {
            saveEdit();
        } else {
            cancelEdit();
        }
    });
}

/**
 * Startuje (wyłącznie wizualny) podgląd zbiorczej edycji CAŁEJ kolumny: zapamiętuje
 * nową wartość w State.pendingColumnEdits (klucz = columnIndex) i nakłada podgląd
 * na wszystkie komórki tej kolumny na bieżącej stronie. Dane w State.currentRows
 * i w backendzie pozostają nietknięte, dopóki użytkownik nie kliknie "Save".
 */
function startColumnEdit(colIndex, value) {
    const pending = { ...State.getInstance().pendingColumnEdits };
    pending[colIndex] = value;
    State.getInstance().pendingColumnEdits = pending;

    applyColumnPreview(colIndex, value);
    updateSaveColumnEditsButtonVisibility();
}

/** Anuluje oczekującą edycję TYLKO jednej kolumny (po jej indeksie) i przywraca jej realne wartości. */
function cancelColumnEdit(colIndex) {
    const pending = { ...State.getInstance().pendingColumnEdits };
    if (!(colIndex in pending)) {return;}

    delete pending[colIndex];
    State.getInstance().pendingColumnEdits = pending;

    clearColumnPreview(colIndex);
    updateSaveColumnEditsButtonVisibility();
}

/** Anuluje WSZYSTKIE oczekujące edycje kolumn - używane m.in. przy uruchomieniu nowego SQL-a (ctrl+enter). */
export function cancelAllColumnEdits() {
    const pending = State.getInstance().pendingColumnEdits || {};
    Object.keys(pending).forEach(colIndex => cancelColumnEdit(Number(colIndex)));
}

/** Ponownie nakłada podgląd dla wszystkich oczekujących edycji kolumn - używane po zmianie strony. */
export function reapplyAllColumnEdits() {
    const pending = State.getInstance().pendingColumnEdits || {};
    if (pending === {}) {
        return;
    }
    Object.keys(pending).forEach(colIndex => {
        applyColumnPreview(Number(colIndex), pending[colIndex]);
    });
    updateSaveColumnEditsButtonVisibility();
}

/* pokazuje/ukrywa przycisk "Save" w zależności od tego, czy są jakieś oczekujące edycje kolumn */
export function updateSaveColumnEditsButtonVisibility(onlyHide = false) {
    const btn = document.getElementById('saveColumnEditsBtn');
    if (!btn) {return;}

    const pending = onlyHide ? {} : (State.getInstance().pendingColumnEdits || {});
    btn.style.display = Object.keys(pending).length > 0 ? 'inline-block' : 'none';
}

/* obsługa kliknięcia przycisku "Save" - wysyła wszystkie oczekujące edycje kolumn do
   rozszerzenia; ono pokaże okno potwierdzenia i wykona (lub anuluje) faktyczny zapis */
function initSaveColumnEditsButton(vscode) {
    const btn = document.getElementById('saveColumnEditsBtn');
    if (!btn) {return;}

    btn.addEventListener('click', () => {
        const headers = State.getInstance().headers;
        const pending = State.getInstance().pendingColumnEdits || {};

        const edits = Object.keys(pending).map(colIndex => ({
            columnIndex: Number(colIndex),
            columnName: headers[Number(colIndex)],
            value: pending[colIndex]
        }));

        if (edits.length === 0) {return;}

        vscode.postMessage({
            command: 'saveColumnEdits',
            edits
        });
    });
}

/* zaznaczenie wiersza - selectedRowIndexes w State jest źródłem prawdy, klasa
   'selected-row' to tylko wizualny efekt uboczny aktualizowany razem z nim */
function setRowSelected(row, rowIndex, select) {
    row.classList.toggle('selected-row', select);
    if (select) {
        State.getInstance().selectedRowIndexes.add(rowIndex);
    } else {
        State.getInstance().selectedRowIndexes.delete(rowIndex);
    }
}

/** Odznacza wszystkie aktualnie zaznaczone wiersze (na podstawie Setu, bez przeszukiwania DOM). */
export function clearRowSelection() {
    const rows = State.getInstance().cachedGridHtml || [];
    State.getInstance().selectedRowIndexes.forEach(rowIndex => {
        if (rows[rowIndex]) {rows[rowIndex].classList.remove('selected-row');}
    });
    State.getInstance().selectedRowIndexes.clear();
}

export function initRowSelection() {

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

        // rows w tej samej kolejności co w DOM, ale bez ponownego przeszukiwania go
        const rows = State.getInstance().cachedGridHtml;

        // SHIFT - zaznaczenie zakresu od anchora
        if (event.shiftKey && anchorRow) {

            if (!event.ctrlKey) {
                clearRowSelection();
            }

            const from = anchorRow._rowIndex;
            const to = targetRow._rowIndex;

            if (from !== undefined && to !== undefined) {

                const start = Math.min(from, to);
                const end = Math.max(from, to);

                for (let i = start; i <= end; i++) {
                    setRowSelected(rows[i], i, true);
                }
            }

            updateDeleteButtonVisibility();
            return;
        }

        // CTRL - przełącz zaznaczenie pojedynczego wiersza
        if (event.ctrlKey) {

            const willSelect = !State.getInstance().selectedRowIndexes.has(targetRow._rowIndex);
            setRowSelected(targetRow, targetRow._rowIndex, willSelect);

            // kliknięty wiersz staje się nowym anchorem
            anchorRow = targetRow;

            updateDeleteButtonVisibility();
            return;
        }

        // zwykły klik

        const wasSelected = State.getInstance().selectedRowIndexes.has(targetRow._rowIndex);
        const selectedCount = State.getInstance().selectedRowIndexes.size;

        clearRowSelection();

        // kliknięcie jedynego zaznaczonego wiersza -> odznaczenie
        if (!(wasSelected && selectedCount === 1)) {
            setRowSelected(targetRow, targetRow._rowIndex, true);
            anchorRow = targetRow;
        } else {
            anchorRow = null;
        }

        updateDeleteButtonVisibility();
    });
}

/* pokazuje ikony w .tools (kosz, generowanie SQL) tylko wtedy, gdy przynajmniej jeden wiersz jest zaznaczony
   (na podstawie State.selectedRowIndexes, bez przeszukiwania DOM po klasach).
   Przycisk #saveColumnEditsBtn jest celowo pominięty - jego widoczność zależy wyłącznie
   od tego, czy są jakieś oczekujące edycje kolumn (patrz updateSaveColumnEditsButtonVisibility) */
export function updateDeleteButtonVisibility() {
    const hasSelection = State.hasInstance() && State.getInstance().selectedRowIndexes.size > 0;
    getRowToolsBtnElements().forEach(btn => {
        btn.style.display = hasSelection ? 'inline-block' : 'none';
    });
}

/* wymusza ukrycie przycisków narzędziowych niezależnie od stanu zaznaczenia - używane
   np. przy 'showEmpty', gdzie siatka i tak znika, więc żadne zaznaczenie nie ma już znaczenia */
export function hideToolsButtons() {
    getRowToolsBtnElements().forEach(btn => {
        btn.style.display = 'none';
    });
}

/* zbiera indeksy aktualnie zaznaczonych wierszy (page-relative, tak jak przy edycji komórki),
   posortowane rosnąco - tak samo jak wcześniej zwracał je querySelectorAll (kolejność w DOM) */
function collectSelectedRowIndexes() {
    return [...State.getInstance().selectedRowIndexes].sort((a, b) => a - b);
}

/* obsługa kliknięcia ikony kosza - wysyła indeksy zaznaczonych wierszy do rozszerzenia */
export function initDeleteRowsButton(vscode) {
    const deleteBtn = document.getElementById('deleteRowsBtn');
    const gridBody = document.getElementById('gridBody');
    if (!deleteBtn || !gridBody) {
        return;
    }

    deleteBtn.addEventListener('click', () => {
        const rowIndexes = collectSelectedRowIndexes();
        if (rowIndexes.length === 0) {
            return;
        }

        vscode.postMessage({
            command: 'deleteRows',
            rowIndexes
        });
    });
}

/* obsługa ikon generowania SQL (INSERT/UPDATE/DELETE) - ta sama logika co kosz, inna komenda */
export function initGenerateSqlButtons(vscode) {
    const gridBody = document.getElementById('gridBody');
    if (!gridBody) {
        return;
    }

    const buttons = [
        { id: 'generateInsertBtn', command: 'generateInsert' },
        { id: 'generateUpdateBtn', command: 'generateUpdate' },
        { id: 'generateDeleteBtn', command: 'generateDelete' }
    ];

    for (const { id, command } of buttons) {
        const btn = document.getElementById(id);
        if (!btn) {
            continue;
        }

        btn.addEventListener('click', () => {
            const rowIndexes = collectSelectedRowIndexes();
            if (rowIndexes.length === 0) {
                return;
            }

            vscode.postMessage({ command, rowIndexes });
        });
    }
}

/* zaznaczenie kolumny */
export function initColumnSelection() {

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
        const headerCell = State.getInstance().cachedHeaderHtml?.[colIndex + 1];
        if (headerCell) {
            headerCell.classList.toggle('selected-col', select);
        }

        const rows = State.getInstance().cachedGrid;
        rows.forEach(rowCells => {
            const cell = rowCells[colIndex + 1];
            if (cell) {
                cell.classList.toggle('selected-col', select);
            }
        });

        if (select) {
            State.getInstance().selectedColIndexes.add(colIndex);
        } else {
            State.getInstance().selectedColIndexes.delete(colIndex);
        }

        // odznaczenie kolumny -> anuluj niezapisaną edycję tej kolumny (znika podświetlenie, wraca wartość, znika przycisk Save jeśli brak innych edycji)
        if (!select) {
            cancelColumnEdit(colIndex);
        }
    }

    function clearAllColumns(headerCells) {
        // headerCells pochodzi z cachedHeaderHtml.slice(1), więc pozycja w tablicy jest indeksem kolumny – nie trzeba parsować dataset.columnIndex
        headerCells.forEach((hc, idx) => selectColumn(idx, false));
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

        // pomijamy indeks 0 (LP) - reszta jest w tej samej kolejności co kolumny
        const headerCells = State.getInstance().cachedHeaderHtml.slice(1);

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

            const isSelected = State.getInstance().selectedColIndexes.has(targetCol);
            selectColumn(targetCol, !isSelected);

            // kliknięta kolumna staje się nowym anchorem
            anchorCol = targetCol;

            return;
        }

        // zwykły klik

        const wasSelected = State.getInstance().selectedColIndexes.has(targetCol);
        const selectedCount = State.getInstance().selectedColIndexes.size;

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
export function initCellSelection() {

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
        // +1, bo pierwsza komórka wiersza to LP
        return State.getInstance().cachedGrid?.[rowIndex]?.[colIndex + 1] ?? null;
    }

    function selectCell(rowIndex, colIndex, select) {
        const cell = getCell(rowIndex, colIndex);
        if (cell) {
            cell.classList.toggle('selected-cell', select);
        }

        const key = `${rowIndex}-${colIndex}`;
        if (select) {
            State.getInstance().selectedCellPositions.add(key);
        } else {
            State.getInstance().selectedCellPositions.delete(key);
        }
    }

    // odznacza wszystkie zaznaczone komórki na podstawie Setu, bez przeszukiwania DOM
    function clearAllCells() {
        State.getInstance().selectedCellPositions.forEach(key => {
            const [r, c] = key.split('-').map(Number);
            const cell = getCell(r, c);
            if (cell) {cell.classList.remove('selected-cell');}
        });
        State.getInstance().selectedCellPositions.clear();
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

            const isSelected = State.getInstance().selectedCellPositions.has(`${targetIndex.row}-${targetIndex.col}`);
            selectCell(targetIndex.row, targetIndex.col, !isSelected);

            // kliknięta komórka staje się nowym anchorem
            anchorCell = targetIndex;

            return;
        }

        // zwykły klik

        const wasSelected = State.getInstance().selectedCellPositions.has(`${targetIndex.row}-${targetIndex.col}`);
        const selectedCount = State.getInstance().selectedCellPositions.size;

        clearAllCells();

        // kliknięcie jedynej zaznaczonej komórki -> odznaczenie
        if (!(wasSelected && selectedCount === 1)) {
            selectCell(targetIndex.row, targetIndex.col, true);
            anchorCell = targetIndex;
        } else {
            anchorCell = null;
        }

    });

    // nawigacja strzałkami przesuwa zaznaczenie do sąsiedniej komórki – działa tylko gdy jedna komórka jest zaznaczona i nie trwa edycja
    const ARROW_DELTAS = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
    };

    document.addEventListener('keydown', (event) => {
        const delta = ARROW_DELTAS[event.key];
        if (!delta) {return;}

        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {return;}

        const positions = State.getInstance().selectedCellPositions;
        if (!positions || positions.size !== 1) {return;}

        const [key] = positions;
        const [rowIndex, colIndex] = key.split('-').map(Number);

        const rowCount = State.getInstance().cachedGrid?.length ?? 0;
        const colCount = State.getInstance().headers?.length ?? 0;

        const newRow = rowIndex + delta[0];
        const newCol = colIndex + delta[1];

        // poza granicami siatki - nic nie robimy (nie ma dokąd przejść)
        if (newRow < 0 || newRow >= rowCount || newCol < 0 || newCol >= colCount) {return;}

        event.preventDefault();

        clearAllCells();
        selectCell(newRow, newCol, true);
        anchorCell = { row: newRow, col: newCol };

        const cell = getCell(newRow, newCol);
        if (cell) {cell.scrollIntoView({block: 'nearest', inline: 'nearest'});}
    });
}

/* kopiowanie zaznaczenia (wiersze / kolumny / komórki) do schowka */
export function initClipboard() {

    const gridBody = document.getElementById('gridBody');
    if (!gridBody) {
        return;
    }

    function cellValue(rowIndex, colIndex) {
        const cell = State.getInstance().cachedGrid?.[rowIndex]?.[colIndex + 1];
        return cell ? cell.textContent : '';
    }

    // zbiera pozycje (row-col) ze wszystkich trzech typów zaznaczenia wprost z Setów w State, bez przeszukiwania DOM po klasach
    function collectSelectedPositions() {
        const positions = new Set();
        const state = State.getInstance();

        // zaznaczone wiersze -> wszystkie kolumny danego wiersza
        const columnCount = state.headers.length;
        state.selectedRowIndexes.forEach(rowIndex => {
            for (let col = 0; col < columnCount; col++) {
                positions.add(`${rowIndex}-${col}`);
            }
        });

        // zaznaczone kolumny -> wszystkie wiersze danej kolumny (bieżącej strony)
        const rowCount = state.cachedGrid.length;
        state.selectedColIndexes.forEach(colIndex => {
            for (let row = 0; row < rowCount; row++) {
                positions.add(`${row}-${colIndex}`);
            }
        });

        // pojedyncze zaznaczone komórki
        state.selectedCellPositions.forEach(key => positions.add(key));

        return positions;
    }

    // buduje tekst TSV (wklejalny do Excela/Sheets) odtwarzając prostokąt z użytych wierszy/kolumn – pola spoza zaznaczenia wychodzą puste
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
            // ochrona przed wielokrotnym KILL QUERY – przy połączeniach międzykontynentalnych round-trip trwa sekundy, bez blokady można kliknąć kilka razy
            if (btn.classList.contains('cancelling')) {
                return;
            }
            btn.classList.add('cancelling');

            // feedback natychmiast, przed odpowiedzią z rozszerzenia – czekanie na KILL QUERY sprawiało wrażenie zawieszenia, tu to zmiana DOM od razu
            const loadingText = document.querySelector('.loading-text');
            if (loadingText) {
                loadingText.textContent = 'Cancelling query…';
                document.querySelector('.spinner').style.borderTopColor = 'var(--vscode-errorForeground)';
            }

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
