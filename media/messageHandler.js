import { State } from './state.js';
import { renderHeaders, initializeGrid, restoreGridFromCache, renderPage } from './tableRenderer.js';
import { cancelAllColumnEdits, reapplyAllColumnEdits } from './editor.js';

let sqlFile;
let queryTimer = null;
let queryStartTime = null;

// Stworzenie dekodera raz zapobiega ciągłemu tworzeniu nowych obiektów w pamięci
const decoder = new TextDecoder('utf-8');

const loadingOverlay = document.getElementById('loadingOverlay');
const errorDisplay = document.getElementById('errorDisplay');
const gridContainer = document.getElementById('gridContainer');
const spinner = document.querySelector('.spinner');
const loadingText = document.querySelector('.loading-text');
const cancelBtn = document.getElementById('cancelQuery');
const infoMessage = document.getElementById('infoMessage');

function stopQueryTimer() {
    if (queryTimer) {
        clearInterval(queryTimer);
        queryTimer = null;
    }
}
function showFlashMessage(text, seconds = 3) {
    const flash = document.getElementById('flashMessage');
    if (!flash) {return;}
    flash.innerText = text;
    flash.style.opacity = '1';
    flashTimeout = setTimeout(() => {
        flash.style.opacity = '0';
    }, seconds * 1000);
}
function updatePagination(currentPage = 0, totalPages = 0) {
    document.getElementById('totalPages').textContent = totalPages;
    document.getElementById('currentPage').textContent = currentPage;
    
    // Aktualizuj przyciski paginacji
    document.getElementById('prevBtn').disabled = (currentPage === 1);
    document.getElementById('firstBtn').disabled = (currentPage === 1);
    document.getElementById('nextBtn').disabled = (currentPage === totalPages);
    document.getElementById('lastBtn').disabled = (currentPage === totalPages);
}
function updateDbAndTimes(connectionName = '-------', connectionTime = null, queryTime = null, connectionColor = null) {
    // ustawienie połączenia z DB i czasów
    const connNameEl = document.getElementById('connectionName');
    connNameEl.textContent = connectionName;
    document.getElementById('connectionColor').style.color = connectionColor ?? '';
    // ustawienie czasu połączenia
    document.getElementById('connectionTime').textContent = (connectionTime === null) ? '---' : connectionTime.toFixed(2);
    // ustawienie czasu query
    let qt, qtu;
    if (queryTime === null) {
        qt = '---';
        qtu = 'ms';
    } else {
        if (queryTime < 1000) {
            qt = queryTime.toFixed(2);
        } else {
            qt = (queryTime / 1000).toFixed(3);
        }
        qtu = queryTime < 1000 ? 'ms' : 's';
    }
    document.getElementById('queryTime').textContent = qt;
    document.getElementById('queryTimeUnit').textContent = qtu;
}
function updateInfoMessage(msg = '') {
    if (infoMessage) {
        if (msg) {
            infoMessage.style.display = 'inline';
            infoMessage.textContent = msg;
        } else {
            infoMessage.style.display = 'none';
        }
    }
}
function updateErrorMessage(err = '') {
    if (errorDisplay) {
        if (err) {
            errorDisplay.style.display = 'block';
            errorDisplay.textContent = `Error: ${err}`;
        } else {
            errorDisplay.style.display = 'none';
        }
    }
}
function startSpinner() {
    if (loadingOverlay) {loadingOverlay.style.display = 'flex';}
}
function stopSpinner() {
    if (loadingOverlay) {loadingOverlay.style.display = 'none';}
}
function startGridContainer() {
    if (gridContainer) {gridContainer.style.display = 'flex';}
}
function stopGridContainer() {
    if (gridContainer) {gridContainer.style.display = 'none';}
}

window.addEventListener('message', event => {
    const msg = event.data;
    
    if (msg.command === 'queryStarted') {
        cancelBtn.style.display = 'inline-block';
        
        // postęp czasu w czasie wykonywania SQL-a
        stopQueryTimer();
        queryStartTime = msg.startedAt;
        queryTimer = setInterval(() => {
            const elapsed = (Date.now() - queryStartTime) / 1000;
            document.getElementById('queryTime').textContent = elapsed.toFixed(1);
            document.getElementById('queryTimeUnit').textContent = 's';
        }, 100);
        
        startGridContainer();
        
        startSpinner();
        spinner.style.borderTopColor = '#ffb937';

        // nowe zapytanie -> poprzednie zaznaczenie wierszy przestaje mieć sens
        document.querySelectorAll('.tools-btn').forEach(btn => {btn.style.display = 'none';});

        // nowe zapytanie (ctrl+enter) -> anuluj ewentualną niezapisaną edycję kolumny(kolumn)
        try {
            cancelAllColumnEdits();
        } catch (e) {
            // State nie był jeszcze zainicjalizowany (pierwsze uruchomienie) - nic do anulowania
        }
    }

    if (msg.command === 'queryFinished') {
        cancelBtn.style.display = 'none';
        stopQueryTimer();
    }
    
    if (msg.command === 'loadingWebview') {
        spinner.style.borderTopColor = '#3794ff';
    }

    if (msg.command === 'appendData') {
        console.log("--- START WEBVIEW PROCESSING ---");
        
        console.log(msg.sentAt);
        const duration = Date.now() - msg.sentAt;
        console.log(`🚀 Travel time via postMessage: ${duration} ms`);
        
        if (!msg.sqlFile) {
            throw new Error("Missing: msg.sqlFile");
        }
        State.init(msg.sqlFile);
        // Oblicz całkowitą liczbę stron
        State.getInstance().totalPages = Math.ceil(
            msg.totalRows / State.getInstance().ROWS_PER_PAGE
        );
        if (msg.headers) {
            State.getInstance().headers = msg.headers;
        }
        State.getInstance().columnTypes = msg.columnTypes ?? [];
        State.getInstance().connectionName = msg.connectionName;
        State.getInstance().connectionTime = msg.connectionTime;
        State.getInstance().queryTime = msg.queryTime;
        State.getInstance().connectionColor = msg.connectionColor ?? null;
        State.getInstance().infoMessage = msg.infoMessage;
        State.getInstance().errorMessage = msg.errorMessage;
        updateDbAndTimes(State.getInstance().connectionName, State.getInstance().connectionTime, State.getInstance().queryTime, State.getInstance().connectionColor);
        updateInfoMessage(State.getInstance().infoMessage);
        updateErrorMessage(State.getInstance().errorMessage);
        updatePagination(State.getInstance().currentPage, State.getInstance().totalPages);
        
        if (msg.flashMessage) {showFlashMessage(msg.flashMessage, 4);}
        
        const currentRows = msg.isEncoded ? JSON.parse(decoder.decode(msg.rows)) : msg.rows;
        
        console.time("⏱️ renderHeaders time");
        if (State.getInstance().headers) {
            renderHeaders(currentRows); // Ta funkcja teraz przeskanuje State.getInstance().currentRows
        }
        console.timeEnd("⏱️ renderHeaders time");
        
        const shape = `${currentRows.length}x${State.getInstance().headers.length}`;
        if (sqlFile && sqlFile === msg.sqlFile) { // kiedy jest powtórne uruchomienie SQL w tym samym pliku
            if (State.getInstance().gridShape !== shape) {
                console.time("⏱️ initializeGrid time");
                initializeGrid(currentRows);
                console.timeEnd("⏱️ initializeGrid time");
                State.getInstance().currentRows = undefined;
                State.getInstance().gridShape = shape;
            }
        } else { // kiedy jest nowe uruchomienie pliku lub zmiana pliku
            if (State.getInstance().gridShape === shape) {
                console.time("⏱️ restoreGridFromCache time");
                restoreGridFromCache();
                console.timeEnd("⏱️ restoreGridFromCache time");
            } else {
                console.time("⏱️ initializeGrid time");
                initializeGrid(currentRows);
                State.getInstance().currentRows = undefined;
                console.timeEnd("⏱️ initializeGrid time");
                State.getInstance().gridShape = shape;
            }
            sqlFile = msg.sqlFile;
        }
        
        console.time("⏱️ renderPage time");
        renderPage(currentRows);
        console.timeEnd("⏱️ renderPage time");
        
        if (msg.isLast) {
            // ew. logika na koniec
        }

        if (msg.clearSelection) {
            const gridBody = document.getElementById('gridBody');
            if (gridBody) {
                gridBody.querySelectorAll('.grid-row.selected-row').forEach(
                    row => row.classList.remove('selected-row')
                );
            }

            document.querySelectorAll('.tools-btn').forEach(btn => {btn.style.display = 'none';});

            // dane zostały odświeżone z backendu (np. po udanym zapisie kolumny) ->
            // znika czerwone podświetlenie i przycisk zapisu
            cancelAllColumnEdits();
        } else {
            // zwykłe odświeżenie danych (np. zmiana strony) -> jeśli są jakieś
            // niezapisane edycje kolumn, trzeba ponownie nałożyć ich podgląd,
            // bo renderPage() właśnie nadpisał komórki prawdziwymi wartościami z backendu
            reapplyAllColumnEdits();
        }
        
        stopSpinner();
        
        console.log("--- END WEBVIEW PROCESSING ---");
    }

    if (msg.command === 'showResultsForFile') {
        const duration = Date.now() - msg.sentAt;
        console.log(`🚀 Travel time via postMessage: ${duration} ms`);
        
        if (!msg.sqlFile) {
            throw new Error("Missing: msg.sqlFile");
        }
        State.init(msg.sqlFile);
        sqlFile = msg.sqlFile;
        
        // zaktualizuj kolor (może się zmienić po pickConnectionColor)
        State.getInstance().connectionColor = msg.connectionColor ?? null;
        
        startGridContainer();
        updateDbAndTimes(State.getInstance().connectionName, State.getInstance().connectionTime, State.getInstance().queryTime, State.getInstance().connectionColor);
        updateInfoMessage(State.getInstance().infoMessage);
        updateErrorMessage(State.getInstance().errorMessage);
        updatePagination(State.getInstance().currentPage, State.getInstance().totalPages);
        
        // renderowanie HTML
        console.time("⏱️ renderHeaders time");
        renderHeaders(State.getInstance().currentRows);
        console.timeEnd("⏱️ renderHeaders time");
        console.time("⏱️ restoreGridFromCache time");
        restoreGridFromCache();
        console.timeEnd("⏱️ restoreGridFromCache time");
    }
    
    if (msg.command === 'showEmpty') {
        const duration = Date.now() - msg.sentAt;
        console.log(`🚀 Travel time via postMessage: ${duration} ms`);
        
        stopGridContainer();

        // czyścimy to, co jest aktualnie wyrenderowane w webview
        document.getElementById('gridHeader').innerHTML = '';
        document.getElementById('gridBody').innerHTML = '';
        sqlFile = undefined; // zapomnij, dla jakiego pliku była ostatnio wyrenderowana siatka

        try {
            cancelAllColumnEdits();
        } catch (e) {
            // State nie był jeszcze zainicjalizowany - nic do anulowania
        }

        updateDbAndTimes();
        updateInfoMessage();
        updateErrorMessage();
        updatePagination();
    }
    
    if (msg.command === 'changeConnection') {
        State.getInstance().connectionName = msg.connectionName;
        State.getInstance().connectionTime = msg.connectionTime;
        State.getInstance().connectionColor = msg.connectionColor ?? null;
        updateDbAndTimes(State.getInstance().connectionName, State.getInstance().connectionTime, null, State.getInstance().connectionColor);
        // showFlashMessage('Connection DB was changed', 3);
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

    if (msg.command === 'columnEditsCancelled') {
        // użytkownik odrzucił prompt potwierdzenia w backendzie (albo wystąpił błąd
        // zapisu) -> nic nie zostało zmienione w bazie, cofamy wizualny podgląd
        cancelAllColumnEdits();
    }
});
