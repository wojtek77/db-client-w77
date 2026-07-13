import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, click, headerCellOf, dataCellOf } from './domTestUtils.js';
import { initColumnSelection } from '../editor.js';

describe('column selection (clicking the header)', () => {

    test('clicking a header selects the whole column (header + all data cells) and the Set in State', () => {
        setupDom();
        const state = buildGrid('col-sel-1.sql', {
            headers: ['id', 'name', 'age'],
            currentRows: [[1, 'a', 10], [2, 'b', 20], [3, 'c', 30]],
        });
        initColumnSelection();

        click(headerCellOf(state, 1)); // kolumna "name"

        assert.equal(headerCellOf(state, 1).classList.contains('selected-col'), true);
        assert.equal(headerCellOf(state, 0).classList.contains('selected-col'), false);
        for (let row = 0; row < 3; row++) {
            assert.equal(dataCellOf(state, row, 1).classList.contains('selected-col'), true);
            assert.equal(dataCellOf(state, row, 0).classList.contains('selected-col'), false);
        }
        assert.deepEqual([...state.selectedColIndexes], [1]);
    });

    test('clicking the only selected column again deselects it', () => {
        setupDom();
        const state = buildGrid('col-sel-2.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a'], [2, 'b']],
        });
        initColumnSelection();

        const header0 = headerCellOf(state, 0);
        click(header0);
        click(header0);

        assert.equal(header0.classList.contains('selected-col'), false);
        assert.equal(state.selectedColIndexes.size, 0);
        assert.equal(dataCellOf(state, 0, 0).classList.contains('selected-col'), false);
    });

    test('Ctrl+click selects multiple columns independently', () => {
        setupDom();
        const state = buildGrid('col-sel-3.sql', {
            headers: ['a', 'b', 'c', 'd'],
            currentRows: [[1, 2, 3, 4]],
        });
        initColumnSelection();

        click(headerCellOf(state, 0), { ctrlKey: true });
        click(headerCellOf(state, 2), { ctrlKey: true });

        assert.deepEqual([...state.selectedColIndexes].sort((a, b) => a - b), [0, 2]);
        assert.equal(headerCellOf(state, 1).classList.contains('selected-col'), false);

        click(headerCellOf(state, 0), { ctrlKey: true }); // odznacz tylko kolumnę 0
        assert.deepEqual([...state.selectedColIndexes], [2]);
    });

    test('Shift+click selects a range of columns from the anchor', () => {
        setupDom();
        const state = buildGrid('col-sel-4.sql', {
            headers: ['a', 'b', 'c', 'd', 'e'],
            currentRows: [[1, 2, 3, 4, 5]],
        });
        initColumnSelection();

        click(headerCellOf(state, 1)); // anchor = kolumna 1
        click(headerCellOf(state, 3), { shiftKey: true }); // zakres 1..3

        assert.deepEqual([...state.selectedColIndexes].sort((a, b) => a - b), [1, 2, 3]);
        [1, 2, 3].forEach(c => assert.equal(headerCellOf(state, c).classList.contains('selected-col'), true));
        [0, 4].forEach(c => assert.equal(headerCellOf(state, c).classList.contains('selected-col'), false));
    });
});
