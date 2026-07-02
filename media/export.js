import { State } from './state.js';

// otwiera ostatnio użyte pliki SQL
function openRecentFiles() {
    window.vscode.postMessage({
        command: 'openRecentFiles'
    });
}

// Export do CSV
function exportToCSV() {
    const rows = State.getInstance().currentRows;
    const headers = State.getInstance().headers;
    
    if (!rows || rows.length === 0) {return;}
    if (!headers || headers.length === 0) {return;}
    if (!window.vscode) {return;}
    
    window.vscode.postMessage({
        command: 'exportCSV',
        rows: rows,
        headers: headers
    });
}

// Export do TXT (format tabelaryczny)
function exportToTXT() {
    const rows = State.getInstance().currentRows;
    const headers = State.getInstance().headers;
    
    if (!rows || rows.length === 0) {return;}
    if (!headers || headers.length === 0) {return;}
    if (!window.vscode) {return;}
    
    window.vscode.postMessage({
        command: 'exportTXT',
        rows: rows,
        headers: headers
    });
}

window.openRecentFiles = openRecentFiles;
window.exportToCSV = exportToCSV;
window.exportToTXT = exportToTXT;