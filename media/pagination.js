import { State } from './state.js';

export function nextPage() {

    if (State.getInstance().currentPage < State.getInstance().totalPages) {

        State.getInstance().currentPage++;

        window.vscode.postMessage({
            command: 'loadPage',
            page: State.getInstance().currentPage
        });
    }
}

export function prevPage() {

    if (State.getInstance().currentPage > 1) {

        State.getInstance().currentPage--;

        window.vscode.postMessage({
            command: 'loadPage',
            page: State.getInstance().currentPage
        });
    }
}

export function firstPage() {

    State.getInstance().currentPage = 1;

    window.vscode.postMessage({
        command: 'loadPage',
        page: 1
    });
}

export function lastPage() {

    State.getInstance().currentPage = State.getInstance().totalPages;

    window.vscode.postMessage({
        command: 'loadPage',
        page: State.getInstance().currentPage
    });
}

export function initPaginationListeners() {
    document.getElementById('firstBtn')?.addEventListener('click', firstPage);
    document.getElementById('prevBtn')?.addEventListener('click', prevPage);
    document.getElementById('nextBtn')?.addEventListener('click', nextPage);
    document.getElementById('lastBtn')?.addEventListener('click', lastPage);
}
