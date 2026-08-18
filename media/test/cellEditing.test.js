import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, dataCellOf } from './domTestUtils.js';
import { initEditor } from '../editor.js';

function fakeVscode() {
    const messages = [];
    return {
        postMessage: (msg) => messages.push(msg),
        messages,
    };
}

/** dblclick na komórce -> wpisanie nowej wartości -> Enter (commit edycji) */
function editCell(cell, newValue) {
    cell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));

    const input = cell.querySelector('input, textarea');
    if (!input) {throw new Error('Editing did not start - no input/textarea found in cell');}

    input.value = newValue;
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

describe('edycja komórki (dblclick + Enter) - komenda updateCell', () => {

    test('wysyła rowKey (stabilny identyfikator z backendu) obok page-relative rowIndex', () => {
        setupDom();
        const state = buildGrid('cell-edit-1.sql', {
            headers: ['name'],
            currentRows: [['foo'], ['bar'], ['baz']],
            // celowo nieciągłe klucze - gdyby kod błędnie wysyłał rowIndex zamiast rowKey, ten test by to wykrył
            rowKeys: [700, 701, 702],
        });

        const vscode = fakeVscode();
        initEditor(vscode);
        // initEditor rejestruje listenery wewnątrz DOMContentLoaded - w jsdom to zdarzenie już minęło zanim doszliśmy tutaj, więc odpalamy je ręcznie
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const cell = dataCellOf(state, 1, 0); // page-relative wiersz 1 -> rowKey 701
        editCell(cell, 'edited-value');

        assert.equal(vscode.messages.length, 1);
        assert.deepEqual(vscode.messages[0], {
            command: 'updateCell',
            rowKey: 701,
            rowIndex: 1,
            columnIndex: 0,
            value: 'edited-value',
        });
    });

    test('nie wysyła nic, gdy nowa wartość jest identyczna ze starą', () => {
        setupDom();
        const state = buildGrid('cell-edit-2.sql', {
            headers: ['name'],
            currentRows: [['foo']],
            rowKeys: [900],
        });

        const vscode = fakeVscode();
        initEditor(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const cell = dataCellOf(state, 0, 0);
        editCell(cell, 'foo'); // ta sama wartość co oryginalna

        assert.equal(vscode.messages.length, 0);
    });

    test('kolumna z wieloma wierszami: każda edycja adresuje właściwy wiersz przez jego rowKey', () => {
        setupDom();
        const state = buildGrid('cell-edit-3.sql', {
            headers: ['a', 'b'],
            currentRows: [['r0c0', 'r0c1'], ['r1c0', 'r1c1']],
            rowKeys: [10, 20],
        });

        const vscode = fakeVscode();
        initEditor(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        editCell(dataCellOf(state, 0, 1), 'new-r0c1'); // wiersz 0, kolumna 1 -> rowKey 10
        editCell(dataCellOf(state, 1, 0), 'new-r1c0'); // wiersz 1, kolumna 0 -> rowKey 20

        assert.deepEqual(vscode.messages, [
            { command: 'updateCell', rowKey: 10, rowIndex: 0, columnIndex: 1, value: 'new-r0c1' },
            { command: 'updateCell', rowKey: 20, rowIndex: 1, columnIndex: 0, value: 'new-r1c0' },
        ]);
    });
});
