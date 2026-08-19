import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, click, headerCellOf, dataCellOf } from './domTestUtils.js';
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

/** buduje siatkę i odpala initEditor tak samo jak cellEditing.test.js */
function setup(filename, gridOptions) {
    setupDom();
    const state = buildGrid(filename, gridOptions);
    const vscode = fakeVscode();
    initEditor(vscode);
    // initEditor rejestruje listenery wewnątrz DOMContentLoaded - w jsdom to zdarzenie już minęło zanim doszliśmy tutaj, więc odpalamy je ręcznie
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    return { state, vscode };
}

describe('zbiorcza edycja kolumny - przyciski Save/Cancel', () => {

    test('edycja komórki w zaznaczonej kolumnie tylko podgląda zmianę i pokazuje Save + Cancel', () => {
        const { state } = setup('col-edit-1.sql', {
            headers: ['name'],
            currentRows: [['foo'], ['bar']],
        });

        click(headerCellOf(state, 0)); // zaznacz całą kolumnę "name"
        editCell(dataCellOf(state, 0, 0), 'new-value');

        // podgląd nałożony na wszystkie komórki tej kolumny, nie tylko na edytowaną
        assert.equal(dataCellOf(state, 0, 0).textContent, 'new-value');
        assert.equal(dataCellOf(state, 1, 0).textContent, 'new-value');
        assert.equal(dataCellOf(state, 0, 0).classList.contains('column-edit-pending'), true);
        assert.equal(dataCellOf(state, 1, 0).classList.contains('column-edit-pending'), true);

        assert.equal(document.getElementById('saveColumnEditsBtn').style.display, 'inline-block');
        assert.equal(document.getElementById('cancelColumnEditsBtn').style.display, 'inline-block');
    });

    test('odznaczenie kolumny NIE anuluje jej oczekującej edycji (podgląd i przyciski zostają)', () => {
        const { state } = setup('col-edit-2.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });

        const header = headerCellOf(state, 0);
        click(header); // zaznacz
        editCell(dataCellOf(state, 0, 0), 'pending-value');
        click(header); // odznacz tę samą (jedyną zaznaczoną) kolumnę

        assert.equal(header.classList.contains('selected-col'), false);
        assert.equal(state.selectedColIndexes.size, 0);

        // podgląd oczekującej edycji nadal na miejscu
        assert.equal(dataCellOf(state, 0, 0).textContent, 'pending-value');
        assert.equal(dataCellOf(state, 0, 0).classList.contains('column-edit-pending'), true);
        assert.equal(document.getElementById('saveColumnEditsBtn').style.display, 'inline-block');
        assert.equal(document.getElementById('cancelColumnEditsBtn').style.display, 'inline-block');
    });

    test('przycisk Cancel odrzuca wszystkie oczekujące edycje, przywraca wartości i chowa oba przyciski', () => {
        const { state, vscode } = setup('col-edit-3.sql', {
            headers: ['a', 'b'],
            currentRows: [['a1', 'b1'], ['a2', 'b2']],
        });

        click(headerCellOf(state, 0));
        editCell(dataCellOf(state, 0, 0), 'edited-a');
        click(headerCellOf(state, 1));
        editCell(dataCellOf(state, 0, 1), 'edited-b');

        click(document.getElementById('cancelColumnEditsBtn'));

        // wracają oryginalne wartości ze State.currentRows, znika podświetlenie
        assert.equal(dataCellOf(state, 0, 0).textContent, 'a1');
        assert.equal(dataCellOf(state, 1, 0).textContent, 'a2');
        assert.equal(dataCellOf(state, 0, 1).textContent, 'b1');
        assert.equal(dataCellOf(state, 1, 1).textContent, 'b2');
        assert.equal(dataCellOf(state, 0, 0).classList.contains('column-edit-pending'), false);
        assert.equal(dataCellOf(state, 0, 1).classList.contains('column-edit-pending'), false);

        assert.deepEqual(state.pendingColumnEdits, {});
        assert.equal(document.getElementById('saveColumnEditsBtn').style.display, 'none');
        assert.equal(document.getElementById('cancelColumnEditsBtn').style.display, 'none');

        // Cancel jest wyłącznie lokalny (wizualny) - nic nie idzie do rozszerzenia
        assert.equal(vscode.messages.length, 0);
    });

    test('przycisk Save wysyła wszystkie oczekujące edycje kolumn do rozszerzenia (Cancel na to nie wpływa)', () => {
        const { state, vscode } = setup('col-edit-4.sql', {
            headers: ['a', 'b'],
            currentRows: [['a1', 'b1']],
        });

        click(headerCellOf(state, 0));
        editCell(dataCellOf(state, 0, 0), 'edited-a');

        click(document.getElementById('saveColumnEditsBtn'));

        assert.equal(vscode.messages.length, 1);
        assert.deepEqual(vscode.messages[0], {
            command: 'saveColumnEdits',
            edits: [
                { columnIndex: 0, columnName: 'a', value: 'edited-a' },
            ],
        });
    });
});
