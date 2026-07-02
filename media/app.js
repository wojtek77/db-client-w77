import { initEditor } from './editor.js';
import './pagination.js';
import './export.js';
import './messageHandler.js';

window.vscode = acquireVsCodeApi();
initEditor(window.vscode);
