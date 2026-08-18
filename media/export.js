import { State } from './state.js';

// otwiera ostatnio użyte pliki SQL
export function openRecentFiles() {
    window.vscode.postMessage({
        command: 'openRecentFiles'
    });
}

// export do CSV
export function exportToCSV() {
    // currentRows to teraz {key, data}[] (patrz JSDoc State.currentRows) - backend i tak ignoruje ten payload (czyta własne _allRows), ale wysyłamy poprawny kształt
    const rows = State.getInstance().currentRows?.map((entry) => entry.data);
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

// export do TXT (format tabelaryczny)
export function exportToTXT() {
    // currentRows to teraz {key, data}[] (patrz JSDoc State.currentRows) - backend i tak ignoruje ten payload (czyta własne _allRows), ale wysyłamy poprawny kształt
    const rows = State.getInstance().currentRows?.map((entry) => entry.data);
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

export function initExportListeners() {
    document.getElementById('openRecentFilesBtn')?.addEventListener('click', openRecentFiles);
    document.getElementById('exportCSVBtn')?.addEventListener('click', exportToCSV);
    document.getElementById('exportTXTBtn')?.addEventListener('click', exportToTXT);
}
