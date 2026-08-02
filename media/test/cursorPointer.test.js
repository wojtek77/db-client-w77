import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, loadStylesheet, buildGrid, lpCellOf, dataCellOf, headerCellOf } from './domTestUtils.js';

// pomocnicza funkcja - computed cursor danego elementu z aktualnie załadowanego styles.css
function cursorOf(el) {
    return window.getComputedStyle(el).cursor;
}

describe('cursor: pointer w siatce wyników (regresja dla buga, gdzie pointer znikał po zaznaczeniu wiersza)', () => {

    test('komórka nagłówka "#" (header-cell.lp-cell) nie jest klikalna - cursor: default', () => {
        setupDom();
        loadStylesheet();
        const state = buildGrid('cursor-1.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a'], [2, 'b']],
        });

        const hashHeader = state.cachedHeaderHtml[0];
        assert.equal(hashHeader.classList.contains('header-cell'), true);
        assert.equal(hashHeader.classList.contains('lp-cell'), true);
        assert.equal(cursorOf(hashHeader), 'default');
    });

    test('nagłówek zwykłej kolumny (bez klikniętego hovera) nie ma wymuszonego pointera z poziomu bazowego CSS', () => {
        setupDom();
        loadStylesheet();
        const state = buildGrid('cursor-2.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a']],
        });

        const idHeader = headerCellOf(state, 0);
        // pointer dla nagłówków kolumn jest ustawiony tylko na :hover, nie w stanie bazowym
        assert.equal(cursorOf(idHeader), 'auto');
    });

    test('komórka z liczbą porządkową (LP) w wierszu ma cursor: pointer - można nią zaznaczyć cały wiersz', () => {
        setupDom();
        loadStylesheet();
        const state = buildGrid('cursor-3.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a'], [2, 'b']],
        });

        const lp = lpCellOf(state, 0);
        assert.equal(lp.classList.contains('header-cell'), false, 'komórka LP w wierszu danych nie może mieć klasy header-cell');
        assert.equal(cursorOf(lp), 'pointer');
    });

    test('zwykła komórka danych w wierszu ma cursor: pointer (cały wiersz jest klikalny)', () => {
        setupDom();
        loadStylesheet();
        const state = buildGrid('cursor-4.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a'], [2, 'b']],
        });

        const cell = dataCellOf(state, 0, 0);
        assert.equal(cursorOf(cell), 'pointer');
    });

    test('REGRESJA: po zaznaczeniu wiersza (klasa selected-row) pointer nie znika ani z wiersza, ani z komórki LP', () => {
        setupDom();
        loadStylesheet();
        const state = buildGrid('cursor-5.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a'], [2, 'b']],
        });

        const row = state.cachedGridHtml[0];
        const lp = lpCellOf(state, 0);
        const cell = dataCellOf(state, 0, 0);

        // symulujemy zaznaczenie wiersza bez przechodzenia przez cały mechanizm klikania - interesuje nas tylko CSS
        row.classList.add('selected-row');

        assert.equal(cursorOf(row), 'pointer');
        assert.equal(cursorOf(lp), 'pointer');
        assert.equal(cursorOf(cell), 'pointer');
    });

    test('REGRESJA: po zaznaczeniu kolumny (klasa selected-col) pointer w wierszu nadal działa tak samo jak wcześniej', () => {
        setupDom();
        loadStylesheet();
        const state = buildGrid('cursor-6.sql', {
            headers: ['id', 'name'],
            currentRows: [[1, 'a'], [2, 'b']],
        });

        const cell = dataCellOf(state, 0, 0);
        cell.classList.add('selected-col');

        assert.equal(cursorOf(cell), 'pointer');
    });
});
