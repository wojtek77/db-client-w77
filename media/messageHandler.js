import { State } from './state.js';
import { renderHeaders, initializeGrid, restoreGridFromCache, restoreHeaderFromCache, renderPage } from './tableRenderer.js';
import { cancelAllColumnEdits, reapplyAllColumnEdits, updateDeleteButtonVisibility, updateSaveColumnEditsButtonVisibility, clearRowSelection, hideToolsButtons } from './editor.js';

let sqlFile;
let queryTimer = null;
let queryStartTime = null;

// stworzenie dekodera raz zapobiega ciągłemu tworzeniu nowych obiektów w pamięci
const decoder = new TextDecoder('utf-8');

const loadingOverlay = document.getElementById('loadingOverlay');
const errorDisplay = document.getElementById('errorDisplay');
const gridContainer = document.getElementById('gridContainer');
const spinner = document.querySelector('.spinner');
const loadingText = document.querySelector('.loading-text');
const cancelBtn = document.getElementById('cancelQuery');
const infoMessage = document.getElementById('infoMessage');

// przyciski narzędziowe pobieramy przez getElementById na żądanie, nie raz przy starcie – taki cache zamrażałby elementy sprzed przebudowania strony
function getToolsBtnElements() {
    return [
        'generateInsertBtn',
        'generateUpdateBtn',
        'generateDeleteBtn',
        'deleteRowsBtn',
        'saveColumnEditsBtn',
    ].map(id => document.getElementById(id)).filter(Boolean);
}

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
    
    // aktualizuj przyciski paginacji
    document.getElementById('prevBtn').disabled = (currentPage === 1);
    document.getElementById('firstBtn').disabled = (currentPage === 1);
    document.getElementById('nextBtn').disabled = (currentPage === totalPages);
    document.getElementById('lastBtn').disabled = (currentPage === totalPages);
}
function updateDbAndTimes(connectionName = '-------', connectionTime = null, queryTime = null, connectionColor = null, isProduction = false, isReadOnly = false) {
    // ustawienie połączenia z DB i czasów
    const connNameEl = document.getElementById('connectionName');
    connNameEl.textContent = connectionName;
    const toolbar = document.getElementById('connectionColor');
    toolbar.style.color = connectionColor ?? '';
    // silniejsze, trudne do przeoczenia oznaczenie połączeń produkcyjnych/tylko-do-odczytu, niezależnie od koloru wybranego przez użytkownika
    toolbar.classList.toggle('production-connection', !!isProduction);
    toolbar.classList.toggle('readonly-connection', !!isReadOnly);
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
function stopToolsBtn() {
    const state = State.getInstance();

    // nic nie jest widoczne, jeśli nie ma zaznaczonych wierszy ani oczekujących edycji kolumn – pomijamy zbędny zapis do stylu i reflow
    const hasSelection = state.selectedRowIndexes.size > 0;
    const hasPendingEdits = Object.keys(state.pendingColumnEdits).length > 0;
    if (!hasSelection && !hasPendingEdits) {
        return;
    }

    getToolsBtnElements().forEach(btn => { btn.style.display = 'none'; });
    state.pendingColumnEdits = {};
}

window.addEventListener('message', event => {
    const msg = event.data;
    
    if (msg.command === 'queryStarted') {
        cancelBtn.style.display = 'inline-block';
        // nowe zapytanie startuje na czysto – usuń ewentualny stan 'cancelling' pozostały po poprzednim anulowaniu
        cancelBtn.classList.remove('cancelling');
        if (loadingText) {
            loadingText.textContent = 'Loading data...';
        }
        
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
        
        updateErrorMessage();
    }

    if (msg.command === 'queryFinished') {
        cancelBtn.style.display = 'none';
        cancelBtn.classList.remove('cancelling');
        stopQueryTimer();
        if (msg.connectionFailed) {
            // przy błędzie chowamy spinner tutaj, bo 'appendData' (które normalnie go chowa) nie zostanie wysłane
            stopSpinner();
        }
    }
    
    if (msg.command === 'loadingWebview') {
        spinner.style.borderTopColor = '#3794ff';
    }

    if (msg.command === 'appendData') {
        console.log("--- START WEBVIEW PROCESSING ---");
        
        const duration = Date.now() - msg.sentAt;
        console.log(`🚀 Travel time via postMessage: ${duration} ms`);
        
        if (!msg.sqlFile) {
            throw new Error("Missing: msg.sqlFile");
        }
        State.init(msg.sqlFile);
        // ustaw stronę na podstawie odpowiedzi z backendu, nie 'optymistycznej' wartości z pagination.js – zawsze zgodny z tym, co faktycznie przyszło
        if (typeof msg.currentPage === 'number') {
            State.getInstance().currentPage = msg.currentPage;
        }
        // oblicz całkowitą liczbę stron
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
        State.getInstance().isProduction = msg.isProduction ?? false;
        State.getInstance().isReadOnly = msg.isReadOnly ?? false;
        State.getInstance().infoMessage = msg.infoMessage;
        State.getInstance().errorMessage = msg.errorMessage;
        updateDbAndTimes(State.getInstance().connectionName, State.getInstance().connectionTime, State.getInstance().queryTime, State.getInstance().connectionColor, State.getInstance().isProduction, State.getInstance().isReadOnly);
        updateInfoMessage(State.getInstance().infoMessage);
        updateErrorMessage(State.getInstance().errorMessage);
        updatePagination(State.getInstance().currentPage, State.getInstance().totalPages);
        
        if (msg.flashMessage) {showFlashMessage(msg.flashMessage, 4);}
        
        const currentRows = msg.isEncoded ? JSON.parse(decoder.decode(msg.rows)) : msg.rows;
        
        const shape = `${currentRows.length}x${State.getInstance().headers.join('|')}`;

        let isSameQuery = Boolean(msg.isSameQuery);

        if (sqlFile && sqlFile === msg.sqlFile) { // kiedy jest powtórne uruchomienie SQL w tym samym pliku
            // header DOM już jest poprawny (ten sam plik, poprzednie renderHeaders) – przebudowujemy go tylko gdy zmienił się kształt albo nazwy kolumn
            if (State.getInstance().gridShape !== shape) {
                console.time("⏱️ renderHeaders time");
                renderHeaders(currentRows);
                console.timeEnd("⏱️ renderHeaders time");

                console.time("⏱️ initializeGrid time");
                initializeGrid(currentRows);
                console.timeEnd("⏱️ initializeGrid time");
                State.getInstance().currentRows = undefined;
                State.getInstance().gridShape = shape;

                isSameQuery = false;
            }
        } else { // kiedy jest nowe uruchomienie pliku lub zmiana pliku
            // header DOM mógł należeć do innego, poprzednio otwartego pliku – przy korzystaniu z cache tego pliku przywracamy też jego nagłówek z cache
            if (State.getInstance().gridShape === shape) {
                console.time("⏱️ restoreHeaderFromCache time");
                restoreHeaderFromCache();
                console.timeEnd("⏱️ restoreHeaderFromCache time");
                console.time("⏱️ restoreGridFromCache time");
                restoreGridFromCache();
                console.timeEnd("⏱️ restoreGridFromCache time");
            } else {
                console.time("⏱️ renderHeaders time");
                renderHeaders(currentRows);
                console.timeEnd("⏱️ renderHeaders time");
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
            clearRowSelection();

            // dane odświeżone z backendu -> znika podświetlenie i przycisk zapisu
            // musi być wywołane przed stopToolsBtn(), bo cancelAllColumnEdits() korzysta z jeszcze niewyczyszczonego State.pendingColumnEdits
            cancelAllColumnEdits();

            stopToolsBtn();
        } else {
            if (isSameQuery) {
                // jeśli są niezapisane edycje kolumn, trzeba ponownie nałożyć ich podgląd, bo renderPage() nadpisał komórki wartościami z backendu
                reapplyAllColumnEdits();
            } else {
                stopToolsBtn();
            }
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
        State.getInstance().isProduction = msg.isProduction ?? false;
        State.getInstance().isReadOnly = msg.isReadOnly ?? false;
        
        startGridContainer();
        updateDbAndTimes(State.getInstance().connectionName, State.getInstance().connectionTime, State.getInstance().queryTime, State.getInstance().connectionColor, State.getInstance().isProduction, State.getInstance().isReadOnly);
        updateInfoMessage(State.getInstance().infoMessage);
        updateErrorMessage(State.getInstance().errorMessage);
        updatePagination(State.getInstance().currentPage, State.getInstance().totalPages);
        updateDeleteButtonVisibility();
        updateSaveColumnEditsButtonVisibility();
        
        // renderowanie HTML
        console.time("⏱️ restoreHeaderFromCache time");
        restoreHeaderFromCache();
        console.timeEnd("⏱️ restoreHeaderFromCache time");
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

        updateDbAndTimes();
        updateInfoMessage();
        updateErrorMessage();
        updatePagination();
        hideToolsButtons();
        updateSaveColumnEditsButtonVisibility(true); // tylko ukrywa
    }
    
    if (msg.command === 'changeConnection') {
        State.getInstance().connectionName = msg.connectionName;
        State.getInstance().connectionTime = msg.connectionTime;
        State.getInstance().connectionColor = msg.connectionColor ?? null;
        State.getInstance().isProduction = msg.isProduction ?? false;
        State.getInstance().isReadOnly = msg.isReadOnly ?? false;
        updateDbAndTimes(State.getInstance().connectionName, State.getInstance().connectionTime, null, State.getInstance().connectionColor, State.getInstance().isProduction, State.getInstance().isReadOnly);
        // showFlashMessage('Connection DB was changed', 3);
    }
    
    if (msg.command === 'updateConfirmed') {
        // korzystamy z cachedGrid (komórka ma _index = {row, col}) zamiast przeszukiwać DOM po atrybutach, których komórki nigdy nie dostają
        const rowCells = State.getInstance().cachedGrid?.[msg.rowIndex];
        const cell = rowCells?.[msg.columnIndex + 1]; // +1 bo indeks 0 to kolumna LP
        if (cell) {
            cell.classList.add('updated-cell');
            setTimeout(() => cell.classList.remove('updated-cell'), 500);
        }
    }

    if (msg.command === 'columnEditsCancelled') {
        // użytkownik odrzucił prompt potwierdzenia (albo wystąpił błąd zapisu) -> nic nie zmienione w bazie, cofamy wizualny podgląd
        cancelAllColumnEdits();
    }

    if (msg.command === 'clearCache') {
        // backend zgłasza zamknięcie zakładki pliku SQL – usuwamy jego cache, żeby nie trzymać go w pamięci webview w nieskończoność
        State.clear(msg.sqlFile);
    }
});
