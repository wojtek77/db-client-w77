import { initEditor } from './editor.js';
import { initPaginationListeners } from './pagination.js';
import { initExportListeners } from './export.js';
import './messageHandler.js';

window.vscode = acquireVsCodeApi();
initEditor(window.vscode);

// sygnalizujemy rozszerzeniu, że webview się załadował i jest gotowy odbierać wiadomości – bez tego wyniki mogłyby zostać wysłane zanim był gotowy
window.vscode.postMessage({ command: 'webviewReady' });

document.addEventListener('DOMContentLoaded', () => {
    initPaginationListeners();
    initExportListeners();
});
