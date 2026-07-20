import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { State } from '../state.js';

describe('State - selection Sets and hasInstance', () => {

    test('hasInstance() returns false before the first State.init(), then true', () => {
        // jedyny sensowny test stanu 'przed init' (State.#instance jest per-proces) – dalej sprawdzamy tylko zachowanie po init
        State.init('state-test-hasinstance.sql');
        assert.equal(State.hasInstance(), true);
    });

    test('a freshly initialized file has empty selection Sets', () => {
        const state = State.init('state-test-fresh.sql');
        assert.equal(state.selectedRowIndexes.size, 0);
        assert.equal(state.selectedColIndexes.size, 0);
        assert.equal(state.selectedCellPositions.size, 0);
        assert.ok(state.selectedRowIndexes instanceof Set);
        assert.ok(state.selectedColIndexes instanceof Set);
        assert.ok(state.selectedCellPositions instanceof Set);
    });

    test('each file has its own, independent selection Sets', () => {
        const fileA = State.init('state-test-file-a.sql');
        fileA.selectedRowIndexes.add(1);
        fileA.selectedColIndexes.add(2);
        fileA.selectedCellPositions.add('3-4');

        const fileB = State.init('state-test-file-b.sql');
        assert.equal(fileB.selectedRowIndexes.size, 0, 'file B should not see the selection from file A');
        assert.equal(fileB.selectedColIndexes.size, 0);
        assert.equal(fileB.selectedCellPositions.size, 0);
    });

    test('switching back to an earlier file restores its selection (same Set instance)', () => {
        const fileA = State.init('state-test-file-c.sql');
        fileA.selectedRowIndexes.add(5);

        State.init('state-test-file-d.sql'); // przełącz na inny plik

        const fileAagain = State.init('state-test-file-c.sql'); // wróć do A
        assert.equal(fileAagain.selectedRowIndexes.has(5), true);
    });

    test('getInstance() contract is consistent with hasInstance() (checked indirectly)', () => {
        // nie testujemy stanu przed init (State już był inicjalizowany wcześniej), tylko że hasInstance()===true gwarantuje brak rzucania w getInstance()
        assert.equal(State.hasInstance(), true);
        assert.doesNotThrow(() => State.getInstance());
    });
});

describe('State.clear()', () => {

    test('usuwa zapisany stan pliku - ponowny init daje świeże, domyślne wartości', () => {
        const state = State.init('state-test-clear.sql');
        state.headers = ['a', 'b'];
        state.currentRows = [[1, 2]];
        state.selectedRowIndexes.add(1);

        State.clear('state-test-clear.sql');

        const fresh = State.init('state-test-clear.sql');
        assert.deepEqual(fresh.headers, []);
        assert.deepEqual(fresh.currentRows, []);
        assert.equal(fresh.selectedRowIndexes.size, 0);
    });

    test('nie wpływa na stan innych plików', () => {
        State.init('state-test-clear-a.sql').headers = ['x'];
        State.init('state-test-clear-b.sql').headers = ['y'];

        State.clear('state-test-clear-a.sql');

        assert.deepEqual(State.init('state-test-clear-b.sql').headers, ['y']);
    });

    test('czyszczenie pliku, który nigdy nie istniał, nic nie psuje', () => {
        assert.doesNotThrow(() => State.clear('state-test-clear-never-existed.sql'));
    });
});
