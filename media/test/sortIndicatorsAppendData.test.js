import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, headerCellOf } from './domTestUtils.js';
import { State } from '../state.js';

// messageHandler.js czyta DOM już w momencie importu, więc setupDom() musi być przed dynamicznym importem, nie statycznym na górze pliku
// listener 'message' jest podpięty pod to konkretne `dom.window` – testy muszą dispatchować eventy na tym samym obiekcie
const dom = setupDom();
await import('../messageHandler.js');

/** Symuluje wiadomość 'appendData' z backendu (SqlResultsProvider.sendPage), tak jak naprawdę leci przez postMessage do webview. */
function sendAppendData({ sqlFile, headers, rows, rowKeys, isSameQuery, sortCriteria = [] }) {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
            command: 'appendData',
            sqlFile,
            headers,
            columnTypes: [],
            rows,
            rowKeys,
            isEncoded: false,
            totalRows: rows.length,
            currentPage: 1,
            connectionName: 'test-conn',
            connectionTime: 1,
            queryTime: 1,
            isSameQuery,
            sortCriteria,
            sentAt: Date.now(),
        }
    }));
}

/** Symuluje wiadomość 'showResultsForFile' (powrót do wcześniej otwartej zakładki pliku). */
function sendShowResultsForFile({ sqlFile, sortCriteria = [] }) {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
            command: 'showResultsForFile',
            sqlFile,
            sortCriteria,
            sentAt: Date.now(),
        }
    }));
}

/** Zwraca glif+klasę strzałki sortowania danej kolumny. */
function indicatorOf(state, colIndex) {
    const el = headerCellOf(state, colIndex).querySelector('.sort-indicator');
    return { text: el.textContent, active: el.classList.contains('sort-active') };
}

describe('regres: strzałki sortowania po appendData - gałąź A/D (renderHeaders ustawia je od razu)', () => {

    test('nowy plik z od razu aktywnym sortowaniem - świeżo zbudowany nagłówek ma poprawną strzałkę bez dodatkowego updateSortIndicators()', () => {
        const sqlFile = 'sort-branch-ad-1.sql';

        sendAppendData({
            sqlFile,
            headers: ['id', 'name'],
            rows: [[1, 'a']],
            isSameQuery: false,
            sortCriteria: [{ columnIndex: 1, direction: 'desc' }],
        });

        const state = State.getInstance();
        assert.deepEqual(indicatorOf(state, 1), { text: '▼', active: true });
        assert.deepEqual(indicatorOf(state, 0), { text: '⇅', active: false });
    });
});

describe('regres: strzałki sortowania po appendData - gałąź B (ten sam plik, kształt bez zmian, DOM nie jest przebudowywany)', () => {

    test('kliknięcie sortowania na tym samym pliku i kształcie musi zaktualizować strzałkę mimo że header DOM nie jest przebudowywany', () => {
        const sqlFile = 'sort-branch-b-1.sql';

        // pierwsze uruchomienie - brak aktywnego sortowania
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20]],
            isSameQuery: false,
            sortCriteria: [],
        });

        const state = State.getInstance();
        assert.deepEqual(indicatorOf(state, 0), { text: '⇅', active: false });

        // ten sam plik, ten sam kształt wyniku (kolumny bez zmian) - dokładnie ścieżka po kliknięciu w strzałkę sortowania
        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10], ['B200', 20]],
            isSameQuery: true,
            sortCriteria: [{ columnIndex: 0, direction: 'asc' }],
        });

        assert.deepEqual(indicatorOf(State.getInstance(), 0), { text: '▲', active: true });
        assert.deepEqual(indicatorOf(State.getInstance(), 1), { text: '⇅', active: false });
    });

    test('cofnięcie sortowania (nowe sortCriteria = []) na tym samym kształcie usuwa strzałkę, a nie zostawia starej', () => {
        const sqlFile = 'sort-branch-b-2.sql';

        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10]],
            isSameQuery: false,
            sortCriteria: [{ columnIndex: 1, direction: 'desc' }],
        });

        assert.deepEqual(indicatorOf(State.getInstance(), 1), { text: '▼', active: true });

        sendAppendData({
            sqlFile,
            headers: ['sku', 'price'],
            rows: [['A100', 10]],
            isSameQuery: true,
            sortCriteria: [],
        });

        assert.deepEqual(indicatorOf(State.getInstance(), 1), { text: '⇅', active: false });
    });
});

describe('regres: strzałki sortowania po appendData - gałąź C (restoreHeaderFromCache przy powrocie do pliku)', () => {

    test('przełączenie na plik z cache o tym samym kształcie odświeża strzałki zgodnie z jego własnym sortCriteria, nie zostawia strzałek poprzedniego pliku', () => {
        const sqlFileA = 'sort-branch-c-a.sql';
        const sqlFileB = 'sort-branch-c-b.sql';

        // plik A - aktywne sortowanie po kolumnie 0
        sendAppendData({
            sqlFile: sqlFileA,
            headers: ['x', 'y'],
            rows: [[1, 2]],
            isSameQuery: false,
            sortCriteria: [{ columnIndex: 0, direction: 'asc' }],
        });
        const stateA = State.getInstance();
        assert.deepEqual(indicatorOf(stateA, 0), { text: '▲', active: true });

        // plik B - ten sam kształt (te same nazwy kolumn), ale bez sortowania
        sendAppendData({
            sqlFile: sqlFileB,
            headers: ['x', 'y'],
            rows: [[3, 4]],
            isSameQuery: false,
            sortCriteria: [],
        });
        assert.deepEqual(indicatorOf(State.getInstance(), 0), { text: '⇅', active: false });

        // powrót do pliku A - ten sam kształt co poprzednio zapamiętany w cache -> restoreHeaderFromCache(), a nie renderHeaders()
        sendAppendData({
            sqlFile: sqlFileA,
            headers: ['x', 'y'],
            rows: [[1, 2]],
            isSameQuery: false,
            sortCriteria: [{ columnIndex: 0, direction: 'asc' }],
        });

        // gdyby updateSortIndicators() nie wykonało się w tej gałęzi, przywrócony z cache nagłówek pliku B (bez sortowania) zostałby błędnie użyty jako header pliku A
        assert.deepEqual(indicatorOf(State.getInstance(), 0), { text: '▲', active: true });
    });
});

describe('regres: strzałki sortowania w showResultsForFile (powrót do zakładki pliku)', () => {

    test('powrót do zakładki przywraca strzałki zgodnie z sortCriteria zapamiętanym po stronie backendu dla tego pliku', () => {
        const sqlFile = 'sort-show-results-1.sql';

        // pierwsze wypełnienie danych dla pliku (buduje cache nagłówka), bez aktywnego sortowania
        sendAppendData({
            sqlFile,
            headers: ['a', 'b'],
            rows: [[1, 2]],
            isSameQuery: false,
            sortCriteria: [],
        });
        assert.deepEqual(indicatorOf(State.getInstance(), 1), { text: '⇅', active: false });

        // użytkownik przełącza się na inny plik (zmiana zakładki w edytorze), potem backend przysyła showResultsForFile z zapamiętanym sortCriteria dla tego pliku
        sendShowResultsForFile({
            sqlFile,
            sortCriteria: [{ columnIndex: 1, direction: 'desc' }],
        });

        assert.deepEqual(indicatorOf(State.getInstance(), 1), { text: '▼', active: true });
        assert.deepEqual(indicatorOf(State.getInstance(), 0), { text: '⇅', active: false });
    });
});

describe('regres: wiele aktywnych kryteriów - numer priorytetu w gałęziach A i B', () => {

    test('dwa kryteria sortowania od razu przy renderHeaders() (gałąź A) mają numer priorytetu ▲1/▼2', () => {
        const sqlFile = 'sort-priority-a.sql';

        sendAppendData({
            sqlFile,
            headers: ['a', 'b', 'c'],
            rows: [[1, 2, 3]],
            isSameQuery: false,
            sortCriteria: [
                { columnIndex: 2, direction: 'desc' },
                { columnIndex: 0, direction: 'asc' },
            ],
        });

        assert.deepEqual(indicatorOf(State.getInstance(), 2), { text: '▼1', active: true });
        assert.deepEqual(indicatorOf(State.getInstance(), 0), { text: '▲2', active: true });
    });

    test('rozszerzenie z jednego na dwa kryteria na tym samym kształcie (gałąź B) dopisuje numer priorytetu do obu strzałek', () => {
        const sqlFile = 'sort-priority-b.sql';

        sendAppendData({
            sqlFile,
            headers: ['a', 'b'],
            rows: [[1, 2]],
            isSameQuery: false,
            sortCriteria: [{ columnIndex: 0, direction: 'asc' }],
        });
        assert.deepEqual(indicatorOf(State.getInstance(), 0), { text: '▲', active: true });

        // Shift+klik na drugą kolumnę dokłada ją jako drugie kryterium - ten sam plik i kształt
        sendAppendData({
            sqlFile,
            headers: ['a', 'b'],
            rows: [[1, 2]],
            isSameQuery: true,
            sortCriteria: [
                { columnIndex: 0, direction: 'asc' },
                { columnIndex: 1, direction: 'desc' },
            ],
        });

        assert.deepEqual(indicatorOf(State.getInstance(), 0), { text: '▲1', active: true });
        assert.deepEqual(indicatorOf(State.getInstance(), 1), { text: '▼2', active: true });
    });
});
