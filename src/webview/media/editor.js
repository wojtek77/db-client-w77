function initEditor(vscode) {

    const rowsLayer =
        document.getElementById('tableBody');

    rowsLayer.addEventListener('dblclick', e => {

        const target = e.target;

        if (!(target instanceof HTMLElement)) {
            return;
        }

        const cell = target.closest('td');

        if (!cell.dataset.column) {
            return;
        }

        if (cell.querySelector('input')) {
            return;
        }

        const oldValue =
            cell.dataset.value || '';

        const input =
            document.createElement('input');

        input.value = oldValue;

        input.style.width = '100%';
        input.style.border = 'none';
        input.style.padding = '0';
        input.style.margin = '0';
        input.style.background = 'transparent';
        input.style.color = 'inherit';
        input.style.font = 'inherit';

        cell.innerHTML = '';

        cell.appendChild(input);

        input.focus();

        input.select();

        function save() {

            const newValue = input.value;

            cell.dataset.value = newValue;

            cell.textContent = newValue;

            vscode.postMessage({
                command: 'updateCell',
                id: cell.dataset.id,
                column: cell.dataset.column,
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
