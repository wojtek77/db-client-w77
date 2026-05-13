function nextPage() {

    if (window.state.currentPage < window.state.totalPages) {

        window.state.currentPage++;

        window.vscode.postMessage({
            command: 'loadPage',
            page: window.state.currentPage
        });
    }
}

function prevPage() {

    if (window.state.currentPage > 1) {

        window.state.currentPage--;

        window.vscode.postMessage({
            command: 'loadPage',
            page: window.state.currentPage
        });
    }
}

function firstPage() {

    window.state.currentPage = 1;

    window.vscode.postMessage({
        command: 'loadPage',
        page: 1
    });
}

function lastPage() {

    window.state.currentPage = window.state.totalPages;

    window.vscode.postMessage({
        command: 'loadPage',
        page: window.state.currentPage
    });
}

window.nextPage = nextPage;
window.prevPage = prevPage;
window.firstPage = firstPage;
window.lastPage = lastPage;
