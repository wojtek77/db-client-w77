import { State } from './state.js';

// przesuwa dany typ na koniec state.selectionTypeOrder (czyli czyni go "aktywnym") - delete+add, bo zwykły add na Secie nie zmienia pozycji istniejącego elementu
function touchSelectionType(type) {
    const order = State.getInstance().selectionTypeOrder;
    order.delete(type);
    order.add(type);
}

// usuwa dany typ z state.selectionTypeOrder, ale tylko gdy faktycznie nie ma już żadnych zaznaczeń tego typu - w przeciwnym razie kolejność zostaje bez zmian
function untouchSelectionTypeIfEmpty(type, isEmptyNow) {
    if (isEmptyNow) {
        State.getInstance().selectionTypeOrder.delete(type);
    }
}

// --- wiersze ---

export function markRowSelected(rowIndex) {
    State.getInstance().selectedRowIndexes.add(rowIndex);
    touchSelectionType('row');
}

export function unmarkRowSelected(rowIndex) {
    const state = State.getInstance();
    state.selectedRowIndexes.delete(rowIndex);
    untouchSelectionTypeIfEmpty('row', state.selectedRowIndexes.size === 0);
}

export function clearAllRowMarks() {
    const state = State.getInstance();
    state.selectedRowIndexes.clear();
    state.selectionTypeOrder.delete('row');
}

// --- kolumny ---

export function markColSelected(colIndex) {
    State.getInstance().selectedColIndexes.add(colIndex);
    touchSelectionType('col');
}

export function unmarkColSelected(colIndex) {
    const state = State.getInstance();
    state.selectedColIndexes.delete(colIndex);
    untouchSelectionTypeIfEmpty('col', state.selectedColIndexes.size === 0);
}

export function clearAllColMarks() {
    const state = State.getInstance();
    state.selectedColIndexes.clear();
    state.selectionTypeOrder.delete('col');
}

// --- komórki ---

export function markCellSelected(rowIndex, colIndex) {
    State.getInstance().selectedCellPositions.add(`${rowIndex}-${colIndex}`);
    touchSelectionType('cell');
}

export function unmarkCellSelected(rowIndex, colIndex) {
    const state = State.getInstance();
    state.selectedCellPositions.delete(`${rowIndex}-${colIndex}`);
    untouchSelectionTypeIfEmpty('cell', state.selectedCellPositions.size === 0);
}

export function clearAllCellMarks() {
    const state = State.getInstance();
    state.selectedCellPositions.clear();
    state.selectionTypeOrder.delete('cell');
}

/**
 * Zwraca pozycje "row-col" do skopiowania na podstawie WYŁĄCZNIE ostatnio aktywnego typu zaznaczenia
 * (ostatni element state.selectionTypeOrder) - pozostałe typy mogą pozostawać wizualnie zaznaczone
 * (np. jako punkt odniesienia w danych), ale nie wchodzą do kopiowanego tekstu.
 * @returns {Set<string>}
 */
export function getActiveClipboardPositions() {
    const state = State.getInstance();
    const order = state.selectionTypeOrder;
    const positions = new Set();

    if (order.size === 0) {
        return positions;
    }

    const activeType = [...order].at(-1);

    if (activeType === 'row') {
        const columnCount = state.headers.length;
        state.selectedRowIndexes.forEach(rowIndex => {
            for (let col = 0; col < columnCount; col++) {
                positions.add(`${rowIndex}-${col}`);
            }
        });
    } else if (activeType === 'col') {
        const rowCount = state.cachedGrid.length;
        state.selectedColIndexes.forEach(colIndex => {
            for (let row = 0; row < rowCount; row++) {
                positions.add(`${row}-${colIndex}`);
            }
        });
    } else if (activeType === 'cell') {
        state.selectedCellPositions.forEach(key => positions.add(key));
    }

    return positions;
}
