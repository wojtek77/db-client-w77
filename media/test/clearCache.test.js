import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './domTestUtils.js';
import { State } from '../state.js';

// messageHandler.js czyta elementy DOM (document.getElementById) już w momencie
// importu, więc document/window muszą istnieć ZANIM ten moduł zostanie
// załadowany - stąd setupDom() przed dynamicznym importem, zamiast statycznego
// importu na górze pliku (który wykonałby się przed setupDom()).
//
// Listener 'message' zostaje podpięty pod TO konkretne `dom.window` - więc w
// testach poniżej trzeba dispatchować eventy na tym samym obiekcie, a nie na
// nowym `window` z kolejnego setupDom().
const dom = setupDom();
await import('../messageHandler.js');

/** Symuluje wiadomość z backendu (postMessage z SqlResultsProvider) do webview. */
function postMessageToWebview(data) {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

describe('messageHandler - obsługa komendy clearCache', () => {

    test('czyści stan tylko dla wskazanego pliku, inne pliki zostają nietknięte', () => {
        State.init('clear-cmd-a.sql').headers = ['a'];
        State.init('clear-cmd-b.sql').headers = ['b'];

        postMessageToWebview({ command: 'clearCache', sqlFile: 'clear-cmd-a.sql' });

        // po wyczyszczeniu ponowny init tego samego pliku ma dać ŚWIEŻY,
        // domyślny stan - a nie odzyskać poprzednie 'headers'
        assert.deepEqual(State.init('clear-cmd-a.sql').headers, []);

        // plik, którego nie dotyczyło czyszczenie, zachowuje swój stan
        assert.deepEqual(State.init('clear-cmd-b.sql').headers, ['b']);
    });
});
