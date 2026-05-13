window.addEventListener('message', event => {

    const msg = event.data;
    console.log('Message received in webview:', msg);

    if (msg.command === 'appendData') {
        console.log('Headers in webview:', msg.headers);

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

        console.log(
            'Chunk loaded:',
            msg.rows.length,
            'rows in',
            (end - start).toFixed(2),
            'ms'
        );

        if (msg.isLast) {
            console.log('LAST PAGE:', window.state.currentRows.length);
        }
    }

    if (msg.command === 'updateConfirmed') {
        // Dla nowego formatu (rowIndex, columnIndex)
        if (msg.rowIndex !== undefined && msg.columnIndex !== undefined) {
            const cells = document.querySelectorAll(
                `[data-row="${msg.rowIndex}"][data-col="${msg.columnIndex}"]`
            );
            cells.forEach(cell => {
                cell.classList.add('updated-cell');
                setTimeout(() => cell.classList.remove('updated-cell'), 500);
            });
        } 
        // Dla starego formatu (id, column)
        else if (msg.id !== undefined && msg.column !== undefined) {
            const cells = document.querySelectorAll(
                `[data-id="${msg.id}"][data-column="${msg.column}"]`
            );
            cells.forEach(cell => {
                cell.classList.add('updated-cell');
                setTimeout(() => cell.classList.remove('updated-cell'), 500);
            });
        }
    }
});