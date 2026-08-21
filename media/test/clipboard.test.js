import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, click, keydown, headerCellOf, dataCellOf } from './domTestUtils.js';
import { State } from '../state.js';
import { initRowSelection, initColumnSelection, initCellSelection, initClipboard } from '../editor.js';

/** Podpina mock navigator.clipboard.writeText i zwraca funkcję do odczytu ostatnio skopiowanego tekstu. */
function mockClipboard() {
    let lastCopied = null;
    window.navigator.clipboard = {
        writeText: (text) => {
            lastCopied = text;
            return Promise.resolve();
        },
    };
    return () => lastCopied;
}

function ctrlC(target) {
    keydown(target, { key: 'c', ctrlKey: true });
}

describe('copying the selection to the clipboard (Ctrl+C)', () => {

    test('selecting rows copies all their columns as TSV', () => {
        setupDom();
        const getCopied = mockClipboard();
        const state = buildGrid('clip-1.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'alice'], [2, 'bob'], [3, 'carol']],
        });
        initRowSelection();
        initColumnSelection();
        initCellSelection();
        initClipboard();

        click(state.cachedGridHtml[0].querySelector('.lp-cell'), { ctrlKey: true });
        click(state.cachedGridHtml[2].querySelector('.lp-cell'), { ctrlKey: true });

        ctrlC();

        assert.equal(getCopied(), '1\talice\n3\tcarol');
    });

    test('selecting a column copies all its rows (on the current page) as TSV', () => {
        setupDom();
        const getCopied = mockClipboard();
        const state = buildGrid('clip-2.sql', {
            headers: ['id', 'name', 'age'],
            currentRows: [[1, 'alice', 30], [2, 'bob', 40]],
        });
        initRowSelection();
        initColumnSelection();
        initCellSelection();
        initClipboard();

        click(headerCellOf(state, 1)); // kolumna "name"
        ctrlC();

        assert.equal(getCopied(), 'alice\nbob');
    });

    test('unrelated selected cells form a rectangle with empty fields outside the selection', () => {
        setupDom();
        const getCopied = mockClipboard();
        const state = buildGrid('clip-3.sql', {
            headers: ['a', 'b', 'c'],
            currentRows: [[1, 2, 3], [4, 5, 6]],
        });
        initRowSelection();
        initColumnSelection();
        initCellSelection();
        initClipboard();

        click(dataCellOf(state, 0, 0), { ctrlKey: true }); // (0,0)
        click(dataCellOf(state, 1, 2), { ctrlKey: true }); // (1,2)
        ctrlC();

        // prostokąt obejmujący wiersze 0-1, kolumny 0 i 2 (kolumna 1 pomijana, bo colsSet budowany jest tylko z kolumn obecnych w zaznaczeniu)
        assert.equal(getCopied(), '1\t\n\t6');
    });

    test('no selection -> Ctrl+C does nothing (clipboard untouched)', () => {
        setupDom();
        const getCopied = mockClipboard();
        buildGrid('clip-4.sql', {
            headers: ['a'],
            currentRows: [[1], [2]],
        });
        initRowSelection();
        initColumnSelection();
        initCellSelection();
        initClipboard();

        ctrlC();

        assert.equal(getCopied(), null);
    });

    test('a row selection combined with a later single cell selection copies only the cell (last touched type wins)', () => {
        setupDom();
        const getCopied = mockClipboard();
        const state = buildGrid('clip-5.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4], [5, 6]],
        });
        initRowSelection();
        initColumnSelection();
        initCellSelection();
        initClipboard();

        click(state.cachedGridHtml[0].querySelector('.lp-cell')); // cały wiersz 0 - "row" staje się aktywnym typem
        click(dataCellOf(state, 2, 1), { ctrlKey: true }); // tylko komórka (2,1) - "cell" staje się nowym aktywnym typem

        ctrlC();

        // wiersz 0 pozostaje wizualnie zaznaczony (punkt odniesienia), ale kopiowana jest wyłącznie ostatnio dotknięta komórka
        assert.equal(getCopied(), '6');
    });

    test('after the active cell selection is cleared, copying falls back to the previously active row selection', () => {
        setupDom();
        const getCopied = mockClipboard();
        const state = buildGrid('clip-7.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4], [5, 6]],
        });
        initRowSelection();
        initColumnSelection();
        initCellSelection();
        initClipboard();

        click(state.cachedGridHtml[0].querySelector('.lp-cell')); // cały wiersz 0 - "row" aktywny
        click(dataCellOf(state, 2, 1), { ctrlKey: true }); // komórka (2,1) - "cell" aktywny
        click(dataCellOf(state, 2, 1), { ctrlKey: true }); // odznaczenie tej samej komórki - "cell" znika z kolejności (był pusty)

        ctrlC();

        assert.equal(getCopied(), '1\t2');
    });

    test('Ctrl+C inside an input/textarea field is ignored (we do not intercept text copying)', () => {
        setupDom();
        const getCopied = mockClipboard();
        const state = buildGrid('clip-6.sql', {
            headers: ['a'],
            currentRows: [[1], [2]],
        });
        initRowSelection();
        initColumnSelection();
        initCellSelection();
        initClipboard();

        click(state.cachedGridHtml[0].querySelector('.lp-cell')); // zaznacz wiersz 0

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();

        ctrlC();

        assert.equal(getCopied(), null, 'Ctrl+C in an input field should not trigger our grid-selection copy logic');
    });
});
