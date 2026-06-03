let sqlFile;

window.addEventListener('message', event => {

    // Stworzenie dekodera raz zapobiega ciągłemu tworzeniu nowych obiektów w pamięci
    const decoder = new TextDecoder('utf-8');
    
    const msg = event.data;
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    const errorDisplay = document.getElementById('errorDisplay');
    const gridContainer = document.getElementById('gridContainer');
    const spinner = document.querySelector('.spinner');
    const loadingText = document.querySelector('.loading-text');

    function stopError() {
        if (errorDisplay) errorDisplay.style.display = 'none';
    }
    function startSpinner() {
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
    }
    function stopSpinner() {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
    }
    
    if (msg.command === 'loadingDB') {
        startSpinner();
        spinner.style.borderTopColor = '#ffb937';
    }
    if (msg.command === 'loadingWebview') {
        spinner.style.borderTopColor = '#3794ff';
    }

    if (msg.command === 'appendData') {
        console.log("--- START PRZETWARZANIA WEBVIEW ---");
        
        if (msg.sqlFile) {
            State.init(msg.sqlFile);
        }
        
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
            State.getInstance().headers = msg.headers;
        }

        // 🚀 KROK 2: Prawidłowe parsowanie danych.
        // Jeśli w backendzie wysyłasz surową macierz, użyj: State.getInstance().currentRows = msg.rows;
        // Jeśli w backendzie zostawiłeś rowsBuffer (Uint8Array), użyj poniższej linii z decoderem:
        const currentRows = msg.isEncoded ? JSON.parse(decoder.decode(msg.rows)) : msg.rows;
        
        // Oblicz całkowitą liczbę stron
        State.getInstance().totalPages = Math.ceil(
            msg.totalRows / State.getInstance().ROWS_PER_PAGE
        );

        // Ustaw bieżącą stronę jeśli przyszła z wiadomości
        if (msg.currentPage !== undefined) {
            State.getInstance().currentPage = msg.currentPage;
        }

        document.getElementById('totalPages').textContent = State.getInstance().totalPages;
        document.getElementById('currentPage').textContent = State.getInstance().currentPage;
        
        console.time("⏱️ Czas renderHeaders");
        if (State.getInstance().headers) {
            renderHeaders(currentRows); // Ta funkcja teraz przeskanuje State.getInstance().currentRows
        }
        console.timeEnd("⏱️ Czas renderHeaders");
        
        const shape = `${currentRows.length}x${State.getInstance().headers.length}`;
        if (sqlFile && sqlFile === msg.sqlFile) { // kiedy jest powtórne uruchomienie SQL w tym samym pliku
            if (State.getInstance().gridShape !== shape) {
                console.time("⏱️ Czas initializeGrid");
                initializeGrid(currentRows);
                console.timeEnd("⏱️ Czas initializeGrid");
                State.getInstance().gridShape = shape;
            }
        } else { // kiedy jest nowe uruchomienie pliku lub zmiana pliku
            if (State.getInstance().gridShape === shape) {
                console.time("⏱️ Czas restoreGridFromCache");
                restoreGridFromCache();
                console.timeEnd("⏱️ Czas restoreGridFromCache");
            } else {
                console.time("⏱️ Czas initializeGrid");
                initializeGrid(currentRows);    
                console.timeEnd("⏱️ Czas initializeGrid");
                State.getInstance().gridShape = shape;
            }
            // State.getInstance().currentRows = undefined;
            sqlFile = msg.sqlFile;
        }
        
        // 🚀 KROK 3: Renderowanie (Najpierw wiersze, potem inteligentne nagłówki)
        console.time("⏱️ Czas renderPage");
        renderPage(currentRows);
        console.timeEnd("⏱️ Czas renderPage");
        
        // Aktualizuj przyciski paginacji
        document.getElementById('prevBtn').disabled = (State.getInstance().currentPage === 1);
        document.getElementById('firstBtn').disabled = (State.getInstance().currentPage === 1);
        document.getElementById('nextBtn').disabled = (State.getInstance().currentPage === State.getInstance().totalPages);
        document.getElementById('lastBtn').disabled = (State.getInstance().currentPage === State.getInstance().totalPages);

        if (msg.isLast) {
            // ew. logika na koniec
        }
        
        stopSpinner();
        
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
