import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, click, lpCellOf } from './domTestUtils.js';
import { initRowSelection, initDeleteRowsButton, initGenerateSqlButtons } from '../editor.js';

function fakeVscode() {
    const messages = [];
    return {
        postMessage: (msg) => messages.push(msg),
        messages,
    };
}

describe('delete/generate-SQL toolbar buttons (based on State.selectedRowIndexes)', () => {

    test('deleteRowsBtn sends the selected row indexes sorted ascending, regardless of click order', () => {
        setupDom();
        const state = buildGrid('row-actions-1.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3], [4], [5]],
        });
        initRowSelection();
        const vscode = fakeVscode();
        initDeleteRowsButton(vscode);

        // zaznaczamy w kolejności 3, 0, 4 (celowo nie rosnąco)
        click(lpCellOf(state, 3), { ctrlKey: true });
        click(lpCellOf(state, 0), { ctrlKey: true });
        click(lpCellOf(state, 4), { ctrlKey: true });

        document.getElementById('deleteRowsBtn').click();

        assert.equal(vscode.messages.length, 1);
        assert.deepEqual(vscode.messages[0], { command: 'deleteRows', rowIndexes: [0, 3, 4] });
    });

    test('deleteRowsBtn sends nothing when no rows are selected', () => {
        setupDom();
        buildGrid('row-actions-2.sql', {
            headers: ['id'],
            currentRows: [[1], [2]],
        });
        initRowSelection();
        const vscode = fakeVscode();
        initDeleteRowsButton(vscode);

        document.getElementById('deleteRowsBtn').click();

        assert.equal(vscode.messages.length, 0);
    });

    test('generateInsertBtn / generateUpdateBtn / generateDeleteBtn send the matching command with the same indexes', () => {
        setupDom();
        const state = buildGrid('row-actions-3.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3]],
        });
        initRowSelection();
        const vscode = fakeVscode();
        initGenerateSqlButtons(vscode);

        click(lpCellOf(state, 1), { ctrlKey: true });
        click(lpCellOf(state, 2), { ctrlKey: true });

        document.getElementById('generateInsertBtn').click();
        document.getElementById('generateUpdateBtn').click();
        document.getElementById('generateDeleteBtn').click();

        assert.deepEqual(vscode.messages, [
            { command: 'generateInsert', rowIndexes: [1, 2] },
            { command: 'generateUpdate', rowIndexes: [1, 2] },
            { command: 'generateDelete', rowIndexes: [1, 2] },
        ]);
    });
});
