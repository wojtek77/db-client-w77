function exportToCSV() {
    console.log('=== EXPORT CSV: funkcja wywołana ===');
    
    const rows = window.state.currentRows;
    const headers = window.state.headers;
    
    console.log('rows:', rows);
    console.log('headers:', headers);
    
    if (!rows || rows.length === 0) {
        console.warn('Brak danych do eksportu');
        return;
    }
    
    if (!headers || headers.length === 0) {
        console.warn('Brak nagłówków do eksportu');
        return;
    }
    
    // ⭐ UŻYJ GLOBALNEJ INSTANCJI (ustawionej w app.js)
    if (typeof window.vscode === 'undefined') {
        console.error('window.vscode is not defined');
        return;
    }
    
    console.log('Używam window.vscode do wysłania wiadomości');
    
    window.vscode.postMessage({
        command: 'exportCSV',
        rows: rows,
        headers: headers
    });
    
    console.log('Wiadomość wysłana');
}

window.exportToCSV = exportToCSV;