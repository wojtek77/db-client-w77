function nextPage() {

    if (State.getInstance().currentPage < State.getInstance().totalPages) {

        State.getInstance().currentPage++;

        window.vscode.postMessage({
            command: 'loadPage',
            page: State.getInstance().currentPage
        });
    }
}

function prevPage() {

    if (State.getInstance().currentPage > 1) {

        State.getInstance().currentPage--;

        window.vscode.postMessage({
            command: 'loadPage',
            page: State.getInstance().currentPage
        });
    }
}

function firstPage() {

    State.getInstance().currentPage = 1;

    window.vscode.postMessage({
        command: 'loadPage',
        page: 1
    });
}

function lastPage() {

    State.getInstance().currentPage = State.getInstance().totalPages;

    window.vscode.postMessage({
        command: 'loadPage',
        page: State.getInstance().currentPage
    });
}

window.nextPage = nextPage;
window.prevPage = prevPage;
window.firstPage = firstPage;
window.lastPage = lastPage;
