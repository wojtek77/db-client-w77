window.addEventListener('message', event => {

    const msg = event.data;
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    const errorDisplay = document.getElementById('errorDisplay');
    const dataTable = document.getElementById('dataTable');

    function stopSpinner() {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
    }
    function stopError() {
        if (errorDisplay) errorDisplay.style.display = 'none';
    }
    
    if (msg.command === 'loadingData') {
        // spinner
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
    }

    if (msg.command === 'appendData') {
        stopError();
        stopSpinner();
        dataTable.style.display = 'block';
        
        // ustawienie połączenia z DB i czasów
        document.getElementById('connectionName').textContent = msg.connectionName;
        document.getElementById('connectionTime').textContent = msg.connectionTime;
        document.getElementById('queryTime').textContent = msg.queryTime;

        const start = performance.now();

        // Zapisz dane i nagłówki
        window.state.currentRows = msg.rows;
        
        // Używamy nagłówków z wiadomości
        if (msg.headers) {
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
    
    if (msg.command === 'error') {
        stopSpinner();
        if (dataTable) dataTable.style.display = 'none';
        if (errorDisplay) {
            errorDisplay.style.display = 'block';
            errorDisplay.textContent = `Error: ${msg.message}`;
        }
        return; // Zakończ, bo tylko pokazujemy błąd
    }
});
