window.addEventListener('message', event => {

    // Stworzenie dekodera raz zapobiega ciągłemu tworzeniu nowych obiektów w pamięci
    const decoder = new TextDecoder('utf-8');
    
    const msg = event.data;
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    const errorDisplay = document.getElementById('errorDisplay');
    const gridContainer = document.getElementById('gridContainer');

    function stopError() {
        if (errorDisplay) errorDisplay.style.display = 'none';
    }
    function startBlur() {
        if (gridContainer) gridContainer.classList.add('loading-blur');
    }
    function stopBlur() {
        if (gridContainer) gridContainer.classList.remove('loading-blur');
    }
    function startSpinner() {
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
    }
    function stopSpinner() {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
    }
    
    if (msg.command === 'loadingDB') {
        startBlur();
    }
    if (msg.command === 'loadingWebview') {
        startSpinner();
    }

    if (msg.command === 'appendData') {
        console.log("--- START PRZETWARZANIA WEBVIEW ---");
        
        console.log(msg.sentAt);
        const duration = Date.now() - msg.sentAt;
        console.log(`🚀 Czas podróży przez postMessage: ${duration} ms`);
        
        stopError();
        if (gridContainer) gridContainer.style.display = 'flex';
        
        // ustawienie połączenia z DB i czasów
        document.getElementById('connectionName').textContent = msg.connectionName;
        document.getElementById('connectionTime').textContent = msg.connectionTime;
        document.getElementById('queryTime').textContent = msg.queryTime;

        // 🚀 KROK 1: Zapisujemy nagłówki na samym początku (potrzebne do obliczeń w renderHeaders)
        if (msg.headers) {
            window.state.headers = msg.headers;
        }

        // 🚀 KROK 2: Prawidłowe parsowanie danych.
        // Jeśli w backendzie wysyłasz surową macierz, użyj: window.state.currentRows = msg.rows;
        // Jeśli w backendzie zostawiłeś rowsBuffer (Uint8Array), użyj poniższej linii z decoderem:
        window.state.currentRows = msg.isEncoded ? JSON.parse(decoder.decode(msg.rows)) : msg.rows;
        
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
        
        console.time("⏱️ Czas renderHeaders");
        if (window.state.headers) {
            renderHeaders(); // Ta funkcja teraz przeskanuje window.state.currentRows
        }
        console.timeEnd("⏱️ Czas renderHeaders");
        
        const shape = `${window.state.currentRows.length}x${window.state.headers.length}`;
        
        if (window.gridShape !== shape) {
            console.time("⏱️ Czas initializeGrid");
            initializeGrid();
            console.timeEnd("⏱️ Czas initializeGrid");
            
            window.gridShape = shape;
        }
        
        // 🚀 KROK 3: Renderowanie (Najpierw wiersze, potem inteligentne nagłówki)
        console.time("⏱️ Czas renderPage");
        renderPage(window.state.currentRows);
        console.timeEnd("⏱️ Czas renderPage");
        
        // Aktualizuj przyciski paginacji
        document.getElementById('prevBtn').disabled = (window.state.currentPage === 1);
        document.getElementById('firstBtn').disabled = (window.state.currentPage === 1);
        document.getElementById('nextBtn').disabled = (window.state.currentPage === window.state.totalPages);
        document.getElementById('lastBtn').disabled = (window.state.currentPage === window.state.totalPages);

        if (msg.isLast) {
            // ew. logika na koniec
        }
        
        stopSpinner();
        stopBlur();
        
        console.log("--- KONIEC PRZETWARZANIA WEBVIEW ---");
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
        if (gridContainer) gridContainer.style.display = 'none';
        if (errorDisplay) {
            errorDisplay.style.display = 'block';
            errorDisplay.textContent = `Error: ${msg.message}`;
        }
        return; // Zakończ, bo tylko pokazujemy błąd
    }
});
