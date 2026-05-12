function nextPage() {

    if (window.state.currentPage < window.state.totalPages) {

        window.state.currentPage++;

        renderPage();
    }
}

function prevPage() {

    if (window.state.currentPage > 1) {

        window.state.currentPage--;

        renderPage();
    }
}

function firstPage() {

    window.state.currentPage = 1;

    renderPage();
}

function lastPage() {

    window.state.currentPage = window.state.totalPages;

    renderPage();
}

window.nextPage = nextPage;
window.prevPage = prevPage;
window.firstPage = firstPage;
window.lastPage = lastPage;
