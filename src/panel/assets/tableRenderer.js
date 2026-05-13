function renderHeaders() {

    const headerRow =
        document.getElementById('headerRow');

    headerRow.innerHTML = '<th>#</th>';

    for (const header of window.state.headers) {

        const th =
            document.createElement('th');

        th.textContent = header;

        headerRow.appendChild(th);
    }
}

function renderPage() {

    const pageRows = window.state.currentRows;
    
    // obliczenie, ile było wcześniej wyświetlonych rekordów
    const currentPage = window.state.currentPage;
    const ROWS_PER_PAGE = window.state.ROWS_PER_PAGE;
    const extraRows = (currentPage - 1) * ROWS_PER_PAGE;

    const tbody =
        document.getElementById('tableBody');

    const startRender = performance.now();

    tbody.innerHTML = '';

    const fragment =
        document.createDocumentFragment();

    for (let i = 0; i < pageRows.length; i++) {

        const row = pageRows[i];

        const rowNum = extraRows + i + 1;

        const tr = document.createElement('tr');

        const rowCell =
            document.createElement('td');

        rowCell.style.fontWeight = 'bold';

        rowCell.textContent = String(rowNum);

        tr.appendChild(rowCell);

        for (const header of window.state.headers) {

            const td =
                document.createElement('td');
            
            const value = row[header];

            td.dataset.value =
                value === null || value === undefined
                    ? ''
                    : String(value);

            td.dataset.id =
                row.id !== undefined && row.id !== null
                    ? String(row.id)
                    : '';

            td.dataset.column = header;

            td.textContent =
                value === null || value === undefined
                    ? ''
                    : String(value);

            tr.appendChild(td);
        }

        fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);

    document.getElementById(
        'currentPage'
    ).textContent = window.state.currentPage;

    document.getElementById(
        'prevBtn'
    ).disabled = window.state.currentPage === 1;

    document.getElementById(
        'firstBtn'
    ).disabled = window.state.currentPage === 1;

    document.getElementById(
        'nextBtn'
    ).disabled = window.state.currentPage === window.state.totalPages;

    document.getElementById(
        'lastBtn'
    ).disabled = window.state.currentPage === window.state.totalPages;

    const endRender = performance.now();

    console.log(
        'Render:',
        (endRender - startRender).toFixed(2),
        'ms'
    );
}
