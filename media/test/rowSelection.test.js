import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, click, lpCellOf } from './domTestUtils.js';
import { State } from '../state.js';
import { initRowSelection, updateDeleteButtonVisibility, hideToolsButtons, clearRowSelection } from '../editor.js';

describe('row selection (clicking the row number / LP column)', () => {

    test('updateDeleteButtonVisibility() does not throw and hides buttons when State has not been initialized yet', () => {
        setupDom();
        assert.equal(State.hasInstance(), false, 'this test must run first in the file, before any State.init() happens');
        assert.doesNotThrow(() => updateDeleteButtonVisibility());
        assert.equal(document.getElementById('deleteRowsBtn').style.display, 'none');
    });

    test('clicking the row number selects it (CSS class + Set in State) and shows the toolbar buttons', () => {
        setupDom();
        const state = buildGrid('row-sel-1.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a'], [2, 'b'], [3, 'c']],
        });
        initRowSelection();

        click(lpCellOf(state, 0));

        assert.equal(state.cachedGridHtml[0].classList.contains('selected-row'), true);
        assert.deepEqual([...state.selectedRowIndexes], [0]);
        assert.equal(document.getElementById('deleteRowsBtn').style.display, 'inline-block');
        assert.equal(document.getElementById('generateInsertBtn').style.display, 'inline-block');
    });

    test('clicking the only selected row again deselects it and hides the buttons', () => {
        setupDom();
        const state = buildGrid('row-sel-2.sql', {
            headers: ['id'],
            currentRows: [[1], [2]],
        });
        initRowSelection();

        const row0Lp = lpCellOf(state, 0);
        click(row0Lp);
        click(row0Lp);

        assert.equal(state.cachedGridHtml[0].classList.contains('selected-row'), false);
        assert.equal(state.selectedRowIndexes.size, 0);
        assert.equal(document.getElementById('deleteRowsBtn').style.display, 'none');
    });

    test('a plain click on a different row clears the previous selection (only one row at a time)', () => {
        setupDom();
        const state = buildGrid('row-sel-3.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3]],
        });
        initRowSelection();

        click(lpCellOf(state, 0));
        click(lpCellOf(state, 2));

        assert.equal(state.cachedGridHtml[0].classList.contains('selected-row'), false);
        assert.equal(state.cachedGridHtml[2].classList.contains('selected-row'), true);
        assert.deepEqual([...state.selectedRowIndexes], [2]);
    });

    test('Ctrl+click selects multiple rows independently of each other', () => {
        setupDom();
        const state = buildGrid('row-sel-4.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3], [4]],
        });
        initRowSelection();

        click(lpCellOf(state, 0), { ctrlKey: true });
        click(lpCellOf(state, 2), { ctrlKey: true });

        assert.deepEqual([...state.selectedRowIndexes].sort((a, b) => a - b), [0, 2]);
        assert.equal(state.cachedGridHtml[0].classList.contains('selected-row'), true);
        assert.equal(state.cachedGridHtml[1].classList.contains('selected-row'), false);
        assert.equal(state.cachedGridHtml[2].classList.contains('selected-row'), true);

        // Ctrl+klik na już zaznaczonym wierszu odznacza tylko jego, reszta zostaje
        click(lpCellOf(state, 0), { ctrlKey: true });
        assert.deepEqual([...state.selectedRowIndexes], [2]);
    });

    test('Shift+click selects a range of rows from the last clicked row (anchor)', () => {
        setupDom();
        const state = buildGrid('row-sel-5.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3], [4], [5]],
        });
        initRowSelection();

        click(lpCellOf(state, 1)); // anchor = wiersz 1
        click(lpCellOf(state, 3), { shiftKey: true }); // zakres 1..3

        assert.deepEqual([...state.selectedRowIndexes].sort((a, b) => a - b), [1, 2, 3]);
        [1, 2, 3].forEach(i => assert.equal(state.cachedGridHtml[i].classList.contains('selected-row'), true));
        [0, 4].forEach(i => assert.equal(state.cachedGridHtml[i].classList.contains('selected-row'), false));
    });

    test('Ctrl+Shift+click adds a range to the existing selection instead of clearing it', () => {
        setupDom();
        const state = buildGrid('row-sel-6.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3], [4], [5], [6]],
        });
        initRowSelection();

        click(lpCellOf(state, 2), { ctrlKey: true }); // zaznacz wiersz 2, anchor = 2
        click(lpCellOf(state, 5), { ctrlKey: true, shiftKey: true }); // dołóż zakres 2..5

        assert.deepEqual([...state.selectedRowIndexes].sort((a, b) => a - b), [2, 3, 4, 5]);
    });

    test('clearRowSelection() deselects everything - clears both the CSS classes and the Set', () => {
        setupDom();
        const state = buildGrid('row-sel-7.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3]],
        });
        initRowSelection();

        click(lpCellOf(state, 0), { ctrlKey: true });
        click(lpCellOf(state, 1), { ctrlKey: true });
        assert.equal(state.selectedRowIndexes.size, 2);

        clearRowSelection();

        assert.equal(state.selectedRowIndexes.size, 0);
        assert.equal(state.cachedGridHtml[0].classList.contains('selected-row'), false);
        assert.equal(state.cachedGridHtml[1].classList.contains('selected-row'), false);
    });

    test('hideToolsButtons() forces the buttons to hide regardless of the current selection', () => {
        setupDom();
        const state = buildGrid('row-sel-8.sql', {
            headers: ['id'],
            currentRows: [[1], [2]],
        });
        initRowSelection();

        click(lpCellOf(state, 0));
        assert.equal(document.getElementById('deleteRowsBtn').style.display, 'inline-block');

        hideToolsButtons();

        assert.equal(document.getElementById('deleteRowsBtn').style.display, 'none');
        // zaznaczenie logiczne w State nie zostało ruszone przez hideToolsButtons()
        assert.equal(state.selectedRowIndexes.size, 1);
    });
});
