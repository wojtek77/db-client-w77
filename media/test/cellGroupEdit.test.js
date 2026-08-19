import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, click, dblclick, dataCellOf } from './domTestUtils.js';
import { initEditor } from '../editor.js';

function fakeVscode() {
    const messages = [];
    return {
        postMessage: (msg) => messages.push(msg),
        messages,
    };
}

// dblclick w przeglądarce to najpierw click(detail=1), potem click(detail=2), dopiero na końcu dblclick - dokładnie tę sekwencję symulujemy tutaj, żeby złapać ewentualny regres poprawki z pendingCellCollapseTimer
function realDoubleClick(cell) {
    click(cell, { detail: 1 });
    click(cell, { detail: 2 });
    dblclick(cell);
}

// wpisuje nową wartość w polu edycji już otwartym przez dblclick i zatwierdza Enterem
function commitEditValue(cell, value) {
    const input = cell.querySelector('input, textarea');
    if (!input) {throw new Error('Editing did not start - no input/textarea found in cell');}

    input.value = value;
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

function initGridEditor(vscode) {
    initEditor(vscode);
    // initEditor rejestruje listenery wewnątrz DOMContentLoaded - w jsdom to zdarzenie już minęło zanim doszliśmy tutaj, więc odpalamy je ręcznie
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
}

describe('zbiorcza edycja niezależnie zaznaczonych komórek', () => {

    test('dblclick na komórce należącej do zaznaczenia >=2 komórek odkłada zapis i podglądowo zmienia całą grupę', () => {
        setupDom();
        const state = buildGrid('cell-group-1.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
            rowKeys: [10, 20],
        });

        const vscode = fakeVscode();
        initGridEditor(vscode);

        // zaznaczamy 4 komórki (1,1) (1,2) (2,1) (2,2) tak jak w realnym teście użytkownika
        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 0, 1), { ctrlKey: true });
        click(dataCellOf(state, 1, 0), { ctrlKey: true });
        click(dataCellOf(state, 1, 1), { ctrlKey: true });
        assert.equal(state.selectedCellPositions.size, 4);

        realDoubleClick(dataCellOf(state, 0, 0));
        commitEditValue(dataCellOf(state, 0, 0), 'X');

        // nic jeszcze nie poszło do backendu - to tylko podgląd, dopóki użytkownik nie kliknie "Save cells"
        assert.equal(vscode.messages.length, 0);

        assert.deepEqual(state.pendingCellEdits.value, 'X');
        assert.deepEqual([...state.pendingCellEdits.positions].sort(), ['0-0', '0-1', '1-0', '1-1']);

        for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
            const cell = dataCellOf(state, r, c);
            assert.equal(cell.textContent, 'X');
            assert.equal(cell.classList.contains('cell-edit-pending'), true);
        }

        assert.notEqual(document.getElementById('saveCellEditsBtn').style.display, 'none');
    });

    test('"Save cells" wysyła jedną komendę saveCellEdits ze wspólną wartością i wszystkimi komórkami grupy', () => {
        setupDom();
        const state = buildGrid('cell-group-2.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
            rowKeys: [10, 20],
        });

        const vscode = fakeVscode();
        initGridEditor(vscode);

        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 1, 1), { ctrlKey: true });

        realDoubleClick(dataCellOf(state, 0, 0));
        commitEditValue(dataCellOf(state, 0, 0), 'Y');

        click(document.getElementById('saveCellEditsBtn'));

        assert.equal(vscode.messages.length, 1);
        const msg = vscode.messages[0];
        assert.equal(msg.command, 'saveCellEdits');
        assert.equal(msg.value, 'Y');

        const cellsByKey = Object.fromEntries(msg.cells.map(c => [`${c.rowIndex}-${c.columnIndex}`, c]));
        assert.deepEqual(Object.keys(cellsByKey).sort(), ['0-0', '1-1']);
        assert.deepEqual(cellsByKey['0-0'], { rowKey: 10, rowIndex: 0, columnIndex: 0, columnName: 'a' });
        assert.deepEqual(cellsByKey['1-1'], { rowKey: 20, rowIndex: 1, columnIndex: 1, columnName: 'b' });
    });

    test('"Cancel cells" przywraca prawdziwe wartości i czyści stan oczekującej grupy', () => {
        setupDom();
        const state = buildGrid('cell-group-3.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
        });

        const vscode = fakeVscode();
        initGridEditor(vscode);

        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 0, 1), { ctrlKey: true });

        realDoubleClick(dataCellOf(state, 0, 0));
        commitEditValue(dataCellOf(state, 0, 0), 'Z');

        click(document.getElementById('cancelCellEditsBtn'));

        assert.equal(state.pendingCellEdits, null);
        assert.equal(dataCellOf(state, 0, 0).textContent, '1');
        assert.equal(dataCellOf(state, 0, 1).textContent, '2');
        assert.equal(dataCellOf(state, 0, 0).classList.contains('cell-edit-pending'), false);
        assert.equal(dataCellOf(state, 0, 1).classList.contains('cell-edit-pending'), false);
        assert.equal(document.getElementById('saveCellEditsBtn').style.display, 'none');
        assert.equal(vscode.messages.length, 0);
    });

    test('edycja jednej, pojedynczo zaznaczonej komórki nadal zapisuje się od razu (nie wchodzi w tryb grupy)', () => {
        setupDom();
        const state = buildGrid('cell-group-4.sql', {
            headers: ['a'],
            currentRows: [['foo']],
            rowKeys: [5],
        });

        const vscode = fakeVscode();
        initGridEditor(vscode);

        click(dataCellOf(state, 0, 0));
        assert.equal(state.selectedCellPositions.size, 1);

        realDoubleClick(dataCellOf(state, 0, 0));
        commitEditValue(dataCellOf(state, 0, 0), 'natychmiast');

        assert.deepEqual(vscode.messages, [
            { command: 'updateCell', rowKey: 5, rowIndex: 0, columnIndex: 0, value: 'natychmiast' },
        ]);
        assert.equal(state.pendingCellEdits, null);
    });
});

describe('rozróżnianie click/dblclick na komórce należącej do wieloelementowego zaznaczenia', () => {

    test('sam zwykły klik na komórce z zaznaczenia >=2 nie zwęża go od razu (zostawia czas na ewentualny dblclick)', () => {
        setupDom();
        const state = buildGrid('cell-collapse-1.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
        });

        const vscode = fakeVscode();
        initGridEditor(vscode);

        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 1, 1), { ctrlKey: true });
        assert.equal(state.selectedCellPositions.size, 2);

        // pojedynczy klik (detail=1) na jednej z już zaznaczonych komórek - synchronicznie zaznaczenie musi pozostać pełne
        click(dataCellOf(state, 0, 0));

        assert.equal(state.selectedCellPositions.size, 2);
        assert.equal(dataCellOf(state, 0, 0).classList.contains('selected-cell'), true);
        assert.equal(dataCellOf(state, 1, 1).classList.contains('selected-cell'), true);
    });

    test('...ale bez następującego dblclicku po chwili faktycznie zwęża zaznaczenie do tej jednej komórki', async () => {
        setupDom();
        const state = buildGrid('cell-collapse-2.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
        });

        const vscode = fakeVscode();
        initGridEditor(vscode);

        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 1, 1), { ctrlKey: true });

        click(dataCellOf(state, 0, 0));

        // czekamy dłużej niż odroczenie z editor.js (300ms), żeby dać mu szansę faktycznie zadziałać
        await new Promise((resolve) => setTimeout(resolve, 350));

        assert.equal(state.selectedCellPositions.size, 1);
        assert.equal(state.selectedCellPositions.has('0-0'), true);
        assert.equal(dataCellOf(state, 1, 1).classList.contains('selected-cell'), false);
    });

    test('prawdziwy dblclick na komórce z zaznaczenia >=2 anuluje odroczone zwężenie - grupa do edycji zostaje pełna', () => {
        setupDom();
        const state = buildGrid('cell-collapse-3.sql', {
            headers: ['a', 'b'],
            currentRows: [[1, 2], [3, 4]],
        });

        const vscode = fakeVscode();
        initGridEditor(vscode);

        click(dataCellOf(state, 0, 0), { ctrlKey: true });
        click(dataCellOf(state, 1, 1), { ctrlKey: true });

        // to dokładnie scenariusz zgłoszony przez użytkownika: dblclick na jednej z dwóch zaznaczonych komórek
        realDoubleClick(dataCellOf(state, 0, 0));
        commitEditValue(dataCellOf(state, 0, 0), 'grupa');

        assert.deepEqual([...state.pendingCellEdits.positions].sort(), ['0-0', '1-1']);
    });
});
