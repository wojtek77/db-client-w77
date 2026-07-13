import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, click, dataCellOf } from './domTestUtils.js';
import { initCellSelection } from '../editor.js';

describe('single cell selection', () => {

    test('clicking a cell selects it (class + Set)', () => {
        setupDom();
        const state = buildGrid('cell-sel-1.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
        });
        initCellSelection();

        click(dataCellOf(state, 0, 1));

        assert.equal(dataCellOf(state, 0, 1).classList.contains('selected-cell'), true);
        assert.deepEqual([...state.selectedCellPositions], ['0-1']);
    });

    test('clicking the only selected cell again deselects it', () => {
        setupDom();
        const state = buildGrid('cell-sel-2.sql', {
            headers: ['a'],
            currentRows: [[1], [2]],
        });
        initCellSelection();

        const cell = dataCellOf(state, 1, 0);
        click(cell);
        click(cell);

        assert.equal(cell.classList.contains('selected-cell'), false);
        assert.equal(state.selectedCellPositions.size, 0);
    });

    test('clicking a different cell clears the previous selection', () => {
        setupDom();
        const state = buildGrid('cell-sel-3.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
        });
        initCellSelection();

        click(dataCellOf(state, 0, 0));
        click(dataCellOf(state, 1, 1));

        assert.equal(dataCellOf(state, 0, 0).classList.contains('selected-cell'), false);
        assert.equal(dataCellOf(state, 1, 1).classList.contains('selected-cell'), true);
        assert.deepEqual([...state.selectedCellPositions], ['1-1']);
    });

    test('Ctrl+click selects multiple unrelated cells at once', () => {
        setupDom();
        const state = buildGrid('cell-sel-4.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
        });
        initCellSelection();

        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 1, 1), { ctrlKey: true });

        assert.deepEqual([...state.selectedCellPositions].sort(), ['0-0', '1-1']);
    });

    test('Shift+click selects a rectangular range of cells from the anchor', () => {
        setupDom();
        const state = buildGrid('cell-sel-5.sql', {
            headers: ['a', 'b', 'c'],
            currentRows: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
        });
        initCellSelection();

        click(dataCellOf(state, 0, 0)); // anchor = (0,0)
        click(dataCellOf(state, 1, 1), { shiftKey: true }); // prostokąt (0,0)-(1,1)

        const expected = ['0-0', '0-1', '1-0', '1-1'];
        assert.deepEqual([...state.selectedCellPositions].sort(), expected);
        expected.forEach(key => {
            const [r, c] = key.split('-').map(Number);
            assert.equal(dataCellOf(state, r, c).classList.contains('selected-cell'), true);
        });
        assert.equal(dataCellOf(state, 2, 2).classList.contains('selected-cell'), false);
    });

    test('Ctrl+Shift+click adds a rectangle to the existing selection', () => {
        setupDom();
        const state = buildGrid('cell-sel-6.sql', {
            headers: ['a', 'b', 'c'],
            currentRows: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
        });
        initCellSelection();

        click(dataCellOf(state, 2, 2), { ctrlKey: true }); // zaznacz (2,2), anchor=(2,2)
        click(dataCellOf(state, 0, 0), { ctrlKey: true, shiftKey: true }); // dołóż prostokąt (0,0)-(2,2)... anchor to (2,2)

        // anchor to ostatnia klikana komórka z ctrl (2,2), więc zakres to (0,0)-(2,2) razem z wcześniej zaznaczoną (2,2)
        assert.equal(state.selectedCellPositions.has('2-2'), true);
        assert.equal(state.selectedCellPositions.has('0-0'), true);
        assert.equal(state.selectedCellPositions.size, 9); // cały prostokąt 3x3
    });
});
