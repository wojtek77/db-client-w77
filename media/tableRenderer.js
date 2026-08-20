import { State } from './state.js';

export function renderHeaders(pageRows) {
    console.log('renderHeaders');
    const headerContainer = document.getElementById('gridHeader');
    const headers = State.getInstance().headers;
    
    if (!headers || headers.length === 0) {
        headerContainer.innerHTML = '';
        return;
    }

    // inteligentne obliczanie szerokości kolumn
    const columnWidths = [];
    
    for (let j = 0; j < headers.length; j++) {
        // zaczynamy od długości samej nazwy nagłówka
        let maxCharCount = headers[j] ? headers[j].length : 5;

        // skanujemy 200 wierszy dla tej konkretnej kolumny, aby znaleźć najdłuższy tekst
        if (pageRows) {
            for (let i = 0; i < pageRows.length; i++) {
                const val = pageRows[i][j];
                if (val !== null && val !== undefined) {
                    const len = String(val).length;
                    if (len > maxCharCount) {
                        maxCharCount = len;
                    }
                }
            }
        }

        // zamieniamy liczbę znaków na piksele (~8-9px + padding), ograniczamy szerokość do 80-350px, żeby długie teksty nie rozjechały tabeli
        let calculatedWidth = Math.max(80, Math.min(350, maxCharCount * 8.5 + 24));
        columnWidths.push(`${calculatedWidth}px`);
    }

    // składamy finalny szablon: 50px dla LP + unikalna szerokość dla każdej kolumny
    const gridTemplate = `50px ${columnWidths.join(' ')}`;
    
    const gridContainer = document.querySelector('.grid-container');
    if (gridContainer) {
        gridContainer.style.setProperty('--grid-columns', gridTemplate);
    }
    State.getInstance().cachedGridTemplate = gridTemplate;
    
    // budujemy nagłówki HTML
    const fragment = document.createDocumentFragment();
    const lpHeader = document.createElement('div');
    lpHeader.className = 'grid-cell header-cell lp-cell';
    lpHeader.style.fontWeight = 'bold';
    lpHeader.textContent = '#';
    fragment.appendChild(lpHeader);

    for (let i = 0; i < headers.length; i++) {
        const th = document.createElement('div');
        th.className = 'grid-cell header-cell';
        th.dataset.columnIndex = i;

        // nazwa kolumny jako osobny span (nie textContent całego th), żeby obok zmieściła się klikalna strzałka sortowania bez kolizji z zaznaczaniem kolumny (patrz sorting.js)
        const label = document.createElement('span');
        label.className = 'header-label';
        label.textContent = headers[i];
        th.appendChild(label);

        const sortIndicator = document.createElement('span');
        sortIndicator.className = 'sort-indicator';
        th.appendChild(sortIndicator);

        fragment.appendChild(th);
    }
    
    headerContainer.replaceChildren(fragment);
    State.getInstance().cachedHeaderHtml = [...headerContainer.children];

    updateSortIndicators();
}

/**
 * odświeża strzałki sortowania we wszystkich nagłówkach kolumn na podstawie State.sortColumn/State.sortDirection
 * (backend jest źródłem prawdy - patrz msg.sortColumn/msg.sortDirection w messageHandler.js) - wołane po renderHeaders
 * oraz po appendData/showResultsForFile, żeby wskaźnik zawsze odzwierciedlał aktualny stan sortowania z backendu
 */
export function updateSortIndicators() {
    if (!State.hasInstance()) {return;}
    const state = State.getInstance();

    // pomijamy indeks 0 (komórka LP) - reszta jest w tej samej kolejności co kolumny
    const headerCells = state.cachedHeaderHtml ? state.cachedHeaderHtml.slice(1) : [];
    const criteria = state.sortCriteria || [];
    // numer priorytetu (▲1, ▼2, ...) pokazujemy tylko gdy naprawdę jest co numerować - przy jednym aktywnym kryterium sama strzałka wystarczy
    const showPriority = criteria.length > 1;

    headerCells.forEach((headerCell, colIndex) => {
        const indicator = headerCell.querySelector('.sort-indicator');
        if (!indicator) {return;}

        const criterionIndex = criteria.findIndex((c) => c.columnIndex === colIndex);
        const isActive = criterionIndex !== -1;

        if (!isActive) {
            // nieaktywna kolumna też musi mieć jakiś glif w środku - inaczej opacity/hover z CSS nie ma czego pokazać (pusty span jest niewidoczny nawet przy opacity: 1)
            indicator.textContent = '⇅';
        } else {
            const arrow = criteria[criterionIndex].direction === 'asc' ? '▲' : '▼';
            indicator.textContent = showPriority ? `${arrow}${criterionIndex + 1}` : arrow;
        }
        indicator.classList.toggle('sort-active', isActive);
    });
}

/**
 * Przywraca nagłówek z cache danego pliku (razem z klasą 'selected-col',
 * bo to te same węzły DOM, które tam trafiły). Używane przy przełączaniu
 * między plikami/zakładkami, żeby nie przebudowywać nagłówka od zera
 * i nie zgubić zaznaczenia kolumny.
 */
export function restoreHeaderFromCache() {
    const headerContainer = document.getElementById('gridHeader');
    headerContainer.replaceChildren(...State.getInstance().cachedHeaderHtml);

    const gridContainer = document.querySelector('.grid-container');
    if (gridContainer && State.getInstance().cachedGridTemplate) {
        gridContainer.style.setProperty('--grid-columns', State.getInstance().cachedGridTemplate);
    }
}

export function initializeGrid(currentRows) {
    const gridBody = document.getElementById('gridBody');

    // 🚀 usuń stare wiersze
    gridBody.replaceChildren();

    const headers = State.getInstance().headers;
    const columnTypes = State.getInstance().columnTypes;
    const rowCount = currentRows.length;
    const headerCount = headers.length;

    const rows = [];
    const rowsHtml = [];
    
    // const fragment = document.createDocumentFragment();
    for (let i = 0; i < rowCount; ++i) {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'grid-row';
        // podobnie jak przy komórkach (cell._index) zapamiętujemy indeks wiersza na węźle DOM, żeby odczytać 'który to wiersz' bez przeszukiwania DOM
        rowDiv._rowIndex = i;

        const cells = [];

        // pierwsza komórka LP (inne style)
        const cell = document.createElement('div');
        cell.className = 'grid-cell lp-cell';
        cell.textContent = i + 1;
        rowDiv.appendChild(cell);
        cells.push(cell);
        // pozostałe komórki z danymi
        for (let j = 0; j < headerCount; ++j) {
            const cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell._index = {row: i, col: j};
            cell.dataset.columnType = (columnTypes && columnTypes[j]) ? columnTypes[j] : '';
            // cell._row = i;
            // cell._col = j;
            rowDiv.appendChild(cell);
            cells.push(cell);
        }

        // fragment.appendChild(rowDiv);
        gridBody.appendChild(rowDiv);
        rows.push(cells);
        rowsHtml.push(rowDiv);
    }
    // gridBody.appendChild(fragment);

    State.getInstance().cachedGrid = rows;
    State.getInstance().cachedGridHtml = rowsHtml;
}

export function restoreGridFromCache() {
    const gridBody = document.getElementById('gridBody');
    gridBody.replaceChildren(
        ...State.getInstance().cachedGridHtml
    );
}

/**
 * Nakłada WIZUALNY podgląd nowej wartości na CAŁĄ kolumnę (nagłówek + wszystkie
 * komórki danych na bieżącej stronie). To tylko widok - nie rusza State.currentRows
 * ani żadnych danych backendu. Działa bezpośrednio na węzłach z cachedGrid, więc
 * jest tanie i nie wymaga przebudowy siatki.
 * @param {number} columnIndex
 * @param {string} value
 */
export function applyColumnPreview(columnIndex, value) {
    const rows = State.getInstance().cachedGrid;
    if (rows) {
        rows.forEach((rowCells) => {
            const cell = rowCells[columnIndex + 1];
            if (!cell) {return;}
            cell.textContent = value;
            cell.classList.add('column-edit-pending');
        });
    }

    // +1 bo indeks 0 w cachedHeaderHtml to kolumna LP (tak samo jak w cachedGrid)
    const headerCell = State.getInstance().cachedHeaderHtml?.[columnIndex + 1];
    if (headerCell) {headerCell.classList.add('column-edit-pending');}
}

/**
 * Zdejmuje podgląd z kolumny: usuwa podświetlenie i przywraca prawdziwą wartość
 * komórki na podstawie State.currentRows (czyli ostatnich danych faktycznie
 * potwierdzonych przez backend - one nigdy nie były modyfikowane podglądem).
 * @param {number} columnIndex
 */
export function clearColumnPreview(columnIndex) {
    const rows = State.getInstance().cachedGrid;
    const currentRows = State.getInstance().currentRows;

    if (rows) {
        rows.forEach((rowCells, i) => {
            const cell = rowCells[columnIndex + 1];
            if (!cell) {return;}

            cell.classList.remove('column-edit-pending');

            // nie nadpisuj komórki, która akurat jest w trakcie edycji (ma input/textarea)
            if (cell.querySelector('input, textarea')) {return;}

            const rowData = currentRows ? currentRows[i]?.data : undefined;
            cell.textContent = rowData ? (rowData[columnIndex] ?? 'NULL') : '';
        });
    }

    const headerCell = State.getInstance().cachedHeaderHtml?.[columnIndex + 1];
    if (headerCell) {headerCell.classList.remove('column-edit-pending');}
}

/**
 * Nakłada WIZUALNY podgląd nowej wartości na dowolny zbiór KOMÓREK (nie całą kolumnę) - używane
 * przez zbiorczą edycję niezależnie zaznaczonych komórek. To tylko widok, tak jak applyColumnPreview.
 * @param {Set<string>} positions - pozycje w formacie "rowKey-col"
 * @param {string} value
 */
export function applyCellGroupPreview(positions, value) {
    const rows = State.getInstance().cachedGrid;
    const currentRows = State.getInstance().currentRows;
    if (!rows || !currentRows) {return;}

    positions.forEach((key) => {
        const [rowKey, colIndex] = key.split('-').map(Number);
        const rowIndex = currentRows.findIndex(entry => entry?.key === rowKey);
        if (rowIndex === -1) {return;}
        const cell = rows[rowIndex]?.[colIndex + 1];
        if (!cell) {return;}
        cell.textContent = value;
        cell.classList.add('cell-edit-pending');
    });
}

/**
 * Zdejmuje podgląd z podanego zbioru komórek: usuwa podświetlenie i przywraca prawdziwą wartość
 * z State.currentRows - odpowiednik clearColumnPreview, ale dla dowolnego zbioru komórek.
 * @param {Set<string>} positions - pozycje w formacie "rowKey-col"
 */
export function clearCellGroupPreview(positions) {
    const rows = State.getInstance().cachedGrid;
    const currentRows = State.getInstance().currentRows;
    if (!rows || !currentRows) {return;}

    positions.forEach((key) => {
        const [rowKey, colIndex] = key.split('-').map(Number);
        const rowIndex = currentRows.findIndex(entry => entry?.key === rowKey);
        if (rowIndex === -1) {return;}
        const cell = rows[rowIndex]?.[colIndex + 1];
        if (!cell) {return;}

        cell.classList.remove('cell-edit-pending');

        // nie nadpisuj komórki, która akurat jest w trakcie edycji (ma input/textarea)
        if (cell.querySelector('input, textarea')) {return;}

        const rowData = currentRows[rowIndex]?.data;
        cell.textContent = rowData ? (rowData[colIndex] ?? 'NULL') : '';
    });
}

/**
 * Płytkie porównanie dwóch wierszy kolumna-po-kolumnie (bez serializacji do JSON).
 * @param {Array} rowA
 * @param {Array} rowB
 * @param {number} headerCount
 * @returns {boolean}
 */
function rowsEqual(rowA, rowB, headerCount) {
    if (rowA === rowB) {return true;}
    if (!rowA || !rowB) {return false;}

    for (let j = 0; j < headerCount; ++j) {
        if (rowA[j] !== rowB[j]) {return false;}
    }

    return true;
}

/**
 * Renderuje stronę wyników. entries to tablica wpisów {key, data} (patrz RowEntry
 * w SqlResultsProvider.ts) - key to stabilny identyfikator wiersza z backendu, data
 * to jego wartości kolumn. Trzymamy je razem (zamiast osobnych currentRows/currentRowKeys),
 * żeby nie było dwóch struktur, które muszą się zgadzać co do kolejności/długości.
 * @param {Array<{key: number, data: Array}>} entries
 */
export function renderPage(entries) {
    const headers = State.getInstance().headers;
    const rows = State.getInstance().cachedGrid;
    const dataCount = entries.length;
    const headerCount = headers.length;
    const lastEntries = State.getInstance().currentRows;

    for (let i = 0; i < dataCount; ++i) {
        const lastData = lastEntries ? lastEntries[i]?.data : undefined;
        if (lastData && rowsEqual(lastData, entries[i].data, headerCount)) {
            continue;
        }
        
        const rowData = entries[i].data;
        const rowCells = rows[i];

        for (let j = 0; j < headerCount; ++j) {
            
            const value = rowData[j] ?? 'NULL';
            const cell = rowCells[j + 1];

            // if (cell.textContent !== value) {
            //     cell.textContent = value;
            // }
            cell.textContent = value;
        }
    }
    
    State.getInstance().currentRows = entries;
}
