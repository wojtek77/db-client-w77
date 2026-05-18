window.addEventListener('message', event => {

    const msg = event.data;
    
    if (msg.command === 'loadingData') {
        // spinner
        document.getElementById('loadingOverlay').style.display = 'flex';
    }

    if (msg.command === 'appendData') {
        // spinner
        document.getElementById('loadingOverlay').style.display = 'none';
        
        // ustawienie połączenia z DB i czasów
        document.getElementById('connection-name').textContent = msg.connectionName;
        document.getElementById('connection-time').textContent = msg.connectionTime;
        document.getElementById('query-time').textContent = msg.queryTime;

        const start = performance.now();

        // Zapisz dane i nagłówki
        window.state.currentRows = msg.rows;
        
        // Używamy nagłówków z wiadomości
        if (msg.headers && msg.headers.length > 0) {
            window.state.headers = msg.headers;
            renderHeaders();
        }

        // Oblicz całkowitą liczbę stron
        window.state.totalPages = Math.ceil(
            msg.totalRows / window.state.ROWS_PER_PAGE
        );

        // Ustaw bieżącą stronę jeśli przyszła z wiadomości
        if (msg.currentPage !== undefined) {
            window.state.currentPage = msg.currentPage;
        }

        document.getElementById('totalPages').textContent = window.state.totalPages;
        document.getElementById('currentPage').textContent = window.state.currentPage;

        // ⭐ ZAWSZE RENDERUJ STRONĘ (to było pominięte)
        renderPage();

        // Aktualizuj przyciski paginacji
        document.getElementById('prevBtn').disabled = (window.state.currentPage === 1);
        document.getElementById('firstBtn').disabled = (window.state.currentPage === 1);
        document.getElementById('nextBtn').disabled = (window.state.currentPage === window.state.totalPages);
        document.getElementById('lastBtn').disabled = (window.state.currentPage === window.state.totalPages);

        const end = performance.now();

        if (msg.isLast) {
            
        }
    }

    if (msg.command === 'updateConfirmed') {
        const cells = document.querySelectorAll(
            `[data-row="${msg.rowIndex}"][data-col="${msg.columnIndex}"]`
        );
        cells.forEach(cell => {
            cell.classList.add('updated-cell');
            setTimeout(() => cell.classList.remove('updated-cell'), 500);
        });
    }
});