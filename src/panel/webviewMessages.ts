// walidacja kształtu komunikatów przychodzących z webview wyników SQL - wydzielone z SqlResultsProvider.ts jako czysta funkcja, niezależna od stanu klasy

/**
 * Waliduje kształt komunikatów przychodzących z webview. Webview nie jest
 * zaufanym źródłem (renderuje dane z bazy i mogłoby zostać skompromitowane
 * przez np. XSS), więc każdy komunikat musi mieć oczekiwany "command" oraz
 * pola o oczekiwanym typie, zanim zostanie użyty do czegokolwiek (a w
 * szczególności zanim trafi do zapytania SQL).
 */
export function isValidWebviewMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string') {
        return false;
    }

    const isNumberArray = (v: any) => Array.isArray(v) && v.every((n) => typeof n === 'number');

    switch (msg.command) {
        case 'loadPage':
            return typeof msg.page === 'number' && msg.page > 0;

        case 'search':
            return typeof msg.query === 'string';

        case 'sortColumn':
            // additive=true -> Shift+klik (dokłada/aktualizuje/usuwa TĘ kolumnę jako kolejne kryterium, nie ruszając pozostałych); additive=false -> zwykły klik (patrz toggleSort)
            return typeof msg.columnIndex === 'number' && typeof msg.additive === 'boolean';

        case 'updateCell':
            return typeof msg.rowKey === 'number' && typeof msg.rowIndex === 'number' && typeof msg.columnIndex === 'number';

        case 'deleteRows':
        case 'generateInsert':
        case 'generateUpdate':
        case 'generateDelete':
            return isNumberArray(msg.rowKeys);

        case 'saveColumnEdits':
            return Array.isArray(msg.edits) && msg.edits.every((edit: any) =>
                edit && typeof edit === 'object' &&
                typeof edit.columnIndex === 'number' &&
                typeof edit.columnName === 'string'
            );

        case 'saveCellEdits':
            return typeof msg.value !== 'undefined' &&
                Array.isArray(msg.cells) && msg.cells.length > 0 && msg.cells.every((cell: any) =>
                    cell && typeof cell === 'object' &&
                    typeof cell.rowKey === 'number' &&
                    typeof cell.columnIndex === 'number' &&
                    typeof cell.columnName === 'string'
                );

        case 'webviewReady':
        case 'changeConnection':
        case 'openRecentFiles':
        case 'exportCSV':
        case 'exportTXT':
        case 'cancelQuery':
        case 'pickConnectionColor':
            return true;

        default:
            // nieznana komenda - odrzucamy
            return false;
    }
}
