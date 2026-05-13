function renderHeaders() {
    console.log('renderHeaders - headers:', window.state.headers);
    
    const headerRow = document.getElementById('headerRow');
    headerRow.innerHTML = '<th>#</th>';

    for (let i = 0; i < window.state.headers.length; i++) {
        const header = window.state.headers[i];
        const th = document.createElement('th');
        th.textContent = header;
        th.dataset.columnIndex = i;
        headerRow.appendChild(th);
    }
}

function renderPage() {
    console.log('renderPage - rows:', window.state.currentRows);
    
    const pageRows = window.state.currentRows;
    const headers = window.state.headers;
    const currentPage = window.state.currentPage;
    const ROWS_PER_PAGE = window.state.ROWS_PER_PAGE;
    const extraRows = (currentPage - 1) * ROWS_PER_PAGE;

    const tbody = document.getElementById('tableBody');
    
    if (!pageRows || pageRows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="100">Brak danych</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < pageRows.length; i++) {
        const row = pageRows[i];
        const rowNum = extraRows + i + 1;
        const globalRowIndex = (currentPage - 1) * ROWS_PER_PAGE + i;

        const tr = document.createElement('tr');
        tr.dataset.rowIndex = globalRowIndex;

        // Numer wiersza
        const rowCell = document.createElement('td');
        rowCell.style.fontWeight = 'bold';
        rowCell.textContent = String(rowNum);
        tr.appendChild(rowCell);

        // Kolumny
        for (let j = 0; j < headers.length; j++) {
            const td = document.createElement('td');
            const value = row[j];
            
            td.dataset.value = (value === null || value === undefined) ? '' : String(value);
            td.dataset.row = globalRowIndex;
            td.dataset.col = j;
            td.dataset.column = headers[j];
            
            td.textContent = (value === null || value === undefined) ? '' : String(value);
            
            tr.appendChild(td);
        }

        fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);
    
    console.log('Rendered', pageRows.length, 'rows');
}