import { initEditor } from './editor.js';
import { initPaginationListeners } from './pagination.js';
import { initExportListeners } from './export.js';
import './messageHandler.js';

window.vscode = acquireVsCodeApi();
initEditor(window.vscode);

document.addEventListener('DOMContentLoaded', () => {
    initPaginationListeners();
    initExportListeners();
});
