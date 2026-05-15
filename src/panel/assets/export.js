// Export do CSV
function exportToCSV() {
    const rows = window.state.currentRows;
    const headers = window.state.headers;
    
    if (!rows || rows.length === 0) return;
    if (!headers || headers.length === 0) return;
    if (!window.vscode) return;
    
    window.vscode.postMessage({
        command: 'exportCSV',
        rows: rows,
        headers: headers
    });
}

// Export do TXT (format tabelaryczny)
function exportToTXT() {
    const rows = window.state.currentRows;
    const headers = window.state.headers;
    
    if (!rows || rows.length === 0) return;
    if (!headers || headers.length === 0) return;
    if (!window.vscode) return;
    
    window.vscode.postMessage({
        command: 'exportTXT',
        rows: rows,
        headers: headers
    });
}

window.exportToCSV = exportToCSV;
window.exportToTXT = exportToTXT;