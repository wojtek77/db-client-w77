import * as assert from 'assert';
import { isValidWebviewMessage } from '../panel/webviewMessages.js';

suite('isValidWebviewMessage - podstawowy kształt komunikatu', () => {
    test('odrzuca wartości niebędące obiektem albo bez pola command', () => {
        assert.strictEqual(isValidWebviewMessage(null), false);
        assert.strictEqual(isValidWebviewMessage(undefined), false);
        assert.strictEqual(isValidWebviewMessage('loadPage'), false);
        assert.strictEqual(isValidWebviewMessage(42), false);
        assert.strictEqual(isValidWebviewMessage({}), false);
        assert.strictEqual(isValidWebviewMessage({ command: 123 }), false);
    });

    test('odrzuca nieznaną komendę', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'doSomethingEvil' }), false);
    });
});

suite('isValidWebviewMessage - loadPage', () => {
    test('poprawne page>0 -> valid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'loadPage', page: 1 }), true);
        assert.strictEqual(isValidWebviewMessage({ command: 'loadPage', page: 42 }), true);
    });

    test('page=0, ujemne, brak page albo page jako string -> invalid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'loadPage', page: 0 }), false);
        assert.strictEqual(isValidWebviewMessage({ command: 'loadPage', page: -1 }), false);
        assert.strictEqual(isValidWebviewMessage({ command: 'loadPage' }), false);
        assert.strictEqual(isValidWebviewMessage({ command: 'loadPage', page: '1' }), false);
    });
});

suite('isValidWebviewMessage - search', () => {
    test('query jako string (także pusty) -> valid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'search', query: 'abc' }), true);
        assert.strictEqual(isValidWebviewMessage({ command: 'search', query: '' }), true);
    });

    test('query jako liczba albo brak query -> invalid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'search', query: 123 }), false);
        assert.strictEqual(isValidWebviewMessage({ command: 'search' }), false);
    });
});

suite('isValidWebviewMessage - sortColumn', () => {
    test('columnIndex jako liczba + additive jako boolean -> valid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'sortColumn', columnIndex: 0, additive: false }), true);
        assert.strictEqual(isValidWebviewMessage({ command: 'sortColumn', columnIndex: 3, additive: true }), true);
    });

    test('brak additive albo zły typ pól -> invalid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'sortColumn', columnIndex: 0 }), false);
        assert.strictEqual(isValidWebviewMessage({ command: 'sortColumn', columnIndex: '0', additive: false }), false);
        assert.strictEqual(isValidWebviewMessage({ command: 'sortColumn', columnIndex: 0, additive: 'false' }), false);
    });
});

suite('isValidWebviewMessage - updateCell', () => {
    test('rowKey/rowIndex/columnIndex jako liczby -> valid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'updateCell', rowKey: 5, rowIndex: 0, columnIndex: 2, value: 'x' }), true);
    });

    test('brak jednego z wymaganych pól liczbowych -> invalid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'updateCell', rowIndex: 0, columnIndex: 2 }), false);
        assert.strictEqual(isValidWebviewMessage({ command: 'updateCell', rowKey: '5', rowIndex: 0, columnIndex: 2 }), false);
    });
});

suite('isValidWebviewMessage - deleteRows / generateInsert / generateUpdate / generateDelete (tablica liczb)', () => {
    for (const command of ['deleteRows', 'generateInsert', 'generateUpdate', 'generateDelete']) {
        test(`${command}: rowKeys jako number[] (w tym pusta tablica) -> valid`, () => {
            assert.strictEqual(isValidWebviewMessage({ command, rowKeys: [1, 2, 3] }), true);
            assert.strictEqual(isValidWebviewMessage({ command, rowKeys: [] }), true);
        });

        test(`${command}: rowKeys jako string[], obiekt albo brak -> invalid`, () => {
            assert.strictEqual(isValidWebviewMessage({ command, rowKeys: ['1', '2'] }), false);
            assert.strictEqual(isValidWebviewMessage({ command, rowKeys: 'nope' }), false);
            assert.strictEqual(isValidWebviewMessage({ command }), false);
        });
    }
});

suite('isValidWebviewMessage - saveColumnEdits', () => {
    test('tablica edits z poprawnym kształtem (columnIndex:number, columnName:string) -> valid', () => {
        assert.strictEqual(isValidWebviewMessage({
            command: 'saveColumnEdits',
            edits: [{ columnIndex: 0, columnName: 'price', value: 10 }],
        }), true);
    });

    test('pusta tablica edits -> valid (every() na pustej tablicy jest true)', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'saveColumnEdits', edits: [] }), true);
    });

    test('edit bez columnName albo z columnIndex jako string -> invalid', () => {
        assert.strictEqual(isValidWebviewMessage({
            command: 'saveColumnEdits',
            edits: [{ columnIndex: 0, value: 10 }],
        }), false);
        assert.strictEqual(isValidWebviewMessage({
            command: 'saveColumnEdits',
            edits: [{ columnIndex: '0', columnName: 'price', value: 10 }],
        }), false);
    });

    test('edits nie jest tablicą -> invalid', () => {
        assert.strictEqual(isValidWebviewMessage({ command: 'saveColumnEdits', edits: {} }), false);
    });
});

suite('isValidWebviewMessage - saveCellEdits', () => {
    test('niepusta tablica cells z poprawnym kształtem + jawnie ustawione value -> valid', () => {
        assert.strictEqual(isValidWebviewMessage({
            command: 'saveCellEdits',
            value: 'x',
            cells: [{ rowKey: 1, rowIndex: 0, columnIndex: 2, columnName: 'name' }],
        }), true);
    });

    test('value === null jest dozwolone (typeof msg.value !== "undefined")', () => {
        assert.strictEqual(isValidWebviewMessage({
            command: 'saveCellEdits',
            value: null,
            cells: [{ rowKey: 1, rowIndex: 0, columnIndex: 2, columnName: 'name' }],
        }), true);
    });

    test('brak value, pusta tablica cells albo brak columnName w komórce -> invalid', () => {
        assert.strictEqual(isValidWebviewMessage({
            command: 'saveCellEdits',
            cells: [{ rowKey: 1, rowIndex: 0, columnIndex: 2, columnName: 'name' }],
        }), false);
        assert.strictEqual(isValidWebviewMessage({ command: 'saveCellEdits', value: 'x', cells: [] }), false);
        assert.strictEqual(isValidWebviewMessage({
            command: 'saveCellEdits',
            value: 'x',
            cells: [{ rowKey: 1, rowIndex: 0, columnIndex: 2 }],
        }), false);
    });
});

suite('isValidWebviewMessage - komendy bez dodatkowych pól', () => {
    for (const command of ['webviewReady', 'changeConnection', 'openRecentFiles', 'exportCSV', 'exportTXT', 'cancelQuery', 'pickConnectionColor']) {
        test(`${command} -> zawsze valid, niezależnie od dodatkowych pól`, () => {
            assert.strictEqual(isValidWebviewMessage({ command }), true);
            assert.strictEqual(isValidWebviewMessage({ command, cokolwiek: 'ignorowane' }), true);
        });
    }
});
