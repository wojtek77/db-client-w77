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

describe('updateSortIndicators - odzwierciedlenie State.sortCriteria w DOM', () => {

    test('brak aktywnego sortowania (sortCriteria = []) - obie kolumny mają neutralny glif ⇅, żadna nie ma klasy sort-active', () => {
        setupDom();
        const state = buildGrid('sort-ind-1.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2]],
        });
        state.sortCriteria = [];

        updateSortIndicators();

        assert.equal(headerCellOf(state, 0).querySelector('.sort-indicator').textContent, '⇅');
        assert.equal(headerCellOf(state, 1).querySelector('.sort-indicator').textContent, '⇅');
        assert.equal(headerCellOf(state, 0).querySelector('.sort-indicator').classList.contains('sort-active'), false);
    });

    test('jedno kryterium asc na kolumnie 1 - sama strzałka ▲ bez numeru priorytetu, reszta ma neutralny glif ⇅', () => {
        setupDom();
        const state = buildGrid('sort-ind-2.sql', {
            headers: ['a', 'b', 'c'],
            currentRows: [[1, 2, 3]],
        });
        state.sortCriteria = [{ columnIndex: 1, direction: 'asc' }];

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

    test('jedno kryterium desc - strzałka ▼ bez numeru priorytetu', () => {
        setupDom();
        const state = buildGrid('sort-ind-3.sql', {
            headers: ['a'],
            currentRows: [[1]],
        });
        state.sortCriteria = [{ columnIndex: 0, direction: 'desc' }];

        updateSortIndicators();

        assert.equal(headerCellOf(state, 0).querySelector('.sort-indicator').textContent, '▼');
    });

    test('dwa aktywne kryteria - każde pokazuje strzałkę Z numerem priorytetu (1 = główne, 2 = rozstrzyga remisy)', () => {
        setupDom();
        const state = buildGrid('sort-ind-4.sql', {
            headers: ['a', 'b', 'c'],
            currentRows: [[1, 2, 3]],
        });
        // kolumna 2 jest głównym kryterium (priorytet 1), kolumna 0 rozstrzyga remisy (priorytet 2)
        state.sortCriteria = [
            { columnIndex: 2, direction: 'desc' },
            { columnIndex: 0, direction: 'asc' },
        ];

        updateSortIndicators();

        assert.equal(headerCellOf(state, 2).querySelector('.sort-indicator').textContent, '▼1');
        assert.equal(headerCellOf(state, 0).querySelector('.sort-indicator').textContent, '▲2');
        assert.equal(headerCellOf(state, 1).querySelector('.sort-indicator').textContent, '⇅');
        assert.equal(headerCellOf(state, 1).querySelector('.sort-indicator').classList.contains('sort-active'), false);
    });
});

describe('sorting.js - klik w strzałkę sortowania wysyła columnIndex + additive (Shift)', () => {

    test('zwykły klik (bez Shift) wysyła additive: false', () => {
        setupDom();
        const state = buildGrid('sort-click-1.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2]],
        });
        state.sortCriteria = [];

        const vscode = fakeVscode();
        initSortListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        clickSortIndicator(state, 1);

        assert.deepEqual(vscode.sent, [{ command: 'sortColumn', columnIndex: 1, additive: false }]);
    });

    test('Shift+klik wysyła additive: true', () => {
        setupDom();
        const state = buildGrid('sort-click-2.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2]],
        });
        state.sortCriteria = [{ columnIndex: 0, direction: 'asc' }];

        const vscode = fakeVscode();
        initSortListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        clickSortIndicator(state, 1, { shiftKey: true });

        assert.deepEqual(vscode.sent, [{ command: 'sortColumn', columnIndex: 1, additive: true }]);
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

    test('Shift+klik w strzałkę też NIE odpala zaznaczania zakresu kolumn z editor.js (mimo że tam Shift+klik na nagłówku zwykle zaznacza zakres)', () => {
        setupDom();
        const state = buildGrid('sort-click-6.sql', {
            headers: ['a', 'b', 'c'],
            currentRows: [[1, 2, 3]],
        });

        const vscode = fakeVscode();
        initColumnSelection();
        initSortListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        clickSortIndicator(state, 1, { shiftKey: true });

        assert.equal(vscode.sent.length, 1);
        assert.equal(vscode.sent[0].additive, true);
        assert.equal(state.selectedColIndexes.size, 0);
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
