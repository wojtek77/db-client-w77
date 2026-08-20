import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, click, headerCellOf } from './domTestUtils.js';
import { initSortListeners } from '../sorting.js';
import { updateSortIndicators } from '../tableRenderer.js';
import { initColumnSelection } from '../editor.js';

/** minimalny fake VS Code API - zapamiętuje wszystkie postMessage, żeby testy mogły je zweryfikować */
function fakeVscode() {
    const sent = [];
    return {
        postMessage: (msg) => sent.push(msg),
        sent,
    };
}

/** klika bezpośrednio w .sort-indicator danej kolumny (nie w cały header-cell) */
function clickSortIndicator(state, colIndex, opts) {
    const indicator = headerCellOf(state, colIndex).querySelector('.sort-indicator');
    click(indicator, opts);
}

describe('renderHeaders - struktura nagłówka pod sortowanie', () => {

    test('każdy header-cell (poza LP) ma osobny .header-label z nazwą kolumny i domyślny (nieaktywny) glif sortowania w .sort-indicator', () => {
        setupDom();
        const state = buildGrid('sort-render-1.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a']],
        });

        const header0 = headerCellOf(state, 0);
        assert.equal(header0.querySelector('.header-label').textContent, 'id');
        // pusty string byłby niewidoczny nawet przy pełnym opacity - domyślny glif musi być obecny, tylko wizualnie przygaszony przez CSS
        assert.equal(header0.querySelector('.sort-indicator').textContent, '⇅');
        assert.equal(header0.querySelector('.sort-indicator').classList.contains('sort-active'), false);
    });
});

describe('updateSortIndicators - odzwierciedlenie State.sortColumn/sortDirection w DOM', () => {

    test('brak aktywnego sortowania (sortColumn = null) - obie kolumny mają neutralny glif ⇅, żadna nie ma klasy sort-active', () => {
        setupDom();
        const state = buildGrid('sort-ind-1.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2]],
        });
        state.sortColumn = null;
        state.sortDirection = null;

        updateSortIndicators();

        assert.equal(headerCellOf(state, 0).querySelector('.sort-indicator').textContent, '⇅');
        assert.equal(headerCellOf(state, 1).querySelector('.sort-indicator').textContent, '⇅');
        assert.equal(headerCellOf(state, 0).querySelector('.sort-indicator').classList.contains('sort-active'), false);
    });

    test('sortColumn=1, sortDirection="asc" - strzałka ▲ tylko na kolumnie 1, reszta ma neutralny glif ⇅', () => {
        setupDom();
        const state = buildGrid('sort-ind-2.sql', {
            headers: ['a', 'b', 'c'],
            currentRows: [[1, 2, 3]],
        });
        state.sortColumn = 1;
        state.sortDirection = 'asc';

        updateSortIndicators();

        const ind0 = headerCellOf(state, 0).querySelector('.sort-indicator');
        const ind1 = headerCellOf(state, 1).querySelector('.sort-indicator');
        const ind2 = headerCellOf(state, 2).querySelector('.sort-indicator');

        assert.equal(ind1.textContent, '▲');
        assert.equal(ind1.classList.contains('sort-active'), true);
        assert.equal(ind0.textContent, '⇅');
        assert.equal(ind0.classList.contains('sort-active'), false);
        assert.equal(ind2.textContent, '⇅');
    });

    test('sortDirection="desc" - strzałka ▼', () => {
        setupDom();
        const state = buildGrid('sort-ind-3.sql', {
            headers: ['a'],
            currentRows: [[1]],
        });
        state.sortColumn = 0;
        state.sortDirection = 'desc';

        updateSortIndicators();

        assert.equal(headerCellOf(state, 0).querySelector('.sort-indicator').textContent, '▼');
    });
});

describe('sorting.js - klik w strzałkę sortowania', () => {

    test('pierwszy klik na kolumnie bez sortowania wysyła direction: "asc"', () => {
        setupDom();
        const state = buildGrid('sort-click-1.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2]],
        });
        state.sortColumn = null;
        state.sortDirection = null;

        const vscode = fakeVscode();
        initSortListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        clickSortIndicator(state, 1);

        assert.deepEqual(vscode.sent, [{ command: 'sortColumn', columnIndex: 1, direction: 'asc' }]);
    });

    test('cykl na tej samej kolumnie: asc -> desc -> null (brak sortowania)', () => {
        setupDom();
        const state = buildGrid('sort-click-2.sql', {
            headers: ['a'],
            currentRows: [[1]],
        });

        const vscode = fakeVscode();
        initSortListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        // symulujemy to, co backend odesłałby po appendData po każdym kliknięciu (source of truth), bo sorting.js czyta aktualny kierunek z State
        state.sortColumn = null; state.sortDirection = null;
        clickSortIndicator(state, 0);
        assert.equal(vscode.sent[0].direction, 'asc');

        state.sortColumn = 0; state.sortDirection = 'asc';
        clickSortIndicator(state, 0);
        assert.equal(vscode.sent[1].direction, 'desc');

        state.sortColumn = 0; state.sortDirection = 'desc';
        clickSortIndicator(state, 0);
        assert.equal(vscode.sent[2].direction, null);
    });

    test('kliknięcie strzałki innej kolumny niż aktualnie posortowana zaczyna od "asc" (nie kontynuuje cyklu tamtej kolumny)', () => {
        setupDom();
        const state = buildGrid('sort-click-3.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2]],
        });
        state.sortColumn = 0;
        state.sortDirection = 'desc'; // kolumna 0 jest już w stanie "desc"

        const vscode = fakeVscode();
        initSortListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        clickSortIndicator(state, 1); // klikamy zupełnie inną kolumnę

        assert.deepEqual(vscode.sent, [{ command: 'sortColumn', columnIndex: 1, direction: 'asc' }]);
    });

    test('klik w strzałkę NIE zaznacza kolumny (nie koliduje z initColumnSelection na tym samym #gridHeader)', () => {
        setupDom();
        const state = buildGrid('sort-click-4.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2]],
        });

        const vscode = fakeVscode();
        // rejestrujemy oba listenery na #gridHeader - dokładnie tak, jak w prawdziwej appce (app.js: initEditor + initSortListeners)
        initColumnSelection();
        initSortListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        clickSortIndicator(state, 0);

        assert.equal(vscode.sent.length, 1);
        assert.equal(state.selectedColIndexes.size, 0);
        assert.equal(headerCellOf(state, 0).classList.contains('selected-col'), false);
    });

    test('klik gdzie indziej w header-cell (poza strzałką) nadal normalnie zaznacza kolumnę', () => {
        setupDom();
        const state = buildGrid('sort-click-5.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2]],
        });

        const vscode = fakeVscode();
        initColumnSelection();
        initSortListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        click(headerCellOf(state, 0).querySelector('.header-label'));

        assert.equal(vscode.sent.length, 0);
        assert.equal(headerCellOf(state, 0).classList.contains('selected-col'), true);
        assert.deepEqual([...state.selectedColIndexes], [0]);
    });
});
