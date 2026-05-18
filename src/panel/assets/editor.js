function initEditor(vscode) {

    const rowsLayer = document.getElementById('tableBody');

    rowsLayer.addEventListener('dblclick', e => {

        const target = e.target;

        if (!(target instanceof HTMLElement)) {
            return;
        }

        const cell = target.closest('td');

        // Pomijamy komórkę z numerem wiersza (pierwsza kolumna)
        if (!cell.dataset.column) {
            return;
        }

        if (cell.querySelector('input')) {
            return;
        }

        const oldValue = cell.dataset.value || '';
        
        // ⭐ Pobierz indeksy wiersza i kolumny z atrybutów data-row i data-col
        const rowIndex = parseInt(cell.getAttribute('data-row'));
        const columnIndex = parseInt(cell.getAttribute('data-col'));
        
        

        const input = document.createElement('input');

        input.value = oldValue;

        input.style.width = '100%';
        input.style.border = 'none';
        input.style.padding = '3px';
        input.style.margin = '0';
        input.style.background = 'transparent';
        input.style.color = 'inherit';
        input.style.font = 'inherit';
        input.style.fontWeight = 'bold';
        input.style.fontSize = '133%';

        cell.innerHTML = '';

        cell.appendChild(input);

        input.focus();

        input.select();

        function save() {

            const newValue = input.value;

            if (oldValue === newValue) {
                cell.dataset.value = oldValue;
                cell.textContent = oldValue;
                return;
            }

            cell.dataset.value = newValue;
            cell.textContent = newValue;

            // ⭐ WYŚLIJ NOWY FORMAT (rowIndex, columnIndex)
            vscode.postMessage({
                command: 'updateCell',
                rowIndex: rowIndex,
                columnIndex: columnIndex,
                value: newValue
            });
        }

        input.addEventListener('blur', save);

        input.addEventListener('keydown', ev => {

            if (ev.key === 'Enter') {
                input.blur();
            }

            if (ev.key === 'Escape') {

                input.removeEventListener('blur', save);

                input.blur();

                cell.dataset.value = oldValue;
                cell.textContent = oldValue;
            }
        });
    });
}
