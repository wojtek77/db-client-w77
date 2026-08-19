import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, click, lpCellOf, headerCellOf, dataCellOf } from './domTestUtils.js';
import { State } from '../state.js';
import { initRowSelection, initColumnSelection, initCellSelection } from '../editor.js';

// messageHandler.js czyta DOM już w momencie importu, więc setupDom() musi być przed dynamicznym importem, nie statycznym na górze pliku
// listener 'message' jest podpięty pod to konkretne `dom.window` – testy muszą dispatchować eventy na tym samym obiekcie
const dom = setupDom();
await import('../messageHandler.js');
initRowSelection();
initColumnSelection();
initCellSelection();

/** Symuluje wiadomość 'appendData' z backendu (SqlResultsProvider.sendPage), tak jak naprawdę leci przez postMessage do webview. */
function sendAppendData({ sqlFile, headers, rows, isSameQuery, clearSelection = false }) {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
            command: 'appendData',
            sqlFile,
            headers,
            columnTypes: [],
            rows,
            isEncoded: false,
            totalRows: rows.length,
            currentPage: 1,
            connectionName: 'test-conn',
            connectionTime: 1,
            queryTime: 1,
            isSameQuery,
            clearSelection,
            sentAt: Date.now(),
        }
    }));
}

describe('zaznaczenie wiersza między różnymi zapytaniami na tym samym pliku SQL', () => {

    test('uruchomienie innego SQL-a czyści zaznaczenie z poprzedniego wyniku (nie zostaje "widmowy" indeks)', () => {
        const sqlFile = 'cross-query-1.sql';

        // QueryA: wąska lista kolumn, kilka wierszy
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20], ['C300', 30]],
            isSameQuery: false, // pierwsze uruchomienie tego pliku - nie ma jeszcze poprzedniego SQL-a
        });

        const state = State.getInstance();
        click(lpCellOf(state, 2)); // zaznaczamy 3-ci wiersz
        assert.deepEqual([...state.selectedRowIndexes], [2]);
        assert.equal(state.cachedGridHtml[2].classList.contains('selected-row'), true);
        assert.equal(document.getElementById('generateInsertBtn').style.display, 'inline-block', 'przyciski narzędziowe muszą być widoczne po zaznaczeniu wiersza');

        // QueryB: inny SQL, inny kształt wyniku (więcej kolumn, inna kolejność wierszy) -> backend zawsze wysyła isSameQuery=false
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price', 'warehouse'],
            rows: [['C300', 30, 'EU'], ['B200', 20, 'US'], ['A100', 10, 'EU']],
            isSameQuery: false,
        });

        // stary indeks (2) nie powinien przetrwać zmiany zapytania, mimo że siatka mogła zostać przebudowana
        assert.equal(State.getInstance().selectedRowIndexes.size, 0);

        // przyciski (kosz, generowanie SQL) muszą realnie zniknąć z DOM, nie tylko z State - tu właśnie występował bug
        assert.equal(document.getElementById('generateInsertBtn').style.display, 'none', 'przyciski narzędziowe muszą zniknąć po uruchomieniu innego SQL-a');
        assert.equal(document.getElementById('deleteRowsBtn').style.display, 'none');

        // QueryA ponownie: ten sam tekst co za pierwszym razem, ale inny niż poprzedni (QueryB) -> znowu isSameQuery=false
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20], ['C300', 30]],
            isSameQuery: false,
        });

        const stateAfterRerun = State.getInstance();
        assert.equal(stateAfterRerun.selectedRowIndexes.size, 0, 'nie ma żadnych "widmowych" zaznaczeń z poprzednich wyników');

        // klik na 3-ci wiersz musi go ZAZNACZYĆ, a nie odznaczyć (tu właśnie wcześniej występował bug)
        click(lpCellOf(stateAfterRerun, 2));
        assert.deepEqual([...stateAfterRerun.selectedRowIndexes], [2]);
        assert.equal(stateAfterRerun.cachedGridHtml[2].classList.contains('selected-row'), true);
    });

    test('ponowne uruchomienie DOKŁADNIE TEGO SAMEGO SQL-a (np. odświeżenie) zachowuje zaznaczenie', () => {
        const sqlFile = 'cross-query-2.sql';

        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20]],
            isSameQuery: false,
        });

        const state = State.getInstance();
        click(lpCellOf(state, 0));
        assert.deepEqual([...state.selectedRowIndexes], [0]);

        // dokładnie ten sam SQL, ten sam kształt wyniku -> backend wysyła isSameQuery=true
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20]],
            isSameQuery: true,
        });

        assert.deepEqual([...State.getInstance().selectedRowIndexes], [0], 'odświeżenie tego samego zapytania nie powinno gubić zaznaczenia');
    });
});

describe('zaznaczenie kolumny między różnymi zapytaniami na tym samym pliku SQL', () => {

    test('uruchomienie innego SQL-a, a potem powrót do poprzedniego, nie zostawia "widmowego" zaznaczenia kolumny', () => {
        const sqlFile = 'cross-query-cols-1.sql';

        // SQL1
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20], ['C300', 30]],
            isSameQuery: false,
        });

        const state = State.getInstance();
        click(headerCellOf(state, 0)); // zaznaczamy kolumnę 'sku'
        assert.deepEqual([...state.selectedColIndexes], [0]);
        assert.equal(headerCellOf(state, 0).classList.contains('selected-col'), true);

        // SQL2 - inny kształt wyniku, jak w prawdziwym backendzie zawsze isSameQuery=false
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price', 'warehouse'],
            rows: [['C300', 30, 'EU'], ['B200', 20, 'US'], ['A100', 10, 'EU']],
            isSameQuery: false,
        });
        assert.equal(State.getInstance().selectedColIndexes.size, 0);

        // SQL1 ponownie - ten sam kształt co za pierwszym razem
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20], ['C300', 30]],
            isSameQuery: false,
        });

        const stateAfterRerun = State.getInstance();
        assert.equal(stateAfterRerun.selectedColIndexes.size, 0, 'nie ma żadnego "widmowego" zaznaczenia kolumny z poprzednich wyników');

        // pierwszy klik na kolumnę musi ją ZAZNACZYĆ za jednym razem, a nie wymagać drugiego kliknięcia
        click(headerCellOf(stateAfterRerun, 0));
        assert.deepEqual([...stateAfterRerun.selectedColIndexes], [0]);
        assert.equal(headerCellOf(stateAfterRerun, 0).classList.contains('selected-col'), true);
    });
});

describe('zaznaczenie komórki między różnymi zapytaniami na tym samym pliku SQL', () => {

    test('uruchomienie innego SQL-a, a potem powrót do poprzedniego, nie zostawia "widmowego" zaznaczenia komórki', () => {
        const sqlFile = 'cross-query-cells-1.sql';

        // SQL1
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20], ['C300', 30]],
            isSameQuery: false,
        });

        const state = State.getInstance();
        click(dataCellOf(state, 1, 0)); // zaznaczamy komórkę (wiersz 1, kolumna 'sku')
        assert.deepEqual([...state.selectedCellPositions], ['1-0']);
        assert.equal(dataCellOf(state, 1, 0).classList.contains('selected-cell'), true);

        // SQL2 - inny kształt wyniku, jak w prawdziwym backendzie zawsze isSameQuery=false
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price', 'warehouse'],
            rows: [['C300', 30, 'EU'], ['B200', 20, 'US'], ['A100', 10, 'EU']],
            isSameQuery: false,
        });
        assert.equal(State.getInstance().selectedCellPositions.size, 0);

        // SQL1 ponownie - ten sam kształt co za pierwszym razem
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20], ['C300', 30]],
            isSameQuery: false,
        });

        const stateAfterRerun = State.getInstance();
        assert.equal(stateAfterRerun.selectedCellPositions.size, 0, 'nie ma żadnego "widmowego" zaznaczenia komórki z poprzednich wyników');

        // pierwszy klik na komórkę musi ją ZAZNACZYĆ za jednym razem, a nie wymagać drugiego kliknięcia
        click(dataCellOf(stateAfterRerun, 1, 0));
        assert.deepEqual([...stateAfterRerun.selectedCellPositions], ['1-0']);
        assert.equal(dataCellOf(stateAfterRerun, 1, 0).classList.contains('selected-cell'), true);
    });
});

describe('oczekująca zbiorcza edycja komórek (pendingCellEdits) między zapytaniami na tym samym pliku SQL', () => {

    test('ponowne uruchomienie DOKŁADNIE TEGO SAMEGO SQL-a zachowuje oczekującą edycję grupy komórek (tak jak przy edycji kolumny)', () => {
        const sqlFile = 'cross-query-cell-group-1.sql';

        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20]],
            isSameQuery: false,
        });

        const state = State.getInstance();
        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 1, 1), { ctrlKey: true });

        // symulujemy skutek startCellGroupEdit() (patrz cellGroupEdit.test.js dla testu samego wejścia w tryb grupy) - tu interesuje nas wyłącznie zachowanie się tego stanu przy odświeżeniu
        state.pendingCellEdits = { value: 'X', positions: new Set(state.selectedCellPositions) };
        dataCellOf(state, 0, 0).textContent = 'X';
        dataCellOf(state, 0, 0).classList.add('cell-edit-pending');
        dataCellOf(state, 1, 1).textContent = 'X';
        dataCellOf(state, 1, 1).classList.add('cell-edit-pending');

        // dokładnie ten sam SQL, ten sam kształt wyniku -> backend wysyła isSameQuery=true (np. ponowne uruchomienie tego samego zapytania przez Ctrl+Enter)
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20]],
            isSameQuery: true,
        });

        const stateAfterRerun = State.getInstance();
        assert.notEqual(stateAfterRerun.pendingCellEdits, null, 'oczekująca edycja grupy komórek nie powinna zniknąć po ponownym uruchomieniu tego samego SQL-a');
        assert.equal(dataCellOf(stateAfterRerun, 0, 0).textContent, 'X');
        assert.equal(dataCellOf(stateAfterRerun, 0, 0).classList.contains('cell-edit-pending'), true);
        assert.equal(dataCellOf(stateAfterRerun, 1, 1).textContent, 'X');
        assert.equal(dataCellOf(stateAfterRerun, 1, 1).classList.contains('cell-edit-pending'), true);
        assert.notEqual(document.getElementById('saveCellEditsBtn').style.display, 'none');
    });

    test('uruchomienie INNEGO SQL-a anuluje oczekującą edycję grupy komórek (pozycje odnosiłyby się do już nieistniejącego wyniku)', () => {
        const sqlFile = 'cross-query-cell-group-2.sql';

        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20]],
            isSameQuery: false,
        });

        const state = State.getInstance();
        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 1, 1), { ctrlKey: true });
        state.pendingCellEdits = { value: 'X', positions: new Set(state.selectedCellPositions) };
        dataCellOf(state, 0, 0).classList.add('cell-edit-pending');
        dataCellOf(state, 1, 1).classList.add('cell-edit-pending');

        sendAppendData({
            sqlFile,
            headers: ['sku', 'price', 'warehouse'],
            rows: [['A100', 10, 'EU'], ['B200', 20, 'EU']],
            isSameQuery: false,
        });

        assert.equal(State.getInstance().pendingCellEdits, null);
        assert.equal(document.getElementById('saveCellEditsBtn').style.display, 'none');
    });
});
