import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, click, lpCellOf } from './domTestUtils.js';
import { State } from '../state.js';
import { initRowSelection } from '../editor.js';

// messageHandler.js czyta DOM już w momencie importu, więc setupDom() musi być przed dynamicznym importem, nie statycznym na górze pliku
// listener 'message' jest podpięty pod to konkretne `dom.window` – testy muszą dispatchować eventy na tym samym obiekcie
const dom = setupDom();
await import('../messageHandler.js');
initRowSelection();

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
