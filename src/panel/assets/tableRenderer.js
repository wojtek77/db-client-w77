function renderHeaders() {
    console.log('renderHeaders');
    const headerContainer = document.getElementById('gridHeader');
    const headers = window.state.headers;
    const pageRows = window.state.currentRows;
    
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

function renderPage() {
    console.log('renderPage');
    
    const pageRows = window.state.currentRows;
    const headers = window.state.headers;
    const currentPage = window.state.currentPage;
    const ROWS_PER_PAGE = window.state.ROWS_PER_PAGE;
    
    const gridBody = document.getElementById('gridBody');
    
    if (!pageRows || pageRows.length === 0) {
        gridBody.innerHTML = '';
        return;
    }

    const baseIndex = (currentPage - 1) * ROWS_PER_PAGE;
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < pageRows.length; i++) {
        const row = pageRows[i];
        const globalRowIndex = baseIndex + i;
        const rowNum = globalRowIndex + 1;

        const rowDiv = document.createElement('div');
        rowDiv.className = 'grid-row';
        rowDiv.dataset.rowIndex = globalRowIndex;

        // Komórka LP
        const lpCell = document.createElement('div');
        lpCell.className = 'grid-cell lp-cell';
        lpCell.style.fontWeight = 'bold';
        lpCell.textContent = String(rowNum);
        rowDiv.appendChild(lpCell);

        // Komórki z danymi
        for (let j = 0; j < headers.length; j++) {
            const value = row[j];
            const displayValue = (value === null || value === undefined) ? '' : String(value);

            const cellDiv = document.createElement('div');
            cellDiv.className = 'grid-cell';
            cellDiv.dataset.row = globalRowIndex;
            cellDiv.dataset.col = j;
            cellDiv.dataset.column = headers[j];
            cellDiv.textContent = displayValue;
            rowDiv.appendChild(cellDiv);
        }

        fragment.appendChild(rowDiv);
    }

    gridBody.replaceChildren(fragment);
}
