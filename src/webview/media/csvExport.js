function exportToCSV() {

    let csv = window.state.headers.join(',') + '\\n';

    for (const row of window.state.allData) {

        const line = window.state.headers.map(h => {

            let cell = row[h] || '';

            if (
                typeof cell === 'string' &&
                (
                    cell.includes(',') ||
                    cell.includes('"') ||
                    cell.includes('\\n')
                )
            ) {

                cell =
                    '"' +
                    cell.replace(/"/g, '""') +
                    '"';
            }

            return cell;

        }).join(',');

        csv += line + '\\n';
    }

    const blob = new Blob(
        [csv],
        {
            type: 'text/csv;charset=utf-8;'
        }
    );

    const url =
        URL.createObjectURL(blob);

    const a =
        document.createElement('a');

    a.href = url;

    a.download =
        'export_' +
        new Date()
            .toISOString()
            .slice(0,19)
            .replace(/:/g, '-') +
        '.csv';

    document.body.appendChild(a);

    a.click();

    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}

window.exportToCSV = exportToCSV;
