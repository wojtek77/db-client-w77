function renderHeaders(pageRows) {
    console.log('renderHeaders');
    const headerContainer = document.getElementById('gridHeader');
    const headers = State.getInstance().headers;
    
    if (!headers || headers.length === 0) {
        headerContainer.innerHTML = '';
        return;
    }

    // 🚀 INTELIGENTNE OBLICZANIE SZEROKOŚCI KOLUMN
    const columnWidths = [];
    
    for (let j = 0; j < headers.length; j++) {
        // Zaczynamy od długości samej nazwy nagłówka
        let maxCharCount = headers[j] ? headers[j].length : 5;

        // Skanujemy 200 wierszy dla tej konkretnej kolumny, aby znaleźć najdłuższy tekst
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

        // Zamieniamy liczbę znaków na piksele (średnio 8-9px na znak + padding komórki)
        // Ograniczamy szerokość: minimum 80px, maksimum 350px (żeby bardzo długie teksty nie rozjechały tabeli)
        let calculatedWidth = Math.max(80, Math.min(350, maxCharCount * 8.5 + 24));
        columnWidths.push(`${calculatedWidth}px`);
    }

    // Składamy finalny szablon: 50px dla LP + unikalna szerokość dla każdej kolumny
    const gridTemplate = `50px ${columnWidths.join(' ')}`;
    
    const gridContainer = document.querySelector('.grid-container');
    if (gridContainer) {
        gridContainer.style.setProperty('--grid-columns', gridTemplate);
    }
    
    // Budujemy nagłówki HTML
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
        th.textContent = headers[i];
        fragment.appendChild(th);
    }
    
    headerContainer.replaceChildren(fragment);
}

function initializeGrid(currentRows) {
    const gridBody = document.getElementById('gridBody');

    // 🚀 usuń stare wiersze
    gridBody.replaceChildren();

    const headers = State.getInstance().headers;
    const rowCount = currentRows.length;
    const headerCount = headers.length;

    const rows = [];
    const rowsHtml = [];
    
    // const fragment = document.createDocumentFragment();
    for (let i = 0; i < rowCount; ++i) {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'grid-row';

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

function restoreGridFromCache() {
    const gridBody = document.getElementById('gridBody');
    gridBody.replaceChildren(
        ...State.getInstance().cachedGridHtml
    );
}

function renderPage(data) {
    const headers = State.getInstance().headers;
    const rows = State.getInstance().cachedGrid;
    const dataCount = data.length;
    const headerCount = headers.length;
    const lastData = State.getInstance().currentRows;

    for (let i = 0; i < dataCount; ++i) {
        if (lastData && JSON.stringify(lastData[i]) === JSON.stringify(data[i])) {
            continue;
        }
        
        const rowData = data[i];
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
    
    State.getInstance().currentRows = data;
}
