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

    test('deleteRowsBtn sends the rowKeys (not raw page-relative indexes) sorted by their row position, regardless of click order', () => {
        setupDom();
        // celowo nieciągłe/nietrywialne klucze - gdyby kod błędnie wysyłał page-relative rowIndex zamiast rowKey, ten test by to wykrył
        const state = buildGrid('row-actions-1.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3], [4], [5]],
            rowKeys: [100, 101, 102, 103, 104],
        });
        initRowSelection();
        const vscode = fakeVscode();
        initDeleteRowsButton(vscode);

        // zaznaczamy w kolejności wiersz 3, 0, 4 (celowo nie rosnąco)
        click(lpCellOf(state, 3), { ctrlKey: true });
        click(lpCellOf(state, 0), { ctrlKey: true });
        click(lpCellOf(state, 4), { ctrlKey: true });

        document.getElementById('deleteRowsBtn').click();

        assert.equal(vscode.messages.length, 1);
        // posortowane wg pozycji wiersza (0, 3, 4) -> odpowiadające im klucze (100, 103, 104)
        assert.deepEqual(vscode.messages[0], { command: 'deleteRows', rowKeys: [100, 103, 104] });
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

    test('generateInsertBtn / generateUpdateBtn / generateDeleteBtn send the matching command with the same rowKeys', () => {
        setupDom();
        const state = buildGrid('row-actions-3.sql', {
            headers: ['id'],
            currentRows: [[1], [2], [3]],
            rowKeys: [500, 501, 502],
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
            { command: 'generateInsert', rowKeys: [501, 502] },
            { command: 'generateUpdate', rowKeys: [501, 502] },
            { command: 'generateDelete', rowKeys: [501, 502] },
        ]);
    });

    test('wiersz bez odpowiadającego klucza (np. backend przysłał krótszą listę rowKeys niż wierszy) jest pomijany, nie wysyłany jako undefined', () => {
        setupDom();
        const state = buildGrid('row-actions-4.sql', {
            headers: ['id'],
            currentRows: [[1], [2]],
            rowKeys: [200], // celowo krótsza niż currentRows - drugi wiersz nie ma odpowiadającego klucza
        });
        initRowSelection();
        const vscode = fakeVscode();
        initDeleteRowsButton(vscode);

        click(lpCellOf(state, 0), { ctrlKey: true });
        click(lpCellOf(state, 1), { ctrlKey: true });

        document.getElementById('deleteRowsBtn').click();

        assert.deepEqual(vscode.messages[0], { command: 'deleteRows', rowKeys: [200] });
    });
});

