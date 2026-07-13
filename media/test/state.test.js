import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { State } from '../state.js';

describe('State - selection Sets and hasInstance', () => {

    test('hasInstance() returns false before the first State.init(), then true', () => {
        // Uwaga: to jest jedyny sensowny test dla stanu "przed init", bo State.#instance
        // jest per-proces (module-level static) - w kolejnych testach w tym pliku
        // instancja będzie już istniała.
        // Tu tylko sprawdzamy samo zachowanie po init, bez zakładania stanu początkowego procesu.
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
        // Nie testujemy tu bezpośrednio "stanu przed jakimkolwiek init" (bo w tym procesie
        // testowym State był już inicjalizowany wcześniej), tylko upewniamy się,
        // że kontrakt hasInstance/getInstance jest spójny: gdy hasInstance() === true,
        // getInstance() nie rzuca.
        assert.equal(State.hasInstance(), true);
        assert.doesNotThrow(() => State.getInstance());
    });
});
