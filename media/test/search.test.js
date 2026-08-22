import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, buildGrid, dataCellOf } from './domTestUtils.js';
import {
    initSearchListeners,
    highlightMatchesOnCurrentPage,
    restoreSearchUI,
    resetSearch,
    hideSearchIndicator,
} from '../search.js';

/** minimalny fake VS Code API - zapamiętuje wszystkie postMessage, żeby testy mogły je zweryfikować */
function fakeVscode() {
    const sent = [];
    return {
        postMessage: (msg) => sent.push(msg),
        sent,
    };
}

describe('search.js - podświetlanie dopasowań na bieżącej stronie', () => {

    test('owija dopasowany fragment w <mark class="search-match">, zachowując pełny tekst komórki', () => {
        setupDom();
        const state = buildGrid('search-hl-1.sql', {
            headers: ['name'],
            currentRows: [['foobar'], ['baz']],
        });
        state.searchQuery = 'oob';

        highlightMatchesOnCurrentPage();

        const cell = dataCellOf(state, 0, 0);
        const mark = cell.querySelector('mark.search-match');
        assert.ok(mark);
        assert.equal(mark.textContent, 'oob');
        assert.equal(cell.textContent, 'foobar');

        // druga komórka nie zawiera frazy - brak <mark>, zwykły tekst
        const otherCell = dataCellOf(state, 1, 0);
        assert.equal(otherCell.querySelector('mark'), null);
        assert.equal(otherCell.textContent, 'baz');
    });

    test('dopasowanie bez rozróżniania wielkości liter, podświetlony fragment zachowuje oryginalną wielkość liter z danych', () => {
        setupDom();
        const state = buildGrid('search-hl-2.sql', {
            headers: ['name'],
            currentRows: [['FooBar']],
        });
        state.searchQuery = 'foobar';

        highlightMatchesOnCurrentPage();

        assert.equal(dataCellOf(state, 0, 0).querySelector('mark').textContent, 'FooBar');
    });

    test('podświetla WSZYSTKIE wystąpienia frazy w jednej komórce', () => {
        setupDom();
        const state = buildGrid('search-hl-3.sql', {
            headers: ['name'],
            currentRows: [['abcabc']],
        });
        state.searchQuery = 'abc';

        highlightMatchesOnCurrentPage();

        const marks = dataCellOf(state, 0, 0).querySelectorAll('mark.search-match');
        assert.equal(marks.length, 2);
    });

    test('pusta fraza usuwa wcześniejsze podświetlenie i przywraca zwykły tekst', () => {
        setupDom();
        const state = buildGrid('search-hl-4.sql', {
            headers: ['name'],
            currentRows: [['foobar']],
        });
        state.searchQuery = 'foo';
        highlightMatchesOnCurrentPage();
        assert.ok(dataCellOf(state, 0, 0).querySelector('mark'));

        state.searchQuery = '';
        highlightMatchesOnCurrentPage();

        const cell = dataCellOf(state, 0, 0);
        assert.equal(cell.querySelector('mark'), null);
        assert.equal(cell.textContent, 'foobar');
    });

    test('NULL renderuje się jako tekst "NULL" i też może zostać dopasowany', () => {
        setupDom();
        const state = buildGrid('search-hl-5.sql', {
            headers: ['name'],
            currentRows: [[null]],
        });
        state.searchQuery = 'null';

        highlightMatchesOnCurrentPage();

        assert.equal(dataCellOf(state, 0, 0).querySelector('mark')?.textContent, 'NULL');
    });

    test('komórka w trakcie edycji (input) nie jest nadpisywana', () => {
        setupDom();
        const state = buildGrid('search-hl-6.sql', {
            headers: ['name'],
            currentRows: [['foobar']],
        });
        const cell = dataCellOf(state, 0, 0);
        const input = document.createElement('input');
        input.value = 'foobar';
        cell.replaceChildren(input);

        state.searchQuery = 'foo';
        highlightMatchesOnCurrentPage();

        assert.equal(cell.querySelector('input'), input, 'input powinien zostać nietknięty');
    });

    test('komórka z niezapisanym podglądem bulk-edita (column-edit-pending) nie jest nadpisywana', () => {
        setupDom();
        const state = buildGrid('search-hl-7.sql', {
            headers: ['name'],
            currentRows: [['foobar']],
        });
        const cell = dataCellOf(state, 0, 0);
        cell.classList.add('column-edit-pending');
        cell.textContent = 'pending-preview-value';

        state.searchQuery = 'foo';
        highlightMatchesOnCurrentPage();

        assert.equal(cell.textContent, 'pending-preview-value');
        assert.equal(cell.querySelector('mark'), null);
    });

    test('komórka z niezapisanym podglądem zbiorczej edycji komórek (cell-edit-pending) nie jest nadpisywana', () => {
        setupDom();
        const state = buildGrid('search-hl-7b.sql', {
            headers: ['name'],
            currentRows: [['foobar']],
        });
        const cell = dataCellOf(state, 0, 0);
        cell.classList.add('cell-edit-pending');
        cell.textContent = 'pending-cell-group-value';

        // regres: to dokładnie ten scenariusz zgłoszony przez użytkownika - restoreSearchUI (a więc i highlightMatchesOnCurrentPage) wywołuje się też przy powrocie do zakładki pliku (showResultsForFile), nawet bez aktywnego wyszukiwania
        state.searchQuery = '';
        highlightMatchesOnCurrentPage();

        assert.equal(cell.textContent, 'pending-cell-group-value');
        assert.equal(cell.querySelector('mark'), null);
    });

    test('wiele kolumn: podświetlana jest tylko ta, która faktycznie zawiera frazę', () => {
        setupDom();
        const state = buildGrid('search-hl-8.sql', {
            headers: ['a', 'b'],
            currentRows: [['foo', 'other']],
        });
        state.searchQuery = 'foo';

        highlightMatchesOnCurrentPage();

        assert.ok(dataCellOf(state, 0, 0).querySelector('mark'));
        assert.equal(dataCellOf(state, 0, 1).querySelector('mark'), null);
        assert.equal(dataCellOf(state, 0, 1).textContent, 'other');
    });

    test('komórka, która nigdy nie była dopasowaniem, w ogóle nie jest dotykana (referencja jej węzła tekstowego się nie zmienia)', () => {
        setupDom();
        const state = buildGrid('search-hl-9.sql', {
            headers: ['a', 'b'],
            currentRows: [['foo', 'never-matches-anything']],
        });

        // komórka spoza dopasowań - zapamiętujemy referencję jej JEDYNEGO węzła tekstowego z chwili initializeGrid/renderPage, jeszcze przed pierwszym wyszukiwaniem
        const untouchedCell = dataCellOf(state, 0, 1);
        const originalTextNode = untouchedCell.firstChild;
        assert.equal(originalTextNode.nodeType, window.Node.TEXT_NODE);

        // pierwsze wyszukiwanie - dopasowuje TYLKO drugą kolumnę
        state.searchQuery = 'foo';
        highlightMatchesOnCurrentPage();

        // gdyby highlightMatchesOnCurrentPage nadpisał tę komórkę (np. przez cell.textContent = text), silnik utworzyłby NOWY węzeł tekstowy - referencja by się zmieniła
        assert.equal(untouchedCell.firstChild, originalTextNode, 'komórka spoza dopasowań nie powinna być w ogóle dotknięta przy pierwszym wyszukiwaniu');

        // zmiana frazy (wciąż bez dopasowania w tej kolumnie) - to właśnie ten przypadek miałby zamiatać cały grid w starym rozwiązaniu (hasHighlights=true -> pełny sweep)
        state.searchQuery = 'bar';
        highlightMatchesOnCurrentPage();

        assert.equal(untouchedCell.firstChild, originalTextNode, 'komórka spoza dopasowań nie powinna być dotknięta także przy kolejnym wyszukiwaniu z inną frazą');

        // czyszczenie wyszukiwania - też nie powinno jej ruszyć, bo nigdy nie trafiła do searchHighlightedCells
        state.searchQuery = '';
        highlightMatchesOnCurrentPage();

        assert.equal(untouchedCell.firstChild, originalTextNode, 'komórka spoza dopasowań nie powinna być dotknięta także po wyczyszczeniu frazy');
        assert.equal(untouchedCell.textContent, 'never-matches-anything');

        // sanity check techniki dowodu: komórka, która FAKTYCZNIE była dopasowaniem, musi dostać nowe węzły (referencja się zmienia)
        const matchingCell = dataCellOf(state, 0, 0);
        const originalMatchingTextNode = matchingCell.firstChild;
        state.searchQuery = 'foo';
        highlightMatchesOnCurrentPage();
        assert.notEqual(matchingCell.firstChild, originalMatchingTextNode, 'sanity check: dopasowana komórka faktycznie dostaje nowe węzły (inaczej test niczego by nie dowodził)');
    });
});

describe('search.js - synchronizacja stanu i UI', () => {

    test('wpisanie frazy w input aktualizuje State.searchQuery i wysyła (po debounce) komendę search do backendu', async () => {
        setupDom();
        buildGrid('search-state-1.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });

        const vscode = fakeVscode();
        initSearchListeners(vscode);
        // initSearchListeners rejestruje listenery wewnątrz DOMContentLoaded - w jsdom to zdarzenie już minęło zanim doszliśmy tutaj, więc odpalamy je ręcznie
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const input = document.getElementById('searchInput');
        input.value = 'foo';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));

        await new Promise((resolve) => setTimeout(resolve, 400));

        assert.deepEqual(vscode.sent, [{ command: 'search', query: 'foo' }]);
    });

    test('Escape czyści frazę lokalnie i natychmiast wysyła pustą komendę search (bez czekania na debounce)', () => {
        setupDom();
        const state = buildGrid('search-state-2.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });
        state.searchQuery = 'foo';

        const vscode = fakeVscode();
        initSearchListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const input = document.getElementById('searchInput');
        input.value = 'foo';
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

        assert.equal(state.searchQuery, '');
        assert.equal(input.value, '');
        assert.deepEqual(vscode.sent, [{ command: 'search', query: '' }]);
    });

    test('resetSearch czyści State.searchQuery, pole inputu i licznik', () => {
        setupDom();
        const state = buildGrid('search-reset-1.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });
        state.searchQuery = 'foo';
        state.totalRows = 1;
        state.totalRowsUnfiltered = 5;
        document.getElementById('searchInput').value = 'foo';
        document.getElementById('searchCount').textContent = '1 of 5';

        resetSearch();

        assert.equal(state.searchQuery, '');
        assert.equal(document.getElementById('searchInput').value, '');
        assert.equal(document.getElementById('searchCount').textContent, '');
    });

    test('restoreSearchUI przywraca frazę z State do inputu, pokazuje licznik "X of Y" i podświetla bieżącą stronę', () => {
        setupDom();
        const state = buildGrid('search-restore-1.sql', {
            headers: ['name'],
            currentRows: [['foobar']],
        });
        state.searchQuery = 'foo';
        state.totalRows = 1;
        state.totalRowsUnfiltered = 5;

        restoreSearchUI();

        assert.equal(document.getElementById('searchInput').value, 'foo');
        assert.equal(document.getElementById('searchCount').textContent, '1 of 5');
        assert.ok(dataCellOf(state, 0, 0).querySelector('mark.search-match'));
    });

    test('restoreSearchUI nie nadpisuje inputu, jeśli user właśnie w nim pisze', () => {
        setupDom();
        const state = buildGrid('search-restore-2.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });
        state.searchQuery = 'stan-w-state';

        const input = document.getElementById('searchInput');
        input.value = 'to-co-user-wpisuje';
        input.focus();

        restoreSearchUI();

        assert.equal(input.value, 'to-co-user-wpisuje');
    });

    test('licznik jest pusty, gdy nie ma aktywnej frazy', () => {
        setupDom();
        buildGrid('search-state-3.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });

        restoreSearchUI();

        assert.equal(document.getElementById('searchCount').textContent, '');
    });

    test('krzyżyk czyszczenia jest ukryty przy pustym inpucie i pojawia się po wpisaniu tekstu', () => {
        setupDom();
        buildGrid('search-clear-vis-1.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });

        const vscode = fakeVscode();
        initSearchListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const input = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        assert.equal(clearBtn.classList.contains('visible'), false);

        input.value = 'f';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));

        assert.equal(clearBtn.classList.contains('visible'), true);
    });

    test('klik krzyżyka czyści frazę lokalnie i natychmiast wysyła pustą komendę search (bez czekania na debounce)', () => {
        setupDom();
        const state = buildGrid('search-clear-1.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });
        state.searchQuery = 'foo';

        const vscode = fakeVscode();
        initSearchListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const input = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        input.value = 'foo';
        clearBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

        assert.equal(state.searchQuery, '');
        assert.equal(input.value, '');
        assert.equal(clearBtn.classList.contains('visible'), false);
        assert.deepEqual(vscode.sent, [{ command: 'search', query: '' }]);
    });

    test('Ctrl+F (i Cmd+F) przenosi fokus do pola wyszukiwania', () => {
        setupDom();
        buildGrid('search-state-4.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });

        const vscode = fakeVscode();
        initSearchListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const input = document.getElementById('searchInput');
        assert.notEqual(document.activeElement, input);

        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));

        assert.equal(document.activeElement, input);
    });
});

describe('search.js - wskaźnik "szukam"', () => {

    test('krótkie wyszukiwanie (zakończone przed progiem pokazania) nigdy nie pokazuje wskaźnika', async () => {
        setupDom();
        buildGrid('search-ind-1.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });

        const vscode = fakeVscode();
        initSearchListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const input = document.getElementById('searchInput');
        input.value = 'foo';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));

        // czekamy aż debounce wyśle zapytanie, ale krócej niż próg pokazania wskaźnika liczony od momentu wysłania
        await new Promise((resolve) => setTimeout(resolve, 220));
        hideSearchIndicator(); // symulacja szybkiej odpowiedzi backendu (appendData)

        const spinner = document.getElementById('searchSpinner');
        assert.equal(spinner.classList.contains('visible'), false);
    });

    test('długie wyszukiwanie pokazuje wskaźnik po progu i chowa go dopiero po minimalnym czasie trzymania', async () => {
        setupDom();
        buildGrid('search-ind-2.sql', {
            headers: ['name'],
            currentRows: [['foo']],
        });

        const vscode = fakeVscode();
        initSearchListeners(vscode);
        document.dispatchEvent(new window.Event('DOMContentLoaded'));

        const input = document.getElementById('searchInput');
        input.value = 'foo';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));

        const spinner = document.getElementById('searchSpinner');

        // po debounce (150ms) + progu pokazania (150ms) wskaźnik powinien być już widoczny
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(spinner.classList.contains('visible'), true);

        // backend odpowiada zaraz po pokazaniu się wskaźnika - mimo to musi zostać widoczny jeszcze przez minimalny czas trzymania
        hideSearchIndicator();
        assert.equal(spinner.classList.contains('visible'), true, 'wskaźnik nie powinien zniknąć natychmiast');

        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(spinner.classList.contains('visible'), false);
    });
});
