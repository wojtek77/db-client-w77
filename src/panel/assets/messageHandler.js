window.addEventListener('message', event => {

    const msg = event.data;

    if (msg.command === 'appendData') {

        const start = performance.now();

        window.state.allData.push(...msg.rows);

        if (window.state.headers.length === 0 && window.state.allData.length) {

            window.state.headers = Object.keys(window.state.allData[0]);

            renderHeaders();
        }

        window.state.totalPages = Math.ceil(
            window.state.allData.length / window.state.ROWS_PER_PAGE
        );

        document.getElementById(
            'totalPages'
        ).textContent = window.state.totalPages;

        // render tylko pierwszego chunk
        if (window.state.currentPage === 1) {
            renderPage();
        }

        const end = performance.now();

        console.log(
            'Chunk loaded:',
            msg.rows.length,
            'rows in',
            (end - start).toFixed(2),
            'ms'
        );

        if (msg.isLast) {

            console.log(
                'ALL DATA LOADED:',
                window.state.allData.length
            );
        }
    }

    if (msg.command === 'updateConfirmed') {

        const cells = document.querySelectorAll(
            '[data-id="' + msg.id + '"][data-column="' + msg.column + '"]'
        );

        cells.forEach(cell => {

            cell.classList.add('updated-cell');

            setTimeout(() => {

                cell.classList.remove('updated-cell');

            }, 500);
        });
    }
});
