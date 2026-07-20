import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './domTestUtils.js';
import { State } from '../state.js';

// messageHandler.js czyta DOM już w momencie importu, więc setupDom() musi być przed dynamicznym importem, nie statycznym na górze pliku
// listener 'message' jest podpięty pod to konkretne `dom.window` – testy muszą dispatchować eventy na tym samym obiekcie
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

        // po wyczyszczeniu ponowny init tego samego pliku ma dać świeży, domyślny stan, a nie odzyskać poprzednie 'headers'
        assert.deepEqual(State.init('clear-cmd-a.sql').headers, []);

        // plik, którego nie dotyczyło czyszczenie, zachowuje swój stan
        assert.deepEqual(State.init('clear-cmd-b.sql').headers, ['b']);
    });
});
