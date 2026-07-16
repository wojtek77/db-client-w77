import { initEditor } from './editor.js';
import { initPaginationListeners } from './pagination.js';
import { initExportListeners } from './export.js';
import './messageHandler.js';

window.vscode = acquireVsCodeApi();
initEditor(window.vscode);

// Sygnalizujemy do rozszerzenia, że ten webview faktycznie się załadował i
// jego skrypt jest już w stanie odbierać wiadomości. `window.addEventListener
// ('message', ...)` w messageHandler.js jest już zarejestrowane w tym
// momencie (import tego modułu został w pełni zewaluowany, zanim wykonał się
// ten kod). Bez tego sygnału rozszerzenie mogłoby wysłać np. wyniki
// zapytania, zanim ten webview był w ogóle gotowy je odebrać - a VS Code nie
// gwarantuje dostarczenia takich "przedwczesnych" wiadomości.
window.vscode.postMessage({ command: 'webviewReady' });

document.addEventListener('DOMContentLoaded', () => {
    initPaginationListeners();
    initExportListeners();
});
